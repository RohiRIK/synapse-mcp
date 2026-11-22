# Technical reference

[← Back to the README](../README.md)

The README covers getting started. This page covers the constraints and operational details you need when adapting or deploying the template.

## Client connection contract

Synapse is client-agnostic: any agent, IDE, or application that implements MCP over stdio can launch it. Product names such as Claude, Cursor, Hermes, OpenClaw, and pi identify possible hosts, not gateway dependencies or a verified compatibility list. A host may require its own MCP extension or bridge.

Configure the host's stdio integration with:

| Setting | Value |
| --- | --- |
| Executable | Absolute path to `bun` |
| Arguments | `--no-env-file`, then the absolute path to this repository's `src/index.ts` |
| Environment | `SERVICE_AUTH_TOKEN`, `TENANT_ID`, and an absolute `MCP_CONFIG_PATH` |
| Optional telemetry | `MCP_DASHBOARD_ENABLED=true` only when the dashboard package is built and wanted |

The host owns the process's stdin/stdout; stdout contains MCP frames only. Each host launches its own process and fixes its tenant through the environment. There is no vendor-specific routing, no shared upstream HTTP endpoint, and no session recovery after that process exits.

Both client-facing and downstream Streamable HTTP support remain planned. The optional dashboard HTTP server cannot be used as an MCP endpoint. The JSON examples below use the `mcpServers` format accepted by some hosts; translate the launch settings into your host's own configuration format where necessary.

## Configuration

| Environment variable | Required | Meaning |
| --- | --- | --- |
| `SERVICE_AUTH_TOKEN` | When any SSE service is configured | Nonempty, header-safe bearer token; no `Bearer ` prefix. Never passed to stdio services. |
| `TENANT_ID` | Yes | Immutable identity, 1–128 letters/digits/dots/underscores/hyphens; starts with a letter or digit |
| `MCP_CONFIG_PATH` | No | JSON configuration path; defaults to `config.json` relative to the working directory |
| `MCP_DASHBOARD_ENABLED` | No | Strict `true` or `false`; defaults to `false`. Enables the optional local read-only telemetry agent, not an HTTP listener. Requires `dashboard/` to be built. |

Use an absolute configuration path in MCP hosts. The environment and config file are trusted administrative inputs, not model-controlled settings.

### Service configuration rules

- `services` contains **1–64** uniquely named services. Unknown configuration keys fail validation.
- An SSE service has `name`, `url`, and an optional `timeout`. `transport: "sse"` is the default and may be omitted.
- A stdio service has `name`, `transport: "stdio"`, `command`, and optional `args`, `env`, `cwd` and `timeout`. The gateway starts it as a child process and speaks MCP over its stdin and stdout.
- Names are at most **32 characters**: lowercase letters/digits with single internal `_` or `-` separators, starting with a letter. `__` and trailing separators are forbidden so routing stays unambiguous.
- `timeout` is milliseconds, defaults to **10000**, and must be **100–300000**. It bounds the entire startup plus initial discovery, each subsequent full discovery, and each tool call. Progress does not extend deadlines.
- URLs must use **HTTPS**, except HTTP on `localhost`, `127.0.0.1`, or `[::1]` for local development. URL credentials and fragments are forbidden. Configure the final SSE URL: redirects are not followed.
- A stdio child starts with a minimal environment: the MCP SDK's safe set (`PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LOGNAME` and their Windows equivalents), the service's `env`, then `SYNAPSE_TENANT_ID` and `SYNAPSE_SERVICE_NAME`, which `env` cannot set. It does not inherit the gateway's other variables, and never `SERVICE_AUTH_TOKEN`. Its stderr goes to the gateway's stderr; its stdout carries only MCP frames. It stops when the gateway shuts down.
- `env` keys are shell-style names (`A-Z`, `a-z`, digits, `_`), at most 64 of them. Put no secrets in `config.json`; a child that needs a credential should load it itself.
- The same process-scoped token and tenant are sent to every configured SSE service. Only list trusted endpoints authorized to receive those credentials.
- Zod validates configuration, which is frozen at startup. Restart to change endpoints, rotate credentials, or change tenants.

Use your system's trusted CA configuration for internal TLS. Do not disable certificate validation.

### Microsoft sign-in for Graph planes

A top-level `signIn` block gives the gateway one interactive Microsoft sign-in, which it lends to every stdio service marked `"signIn": true`:

```json
{
  "signIn": { "clientId": "wellknown", "sessionMaxAgeHours": 8 },
  "services": [
    { "name": "entra", "transport": "stdio", "command": "/abs/bun", "args": ["--no-env-file", "/abs/entra_id_mcp/src/index.ts"], "signIn": true, "timeout": 30000 }
  ]
}
```

- `TENANT_ID` must then be the directory's GUID. The session is bound to it: an account from any other directory is dropped as soon as the sign-in returns, and nothing is kept.
- `clientId` is an app registration's GUID, or `wellknown` for Microsoft Graph Command Line Tools. `writeClientId` (optional) is a second registration consented for writes. It signs in only when a write first asks for a token, and its session lasts at most 15 minutes. It must differ from `clientId`.
- `sessionMaxAgeHours` (0.25–24, default 8): after this, the next call signs in again.
- Everything is in memory. No token cache is written, and the sign-in ends when the gateway does, so an earlier session can never answer for this one.
- A signed-in child gets `MCP_GRAPH_TOKEN_BROKER=1` and `GATEWAY_EXPECTED_TENANT_ID=<TENANT_ID>`, which config `env` cannot set. It asks for tokens with the JSON-RPC request `x-mcp-graph/token` over its stdio pipe; the contract is `mcp_shared/src/token-broker.ts` in microsoft-graph-mcp-servers. Only Microsoft Graph delegated scopes are lent; `.default` and other audiences are refused. Services without `signIn` cannot borrow a token.
- The browser opens before the first call to a signed-in service starts its timeout, not during it. No browser opens until then.
- A sign-in is not an approval: confirm-gated tools still need the person's approval in the client.

### Environment files and dependencies

Bun loads a `.env` from the working directory by default. `bun run start` relies on that for local use. Host launches pass `--no-env-file` so that only the environment the host supplies is used.

`.env` and `config.local.json` are ignored by Git. Never commit real secrets, and restrict access to desktop host configuration files containing tokens. Commit `bun.lock` and install with `bun install --frozen-lockfile` for reproducible dependency resolution.

## Optional dashboard

The [dashboard package](../dashboard/README.md) is installed and built separately. Disabled gateways do not import it, collect dashboard event history, create telemetry sockets, or start dashboard HTTP servers. Opted-in gateways expose only allowlisted operational metadata through a private per-user Unix socket. A separately launched dashboard server serves the React UI on loopback with a temporary access token.

This interface is read-only and scoped to the same OS user. It does not provide protection from arbitrary programs already running under that user. Stop the dashboard independently; removing gateway telemetry requires disabling the environment flag and restarting the gateway.

## Tool behavior

### Discovery and naming

- `create_invoice` from `billing` becomes `billing__create_invoice`.
- Descriptions end with `[Tenant: tenant-acme] [Service: billing]`, using the configured identity and service name.
- Names split at the first `__`; downstream names containing `__` still work.
- Discovery consumes all downstream pages, bounded to **100 pages / 10000 tools per service**. Duplicate tool names and repeating cursors fail discovery for that service.
- Changes announced through `notifications/tools/list_changed` trigger fresh discovery and an upstream tool-list notification.
- The gateway returns one complete upstream tool list, with no cursor. Supplying a cursor returns `InvalidParams`.

### Schemas and execution

- Reserved tenant properties and their `required` entries are removed from published input schemas, including nested definitions and composition branches. Runtime rejection remains authoritative, including for `additionalProperties` and complex schemas.
- Tool annotations, output schemas, structured content, and normal `isError` tool results are preserved.
- Tools are omitted with a warning if their names cannot form a valid namespaced name of at most **128 characters**, their input schemas exceed **64 nesting levels**, or they require task execution.
- Calls forward the original arguments unchanged, with only the name un-namespaced. Identity is never synthesized into tool arguments.
- Session-local client `_meta` and progress tokens are not forwarded. Task-augmented calls are rejected. Upstream cancellation is propagated to downstream requests.

### Approval in the client for confirm-gated tools

A tool is confirm-gated when its input schema has a boolean `confirm` property. Called without `confirm: true`, such a tool answers with a preview whose `structuredContent.type` is `confirmation_required` and changes nothing. The model is the one that sends `confirm: true`, so Synapse does not take that as approval:

1. Synapse calls the tool with `confirm: false` and gets the preview.
2. It shows the preview to the person through MCP elicitation, as a dialog with one "I approve this change" checkbox. Instructions the downstream wrote for the model are left out.
3. Only if the person ticks it and accepts does Synapse send the call with `confirm: true`.

It fails closed. A client that does not declare elicitation, an error while asking, a decline, a cancel, an unticked accept, or no answer within 10 minutes all mean nothing runs. The model then gets an error result saying so. A tool whose first answer is not a confirmation preview has no confirmation step: that answer is returned and the tool is not called again. Calls with `confirm: false`, and tools without a boolean `confirm`, are forwarded unchanged.

### Scope

This is a **tools-only** gateway. It does not proxy resources, prompts, sampling, elicitation, subscriptions, or experimental tasks. It exposes no network listener upstream.

Downstreams are SSE servers or local stdio servers. The template deliberately uses `SSEClientTransport` for existing SSE servers. The SDK recommends Streamable HTTP for new deployments, but a Streamable HTTP `/mcp` endpoint cannot be substituted for an SSE `/sse` endpoint without changing the transport implementation.

## Tenant security contract

### 1. Identity is transport-only

Every SSE GET—including reconnect attempts—and HTTP message POST receives forced `Authorization` and `X-Tenant-ID` headers. The modern EventSource API uses `eventSourceInit.fetch`, not a nonstandard `headers` option. `requestInit.headers` and the POST fetch hook enforce the same identity.

### 2. Arguments cannot override identity

Calls containing `tenant_id` anywhere in their parameters, including nested objects, arrays, or `_meta`, fail with `InvalidParams` before reaching a downstream. Case variants, `tenantId`, and `tenant-id` are also reserved, even when their value matches the configured tenant. The gateway never inserts tenant identity into arguments.

### 3. Credentials cannot follow redirects

All redirects and cross-origin message endpoints are blocked. Configure the final SSE URL directly.

### 4. Downstreams must authorize the tenant

Each service must validate the bearer token, check that it grants access to `X-Tenant-ID`, derive data access from that header, and enforce tenant filtering at the application/database layer. An arbitrary tenant header on a publicly reachable backend is not proof of authorization.

### 5. Schema filtering is not a backend migration

Legacy tools that require an argument-based tenant must be adapted to transport-derived tenancy. The gateway will not fill in their old tenant argument. Complex schemas may still reject a call; tenant guardrails are never relaxed to make it succeed.

### 6. Descriptions are attention cues, not security boundaries

Prompt injection, encoded strings, arbitrary business arguments, and tool result text cannot be semantically sanitized into a tenant authorization guarantee. Backend authorization is mandatory. Treat downstream descriptions and results as untrusted model content.

This template is not a shared multi-user authorization broker. A host that can launch both tenants' gateways can select either one. Isolate host profiles, OS accounts, and credentials where access must be restricted.

## Two-tenant client configuration

Run one process per tenant, with separate environment and appropriately scoped credentials. The endpoint configuration can be shared if it contains no secrets. This example uses a Claude Desktop/Cursor-style `mcpServers` map; other clients or adapters may require a different configuration format.

```json
{
  "mcpServers": {
    "acme-gateway": {
      "command": "/absolute/path/to/bun",
      "args": ["--no-env-file", "/absolute/path/to/synapse-mcp/src/index.ts"],
      "env": {
        "SERVICE_AUTH_TOKEN": "replace-with-acme-token",
        "TENANT_ID": "tenant-acme",
        "MCP_CONFIG_PATH": "/absolute/path/to/synapse-mcp/config.json"
      }
    },
    "globex-gateway": {
      "command": "/absolute/path/to/bun",
      "args": ["--no-env-file", "/absolute/path/to/synapse-mcp/src/index.ts"],
      "env": {
        "SERVICE_AUTH_TOKEN": "replace-with-globex-token",
        "TENANT_ID": "tenant-globex",
        "MCP_CONFIG_PATH": "/absolute/path/to/synapse-mcp/config.json"
      }
    }
  }
}
```

**Both entries give that MCP host access to both tenants.** For users who must see only one tenant, configure only their gateway. Separate downstream sessions prevent transport-context mixing; they do not prevent a host with both credentials from deliberately selecting either gateway.

## Resilience and operations

### Service failures

A service that cannot connect, initialize, or list tools before its deadline is quarantined. Other services continue normally. If all fail, initialization still succeeds and `tools/list` returns `[]`.

Broken streams or discovery failures remove a service's tools and close its transport. **There is no automatic session recovery:** restart the gateway after restoring the service. A transport reconnect alone would not safely establish a fresh MCP session.

### Errors and retries

| Situation | Protocol behavior |
| --- | --- |
| Unknown or unavailable namespaced tool | `MethodNotFound` |
| Forbidden tenant arguments or downstream argument rejection | `InvalidParams` |
| Other downstream failures, timeouts, or cancellation during a call | `InternalError` when a response is still applicable |
| Downstream business failure returned as a tool result | The normal `isError` result is preserved |

Downstream protocol error messages and data are replaced with safe messages. Successful tool result bodies—including business `isError` results—are intentionally not rewritten.

Tool calls are **never automatically retried**. A timeout or cancellation does not prove that a backend operation did not execute. Use backend idempotency keys for mutations.

### Shutdown and logging

`SIGINT`, `SIGTERM`, stdin EOF/close, and upstream transport closure trigger idempotent cleanup of downstream clients/SSE streams and stdio. A five-second watchdog bounds shutdown.

Structured logs go only to **stderr**. The gateway does not log tokens, URLs, arguments, results, or raw downstream exceptions. Do not add `console.log` to server code; stdout belongs to MCP frames.

### Deployment checklist

- Use tenant-scoped, least-privilege tokens and protect files containing credentials.
- Enforce backend authorization and tenant-scoped data access.
- Set backend response, rate, and concurrency limits; monitor warning logs.
- Preserve the upstream **1 MiB frame limit**, or review the implications before changing it.
- Run tests and dependency audits in CI.
- Plan restarts for credential rotation, configuration changes, and service recovery.

This template does not implement distributed rate limiting or an administrative health endpoint.

## Testing

```sh
bun run test
bun audit --production
```

The test script runs `bun test` with local mock SSE servers and real subprocess stdio clients that launch the gateway under Bun. It covers header injection, redirect rejection, tenant isolation and override rejection, pagination, partial and total outages, stalled connection deadlines, tool errors and timeouts, live discovery updates, and signal/EOF cleanup.

No external services or credentials are required. Use `bun run test`, not Bun's separate `bun test` runner. These are protocol-level tests, not a claim that every named AI host has been tested. For gateway and optional dashboard smoke-test commands, see [testing and verification](testing.md).
