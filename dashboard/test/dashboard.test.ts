import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startAgent, type Source } from '../server/agent.js';
import { discover, readSession } from '../server/discovery.js';
import { startDashboard } from '../server/http.js';
import { runtimeDirectory } from '../server/runtime.js';
import { MAX_EVENTS, MAX_SNAPSHOT_BYTES, type Inspection, type LogEvent } from '../shared/protocol.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const empty: Inspection = { services: [], requests: [], requestsTruncated: 0, completedCalls: 0, failedCalls: 0 };
function source() {
  const listeners = new Set<(event: LogEvent) => void>();
  const value: Source = {
    inspect: () => structuredClone(empty),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { value, emit: (event: LogEvent) => { for (const listener of listeners) listener(event); }, listeners };
}
async function temp(t: TestContext) {
  const dir = await mkdtemp('/tmp/sd-'); // Short enough for macOS Unix socket paths.
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail('Condition did not become true');
}

test('agent snapshots are private, bounded, multi-instance, and cleaned up', async (t) => {
  const dir = await temp(t);
  const a = source();
  const first = await startAgent(a.value, dir);
  const second = await startAgent(source().value, dir);
  t.after(() => Promise.all([first.close(), second.close()]));
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  assert.equal((await lstat(first.path)).mode & 0o777, 0o600);
  for (let i = 0; i < MAX_EVENTS + 50; i++) a.emit({ time: new Date().toISOString(), level: 'info', message: `event ${i}` });
  a.emit({ time: new Date().toISOString(), level: 'info', message: 'invalid', secret: 'must-not-appear' } as LogEvent);
  const result = await discover(dir);
  assert.equal(result.sessions.length, 2);
  const inspected = result.sessions.find((session) => session.id === first.id)!;
  assert.equal(inspected.events.length, MAX_EVENTS);
  assert.equal(inspected.events[0]?.message, 'event 50');
  assert(!JSON.stringify(result).includes('must-not-appear'));
  await Promise.all([first.close(), first.close()]);
  assert.equal(a.listeners.size, 0);
  assert.equal((await discover(dir)).sessions.length, 1);
  await second.close();
  assert.deepEqual(await readdir(dir), []);
});

test('unsafe runtime directories and symlink targets are rejected', async (t) => {
  const dir = await temp(t);
  await chmod(dir, 0o755);
  await assert.rejects(runtimeDirectory(dir), /0700/);
  await chmod(dir, 0o700);
  const link = `${dir}-link`;
  await symlink(dir, link);
  t.after(() => rm(link, { force: true }));
  await assert.rejects(runtimeDirectory(link), /symlink/);
  await assert.rejects(runtimeDirectory('relative-directory'), /absolute/);
});

test('malformed, oversized and hung socket responses are bounded and isolated', { timeout: 10_000 }, async (t) => {
  const dir = await temp(t);
  for (const kind of ['malformed', 'oversized', 'hung']) {
    const path = join(dir, `${kind}.sock`);
    const peers = new Set<import('node:net').Socket>();
    const server = createSocketServer((socket) => {
      peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
      if (kind === 'malformed') socket.end('{oops');
      if (kind === 'oversized') socket.end('x'.repeat(MAX_SNAPSHOT_BYTES + 1));
    });
    server.listen(path); await once(server, 'listening'); await chmod(path, 0o600);
    try { await assert.rejects(readSession(path)); }
    finally {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }
});

test('HTTP bridge requires token, correct host/origin, is read-only and serves only built assets', async (t) => {
  const dir = await temp(t);
  const agent = await startAgent(source().value, dir);
  t.after(() => agent.close());
  const bridge = await startDashboard({ directory: dir, clientDir: join(root, 'dashboard/dist/client') });
  t.after(() => bridge.close());
  const token = new URLSearchParams(new URL(bridge.url).hash.slice(1)).get('token');
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${bridge.origin}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${bridge.origin}/api/sessions`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const good = await fetch(`${bridge.origin}/api/sessions`, { headers });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).sessions.length, 1);
  assert.equal(good.headers.get('access-control-allow-origin'), null);
  assert.match(good.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal((await fetch(`${bridge.origin}/api/sessions`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${bridge.origin}/api/sessions`, { headers, method: 'POST' })).status, 405);
  assert.equal((await fetch(`${bridge.origin}/api/stop`, { headers })).status, 404);
  const wrongHost = await new Promise<number>((done, reject) => {
    request(`${bridge.origin}/api/sessions`, { headers: { ...headers, Host: 'attacker.example' } }, (response) => { response.resume(); done(response.statusCode!); }).on('error', reject).end();
  });
  assert.equal(wrongHost, 403);
  for (const path of ['/.env', '/package.json', '/server/agent.ts', '/assets/../../package.json']) {
    assert.equal((await fetch(`${bridge.origin}${path}`, { headers })).status, 404);
  }
  const html = await (await fetch(bridge.origin)).text();
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert(asset);
  const script = await fetch(`${bridge.origin}${asset}`);
  assert.equal(script.status, 200);
  await script.arrayBuffer();
  await bridge.close();
  assert.equal((await discover(dir)).sessions.length, 1, 'closing dashboard does not stop gateway telemetry');
});

async function backend() {
  const sessions = new Map<string, { server: Server; transport: SSEServerTransport }>();
  let release: (() => void) | undefined;
  const server = createHttpServer((req, res) => {
    void (async () => {
      if (req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        const mcp = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'hold', inputSchema: { type: 'object' } }] }));
        mcp.setRequestHandler(CallToolRequestSchema, async () => {
          await new Promise<void>((done) => { release = done; });
          return { content: [{ type: 'text', text: 'SECRET_RESULT' }] };
        });
        sessions.set(transport.sessionId, { server: mcp, transport });
        mcp.onclose = () => { sessions.delete(transport.sessionId); };
        await mcp.connect(transport);
      } else {
        const id = new URL(req.url!, 'http://localhost').searchParams.get('sessionId')!;
        const session = sessions.get(id);
        if (session) await session.transport.handlePostMessage(req, res);
        else res.writeHead(404).end();
      }
    })().catch(() => res.end());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/sse?private=SECRET_URL`,
    release: () => release?.(),
    close: async () => {
      release?.();
      await Promise.all([...sessions.values()].map(({ server: mcp }) => mcp.close()));
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

test('real gateway opt-in reports live calls and never exposes tenant, credentials, URLs or payloads', { timeout: 15_000 }, async (t) => {
  const dir = await temp(t);
  const service = await backend();
  t.after(() => service.close());
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ services: [{ name: 'billing', url: service.url, timeout: 5000 }] }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(root, 'dist/index.js')], stderr: 'pipe',
    env: {
      MCP_CONFIG_PATH: config, SERVICE_AUTH_TOKEN: 'SECRET_TOKEN', TENANT_ID: 'SECRET_TENANT',
      MCP_DASHBOARD_ENABLED: 'true', SYNAPSE_DASHBOARD_RUNTIME_DIR: dir,
    },
  });
  transport.stderr?.resume();
  const client = new Client({ name: 'dashboard-test', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  await client.listTools();
  const before = await discover(dir);
  assert.equal(before.sessions.length, 1);
  assert.equal(before.sessions[0]?.services[0]?.status, 'ready');
  const call = client.callTool({ name: 'billing__hold', arguments: { secret: 'SECRET_ARGUMENT' } });
  await eventually(async () => (await discover(dir)).sessions[0]?.requests.length === 1);
  const during = await discover(dir);
  assert.equal(during.sessions[0]?.services[0]?.activeRequests, 1);
  service.release();
  await call;
  const after = await discover(dir);
  assert.equal(after.sessions[0]?.requests.length, 0);
  assert.equal(after.sessions[0]?.completedCalls, 1);
  assert(!JSON.stringify([before, during, after]).includes('SECRET_'));
  await client.close();
  await eventually(async () => !(await readdir(dir)).some((name) => name.endsWith('.sock')));
});

for (const setting of [undefined, 'false']) {
  test(`dashboard disabled (${setting ?? 'unset'}) creates no runtime directory or socket`, { timeout: 10_000 }, async (t) => {
    const dir = await temp(t);
    const runtime = join(dir, 'must-not-exist');
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ services: [{ name: 'offline', url: 'http://127.0.0.1:1/sse', timeout: 100 }] }));
    const child = spawn(process.execPath, [join(root, 'dist/index.js')], {
      env: {
        PATH: process.env.PATH,
        MCP_CONFIG_PATH: config, SERVICE_AUTH_TOKEN: 'SECRET_TOKEN', TENANT_ID: 'test',
        SYNAPSE_DASHBOARD_RUNTIME_DIR: runtime,
        ...(setting === undefined ? {} : { MCP_DASHBOARD_ENABLED: setting }),
      }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stderr = ''; let stdout = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    await eventually(() => stderr.includes('Gateway ready'));
    await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    const exit = once(child, 'exit');
    child.stdin.end();
    assert.equal((await exit)[0], 0);
    assert.equal(stdout, '');
  });
}

test('dashboard is an independent package and not a gateway dependency', async () => {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert(!pkg.workspaces, 'root install must not implicitly install dashboard');
  for (const dependency of ['react', 'react-dom', 'vite', 'synapse-mcp-dashboard']) assert(!(dependency in pkg.dependencies));
});
