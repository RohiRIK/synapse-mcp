import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { DownstreamManager, log } from './downstream.js';
import { createGateway } from './gateway.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const downstream = new DownstreamManager(config);
  const server = createGateway(config, downstream);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  let stopping: Promise<void> | undefined;

  function shutdown(exitCode = 0): Promise<void> {
    if (stopping) return stopping;
    process.exitCode = exitCode;
    stopping = Promise.resolve().then(async () => {
      log('info', 'Gateway shutting down');
      // Last resort if an SDK/network close ever hangs. Normal shutdown drains naturally.
      const watchdog = setTimeout(() => process.exit(exitCode || 1), 5_000);
      watchdog.unref();
      await Promise.allSettled([downstream.close(), server.close(), transport.close()]);
      process.stdin.pause();
      clearTimeout(watchdog);
    });
    return stopping;
  }

  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  // The SDK stdio transport does not itself close when the parent closes stdin.
  process.stdin.once('end', () => { void shutdown(); });
  process.stdin.once('close', () => { void shutdown(); });
  process.stdin.once('error', () => { void shutdown(1); });
  process.stdout.once('error', () => { void shutdown(1); });
  server.onclose = () => { void shutdown(); };
  server.onerror = () => log('warn', 'Upstream protocol or transport error');

  try {
    // Accept initialize immediately; tools/list waits for bounded, parallel discovery.
    const starting = downstream.start();
    await server.connect(transport);
    await starting;
    if (!stopping) log('info', 'Gateway ready');
  } catch {
    log('error', 'Gateway startup failed');
    await shutdown(1);
  }
}

void main().catch((error: unknown) => {
  // Only configuration errors originate here; their messages are intentionally sanitized.
  log('error', error instanceof Error ? error.message : 'Gateway configuration failed');
  process.exitCode = 1;
});
