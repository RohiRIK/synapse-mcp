/** A real stdio MCP server for tests: reports the environment and pid it was started with. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'stdio-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'whoami', description: 'Report identity', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const data = {
    name: request.params.name,
    args: request.params.arguments ?? {},
    tenant: process.env.SYNAPSE_TENANT_ID ?? null,
    service: process.env.SYNAPSE_SERVICE_NAME ?? null,
    extra: process.env.FIXTURE_EXTRA ?? null,
    hasToken: process.env.SERVICE_AUTH_TOKEN !== undefined,
    hasConfigPath: process.env.MCP_CONFIG_PATH !== undefined,
    cwd: process.cwd(),
    pid: process.pid,
  };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
});
await server.connect(new StdioServerTransport());
