# Plan: a lightweight, controllable MCP gateway

**Status:** core dual-transport/lifecycle/control work remains planned. A separately requested [optional, read-only dashboard](../../dashboard/README.md) now implements basic live inspection, bounded event history, and private local telemetry. It is disabled by default and does not yet provide the mutating controls or dual transports below.

## Goal

Support modern Streamable HTTP and existing SSE backends, then add practical connection/session controls and useful logs—without Redis, a database, a required web dashboard, or a remote management API.

Keep the current strengths: Bun tooling, the official MCP SDK, client-agnostic stdio compatibility, immutable tenant context, namespaced tools, bounded deadlines, and partial-failure handling.

### Client-neutral scope

The gateway targets MCP-capable agents, IDEs, and applications—not only Claude Desktop or Cursor. Hermes, OpenClaw, pi, and custom hosts can use it when their installed MCP integration or adapter supports stdio. Do not introduce vendor-specific routing or assume a shared host configuration format. Verify named integrations individually before claiming tested compatibility.

The current stdio mode gives each host its own gateway process. A future **optional upstream Streamable HTTP server mode** will address HTTP-only clients and shared network access. This is distinct from the downstream transport work below and from the dashboard's read-only HTTP bridge. Before implementing it, specify upstream authentication/authorization, isolated MCP session lifecycles, tenant binding, cancellation, and admission limits. It must not become an unauthenticated public listener or let client arguments select a tenant.

## 1. Architecture and boundaries

```text
Any MCP-capable agent / IDE / application
         │ MCP stdio
         ▼
Gateway process — one tenant-bound gateway session
         ├── In-memory connection + request registry
         ├── Structured events → stderr / optional local JSONL
         ├── Streamable HTTP client → service A
         ├── SSE client             → service B
         └── Optional local control socket
                       ▲
                 Operator CLI
```

### What "session" means

- **Gateway session:** one running stdio gateway process, with a randomly generated ID and a fixed tenant. Created at startup; destroyed at shutdown.
- **Service connection:** one downstream MCP client/transport owned by that gateway session. It can be disconnected and recreated without restarting the gateway.
- **Backend protocol session:** an optional session identifier managed by the Streamable HTTP SDK. It is not the gateway session ID, is not an access credential, and is not exposed in logs/control responses.
- **Request:** one active tool call, tracked with a gateway-generated request ID and cancellation controller.

Nothing resumes automatically after a process restart. Configuration persists; sockets, active calls, and in-memory history do not. No tool call is replayed automatically.

Invoking tools continues through the existing MCP interface and reuses available connections. V1 will not add a second tool-invocation path through the control CLI.

## 2. Dual downstream transports

Add a transport discriminator per service:

```json
{
  "services": [
    {
      "name": "billing",
      "transport": "streamable-http",
      "url": "https://billing.internal.example/mcp",
      "timeout": 10000
    },
    {
      "name": "crm",
      "transport": "sse",
      "url": "https://crm.internal.example/sse",
      "timeout": 10000
    }
  ]
}
```

### Decisions

- Use the official `StreamableHTTPClientTransport` and `SSEClientTransport`.
- Make `streamable-http` the default for omitted `transport` in the new version.
- **Migration is explicit:** existing SSE configurations must add `"transport": "sse"`. Update the repository's example configuration, legacy fixtures, and migration documentation in the same change. Call out this breaking default before release.
- Do not guess the transport from URL paths or automatically try a second protocol. Servers can use arbitrary paths, and authentication/timeouts are not evidence of a protocol mismatch.
- Do not fall back or reconnect/replay in response to a failed tool call.
- Share the existing authenticated fetch guard across both transports: fixed bearer/tenant headers, same-origin requests, redirects blocked, proper abort signals.
- Cover HTTP POSTs, streaming GETs, and session DELETE requests—not just initial connection requests. Keep SDK-managed protocol/session headers intact.
- On deliberate close, attempt bounded best-effort Streamable HTTP session termination when applicable, then close/abort the transport regardless of termination outcome. Sessionless servers and unsupported DELETE must not block cleanup.

**Acceptance:** a single gateway can aggregate and invoke tools from one backend of each transport, without changing the upstream stdio interface or tenant guardrails.

## 3. In-memory lifecycle and request tracking

Refactor the current one-shot connection construction into a reusable connection factory plus lifecycle manager.

### Connection states

`disconnected → connecting → ready`

Failures move to `unavailable`; intentional closure moves through `closing` to `disconnected`.

Keep an explicit desired state so an operator-disconnected service stays disconnected. V1 has manual reconnection, not an automatic retry scheduler.

### State and concurrency rules

- Track service, transport, state, connection generation, connected time, last activity, tool count, and active request count.
- Create a new client, transport, and lifetime AbortController on each connection generation; never reuse an aborted controller or closed client.
- Serialize conflicting connect/reconnect operations for each service. Disconnect and shutdown must promptly abort a connection attempt rather than wait for its full timeout.
- Ignore notifications, discovery results, and close callbacks from obsolete generations. A stale connection must not remove a replacement connection's tools.
- Remove unavailable/disconnected tools immediately and publish `tools/list_changed`; publish rediscovered tools only after a replacement is ready.
- Track active calls with an internal request ID, service, start time, and AbortController. Clear tracking in `finally` on every completion path.
- Combine operator cancellation, upstream cancellation, service shutdown, and configured deadlines.
- Bound admission: proposed defaults of 32 active calls per service and 128 per gateway. Reject excess work with a safe busy error; do not create an unbounded queue or disable the healthy service.
- Keep request failures separate from connection failures. An ordinary tool error must not tear down a healthy transport.

### Control semantics

| Action | Meaning |
| --- | --- |
| Status | Snapshot the gateway session and service states |
| Reconnect service | Abort existing activity, close the old connection, establish a fresh connection, and rediscover tools |
| Disconnect service | Reject new calls to it, cancel active calls, remove its tools, and close it |
| List active requests | Return IDs, service names, and elapsed times—not tool arguments |
| Cancel request | Signal cancellation; acknowledge the signal, not a backend rollback |
| Stop gateway | Acknowledge the command, then use the existing bounded graceful-shutdown path |

A cancellation, disconnect, or timeout cannot guarantee that a backend mutation did not execute. Keep that warning visible in CLI help and docs.

**Acceptance:** reconnect/disconnect/cancel work during startup, discovery, and tool execution; repeated commands and shutdown races cannot resurrect stale connections or leak streams.

## 4. Optional local control interface

Control is **disabled unless explicitly enabled** in configuration. It does not add MCP management tools, a TCP listener, or an HTTP API.

### Transport and security

- V1 targets macOS/Linux Unix domain sockets using Node's built-in `node:net`.
- Use a short per-user runtime path outside the repository/cloud-synced project directory, with a private `0700` directory and a `0600` socket.
- Discover instances by inspecting that private directory and requesting a live handshake; do not persist session credentials or trust a PID alone.
- Identify each instance by a random gateway session ID. Never select an instance merely because it has a matching tenant name.
- Require explicit `--session` selection if multiple instances are running. Never broadcast a mutating command.
- Check directory ownership/modes, reject symlink/path surprises, and safely handle stale sockets. Do not remove an endpoint owned by another live process.
- Version and validate the control protocol with Zod. Use bounded newline-delimited JSON frames, bounded clients/queues, and request timeouts. Only expose a fixed allowlist of commands.
- Treat connection URLs, credentials, backend session IDs, arguments, and results as private; do not serialize internal objects into status responses.
- On Windows, normal MCP operation remains supported. Enabling local controls fails clearly until a named-pipe implementation with equivalent access control is tested—never silently fall back to TCP.

**Security boundary:** this is a same-OS-user operator interface, not protection against arbitrary code running as that user. An AI client with shell access under the same account can potentially reach it. Users needing stronger separation must use separate OS identities or containers.

### CLI experience

Add a compiled `synapse` CLI entry point; keep the existing `dist/index.js` stdio entry point unchanged. Provide a `bun run ctl` script so local development requires no global installation.

```sh
bun run ctl sessions
bun run ctl status --session <id>
bun run ctl reconnect billing --session <id>
bun run ctl disconnect crm --session <id>
bun run ctl requests --session <id>
bun run ctl cancel <request-id> --session <id>
bun run ctl logs --follow --session <id>
bun run ctl logs --export ./gateway-events.jsonl --session <id>
bun run ctl stop --session <id>
```

Human-readable output by default; `--json` for status/list commands and scripts. CLI stdout belongs to its own process and never mixes with gateway MCP stdout.

**Acceptance:** two simultaneous gateways remain independently addressable; controls are inaccessible to other OS users under normal filesystem permissions; slow or malformed control clients cannot stall MCP operations.

## 5. Structured events and optional log files

Replace ad-hoc logging with a small typed event component, not a logging framework dependency.

### Event shape

Allowlisted fields only: timestamp, sequence, level, event name, gateway session ID, service, transport, internal request ID, duration, outcome, and safe error code when applicable.

Never log credentials, headers, tenant IDs by default, backend session IDs, full URLs, tool arguments/results, or raw SDK exceptions. Prefer fixed event names/messages over arbitrary strings. Do not log downstream descriptions as diagnostics.

### Sinks and limits

- **stderr:** keep structured logs and stdout isolation.
- **Recent events:** an in-memory ring buffer; proposed default 1000 events, with per-event size limits.
- **Follow:** stream events to the local CLI; cap subscriber queues, signal dropped-event gaps, and disconnect persistently slow consumers.
- **Export:** write a snapshot of the bounded recent-event buffer to a new operator-selected JSONL file. This is not an unlimited historical archive. Perform file writing in the CLI, use restrictive permissions, and refuse accidental overwrite by default.
- **Optional file sink:** configured explicitly, outside the repository by default, with bounded writes and size-based rotation; proposed limit 10 MiB per file and three retained rotated files.
- File failures or backpressure must not stop tool execution. Emit safe, rate-limited warnings without recursive logging loops; close/flush within the shutdown deadline.

External HTTP log shipping and MCP logging notifications are out of scope for V1. JSONL can be consumed by an existing log collector; a new network exporter would introduce additional credentials, queues, retries, and failure modes.

**Acceptance:** memory/disk usage stays bounded, secrets do not appear in any sink/control output, export is valid JSONL, and slow readers or full/unwritable disks do not block tools.

## 6. Implementation sequence

| Phase | Deliverable | Main files |
| --- | --- | --- |
| 1 | Transport factory, explicit config, migration notes, mixed-transport tests | `src/config.ts`, new `src/transports.ts`, `src/downstream.ts` |
| 2 | Reusable connection lifecycle, generation guards, active request registry, control methods | `src/downstream.ts`, `src/gateway.ts`, `src/index.ts` |
| 3 | Typed events, bounded ring buffer, stderr/file sinks | new `src/events.ts`, configuration and lifecycle integration |
| 4 | Permission-restricted local control socket and CLI | new `src/control.ts`, `src/cli.ts`, `package.json` |
| 5 | Race/security/load tests, README diagrams, examples, reference and CLI documentation | `test/`, `README.md`, `docs/`, CI |

Reuse SDK, Zod, and Node built-ins. Target **no new runtime dependencies**. Bun remains the package manager/script tool; Node remains the tested stdio runtime.

Keep changes reviewable by phase. Do not commit unrelated generated `graphify-out/` artifacts.

## 7. Test and completion checklist

- [ ] Existing SSE behavior and all tenant rejection tests still pass.
- [ ] Mixed SSE + Streamable HTTP discovery and calls work.
- [ ] Sessionful and sessionless Streamable HTTP backends work.
- [ ] Authentication and tenant headers are forced on every downstream request type.
- [ ] Redirects and cross-origin credential forwarding remain blocked.
- [ ] Explicit SSE migration and Streamable HTTP default are tested/documented.
- [ ] One unavailable backend does not break other services or upstream initialization.
- [ ] Repeated/concurrent reconnects cannot produce duplicate live connections or stale tool lists.
- [ ] Disconnect/cancel/shutdown clean up in-flight requests; no calls are automatically replayed.
- [ ] Admission limits and bounded logging survive concurrent calls and slow consumers.
- [ ] Separate gateway instances cannot be accidentally targeted by ambiguous CLI commands.
- [ ] Socket permissions, unsafe paths, malformed frames, stale sockets, and disconnected clients are covered.
- [ ] Log redaction, export, rotation, file errors, dropped-event reporting, and stderr/stdout separation are covered.
- [ ] SIGINT, SIGTERM, EOF, and operator-stop cleanup finish within the shutdown budget.
- [ ] `bun run check` and production dependency audit pass; CI covers supported Node versions and POSIX control behavior.
- [ ] README and diagrams match the implementation, and configuration examples validate.

## Not in this iteration

Redis, SQLite, distributed workers, durable session recovery, shared multi-user sessions, automatic transport guessing, automatic tool retries, remote administration, dashboard-based mutation controls, CLI tool invocation, external log shipping, and automatic session expiry/reconnection policies.

Add these only when a concrete deployment needs them—not as prerequisites for a useful local gateway.
