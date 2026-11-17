// The demo billing MCP server over stdio — Circuit starts it from
// circuit.mcp.json. The server itself is defined in billing-server.mjs so it
// can also run in-process (see that file).
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBillingServer } from './billing-server.mjs';

const server = createBillingServer();
serveStdio(() => server);
