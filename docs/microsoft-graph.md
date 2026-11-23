# Synapse as the Microsoft Graph gateway

Synapse can run the five planes of [microsoft-graph-mcp-servers](https://github.com/RohiRIK/microsoft-graph-mcp-servers) (Entra ID, Intune, Exchange Online, Defender, Purview) in place of its `gateway_mcp`. Each plane is a stdio service; Synapse signs in once and lends that sign-in to all of them.

## Configure

1. Copy [`examples/microsoft-graph.config.json`](../examples/microsoft-graph.config.json) and replace the three placeholder paths: Bun (`command -v bun`), and the clone of microsoft-graph-mcp-servers in `args` and `cwd`. Remove the planes you do not use.
2. Set the environment the host launches Synapse with:

   ```dotenv
   TENANT_ID=<the directory GUID>
   MCP_CONFIG_PATH=/absolute/path/to/your/config.json
   ```

   No `SERVICE_AUTH_TOKEN` is needed: there are no SSE services.

The planes still read their own `settings.yaml`. `cwd` is the clone, so they find its `settings.yaml` the way they always do (walking up from the working directory). To use one elsewhere, add `"env": { "MCP_SETTINGS": "/absolute/path/settings.yaml" }` to each plane. To pick a profile other than `activeProfile`, add `"--profile", "<name>"` to each plane's `args`.

## What holds

- **One sign-in, in memory.** The first call to any plane opens the browser once. Every plane borrows that sign-in; nothing is written to disk, and it ends with Synapse. `sessionMaxAgeHours` caps it. On a remote server with no browser, set `"flow": "device_code"` in the `signIn` block: the person enters a short code at microsoft.com/devicelogin from any device instead (see [reference](reference.md#signing-in-from-a-remote-server-flow-device_code)).
- **One tenant.** The sign-in is bound to `TENANT_ID`, and each plane is started with `GATEWAY_EXPECTED_TENANT_ID` set to it. A plane whose profile names another tenant refuses to start and shows as offline; an account from another directory is dropped at sign-in.
- **Reads by default.** Writes stay off unless the plane's profile turns them on (`enableWrites`). Children do not inherit Synapse's environment, so a stray `*_ENABLE_WRITES` in the host's shell does not reach them.
- **A person approves each change.** Confirm-gated tools run only after the person approves the preview in the client.
- **Optional write identity.** `signIn.writeClientId` names a second app registration consented for writes, signed in only when a write first needs a token. See `docs/specs/read-write-identities.md` in microsoft-graph-mcp-servers for the operator steps.

## Not carried over from gateway_mcp yet

- Resources and prompts: Synapse is tools-only, so the planes' resources and `gateway://session` are not exposed.
- `check_approval_prompt` and the other gateway-local tools.
- Purview's DLP tools keep their own Exchange Online PowerShell sign-in, as under `gateway_mcp`.

## Checked

On Linux with Bun 1.4.4, Synapse started all five planes from this example with a test `settings.yaml`: 138 tools listed (entra 38, intune 51, exchange 14, defender 14, purview 21). With a different `TENANT_ID`, every plane refused to start with "tenant does not match the gateway tenant". A real browser sign-in has not been run through Synapse yet.
