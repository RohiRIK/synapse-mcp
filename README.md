# Synapse MCP

**One connection to your tools. A fixed tenant context for every call.**

Connect Claude Desktop or Cursor to multiple internal MCP services through a single gateway. Synapse combines their tools, routes each call to the right service, and adds your service token and tenant ID to every downstream request.

![Synapse architecture: Claude Desktop or Cursor connects over stdio to a tenant-scoped gateway, which routes tools to billing and CRM over SSE and HTTP.](docs/images/architecture.svg)

[![CI](https://github.com/RohiRIK/synapse-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/RohiRIK/synapse-mcp/actions/workflows/ci.yml)

[Get started](#get-started) · [Connect your AI client](#connect-your-ai-client) · [Multiple tenants](#multiple-tenants) · [Technical reference](docs/reference.md)

## What does it do?

Imagine you have a billing server and a CRM server. Instead of configuring both in every AI client, connect the client to Synapse:

| Your service exposes | Your AI client sees |
| --- | --- |
| Billing → `create_invoice` | `billing__create_invoice` |
| CRM → `get_user` | `crm__get_user` |

The model chooses a tool. **It does not choose the tenant.** That identity comes from the gateway's environment, not tool arguments.

- **One tool list:** discover tools from all configured services in parallel.
- **No name collisions between services:** every tool gets a service prefix.
- **Partial-failure support:** if billing is offline, CRM can still work.
- **Bun-first development:** install, build, and test with Bun; run the MCP process with Node.

> [!NOTE]
> This is a **tools-only, stdio-to-SSE template** built with the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). It does not proxy resources or prompts. The SDK recommends Streamable HTTP for new services; this project intentionally supports existing SSE endpoints. `/mcp` and `/sse` are not interchangeable.

## Get started

You'll need **Bun 1.3.14+**, **Node.js 22.14+**, and at least one downstream MCP server with an SSE endpoint. The example billing and CRM services are not included.

### 1. Install

```sh
git clone https://github.com/RohiRIK/synapse-mcp.git
cd synapse-mcp
bun install --frozen-lockfile
cp .env.example .env
```

### 2. Set your identity

Edit `.env`:

```dotenv
SERVICE_AUTH_TOKEN=replace-with-your-service-token
TENANT_ID=tenant-acme
MCP_CONFIG_PATH=./config.json
```

Use the token itself, without a `Bearer ` prefix. Keep real credentials out of Git; `.env` is already ignored.

### 3. Add your services

Edit `config.json` to point at your actual SSE endpoints:

```json
{
  "services": [
    {
      "name": "billing",
      "url": "http://127.0.0.1:3001/sse",
      "timeout": 10000
    },
    {
      "name": "crm",
      "url": "http://127.0.0.1:3002/sse",
      "timeout": 10000
    }
  ]
}
```

`timeout` is in milliseconds. Use **HTTPS** outside loopback development addresses. Only configure trusted services: every listed endpoint receives the process's token and tenant ID.

### 4. Build

```sh
bun run build
```

You're ready to connect an AI client below. For a local startup check, you can also run:

```sh
node --env-file=.env dist/index.js
```

**A quiet terminal is normal.** This process waits for MCP messages on stdin; it isn't a chat interface or web server. Logs go to stderr. Press `Ctrl+C` to stop it.

## Connect your AI client

Add this entry to Claude Desktop's `claude_desktop_config.json`, or to Cursor's MCP configuration. Replace the paths and credentials with your own:

```json
{
  "mcpServers": {
    "acme-gateway": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/synapse-mcp/dist/index.js"],
      "env": {
        "SERVICE_AUTH_TOKEN": "replace-with-acme-service-token",
        "TENANT_ID": "tenant-acme",
        "MCP_CONFIG_PATH": "/absolute/path/to/synapse-mcp/config.json"
      }
    }
  }
}
```

Restart your client after saving. When the downstream services are available, you should see tools such as `billing__create_invoice` and `crm__get_user`—the exact list comes from your servers.

**Two easy-to-miss details:**

- Use absolute paths. Desktop clients may not start in your project directory. On macOS/Linux, `command -v node` helps locate your Node executable.
- Launch Node directly, not `bun run start` or another package-manager wrapper. Keep script banners out of the MCP stdio channel. The host configuration above supplies the environment; it doesn't rely on your local `.env`.

## Multiple tenants

**Run one gateway process per tenant.** Give each process its own `TENANT_ID` and appropriately scoped token. The processes can share the same nonsecret service configuration.

![Two separate gateway processes use fixed Acme and Globex identities. Shared backend services must validate the token and tenant and scope every data query.](docs/images/tenant-isolation.svg)

For example, add `acme-gateway` and `globex-gateway` entries to your host configuration, each with a different environment. See the [complete two-tenant example](docs/reference.md#two-tenant-client-configuration).

> [!IMPORTANT]
> A client configured with **both** gateways can access **both** tenants. Give each user only the gateway and credentials they should have. Separate processes keep transport identities separate; they do not restrict a host that already has access to both.

## Where the security boundary is

Synapse enforces the gateway side:

- Forces `Authorization` and `X-Tenant-ID` headers on SSE GETs and HTTP POSTs.
- Rejects `tenant_id` arguments, including nested fields and common spelling variants.
- Blocks redirects and cross-origin message endpoints to avoid forwarding credentials elsewhere.

**Your backend must enforce the data-access side.** Validate the bearer token, verify that it permits the requested tenant, and scope every data query to that tenant. A description saying `[Tenant: tenant-acme]` helps the model understand context; it is not authorization.

Legacy tools that require a `tenant_id` argument must be updated to read the transport context instead. Synapse will not fill that argument in for them.

Read the [full security contract](docs/reference.md#tenant-security-contract) before deploying.

## Everyday commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Run the TypeScript entry point through `tsx` |
| `bun run build` | Compile TypeScript into `dist/` |
| `bun run start` | Run the compiled gateway with Node |
| `bun run test` | Build and run unit + real stdio/SSE integration tests |
| `bun audit --production` | Check production dependencies for known vulnerabilities |

Use **`bun run test`**, not `bun test`: the script uses Node's test runner to exercise the desktop runtime. Tests start their own local mock services; no external credentials are needed.

Bun scripts load `.env` automatically. Direct Node launches need `--env-file` or environment variables supplied by the host.

## Something not working?

| What you see | What to check |
| --- | --- |
| The terminal appears to do nothing | Normal: the gateway is waiting for an MCP client on stdin. |
| No tools appear | Check stderr, service URLs, credentials, and whether your downstream servers are running. If all are unavailable, the list is empty. |
| A restored service still isn't listed | Restart the gateway. Automatic session recovery is not implemented. |
| A tool call rejects `tenant_id` | Remove it from the arguments. Tenant identity belongs in the process environment. |
| A mutation timed out | Check the backend before retrying; the operation may already have executed. Use backend idempotency keys. |

## Want to change how it works?

The core is four files:

| File | Responsibility |
| --- | --- |
| [`src/config.ts`](src/config.ts) | Validate environment and service configuration |
| [`src/downstream.ts`](src/downstream.ts) | Connect, authenticate, discover tools, and enforce deadlines |
| [`src/gateway.ts`](src/gateway.ts) | Namespace tools, reject tenant overrides, and route calls |
| [`src/index.ts`](src/index.ts) | Run stdio and handle shutdown |

For configuration limits, protocol behavior, deployment notes, and the multi-tenant config example, see the **[technical reference](docs/reference.md)**.
