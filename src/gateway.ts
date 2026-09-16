import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { GatewayConfig } from './config.js';
import { DownstreamManager, log } from './downstream.js';

/** Reserve tenant_id and common spelling variants at every nesting level. */
export function isTenantKey(key: string): boolean {
  return key.replace(/[_-]/g, '').toLowerCase() === 'tenantid';
}

export function assertNoTenantOverride(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) {
      if (isTenantKey(key)) {
        throw new McpError(ErrorCode.InvalidParams, 'Tenant arguments are forbidden; identity is fixed by the gateway');
      }
      pending.push(child);
    }
  }
}

/** Remove reserved fields from nested schemas, $defs, composition branches and required lists. */
export function sanitizeInputSchema(schema: Tool['inputSchema']): Tool['inputSchema'] {
  function visit(value: unknown, depth = 0): unknown {
    if (depth > 64) throw new Error('Tool schema nesting limit exceeded');
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (['properties', 'dependentSchemas', 'dependentRequired', 'dependencies'].includes(key)
        && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        return [key, Object.fromEntries(Object.entries(child)
          .filter(([name]) => !isTenantKey(name))
          .map(([name, definition]) => [name, visit(
            Array.isArray(definition) ? definition.filter((item) => typeof item !== 'string' || !isTenantKey(item)) : definition,
            depth + 1,
          )]))];
      }
      if (key === 'required' && Array.isArray(child)) {
        return [key, child.filter((item) => typeof item !== 'string' || !isTenantKey(item))];
      }
      return [key, visit(child, depth + 1)];
    }));
  }
  return visit(schema) as Tool['inputSchema'];
}

export function createGateway(config: GatewayConfig, downstream: DownstreamManager): Server {
  const server = new Server(
    { name: 'tenant-mcp-gateway', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  let initialized = false;
  let tools: Tool[] = [];
  let publishedNames = new Set<string>();

  function rebuildTools(): void {
    tools = downstream.tools().flatMap(({ service, tool }) => {
      const name = `${service}__${tool.name}`;
      // This gateway deliberately does not advertise experimental task execution.
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || tool.execution?.taskSupport === 'required') {
        log('warn', 'Skipping unsupported downstream tool name or task requirement', service);
        return [];
      }
      try {
        const { execution: _execution, ...definition } = tool;
        return [{
          ...definition,
          name,
          description: `${tool.description ?? ''}${tool.description ? '\n\n' : ''}[Tenant: ${config.tenantId}] [Service: ${service}]`,
          inputSchema: sanitizeInputSchema(tool.inputSchema),
        }];
      } catch {
        log('warn', 'Skipping downstream tool with unsupported schema', service);
        return [];
      }
    });
    publishedNames = new Set(tools.map((tool) => tool.name));
  }

  downstream.onToolsChanged = () => {
    rebuildTools();
    if (initialized) {
      void server.sendToolListChanged().catch(() => log('warn', 'Unable to send tool-list notification'));
    }
  };
  server.oninitialized = () => { initialized = true; };

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (request.params?.cursor !== undefined) {
      throw new McpError(ErrorCode.InvalidParams, 'Gateway tools/list is not paginated; omit cursor');
    }
    await downstream.start();
    rebuildTools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Validate the whole payload, including _meta, before any downstream side effect.
    assertNoTenantOverride(request.params);
    if (request.params.task !== undefined) {
      throw new McpError(ErrorCode.InvalidParams, 'Task-augmented calls are not supported');
    }
    await downstream.start();
    rebuildTools();
    const separator = request.params.name.indexOf('__');
    if (separator < 1 || !publishedNames.has(request.params.name)) {
      throw new McpError(ErrorCode.MethodNotFound, 'Unknown or unavailable namespaced tool');
    }
    const service = request.params.name.slice(0, separator);
    const name = request.params.name.slice(separator + 2);
    // Arguments are forwarded unchanged; identity is NEVER synthesized into tool arguments.
    // Client metadata/progress tokens are session-local and intentionally not forwarded.
    return downstream.call(service, {
      name,
      ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments }),
    }, extra.signal);
  });
  return server;
}
