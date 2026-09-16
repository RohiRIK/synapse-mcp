import { randomUUID } from 'node:crypto';
import { chmod, unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { MAX_EVENTS, MAX_SNAPSHOT_BYTES, logEventSchema, sessionSchema, type Inspection, type LogEvent } from '../shared/protocol.js';
import { runtimeDirectory } from './runtime.js';

export interface Source {
  inspect(): Inspection;
  subscribe(listener: (event: LogEvent) => void): () => void;
}

/** Loaded by the gateway ONLY when MCP_DASHBOARD_ENABLED=true. No HTTP listener here. */
export async function startAgent(source: Source, directory?: string) {
  const dir = await runtimeDirectory(directory);
  const id = randomUUID();
  const path = join(dir, `s-${id}.sock`);
  const startedAt = new Date().toISOString();
  const events: LogEvent[] = [];
  const sockets = new Set<Socket>();
  const unsubscribe = source.subscribe((event) => {
    // Unknown fields are rejected rather than accidentally shipping internal objects.
    const safe = logEventSchema.safeParse(event);
    if (!safe.success) return;
    events.push(safe.data);
    if (events.length > MAX_EVENTS) events.shift();
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(1000, () => socket.destroy());
    try {
      // Read-only protocol: connecting requests one snapshot, then the agent closes the stream.
      const snapshot = sessionSchema.parse({
        ...source.inspect(), version: 1, id, pid: process.pid, startedAt, events: [...events],
      });
      const data = JSON.stringify(snapshot);
      if (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES) { socket.destroy(); return; }
      socket.end(data);
    } catch {
      socket.destroy();
    }
  });
  server.maxConnections = 8;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
    await chmod(path, 0o600);
  } catch (error) {
    unsubscribe();
    server.close();
    await unlink(path).catch(() => {});
    throw error;
  }
  server.on('error', () => {});
  let closing: Promise<void> | undefined;
  return {
    id,
    path,
    close(): Promise<void> {
      closing ??= Promise.resolve().then(async () => {
        unsubscribe();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await unlink(path).catch(() => {});
      });
      return closing;
    },
  };
}
