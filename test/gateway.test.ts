import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema, CallToolResultSchema, ErrorCode, ListToolsRequestSchema, McpError,
  ToolListChangedNotificationSchema, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { fileConfigSchema, loadConfig } from '../src/config.js';
import { createAuthenticatedFetch } from '../src/downstream.js';
import { assertNoTenantOverride, sanitizeInputSchema } from '../src/gateway.js';

const token = 'test-secret-do-not-log';
const inputSchema: Tool['inputSchema'] = {
  type: 'object',
  properties: {
    value: { type: 'string' }, tenant_id: { type: 'string' },
    nested: { type: 'object', properties: { tenantId: { type: 'string' }, keep: { type: 'string' } }, required: ['tenantId'] },
  },
  required: ['tenant_id'],
};

async function fixture() {
  const requests: Array<{ method: string; headers: IncomingHttpHeaders }> = [];
  const calls: Array<{ tenant: string; name: string; args: unknown }> = [];
  const sessions = new Map<string, { server: Server; transport: SSEServerTransport }>();
  let tools: Tool[] = ['echo', 'raw__name', 'fail', 'business_error', 'slow'].map((name) => ({
    name, description: `Test ${name}`, inputSchema,
  }));
  const http = createServer((req, res) => {
    void (async () => {
      requests.push({ method: req.method ?? '', headers: req.headers });
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/offline') { res.writeHead(503).end(); return; }
      if (url.pathname === '/hang') return;
      if (req.method === 'GET' && url.pathname === '/sse') {
        const tenant = String(req.headers['x-tenant-id']);
        const transport = new SSEServerTransport('/messages', res);
        const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: { listChanged: true } } });
        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
          const offset = Number(request.params?.cursor ?? 0);
          return { tools: tools.slice(offset, offset + 2), ...(offset + 2 < tools.length ? { nextCursor: String(offset + 2) } : {}) };
        });
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          calls.push({ tenant, name: request.params.name, args: request.params.arguments });
          if (request.params.name === 'fail') throw new McpError(ErrorCode.MethodNotFound, `sensitive ${token}`);
          if (request.params.name === 'slow') {
            await new Promise<void>((done) => {
              if (extra.signal.aborted) done();
              else extra.signal.addEventListener('abort', () => done(), { once: true });
            });
          }
          if (request.params.name === 'business_error') return { content: [{ type: 'text', text: 'Business error' }], isError: true };
          const data = { tenant, name: request.params.name, args: request.params.arguments };
          return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        });
        sessions.set(transport.sessionId, { server, transport });
        server.onclose = () => { sessions.delete(transport.sessionId); };
        await server.connect(transport);
        return;
      }
      const session = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (req.method === 'POST' && session) {
        await session.transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests, calls, sessions,
    async changeTools() {
      tools = [...tools, { name: 'added', inputSchema: { type: 'object' } }];
      await Promise.all([...sessions.values()].map(({ server }) => server.sendToolListChanged()));
    },
    async close() {
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}

async function gateway(services: unknown[], tenant = 'tenant-a') {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-gateway-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ services }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('dist/index.js')], stderr: 'pipe',
    env: { SERVICE_AUTH_TOKEN: token, TENANT_ID: tenant, MCP_CONFIG_PATH: path },
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'test-client', version: '1' });
  try { await client.connect(transport); } catch (error) {
    await transport.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    client, transport, stderr: () => stderr,
    async close() {
      await client.close();
      await rm(dir, { recursive: true, force: true });
      assert(!stderr.includes(token), 'gateway must not log credentials');
    },
  };
}

const isCode = (code: number) => (error: unknown) => error instanceof McpError && error.code === code;
async function eventually(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail('Condition did not become true');
}

test('configuration fails closed and diagnostics do not leak values', async () => {
  await assert.rejects(loadConfig({ SERVICE_AUTH_TOKEN: `bad\r\n${token}`, TENANT_ID: '[spoof]' }), (error: Error) => {
    assert(!error.message.includes(token));
    return /SERVICE_AUTH_TOKEN/.test(error.message) && /TENANT_ID/.test(error.message);
  });
  for (const name of ['bad__namespace', 'trailing_', 'UPPER', 'with space']) {
    assert(!fileConfigSchema.safeParse({ services: [{ name, url: 'https://example.com/sse' }] }).success);
  }
  for (const url of ['invalid', 'http://internal.example/sse', 'https://user:pass@example.com/sse', 'file:///tmp/test']) {
    assert(!fileConfigSchema.safeParse({ services: [{ name: 'svc', url }] }).success);
  }
  assert(!fileConfigSchema.safeParse({ services: [1, 2].map(() => ({ name: 'same', url: 'https://example.com' })) }).success);
  assert(!fileConfigSchema.safeParse({ services: [{ name: 'svc', url: 'https://example.com', timeout: 0 }] }).success);
});

test('tenant guard rejects nested keys and aliases without mutating schemas', () => {
  for (const args of [{ tenant_id: 'x' }, { nested: [{ TENANT_ID: 'x' }] }, { tenantId: 'x' }, { 'tenant-id': 'x' }]) {
    assert.throws(() => assertNoTenantOverride(args), isCode(ErrorCode.InvalidParams));
  }
  const before = JSON.stringify(inputSchema);
  const clean = sanitizeInputSchema(inputSchema);
  assert.equal(JSON.stringify(inputSchema), before);
  assert(!JSON.stringify(clean).includes('tenant'));
  assert.deepEqual(clean.required, []);
  assertNoTenantOverride({ value: 'safe', nested: [{ keep: 1 }] });
});

test('authenticated fetch overwrites caller identity and refuses cross-origin requests/redirects', async (t) => {
  const backend = await fixture();
  t.after(() => backend.close());
  const controller = new AbortController();
  const fetcher = createAuthenticatedFetch({ serviceAuthToken: token, tenantId: 'fixed', services: [] }, new URL(backend.url), controller.signal);
  await fetcher(`${backend.url}/offline`, { headers: { Authorization: 'wrong', 'X-Tenant-ID': 'wrong' } });
  assert.equal(backend.requests[0]?.headers.authorization, `Bearer ${token}`);
  assert.equal(backend.requests[0]?.headers['x-tenant-id'], 'fixed');
  await assert.rejects(fetcher('https://example.com/sse'), /Cross-origin/);
  const redirect = createServer((_req, res) => { res.writeHead(302, { Location: `${backend.url}/offline` }).end(); });
  redirect.listen(0, '127.0.0.1');
  await once(redirect, 'listening');
  t.after(() => new Promise<void>((done) => { redirect.closeAllConnections(); redirect.close(() => done()); }));
  const address = redirect.address();
  assert(address && typeof address !== 'string');
  const origin = new URL(`http://127.0.0.1:${address.port}`);
  const redirectFetch = createAuthenticatedFetch({ serviceAuthToken: token, tenantId: 'fixed', services: [] }, origin, controller.signal);
  await assert.rejects(redirectFetch(origin));
  assert.equal(backend.requests.length, 1, 'redirect target never receives credentials');
});

test('real stdio/SSE aggregation, pagination, routing, guardrails, errors and live tool updates', { timeout: 15_000 }, async (t) => {
  const backend = await fixture();
  t.after(() => backend.close());
  const app = await gateway([
    { name: 'billing', url: `${backend.url}/sse`, timeout: 1000 },
    { name: 'crm', url: `${backend.url}/sse`, timeout: 1000 },
    { name: 'offline', url: `${backend.url}/offline`, timeout: 300 },
    { name: 'hanging', url: `${backend.url}/hang`, timeout: 300 },
  ]);
  t.after(() => app.close());
  const listed = await app.client.listTools();
  assert.equal(listed.tools.length, 10, 'all pages from both healthy services');
  assert.equal(listed.tools[0]?.name, 'billing__echo');
  assert(listed.tools.every((tool) => tool.description?.includes('[Tenant: tenant-a] [Service:')));
  assert(!JSON.stringify(listed.tools.map((tool) => tool.inputSchema)).includes('tenant_id'));

  const result = await app.client.callTool({ name: 'billing__raw__name', arguments: { value: 'abc' } });
  assert.deepEqual(result.structuredContent, { tenant: 'tenant-a', name: 'raw__name', args: { value: 'abc' } });
  await app.client.callTool({ name: 'crm__echo', arguments: { value: 'crm' } });
  const before = backend.calls.length;
  for (const args of [{ tenant_id: 'other' }, { filters: [{ tenantId: 'other' }] }]) {
    await assert.rejects(app.client.callTool({ name: 'billing__echo', arguments: args }), isCode(ErrorCode.InvalidParams));
  }
  await assert.rejects(app.client.request({
    method: 'tools/call', params: { name: 'billing__echo', _meta: { tenant_id: 'other' } },
  }, CallToolResultSchema), isCode(ErrorCode.InvalidParams));
  assert.equal(backend.calls.length, before, 'rejected arguments never reach downstream');
  for (const name of ['echo', 'missing__echo', 'billing__missing', 'offline__echo']) {
    await assert.rejects(app.client.callTool({ name }), isCode(ErrorCode.MethodNotFound));
  }
  await assert.rejects(app.client.callTool({ name: 'billing__fail' }), (error: unknown) => {
    assert(error instanceof McpError);
    assert.equal(error.code, ErrorCode.MethodNotFound);
    assert(!error.message.includes(token));
    return true;
  });
  assert.equal((await app.client.callTool({ name: 'billing__business_error' })).isError, true);
  await assert.rejects(app.client.callTool({ name: 'billing__slow' }), isCode(ErrorCode.InternalError));
  await assert.rejects(app.client.listTools({ cursor: 'anything' }), isCode(ErrorCode.InvalidParams));

  let notifications = 0;
  app.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
  await backend.changeTools();
  await eventually(async () => (await app.client.listTools()).tools.length === 12);
  assert(notifications > 0);
  assert(backend.requests.some((request) => request.method === 'GET'));
  assert(backend.requests.some((request) => request.method === 'POST'));
  for (const request of backend.requests) {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers['x-tenant-id'], 'tenant-a');
  }
  await Promise.all([...backend.sessions.values()].map(({ server }) => server.close()));
  await eventually(async () => (await app.client.listTools()).tools.length === 0);
});

test('separate gateway processes keep tenant contexts isolated', { timeout: 10_000 }, async (t) => {
  const backend = await fixture();
  t.after(() => backend.close());
  const services = [{ name: 'svc', url: `${backend.url}/sse`, timeout: 1500 }];
  const a = await gateway(services, 'tenant-a');
  t.after(() => a.close());
  const b = await gateway(services, 'tenant-b');
  t.after(() => b.close());
  const results = await Promise.all([a, b].map((app) => app.client.callTool({ name: 'svc__echo', arguments: {} })));
  assert.equal(results[0]?.structuredContent?.tenant, 'tenant-a');
  assert.equal(results[1]?.structuredContent?.tenant, 'tenant-b');
});

for (const signal of ['SIGINT', 'SIGTERM', 'EOF'] as const) {
  test(`graceful shutdown on ${signal} closes SSE sessions`, {
    timeout: 10_000,
    // Windows child.kill() force-terminates rather than delivering POSIX signals.
    // EOF cleanup is still exercised on every platform.
    skip: process.platform === 'win32' && signal !== 'EOF',
  }, async (t) => {
    const backend = await fixture();
    t.after(() => backend.close());
    const dir = await mkdtemp(join(tmpdir(), 'mcp-shutdown-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ services: [{ name: 'svc', url: `${backend.url}/sse` }] }));
    const child = spawn(process.execPath, [resolve('dist/index.js')], {
      env: { ...process.env, TENANT_ID: 'tenant-a', SERVICE_AUTH_TOKEN: token, MCP_CONFIG_PATH: configPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    await eventually(() => stderr.includes('Gateway ready'));
    assert.equal(backend.sessions.size, 1);
    const exit = once(child, 'exit');
    if (signal === 'EOF') child.stdin.end();
    else child.kill(signal);
    const [code, exitSignal] = await exit;
    assert.equal(code, 0, stderr);
    assert.equal(exitSignal, null);
    assert.equal(stdout, '', 'stdout is reserved exclusively for MCP frames');
    assert(!stderr.includes(token));
    await eventually(() => backend.sessions.size === 0);
  });
}

test('all-downstream outage still serves a valid empty tool list', { timeout: 10_000 }, async (t) => {
  const backend = await fixture();
  t.after(() => backend.close());
  const app = await gateway([{ name: 'down', url: `${backend.url}/offline`, timeout: 300 }]);
  t.after(() => app.close());
  assert.deepEqual((await app.client.listTools()).tools, []);
});
