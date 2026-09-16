# Smoke tests and verification

[← Back to the README](../README.md)

These checks use local mock services and the official MCP SDK client. They verify the gateway independently of any particular agent or IDE. No real service token, configured backend, or external AI account is required.

Requires Bun 1.3.14+ and Node.js 22.14+. Gateway CI covers Windows, Linux, and macOS with Node 22/24. Dashboard tests additionally require macOS/Linux for Unix sockets; browser tests use Chromium. See [platform setup](platforms.md) for installation and host launch examples.

## 1. Gateway: default, dashboard-free path

From the repository root:

```sh
bun install --frozen-lockfile
bun run check
```

This builds TypeScript and runs the suite, including real stdio/SSE protocol smoke coverage:

- Spawn the gateway and complete MCP initialization.
- Discover namespaced tools across multiple services and pagination pages.
- Invoke tools through the correct backend and preserve results.
- Force auth/tenant headers and reject nested tenant overrides.
- Keep healthy services available during partial outages.
- Return a valid empty list during a total outage.
- Handle timeouts, tool-list changes, and stdin EOF on every platform. POSIX signal cleanup tests run on Linux/macOS and are skipped on Windows, where `child.kill()` force-terminates the process.

**Expected:** exit code `0`, all tests pass. The gateway suite does not require installing or building `dashboard/`.

## 2. Optional dashboard: backend and integration checks

Only run these if you want to verify the optional dashboard. From the repository root:

```sh
cd dashboard
bun install --frozen-lockfile
bun run test
```

This script also builds the root gateway. Checks include:

- Dashboard disabled with the flag omitted or set to `false`: no telemetry directory/socket is created.
- Dashboard enabled: a real gateway exposes live, read-only connection/request metadata.
- Multiple opted-in gateway processes are discovered separately.
- Gateway credentials, tenant IDs, URLs, arguments, and results stay out of snapshots.
- Local socket permissions, bounded history, malformed peers, and cleanup work.
- Dashboard API access requires its own launch token and valid Host/Origin headers.
- Stopping the dashboard leaves gateway telemetry running.

**Expected:** exit code `0`, all tests pass. The tests supply temporary environments; do not enable telemetry on your real gateways just to run them.

## 3. Optional dashboard: browser smoke checks

Still inside `dashboard/`:

```sh
# First run only, or after updating Playwright
bunx playwright install chromium
bun run test:browser
```

On Linux CI, use `bunx playwright install --with-deps chromium` if system browser dependencies are missing.

Checks cover the authenticated launch link, token removal from the address bar, honest empty states, connection/session display, filters, JSONL download, mobile layout, session disappearance, and stale-data warnings.

**Expected:** exit code `0`, all browser tests pass. Screenshots and failure diagnostics are generated under `dashboard/test-results/`, which is ignored by Git. Browser-test data is synthetic and isolated; it is not part of the running dashboard.

## 4. Dependency checks

From the repository root:

```sh
bun audit --production
```

For the optional dashboard, run the same command inside `dashboard/` after installing its dependencies. Audit results are time-sensitive; rerun them when updating dependencies or preparing a deployment.

## What these checks do not prove

- **Named host integrations:** Hermes, OpenClaw, pi, Claude, Cursor, or another host must have a compatible MCP stdio integration. Test the installed host/adapter version separately; configuration formats differ.
- **Real backend authorization:** mock-server tests do not prove that your production token is scoped correctly or your database enforces tenant filtering.
- **Unimplemented features:** neither upstream nor downstream Streamable HTTP, operator reconnect/disconnect controls, nor HTTP MCP access through the dashboard are currently available.
- **Performance gains:** correctness tests are not throughput, latency, or capacity benchmarks.

For a real-client acceptance check, launch the gateway through that client's MCP integration, list its tools, and invoke a known read-only tool on a safe test backend. Verify the backend's tenant authorization before enabling mutating tools.
