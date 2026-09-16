# Technical reference

[← Back to the README](../README.md)

The README covers getting started. This page covers the constraints and operational details you need when adapting or deploying the template.

## Configuration

| Environment variable | Required | Meaning |
| --- | --- | --- |
| `SERVICE_AUTH_TOKEN` | Yes | Nonempty, header-safe bearer token; no `Bearer ` prefix |
| `TENANT_ID` | Yes | Immutable identity, 1–128 letters/digits/dots/underscores/hyphens; starts with a letter or digit |
| `MCP_CONFIG_PATH` | No | JSON configuration path; defaults to `config.json` relative to the working directory |

Use an absolute configuration path in desktop clients. The environment and config file are trusted administrative inputs, not model-controlled settings.

### Service configuration rules

- `services` contains **1–64** uniquely named services. Unknown configuration keys fail validation.
- Each service has `name`, `url`, and an optional `timeout`.
- Names are at most **32 characters**: lowercase letters/digits with single internal `_` or `-` separators, starting with a letter. `__` and trailing separators are forbidden so routing stays unambiguous.
- `timeout` is milliseconds, defaults to **10000**, and must be **100–300000**. It bounds the entire startup plus initial discovery, each subsequent full discovery, and each tool call. Progress does not extend deadlines.
- URLs must use **HTTPS**, except HTTP on `localhost`, `127.0.0.1`, or `[::1]` for local development. URL credentials and fragments are forbidden. Configure the final SSE URL: redirects are not followed.
- The same process-scoped token and tenant are sent to every configured service. Only list trusted endpoints authorized to receive those credentials.
- Zod validates configuration, which is frozen at startup. Restart to change endpoints, rotate credentials, or change tenants.

Use your system's trusted CA configuration for internal TLS. Do not disable certificate validation.

### Environment files and dependencies

The gateway itself does not load `.env`. Bun scripts inherit Bun's automatic `.env` loading; direct Node launches require `--env-file` or host-injected environment variables.

`.env` and `config.local.json` are ignored by Git. Never commit real secrets, and restrict access to desktop host configuration files containing tokens. Commit `bun.lock` and install with `bun install --frozen-lockfile` for reproducible dependency resolution.

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

### Scope

This is a **tools-only** gateway. It does not proxy resources, prompts, sampling, elicitation, subscriptions, or experimental tasks. It exposes no network listener upstream.

The template deliberately uses `SSEClientTransport` for existing SSE servers. The SDK recommends Streamable HTTP for new deployments, but a Streamable HTTP `/mcp` endpoint cannot be substituted for an SSE `/sse` endpoint without changing the transport implementation.

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

Run one process per tenant, with separate environment and appropriately scoped credentials. The endpoint configuration can be shared if it contains no secrets.

```json
{
  "mcpServers": {
    "acme-gateway": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/synapse-mcp/dist/index.js"],
      "env": {
        "SERVICE_AUTH_TOKEN": "replace-with-acme-token",
        "TENANT_ID": "tenant-acme",
        "MCP_CONFIG_PATH": "/absolute/path/to/synapse-mcp/config.json"
      }
    },
    "globex-gateway": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/synapse-mcp/dist/index.js"],
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

The test script builds the project, then uses Node's test runner with local mock SSE servers and real subprocess stdio clients. It covers header injection, redirect rejection, tenant isolation and override rejection, pagination, partial and total outages, stalled connection deadlines, tool errors and timeouts, live discovery updates, and signal/EOF cleanup.

No external services or credentials are required. Use `bun run test`, not Bun's separate `bun test` runner.
