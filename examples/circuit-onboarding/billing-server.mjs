// The demo billing MCP server's definition, separate from how it is served:
//  - billing-mcp-server.mjs serves it over stdio (`circuit dev`, circuit.mcp.json);
//  - a host without child processes (a Vercel Function) runs it in-process:
//      new McpConnections({ connections: { billing: { transport: 'inprocess', server: 'billing' } } },
//                         pins, { inprocess: { billing: createBillingServer } })
// A tiny stand-in for a real MCP server (Stripe, your internal billing API…).
// Fully fake, no network.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** A fresh server object (one per connection: an MCP server serves one transport at a time). */
export function createBillingServer() {
  const server = new McpServer({ name: 'demo-billing', version: '1.0.0' });

  server.registerTool(
    'get_charge',
    { description: 'Look up a charge by id', inputSchema: { chargeId: z.string() } },
    async ({ chargeId }) => {
      // 'ch_broken*' simulates the billing API being down (a returned error).
      if (chargeId.startsWith('ch_broken')) {
        return { isError: true, content: [{ type: 'text', text: `billing API 503 looking up ${chargeId}` }] };
      }
      const amount = chargeId.includes('big') ? 900 : 40;
      return { content: [{ type: 'text', text: JSON.stringify({ chargeId, amount, currency: 'EUR', customer: 'acme' }) }] };
    },
  );

  server.registerTool(
    'refund',
    { description: 'Refund (part of) a charge', inputSchema: { chargeId: z.string(), amount: z.number() } },
    async ({ chargeId, amount }) => ({
      content: [{ type: 'text', text: JSON.stringify({ refundId: `re_${chargeId}`, amount, status: 'succeeded' }) }],
    }),
  );

  return server;
}
