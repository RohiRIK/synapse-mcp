import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** A private per-user directory, never the project folder or a publicly readable registry. */
export async function runtimeDirectory(override = process.env.SYNAPSE_DASHBOARD_RUNTIME_DIR): Promise<string> {
  if (process.platform === 'win32' || !process.getuid) {
    throw new Error('Optional dashboard telemetry currently requires macOS or Linux');
  }
  if (override !== undefined && !isAbsolute(override)) throw new Error('Dashboard runtime directory must be absolute');
  const path = resolve(override ?? join('/tmp', `synapse-dashboard-${process.getuid()}`));
  // The final directory must be private, user-owned, and not a symbolic link.
  // An override's parent directories must also be trusted by the operator.
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error('Dashboard runtime directory must be user-owned with mode 0700 and not a symlink');
  }
  // Reserve enough room for a UUID socket name on macOS's shorter sockaddr_un path.
  if (Buffer.byteLength(join(path, `s-${'0'.repeat(36)}.sock`)) > 103) {
    throw new Error('Dashboard runtime directory path is too long for a Unix socket');
  }
  return path;
}
