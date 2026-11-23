/**
 * Speaks the sign-in holder's wire contract (microsoft-graph-mcp-servers'
 * mcp_shared/src/signin-holder.ts) with a fake sign-in that counts browser prompts.
 */
import { chmodSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { holderSocketPath } from '../../src/holder.js';

const tenantId = process.env.MCP_GRAPH_HOLDER_TENANT as string;
const clientId = process.env.MCP_GRAPH_HOLDER_CLIENT as string;
const socketPath = holderSocketPath(tenantId, clientId);
let prompts = 0;
let signedIn = false;
const signIn = () => {
  if (!signedIn) {
    prompts++;
    signedIn = true;
  }
};
const server = createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const end = buffer.indexOf('\n');
    if (end === -1) return;
    const { id, method } = JSON.parse(buffer.slice(0, end)) as { id: number; method: string };
    let result: unknown = {};
    if (method === 'x-mcp-graph/status') result = { signedIn, tenantId, clientId, writeClient: false, pid: process.pid };
    if (method === 'x-mcp-graph/ensure-signed-in') signIn();
    if (method === 'x-mcp-graph/token') {
      signIn();
      result = { accessToken: `prompts=${prompts}`, expiresOn: Date.now() + 3_600_000 };
    }
    socket.end(`${JSON.stringify({ id, result })}\n`);
    if (method === 'x-mcp-graph/sign-out') {
      server.close();
      rmSync(socketPath, { force: true });
      process.exit(0);
    }
  });
});
rmSync(socketPath, { force: true });
server.listen(socketPath, () => chmodSync(socketPath, 0o600));
