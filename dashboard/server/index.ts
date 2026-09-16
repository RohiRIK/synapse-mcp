import { startDashboard } from './http.js';

let stopping = false;
let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
async function stop() {
  stopping = true;
  await dashboard?.close();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

try {
  dashboard = await startDashboard();
  if (stopping) await dashboard.close();
  else {
    // This is a separate operator process, never the MCP stdio process.
    process.stdout.write(`\nSynapse dashboard · local, read-only\n\nOpen this private link in your browser:\n${dashboard.url}\n\nCtrl+C stops the dashboard, not your gateways.\n`);
  }
} catch {
  process.stderr.write('Dashboard could not start. Build it first and check the private runtime directory; see dashboard/README.md.\n');
  process.exitCode = 1;
}
