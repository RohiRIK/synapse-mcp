import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardSnapshot } from '../shared/protocol.js';
import { discover } from './discovery.js';
import { runtimeDirectory } from './runtime.js';

function authorized(request: IncomingMessage, token: string): boolean {
  const value = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

export async function startDashboard(options: { port?: number; directory?: string; clientDir?: string } = {}) {
  const directory = await runtimeDirectory(options.directory);
  const clientDir = options.clientDir ?? fileURLToPath(new URL('../client/', import.meta.url));
  const index = await readFile(join(clientDir, 'index.html')); // Fail clearly before listening if not built.
  const token = randomBytes(32).toString('base64url');
  let origin = '';
  let cached: DashboardSnapshot | undefined;
  let cachedAt = 0;
  let pending: Promise<DashboardSnapshot> | undefined;
  function snapshot(): Promise<DashboardSnapshot> {
    if (cached && Date.now() - cachedAt < 1000) return Promise.resolve(cached);
    pending ??= discover(directory).then((value) => {
      cached = value;
      cachedAt = Date.now();
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    void (async () => {
      // Host checking closes DNS-rebinding paths; no CORS exceptions or wildcard origins.
      if (request.headers.host !== new URL(origin).host
        || (request.headers.origin !== undefined && request.headers.origin !== origin)
        || request.headers['sec-fetch-site'] === 'cross-site') {
        response.writeHead(403).end('Forbidden'); return;
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET'); response.writeHead(405).end('Read-only dashboard'); return;
      }
      const pathname = new URL(request.url ?? '/', origin).pathname;
      if (pathname === '/api/sessions') {
        if (!authorized(request, token)) { response.writeHead(401).end('Open the authenticated startup link'); return; }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(await snapshot()));
        return;
      }
      if (pathname.startsWith('/api/')) { response.writeHead(404).end(); return; }
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(index); return;
      }
      // Serve only Vite assets; never arbitrary paths, environment files, or source files.
      if (/^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(pathname)) {
        const content = await readFile(join(clientDir, pathname.slice(1)));
        response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        response.end(content); return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(503);
      response.end('Dashboard data unavailable');
    });
  });
  server.maxConnections = 32;
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.setTimeout(10_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot determine dashboard address');
  origin = `http://127.0.0.1:${address.port}`;
  server.on('error', () => {});
  let closing: Promise<void> | undefined;
  return {
    origin,
    // A URL fragment never reaches HTTP request logs or the referrer. The UI removes it immediately.
    url: `${origin}/#token=${token}`,
    close(): Promise<void> {
      closing ??= new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
