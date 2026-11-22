import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GatewayConfig, ServiceConfig, SseServiceConfig, StdioServiceConfig } from './config.js';
import {
  answerTokenRequest, type BrokerSessions, EXPECTED_TENANT_ENV, SIGN_OUT_METHOD, signOutAll, TOKEN_BROKER_ENV, TOKEN_METHOD,
} from './signin.js';

const tokenRequestSchema = z.object({
  method: z.literal(TOKEN_METHOD),
  params: z.object({ scopes: z.array(z.string()).max(100), access: z.enum(['read', 'write']).optional() }).passthrough(),
});
const signOutRequestSchema = z.object({ method: z.literal(SIGN_OUT_METHOD), params: z.object({}).passthrough().optional() });

type LogEvent = { time: string; level: 'info' | 'warn' | 'error'; message: string; service?: string };
const logListeners = new Set<(event: LogEvent) => void>();

export function subscribeLogs(listener: (event: LogEvent) => void): () => void {
  logListeners.add(listener);
  return () => { logListeners.delete(listener); };
}

// Deliberately accept only fixed messages, never downstream error bodies or credentials.
export function log(level: 'info' | 'warn' | 'error', message: string, service?: string): void {
  const event: LogEvent = { time: new Date().toISOString(), level, message, ...(service ? { service } : {}) };
  process.stderr.write(`${JSON.stringify(event)}\n`);
  for (const listener of logListeners) {
    try { listener(event); } catch { /* Optional observers must not affect MCP execution. */ }
  }
}

/** Also bounds transport startup, which the SDK's JSON-RPC request timeout does not. */
async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeout: number,
  lifetime: AbortSignal,
): Promise<T> {
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(timeout)]);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new McpError(ErrorCode.RequestTimeout, 'Downstream operation cancelled or timed out'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run(signal);
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** The plain fetch signature the SDK transports call. Bun's `typeof fetch` also carries `preconnect`. */
export type GatewayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Force identity on BOTH SSE GETs and message POSTs, including reconnect attempts. */
export function createAuthenticatedFetch(config: GatewayConfig, url: URL, lifetime: AbortSignal): GatewayFetch {
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    if (target.origin !== url.origin || target.username || target.password) {
      throw new Error('Cross-origin downstream requests are forbidden');
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('Authorization', `Bearer ${config.serviceAuthToken}`);
    headers.set('X-Tenant-ID', config.tenantId);
    const signals = [lifetime];
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    return fetch(input, {
      ...init,
      headers,
      signal: AbortSignal.any(signals),
      // Never leak credentials via redirects (including same-origin-to-cross-origin hops).
      redirect: 'error',
      credentials: 'omit',
    });
  };
}

/**
 * The environment a stdio service starts with: the SDK's minimal safe set (PATH, HOME, USER,
 * SHELL, TERM, LOGNAME and their Windows equivalents), the service's own `env`, then the
 * gateway's identity, which config cannot override. SERVICE_AUTH_TOKEN is never passed.
 * A service with `signIn: true` is also told to borrow tokens from this process and which
 * tenant it must be configured for (it refuses to start for any other).
 */
export function childEnvironment(
  service: StdioServiceConfig,
  tenantId: string,
  inherited: Record<string, string> = getDefaultEnvironment(),
): Record<string, string> {
  return {
    ...inherited,
    ...service.env,
    SYNAPSE_TENANT_ID: tenantId,
    SYNAPSE_SERVICE_NAME: service.name,
    ...(service.signIn ? { [TOKEN_BROKER_ENV]: '1', [EXPECTED_TENANT_ENV]: tenantId } : {}),
  };
}

function sseTransport(config: GatewayConfig, service: SseServiceConfig, lifetime: AbortSignal): Transport {
  const authenticatedFetch = createAuthenticatedFetch(config, new URL(service.url), lifetime);
  return new SSEClientTransport(new URL(service.url), {
    // Modern EventSource uses a fetch hook, NOT a nonstandard "headers" field.
    eventSourceInit: { fetch: authenticatedFetch },
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.serviceAuthToken}`,
        'X-Tenant-ID': config.tenantId,
      },
      redirect: 'error',
    },
    fetch: authenticatedFetch,
  });
}

function stdioTransport(config: GatewayConfig, service: StdioServiceConfig): Transport {
  return new StdioClientTransport({
    command: service.command,
    args: [...service.args],
    env: childEnvironment(service, config.tenantId),
    ...(service.cwd === undefined ? {} : { cwd: service.cwd }),
    // A child's stderr is its log; stdout is reserved for MCP frames, so it cannot reach the host.
    stderr: 'inherit',
  });
}

type Connection = {
  config: ServiceConfig;
  client: Client;
  transport: Transport;
  abort: AbortController;
  status: 'connecting' | 'ready' | 'offline';
  tools: Tool[];
  closing?: Promise<void>;
  refreshing?: Promise<void>;
  refreshAgain: boolean;
  activeRequests: number;
  connectedAt: string | null;
  lastActivityAt: string | null;
};

export class DownstreamManager {
  private readonly connections = new Map<string, Connection>();
  private starting: Promise<void> | undefined;
  private stopped = false;
  private readonly observing: boolean;
  private readonly requests = new Map<string, { id: string; service: string; startedAt: string }>();
  private completedCalls = 0;
  private failedCalls = 0;
  onToolsChanged: () => void = () => {};
  private sessions: Promise<BrokerSessions> | undefined;

  /**
   * `signIn` builds the Microsoft sign-in sessions on first use. Injected so tests can lend
   * fake tokens; by default it is the real MSAL session from src/signin.ts.
   */
  constructor(config: GatewayConfig, private readonly signIn?: () => Promise<BrokerSessions>) {
    this.observing = config.dashboardEnabled === true;
    for (const service of config.services) {
      const abort = new AbortController();
      const transport = service.transport === 'stdio'
        ? stdioTransport(config, service)
        : sseTransport(config, service, abort.signal);
      const client = new Client({ name: 'tenant-mcp-gateway', version: '1.0.0' }, { capabilities: {} });
      const connection: Connection = {
        config: service, client, transport, abort, status: 'connecting', tools: [], refreshAgain: false,
        activeRequests: 0, connectedAt: null, lastActivityAt: null,
      };
      // Fail closed on a broken stream; do not keep routing with a stale SSE session.
      client.onerror = () => this.unavailable(connection);
      client.onclose = () => this.unavailable(connection);
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.refresh(connection));
      if (service.transport === 'stdio' && service.signIn) {
        client.setRequestHandler(tokenRequestSchema, async (request) => {
          try {
            const token = await answerTokenRequest(await this.signInSessions(), request.params);
            return { accessToken: token.accessToken, expiresOn: token.expiresOn };
          } catch (error) {
            // Our own refusal or MSAL's message; never a token.
            throw new McpError(-32000, error instanceof Error ? error.message : 'Token broker failed.');
          }
        });
        client.setRequestHandler(signOutRequestSchema, async () => {
          if (this.sessions) await signOutAll(await this.sessions);
          return {};
        });
      }
      this.connections.set(service.name, connection);
    }
  }

  private signInSessions(): Promise<BrokerSessions> {
    if (!this.signIn) return Promise.reject(new Error('This gateway has no signIn configuration.'));
    this.sessions ??= this.signIn();
    return this.sessions;
  }

  start(): Promise<void> {
    this.starting ??= Promise.all([...this.connections.values()].map((connection) => this.connect(connection)))
      .then(() => {});
    return this.starting;
  }

  private async connect(connection: Connection): Promise<void> {
    if (this.stopped) return;
    try {
      await withDeadline(async (signal) => {
        await connection.client.connect(connection.transport, { signal, timeout: connection.config.timeout });
        if (!connection.client.getServerCapabilities()?.tools) throw new Error('Downstream does not support tools');
        connection.tools = await this.discover(connection, signal);
      }, connection.config.timeout, connection.abort.signal);
      if (connection.abort.signal.aborted || this.stopped) return;
      connection.status = 'ready';
      connection.connectedAt = new Date().toISOString();
      connection.lastActivityAt = connection.connectedAt;
      log('info', 'Downstream connected', connection.config.name);
      this.onToolsChanged();
      if (connection.refreshAgain) void this.refresh(connection);
    } catch {
      this.unavailable(connection);
    }
  }

  private async discover(connection: Connection, signal: AbortSignal): Promise<Tool[]> {
    const tools: Tool[] = [];
    const cursors = new Set<string>();
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await connection.client.listTools(cursor === undefined ? {} : { cursor }, {
        signal, timeout: connection.config.timeout,
      });
      for (const tool of result.tools) {
        if (names.has(tool.name)) throw new Error('Duplicate downstream tool');
        names.add(tool.name);
        tools.push(tool);
      }
      if (tools.length > 10_000) throw new Error('Downstream tool limit exceeded');
      cursor = result.nextCursor;
      if (cursor === undefined) return tools;
      if (cursors.has(cursor)) throw new Error('Repeated downstream cursor');
      cursors.add(cursor);
    }
    throw new Error('Downstream pagination limit exceeded');
  }

  private refresh(connection: Connection): Promise<void> {
    connection.refreshAgain = true;
    if (connection.status !== 'ready' || this.stopped) return Promise.resolve();
    connection.refreshing ??= (async () => {
      try {
        while (connection.refreshAgain && connection.status === 'ready' && !this.stopped) {
          connection.refreshAgain = false;
          const tools = await withDeadline(
            (signal) => this.discover(connection, signal), connection.config.timeout, connection.abort.signal,
          );
          if (connection.status !== 'ready' || this.stopped) return;
          connection.tools = tools;
          this.onToolsChanged();
        }
      } catch {
        this.unavailable(connection);
      } finally {
        delete connection.refreshing;
      }
    })();
    return connection.refreshing;
  }

  private unavailable(connection: Connection): void {
    if (connection.status === 'offline') return;
    connection.status = 'offline';
    connection.tools = [];
    if (!this.stopped) {
      log('warn', 'Downstream unavailable; restart gateway to reconnect', connection.config.name);
      this.onToolsChanged();
    }
    void this.closeConnection(connection);
  }

  private closeConnection(connection: Connection): Promise<void> {
    connection.status = 'offline';
    connection.abort.abort();
    connection.closing ??= Promise.allSettled([
      connection.client.close(), connection.transport.close(),
    ]).then(() => {});
    return connection.closing;
  }

  tools(): Array<{ service: string; tool: Tool }> {
    return [...this.connections.values()]
      .filter((connection) => connection.status === 'ready')
      .flatMap((connection) => connection.tools.map((tool) => ({ service: connection.config.name, tool })));
  }

  async call(service: string, params: CallToolRequest['params'], signal: AbortSignal): Promise<CallToolResult> {
    const connection = this.connections.get(service);
    if (!connection) throw new McpError(ErrorCode.MethodNotFound, 'Unknown downstream service');
    if (connection.status !== 'ready') throw new McpError(ErrorCode.InternalError, 'Downstream service unavailable');
    if (!connection.tools.some((tool) => tool.name === params.name)) {
      throw new McpError(ErrorCode.MethodNotFound, 'Unknown downstream tool');
    }
    if (connection.config.transport === 'stdio' && connection.config.signIn) {
      // Open the browser before the call's deadline starts, not inside it.
      try {
        await (await this.signInSessions()).read.ensureSignedIn();
      } catch (error) {
        throw new McpError(ErrorCode.InternalError,
          `Microsoft sign-in did not complete, so nothing ran: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      if (connection.status !== 'ready') throw new McpError(ErrorCode.InternalError, 'Downstream service unavailable');
    }
    const requestId = this.observing && this.requests.size < 128 ? randomUUID() : undefined;
    connection.activeRequests++;
    connection.lastActivityAt = new Date().toISOString();
    if (requestId) {
      this.requests.set(requestId, { id: requestId, service, startedAt: connection.lastActivityAt });
      log('info', 'Tool call started', service);
    }
    let failed = true;
    try {
      const result = await withDeadline(
        (requestSignal) => connection.client.callTool(params, CallToolResultSchema, {
          signal: requestSignal,
          timeout: connection.config.timeout,
          maxTotalTimeout: connection.config.timeout,
          resetTimeoutOnProgress: false,
        }),
        connection.config.timeout,
        AbortSignal.any([signal, connection.abort.signal]),
      );
      const parsed = CallToolResultSchema.parse(result);
      failed = parsed.isError === true;
      return parsed;
    } catch (error) {
      // Do not forward downstream error data/messages: they may contain credentials or internals.
      if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) {
        throw new McpError(ErrorCode.MethodNotFound, 'Downstream tool not found');
      }
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        throw new McpError(ErrorCode.InvalidParams, 'Downstream rejected tool arguments');
      }
      throw new McpError(ErrorCode.InternalError, 'Downstream tool failed, timed out, or was cancelled');
    } finally {
      connection.activeRequests--;
      connection.lastActivityAt = new Date().toISOString();
      this.completedCalls++;
      if (failed) this.failedCalls++;
      if (requestId) this.requests.delete(requestId);
      if (this.observing) log(failed ? 'warn' : 'info', failed ? 'Tool call failed' : 'Tool call completed', service);
    }
  }

  /** Allowlisted operational metadata only; never expose config, URLs, tenant IDs or payloads. */
  inspect() {
    const services = [...this.connections.values()].map((connection) => ({
      name: connection.config.name,
      transport: connection.config.transport,
      status: connection.status,
      toolCount: connection.status === 'ready' ? connection.tools.length : 0,
      activeRequests: connection.activeRequests,
      connectedAt: connection.connectedAt,
      lastActivityAt: connection.lastActivityAt,
    }));
    return {
      services,
      requests: [...this.requests.values()],
      requestsTruncated: services.reduce((sum, service) => sum + service.activeRequests, 0) - this.requests.size,
      completedCalls: this.completedCalls,
      failedCalls: this.failedCalls,
    };
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.sessions) await this.sessions.then(signOutAll).catch(() => {});
    await Promise.allSettled([...this.connections.values()].map((connection) => this.closeConnection(connection)));
  }
}
