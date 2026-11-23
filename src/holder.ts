/**
 * Borrow the machine's shared Microsoft sign-in instead of holding one of our own.
 *
 * microsoft-graph-mcp-servers runs one background "sign-in holder" per tenant and client:
 * it keeps the delegated sign-in in memory only and lends Graph tokens over a 0600 Unix
 * socket in a 0700 `~/.mcp-graph/run/`. Its gateway, CLI commands and probes all borrow
 * from it, so the person signs in once per work session rather than once per process.
 * With `signIn.holder` configured, Synapse borrows from the same one, and a Synapse
 * restart or a new chat is no longer a new browser prompt.
 *
 * The wire contract (socket name, methods, env) is the one in that repository's
 * `mcp_shared/src/signin-holder.ts`. If no holder can be reached or started, Synapse signs
 * in for itself as before.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrokerSessions, MemorySession } from './signin.js';
import { SIGN_OUT_METHOD, TOKEN_METHOD } from './signin.js';

export const ENSURE_METHOD = 'x-mcp-graph/ensure-signed-in';
export const STATUS_METHOD = 'x-mcp-graph/status';
const TOKEN_TIMEOUT_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 10_000;

export class HolderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HolderUnavailableError';
  }
}

export interface HolderLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export const holderDir = (home: string = homedir()): string => join(home, '.mcp-graph', 'run');

/** Must match mcp_shared's `holderSocketPath` byte for byte. */
export const holderSocketPath = (tenantId: string, clientId: string, home: string = homedir()): string => {
  const key = createHash('sha256')
    .update(`${tenantId.toLowerCase()}|${clientId.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return join(holderDir(home), `signin-${key}.sock`);
};

const UNREACHABLE = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'ECONNRESET', 'EPIPE']);
/** macOS caps a Unix socket path at 104 bytes; past it connect fails with EINVAL. */
const MAX_SOCKET_PATH_BYTES = 103;

export function holderRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = TOKEN_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      reject(new HolderUnavailableError(`The sign-in holder's socket path is over ${MAX_SOCKET_PATH_BYTES} bytes: ${socketPath}`));
      return;
    }
    // Checked up front: Bun 1.3 emits a missing socket's ENOENT before any listener can attach.
    if (!existsSync(socketPath)) {
      reject(new HolderUnavailableError(`No sign-in holder at ${socketPath} (ENOENT).`));
      return;
    }
    const socket = createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`The sign-in holder did not answer ${method} within ${timeoutMs} ms.`))),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      finish(() => {
        try {
          const reply = JSON.parse(buffer.slice(0, end)) as { result?: unknown; error?: { message: string } };
          if (reply.error) reject(new Error(reply.error.message));
          else resolve(reply.result);
        } catch {
          reject(new Error('The sign-in holder sent an unreadable reply.'));
        }
      });
    });
    socket.on('error', (error: NodeJS.ErrnoException) => finish(() => reject(
      error.code && UNREACHABLE.has(error.code)
        ? new HolderUnavailableError(`No sign-in holder at ${socketPath} (${error.code}).`)
        : error,
    )));
    socket.on('close', () => finish(() => reject(
      new HolderUnavailableError('The sign-in holder closed the connection without a reply.'),
    )));
  });
}

async function holderRunning(socketPath: string): Promise<boolean> {
  try {
    await holderRequest(socketPath, STATUS_METHOD, {}, STATUS_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/** Refuse a socket directory another user owns or can reach into. */
export function secureHolderDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = statSync(dir);
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new HolderUnavailableError(`${dir} is owned by another user.`);
  }
  if ((stats.mode & 0o077) !== 0) throw new HolderUnavailableError(`${dir} is accessible to other users; chmod 700 it.`);
}

export interface EnsureHolderOptions {
  readonly tenantId: string;
  readonly clientId: string;
  readonly launch: HolderLaunch;
  readonly maxSessionAgeMs: number;
  readonly home?: string;
}

/** A running holder's socket, starting one if none answers. */
export async function ensureHolder(options: EnsureHolderOptions): Promise<string> {
  const home = options.home ?? homedir();
  const socketPath = holderSocketPath(options.tenantId, options.clientId, home);
  if (await holderRunning(socketPath)) return socketPath;
  const dir = holderDir(home);
  secureHolderDir(dir);
  const logFd = openSync(join(dir, `${basename(socketPath, '.sock')}.log`), 'a', 0o600);
  try {
    const child = spawn(options.launch.command, [...options.launch.args], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      env: {
        ...process.env,
        HOME: home,
        MCP_GRAPH_HOLDER_TENANT: options.tenantId,
        MCP_GRAPH_HOLDER_CLIENT: options.clientId,
        MCP_GRAPH_HOLDER_MAX_AGE_MS: String(options.maxSessionAgeMs),
      },
    });
    child.on('error', () => undefined);
    child.unref();
  } finally {
    closeSync(logFd);
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await holderRunning(socketPath)) return socketPath;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new HolderUnavailableError(`The sign-in holder did not start within ${START_TIMEOUT_MS / 1000}s; see ${dir}.`);
}

/**
 * Sessions backed by the holder, falling back to `local` (Synapse's own in-memory sign-in)
 * only when no holder can be reached or started. An error from a running holder (a cancelled
 * sign-in, the wrong tenant) is passed on, never a reason to sign in a second way.
 *
 * `shared: true` tells the downstream manager not to sign out when Synapse merely stops: the
 * session belongs to the person's whole machine. An explicit sign-out still ends it.
 */
export function createHolderSessions(
  ensure: () => Promise<string>,
  local: () => Promise<BrokerSessions>,
  warn: (message: string) => void,
): BrokerSessions & { readonly shared: true } {
  let socket: string | null = null;
  let fallback: Promise<BrokerSessions> | null = null;
  let signedIn = false;

  const send = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (socket) {
      try {
        return await holderRequest(socket, method, params);
      } catch (error) {
        if (!(error instanceof HolderUnavailableError)) throw error;
        socket = null;
      }
    }
    socket = await ensure();
    return holderRequest(socket, method, params);
  };

  const session = (access: 'read' | 'write'): MemorySession => {
    const viaLocal = async () => {
      const sessions = await (fallback as Promise<BrokerSessions>);
      return access === 'write' ? (sessions.write ?? sessions.read) : sessions.read;
    };
    const run = async <T>(remote: () => Promise<T>, own: (s: MemorySession) => Promise<T>): Promise<T> => {
      if (fallback) return own(await viaLocal());
      try {
        return await remote();
      } catch (error) {
        if (!(error instanceof HolderUnavailableError)) throw error;
        warn(`Shared sign-in unavailable (${error.message}); signing in for this gateway only.`);
        fallback ??= local();
        return own(await viaLocal());
      }
    };
    return {
      getToken: (scopes) => run(async () => {
        const token = await send(TOKEN_METHOD, { scopes: [...scopes], access }) as { accessToken: string; expiresOn: number };
        signedIn = true;
        return { accessToken: token.accessToken, expiresOn: token.expiresOn };
      }, (s) => s.getToken(scopes)),
      ensureSignedIn: () => run(async () => {
        await send(ENSURE_METHOD, { access });
        signedIn = true;
      }, (s) => s.ensureSignedIn()),
      async signOut() {
        signedIn = false;
        if (fallback) {
          const own = await fallback;
          await Promise.all([own.read.signOut(), own.write?.signOut()]);
        }
        if (socket) await holderRequest(socket, SIGN_OUT_METHOD, {}, STATUS_TIMEOUT_MS * 5).catch(() => undefined);
      },
      isSignedIn: () => signedIn,
    };
  };

  const read = session('read');
  const write = session('write');
  return { read, write: { ...write, signOut: async () => undefined }, shared: true };
}
