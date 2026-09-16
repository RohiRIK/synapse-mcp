import { lstat, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { MAX_SESSIONS, MAX_SNAPSHOT_BYTES, sessionSchema, type DashboardSnapshot, type Session } from '../shared/protocol.js';
import { runtimeDirectory } from './runtime.js';

export async function readSession(path: string): Promise<Session> {
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('Unsafe dashboard socket');
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const chunks: Buffer[] = [];
    let bytes = 0;
    // A wall-clock deadline also stops peers that trickle bytes forever.
    const timer = setTimeout(() => socket.destroy(new Error('Dashboard snapshot deadline exceeded')), 1200);
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_SNAPSHOT_BYTES) { socket.destroy(new Error('Dashboard snapshot too large')); return; }
      chunks.push(chunk);
    });
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      reject(new Error('Dashboard socket closed before a complete snapshot'));
    });
    socket.on('end', () => {
      try { resolve(sessionSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch { reject(new Error('Invalid dashboard snapshot')); }
      socket.destroy();
    });
  });
}

export async function discover(directory?: string): Promise<DashboardSnapshot> {
  const dir = await runtimeDirectory(directory);
  const candidates = (await readdir(dir)).filter((name) => /^s-[0-9a-f-]{36}\.sock$/.test(name)).sort();
  const sessions: Session[] = [];
  let unavailable = 0;
  const selected = candidates.slice(0, MAX_SESSIONS);
  // Bounded concurrency; stale or hung sockets never prevent healthy instances from appearing.
  for (let start = 0; start < selected.length; start += 8) {
    await Promise.all(selected.slice(start, start + 8).map(async (name) => {
      try {
        const session = await readSession(join(dir, name));
        if (`s-${session.id}.sock` !== name) throw new Error('Session identity mismatch');
        sessions.push(session);
      } catch { unavailable++; }
    }));
  }
  return {
    capturedAt: new Date().toISOString(),
    sessions: sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    unavailable,
    truncated: candidates.length > MAX_SESSIONS,
  };
}
