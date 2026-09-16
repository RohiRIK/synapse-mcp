import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { DownstreamManager, log, subscribeLogs } from './downstream.js';
import { createGateway } from './gateway.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const downstream = new DownstreamManager(config);
  const server = createGateway(config, downstream);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  let stopping: Promise<void> | undefined;
  let dashboardAgent: { close(): Promise<void> } | undefined;

  function shutdown(exitCode = 0): Promise<void> {
    if (stopping) return stopping;
    process.exitCode = exitCode;
    stopping = Promise.resolve().then(async () => {
      log('info', 'Gateway shutting down');
      // Last resort if an SDK/network close ever hangs. Normal shutdown drains naturally.
      const watchdog = setTimeout(() => process.exit(exitCode || 1), 5_000);
      watchdog.unref();
      await Promise.allSettled([downstream.close(), server.close(), transport.close(), dashboardAgent?.close()]);
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
    if (config.dashboardEnabled) {
      try {
        // No static import: normal gateway installs never load dashboard code or dependencies.
        const moduleUrl = new URL('../dashboard/dist/server/agent.js', import.meta.url);
        const optionalModule = await import(moduleUrl.href) as {
          startAgent(source: { inspect: () => ReturnType<DownstreamManager['inspect']>; subscribe: typeof subscribeLogs }): Promise<{ close(): Promise<void> }>;
        };
        dashboardAgent = await optionalModule.startAgent({ inspect: () => downstream.inspect(), subscribe: subscribeLogs });
      } catch {
        log('error', 'Dashboard telemetry could not start; build dashboard/ and check its private runtime directory (macOS/Linux only)');
        await shutdown(1);
        return;
      }
      if (stopping) { await dashboardAgent.close(); return; }
      log('info', 'Optional read-only dashboard telemetry enabled');
    }
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
