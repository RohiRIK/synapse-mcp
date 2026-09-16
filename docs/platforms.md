# Windows, Linux, and macOS setup

[← Back to the README](../README.md)

Synapse's **core gateway is tested in CI on Windows, Linux, and macOS**, with Node.js 22 and 24. The optional dashboard is a separate capability: it currently supports macOS/Linux only.

Check the [latest CI results](https://github.com/RohiRIK/synapse-mcp/actions/workflows/ci.yml) for the revision you intend to deploy. These are SDK-based protocol tests, not certification of every AI host or production backend.

## Which layer actually depends on the OS?

| Layer | What matters |
| --- | --- |
| Your AI host / MCP adapter | Must be able to launch a standard MCP stdio server; keep using its existing OS-specific launch support |
| Synapse gateway | Node executable path, environment variables, filesystem paths, and process lifecycle |
| Your downstream MCP services | Reachable **SSE** endpoints, TLS trust, and valid authentication—not which OS hosts them |
| Optional dashboard | Local Unix sockets and POSIX permissions; native Windows support is not implemented |

The gateway does **not** start billing/CRM services as local subprocesses. It connects to URLs. A gateway on Windows can reach a service on Linux or macOS, and vice versa, as long as the endpoint, network access, and credentials are correct. Do not add platform-specific downstream launch logic for services already exposed over SSE.

The SDK's stdio client already uses cross-platform process spawning and Windows-aware environment handling. Synapse's tests reuse that SDK rather than inventing a new launcher. Your actual host may use its own implementation, so verify that host's command/environment configuration separately.

## Before sharing with colleagues

1. Install **Bun 1.3.14+** and **Node.js 22.14+**. Node 22/24 are the CI-tested major versions.
2. Make sure their AI host has an MCP **stdio** integration or adapter.
3. Provide actual SSE service URLs and an appropriately scoped token/tenant through a secure channel. The checked-in billing/CRM URLs are examples, not bundled services.
4. Keep `MCP_DASHBOARD_ENABLED=false` for the initial gateway setup.
5. Run `bun run check`, then make a read-only call against a safe test backend using their actual host.

Start with a small pilot. The template still requires backend authorization, secret management, and deployment-specific operational review before production use.

## Windows: PowerShell

```powershell
git clone https://github.com/RohiRIK/synapse-mcp.git
Set-Location synapse-mcp
bun install --frozen-lockfile
Copy-Item .env.example .env
# Edit .env and config.json for your authorized test backend.
bun run build
bun run check
node --env-file=.env dist/index.js
```

The last command is a startup check: the process waits for MCP messages on stdin. It is not a chat interface. Normally your MCP host launches it instead.

Find the Node executable with:

```powershell
(Get-Command node).Source
```

For a host that accepts a `mcpServers` map, a Windows launch configuration can look like this:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/Projects/synapse-mcp/dist/index.js"],
      "env": {
        "SERVICE_AUTH_TOKEN": "replace-with-your-token",
        "TENANT_ID": "tenant-acme",
        "MCP_CONFIG_PATH": "C:/Projects/synapse-mcp/config.json",
        "MCP_DASHBOARD_ENABLED": "false"
      }
    }
  }
}
```

Replace every example path. Forward slashes avoid JSON backslash escaping; if you use backslashes, double them. A path containing spaces is one JSON string, not a shell command with embedded quote characters. Use your host's own format if it does not accept `mcpServers`.

**Dashboard:** do not enable it in a native Windows gateway yet. The current agent requires Unix sockets and POSIX filesystem permissions. Running a complete Linux environment inside WSL2 is a separate setup, not a tested drop-in bridge between native Windows hosts and the dashboard; do not mix runtime directories or assume those environments share sessions.

**Shutdown:** gateway tests cover stdin EOF on Windows. `child.kill()` on Windows force-terminates a process rather than delivering POSIX signals, so those two signal-specific tests are explicitly skipped. Do not rely on forced termination to complete application cleanup.

## Linux / macOS: shell

```sh
git clone https://github.com/RohiRIK/synapse-mcp.git
cd synapse-mcp
bun install --frozen-lockfile
cp .env.example .env
# Edit .env and config.json for your authorized test backend.
bun run build
bun run check
node --env-file=.env dist/index.js
```

Use `command -v node` to locate the executable. In your MCP host, configure that absolute path plus the absolute path to `dist/index.js`, and supply the gateway environment variables directly. Do not assume a desktop host inherits the environment from your interactive shell.

The optional dashboard can be installed separately by following [its setup guide](../dashboard/README.md). Enable telemetry only on the gateway processes you intend to inspect. Dashboard and gateway processes must run as the same OS user and use the same private runtime directory.

## Network and TLS checklist — applies to every OS

- `127.0.0.1` means the machine/network namespace running the gateway. It does not refer to your colleague's machine, a remote service host, or a container's host automatically.
- Use **HTTPS** for non-loopback endpoints. Remote plain HTTP URLs are intentionally rejected.
- Supply the final SSE URL. Redirects and cross-origin message endpoints are blocked to protect credentials.
- If services use a private certificate authority, configure trusted certificates for Node, for example through an appropriate `NODE_EXTRA_CA_CERTS` PEM file at process startup. Never disable TLS verification.
- Verify DNS, firewall rules, VPN/proxy routing, and token authorization from the machine actually running the gateway.
- A backend exposing only Streamable HTTP at `/mcp` cannot yet replace an SSE endpoint. HTTP upstream/downstream support is still planned.
- The dashboard URL is for a browser, not for connecting MCP clients.

## Verification scope

Gateway CI runs Node 22/24 across `ubuntu-latest`, `windows-latest`, and `macos-latest`. The suite tests initialization, aggregation/routing, header injection, tenant rejection, outages, timeouts, tool-list updates, and EOF cleanup. POSIX signal tests also run on Linux/macOS.

Dashboard integration and browser checks run separately on Linux CI; macOS is additionally covered by local testing. There is no native Windows dashboard claim.

See [smoke-test commands](testing.md) for repeatable checks. These do not replace testing your colleagues' specific MCP hosts and backend authorization policies.
