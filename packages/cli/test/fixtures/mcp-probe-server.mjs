// A tiny stdio MCP server for the builder's "test connection" tests: two
// tools, a line on stderr, and nothing else. CRASH=1 makes it exit before
// the handshake, which is what a broken command looks like to the probe.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

if (process.env.CRASH === '1' || process.argv.includes('--crash')) {
  console.error('probe-fixture: refusing to start (CONFIG_MISSING)');
  process.exit(3);
}
console.error('probe-fixture: starting');
const server = new McpServer({ name: 'probe-fixture', version: '9.9.9' });
server.registerTool('echo', { description: 'Echoes its input back.', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}));
server.registerTool('now', { description: 'The current time.' }, async () => ({ content: [{ type: 'text', text: String(Date.now()) }] }));
await server.connect(new StdioServerTransport());
