# Tenant-isolated MCP Gateway

A TypeScript virtual MCP server using the official `@modelcontextprotocol/sdk`:

```text
Claude Desktop / Cursor
        │ stdio (MCP JSON-RPC only)
        ▼
One gateway process per tenant
        ├── SSE GET + HTTP POST → billing
        └── SSE GET + HTTP POST → crm
             Authorization: Bearer <SERVICE_AUTH_TOKEN>
             X-Tenant-ID: <TENANT_ID>
```

Downstreams connect in parallel. Healthy services remain usable if another service fails. This is a **tools-only** gateway: it does not proxy resources, prompts, sampling, elicitation, subscriptions, or experimental tasks.

> The SDK now recommends Streamable HTTP for new deployments. This template deliberately uses `SSEClientTransport` to support the HTTP/SSE downstream servers requested here. A Streamable HTTP `/mcp` endpoint is not interchangeable with an SSE `/sse` endpoint.

## Quick start

Requires **Bun 1.3.14+** for package management/scripts and **Node.js 22.14+** for the tested MCP runtime. Bun is the default development toolchain; Node keeps the official SDK's stdio lifecycle consistent across desktop hosts.

```sh
bun install --frozen-lockfile
cp .env.example .env
# Edit .env with real credentials and config.json with your SSE endpoints.
bun run build
node --env-file=.env dist/index.js
```

The process waits for an MCP client on stdin; it is not a human-facing CLI. An empty tool list is expected if neither example downstream is running.

Alternatively, export the environment before using the scripts:

```sh
export SERVICE_AUTH_TOKEN='your-service-token'
export TENANT_ID='tenant-acme'
export MCP_CONFIG_PATH='/absolute/path/to/config.json'
bun run start        # compiled server (Node runtime)
bun run dev          # TypeScript via tsx
bun run test         # builds, then runs unit and real stdio/SSE integration tests
```

The gateway itself does not load `.env`. Bun scripts inherit Bun's automatic `.env` loading; direct Node launches need `--env-file` or environment variables injected by the MCP host. Never commit secrets; `.env` and `config.local.json` are ignored. Commit `bun.lock` and deploy with `bun install --frozen-lockfile` for reproducible dependency resolution.

Use **`bun run test`**, not `bun test`: the script deliberately runs Node's test runner, exercising the same runtime as desktop clients.

## Configuration

| Environment variable | Required | Meaning |
| --- | --- | --- |
| `SERVICE_AUTH_TOKEN` | Yes | Nonempty, header-safe bearer token; no `Bearer ` prefix |
| `TENANT_ID` | Yes | Immutable tenant identity, 1–128 letters/digits/dots/underscores/hyphens; starts with a letter or digit |
| `MCP_CONFIG_PATH` | No | JSON configuration path, default `config.json` relative to the working directory |

Use an **absolute configuration path** in desktop clients, whose working directory may differ from your shell.

```json
{
  "services": [
    {
      "name": "billing",
      "url": "https://billing.internal.example/sse",
      "timeout": 10000
    },
    {
      "name": "crm",
      "url": "https://crm.internal.example/sse",
      "timeout": 15000
    }
  ]
}
```

- `services` contains 1–64 uniquely named services. Unknown configuration keys fail validation.
- Names are at most 32 characters: lowercase letters/digits with single internal `_` or `-` separators, starting with a letter. `__` and trailing separators are forbidden to make routing unambiguous.
- `timeout` is milliseconds, defaults to `10000`, and must be 100–300000. It bounds the **entire startup + initial discovery**, each subsequent full discovery, and each tool call. Progress does not extend deadlines.
- URLs must use HTTPS, except HTTP on `localhost`, `127.0.0.1`, or `[::1]` for local development. URL credentials and fragments are forbidden. Use your system's trusted CA configuration for internal TLS; do not disable certificate validation.
- The same process-scoped token and tenant are sent to every configured service. Configure only trusted endpoints authorized to receive those credentials.
- Configuration is validated by Zod and frozen at startup. Restart to change endpoints, rotate credentials, or change tenants.

## Claude Desktop / Cursor

After building, add this to `claude_desktop_config.json` (or Cursor's MCP configuration):

```json
{
  "mcpServers": {
    "acme-gateway": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/tenant-mcp-gateway/dist/index.js"],
      "env": {
        "SERVICE_AUTH_TOKEN": "replace-with-acme-service-token",
        "TENANT_ID": "tenant-acme",
        "MCP_CONFIG_PATH": "/absolute/path/to/tenant-mcp-gateway/config.json"
      }
    }
  }
}
```

Use an actual absolute Node executable path, especially with a version manager. Restart the host after changing configuration. Launch Node directly, **not a package-manager script**, from MCP hosts to keep wrappers and script banners out of the stdio protocol. Restrict access to host configuration files containing tokens.

## Multiple tenants

Tenant identity belongs to the **process**, never to a tool argument. Launch separate gateway processes with separate credentials/environment, optionally sharing a nonsecret endpoint configuration:

```json
{
  "mcpServers": {
    "acme-gateway": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/tenant-mcp-gateway/dist/index.js"],
      "env": {
        "SERVICE_AUTH_TOKEN": "replace-with-acme-token",
        "TENANT_ID": "tenant-acme",
        "MCP_CONFIG_PATH": "/absolute/path/to/tenant-mcp-gateway/config.json"
      }
    },
    "globex-gateway": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/tenant-mcp-gateway/dist/index.js"],
      "env": {
        "SERVICE_AUTH_TOKEN": "replace-with-globex-token",
        "TENANT_ID": "tenant-globex",
        "MCP_CONFIG_PATH": "/absolute/path/to/tenant-mcp-gateway/config.json"
      }
    }
  }
}
```

**Both entries give that MCP host access to both tenants.** For users who must see only one tenant, configure only their gateway and isolate host profiles/OS accounts and credentials. Separate downstream sessions prevent transport-context mixing; they do not prevent a host with both credentials from deliberately selecting either gateway.

## Tool behavior

- `create_invoice` from `billing` becomes `billing__create_invoice`.
- Descriptions end with `[Tenant: tenant-acme] [Service: billing]`.
- Names split at the first `__`; downstream names containing `__` still work.
- Discovery consumes all downstream pages (bounded to 100 pages / 10000 tools per service), rejects duplicate tool names/repeating cursors, and updates on `notifications/tools/list_changed`.
- The gateway returns one complete upstream tool list, with no cursor. Supplying a cursor is an `InvalidParams` error.
- Reserved tenant properties and their `required` entries are removed from published input schemas, including nested definitions/composition branches. Runtime enforcement remains authoritative, including for `additionalProperties` and complex schemas.
- Tool annotations, output schemas, structured content, and normal `isError` tool results are preserved. Downstream names that cannot form a valid namespaced name of at most 128 characters, schemas deeper than 64 levels, and task-only tools are omitted with a warning.
- Calls forward the original arguments unchanged, with only the name un-namespaced. Session-local client `_meta` and progress tokens are not forwarded. Task-augmented calls are rejected. Upstream cancellation is propagated to downstream requests.

## Tenant security contract

1. **Identity is transport-only.** Every SSE GET (including reconnect attempts) and HTTP message POST receives forced `Authorization` and `X-Tenant-ID` headers. The modern EventSource API uses `eventSourceInit.fetch`, not a nonstandard `headers` option. `requestInit.headers` and the POST fetch hook enforce the same identity.
2. **Arguments cannot override identity.** Calls containing `tenant_id` anywhere in their parameters, including nested objects, arrays, or `_meta`, fail with `InvalidParams` before reaching a downstream. Case variants, `tenantId`, and `tenant-id` are also reserved, even when their value matches the configured tenant. The gateway never inserts tenant identity into arguments.
3. **Credentials cannot follow redirects.** All redirects and cross-origin message endpoints are blocked. Configure the final SSE URL directly.
4. **Downstreams must authorize the tenant.** Each service must validate the bearer token, check that it grants access to `X-Tenant-ID`, derive data access from that header, and enforce tenant filtering at the application/database layer. Do not merely trust an arbitrary tenant header on a publicly reachable backend.
5. **Schema filtering is not a backend migration.** Legacy tools that require an argument-based tenant must be adapted to transport-derived tenancy. The gateway will not fill in their old tenant argument. Complex schemas may still reject a call; tenant guardrails are never relaxed to make it succeed.
6. **Descriptions are attention cues, not security boundaries.** Prompt injection, encoded strings, arbitrary business arguments, and tool result text cannot be semantically sanitized into a tenant authorization guarantee. Backend authorization is mandatory. Treat downstream descriptions/results as untrusted model content.

The host controls the process environment and config file; those are trusted administrative inputs. This template is not a shared multi-user authorization broker and exposes no network listener upstream.

## Resilience and operations

- A service that cannot connect, initialize, or list tools before its deadline is quarantined. Other services continue normally; if all fail, initialization still succeeds and `tools/list` returns `[]`.
- Broken streams or discovery failures remove a service's tools and close its transport. **There is no automatic session recovery:** restart the gateway after restoring a service. A transport reconnect alone would not safely establish a fresh MCP session.
- Tool calls are never automatically retried: a timeout/cancellation does **not** prove the backend operation did not execute. Use backend idempotency keys for mutations.
- Unknown tools map to `MethodNotFound`; rejected arguments to `InvalidParams`; other downstream failures/timeouts to `InternalError`. Downstream protocol error text/data is replaced with safe messages. Successful tool result bodies (including business `isError` results) are intentionally not rewritten.
- `SIGINT`, `SIGTERM`, stdin EOF/close, and upstream transport closure trigger idempotent cleanup of all downstream clients/SSE streams and stdio. A five-second watchdog bounds shutdown.
- Structured logs go only to **stderr**. The gateway does not log tokens, URLs, arguments, results, or raw downstream exceptions. Do not add `console.log` to server code.
- Upstream frames are limited to 1 MiB. For deployment, also set backend response/rate/concurrency limits, monitor warning logs, use tenant-scoped least-privilege tokens, protect config files, and run dependency updates/audits in CI. This template does not implement distributed rate limiting or an administrative health endpoint.

## Project layout

```text
src/config.ts       Zod validation and immutable configuration
src/downstream.ts   Authenticated SSE clients, discovery, deadlines, cleanup
src/gateway.ts      Tool namespaces, tenant guard, aggregation and routing
src/index.ts        Stdio lifecycle, signals and EOF handling
config.json         Example downstream endpoint map
.env.example        Example environment (no real credentials)
test/gateway.test.ts
```

`bun run test` uses local mock SSE servers and real subprocess stdio clients. It covers header injection, redirect rejection, tenant isolation/override rejection, pagination, partial and total outages, stalled connection deadlines, tool errors/timeouts, live discovery updates, and signal/EOF cleanup. No external services or credentials are required.
