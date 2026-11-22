/** A real stdio MCP server for tests: reports the environment and pid it was started with. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const server = new Server({ name: 'stdio-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'whoami', description: 'Report identity', inputSchema: { type: 'object' } },
    { name: 'graph_token', description: 'Borrow a token from the parent', inputSchema: { type: 'object' } },
    {
      name: 'delete_thing',
      description: 'A confirm-gated change',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, confirm: { type: 'boolean' } } },
    },
  ],
}));
let ran = 0;
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'graph_token') {
    const args = request.params.arguments ?? {};
    try {
      const token = await server.request(
        { method: 'x-mcp-graph/token', params: { scopes: args.scopes ?? ['User.Read.All'], access: args.access ?? 'read' } } as never,
        z.object({ accessToken: z.string(), expiresOn: z.number() }),
      );
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: token };
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'failed' }], isError: true };
    }
  }
  if (request.params.name === 'delete_thing') {
    const args = request.params.arguments ?? {};
    if (args.confirm !== true) {
      const preview = { type: 'confirmation_required', action: `delete ${String(args.id)}` };
      return {
        content: [{ type: 'text', text: `Will delete ${String(args.id)}.\nTo proceed, the AI MUST: ask.\nIf the user says no, do NOT call the tool again.\n` }],
        structuredContent: preview,
      };
    }
    ran++;
    return { content: [{ type: 'text', text: `deleted ${String(args.id)}` }], structuredContent: { deleted: args.id, ran } };
  }
  const data = {
    name: request.params.name,
    args: request.params.arguments ?? {},
    tenant: process.env.SYNAPSE_TENANT_ID ?? null,
    service: process.env.SYNAPSE_SERVICE_NAME ?? null,
    extra: process.env.FIXTURE_EXTRA ?? null,
    broker: process.env.MCP_GRAPH_TOKEN_BROKER ?? null,
    expectedTenant: process.env.GATEWAY_EXPECTED_TENANT_ID ?? null,
    hasToken: process.env.SERVICE_AUTH_TOKEN !== undefined,
    hasConfigPath: process.env.MCP_CONFIG_PATH !== undefined,
    cwd: process.cwd(),
    pid: process.pid,
  };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
});
await server.connect(new StdioServerTransport());
