/**
 * A tiny, real MCP server over stdio with GraphMind instrumentation.
 *
 *   npx graphmind-ai                       # terminal 1: the debugger
 *   node packages/mcp/example/stdio-server.mjs   # terminal 2, or point a
 *                                                # client at this command
 *
 * Then arm a breakpoint on `tool:flights` in the viewer and call the tool from
 * your client: execution stops before the handler runs, and `inject` hands the
 * client whatever you type instead.
 *
 * Note what is NOT here: no console.log. On a stdio server, stdout IS the
 * protocol. GraphMind talks over a WebSocket to 127.0.0.1:4747 and writes
 * nothing to stdout (warnings, if any, go to stderr).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { graphmind } from '@graphmind-ai/mcp';

const gm = graphmind({ app: 'flights-mcp', waitForAttach: true });

const server = gm.wrapServer(new McpServer({ name: 'flights', version: '1.0.0' }));

server.registerTool(
  'flights',
  {
    description: 'Search flights between two airports',
    inputSchema: { from: z.string(), to: z.string() },
  },
  async ({ from, to }) => {
    if (from === to) throw new Error(`origin and destination are both ${from}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ flights: [{ id: 'TP1234', from, to, priceEUR: 199 }] }),
        },
      ],
    };
  },
);

server.registerResource(
  'policy',
  'policy://baggage',
  { description: 'Baggage policy', mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.toString(), text: '1 cabin bag, 8kg.' }] }),
);

server.registerPrompt(
  'bookingEmail',
  { description: 'Draft a booking confirmation', argsSchema: { name: z.string() } },
  ({ name }) => ({
    messages: [
      { role: 'user', content: { type: 'text', text: `Write a booking email for ${name}.` } },
    ],
  }),
);

await server.connect(new StdioServerTransport());
