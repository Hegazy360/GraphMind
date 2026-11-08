/**
 * The onboarding workflow: triage an invoice, with every Circuit primitive
 * on display — a flaky step (pauses at an error gate on first failure so you
 * can fix-and-resume it), an approval, and an external event.
 *
 *   circuit dev --workflows workflows.mjs
 */
import { workflow, z } from '@graphmind-ai/circuit-sdk';

// Simulated ERP: the first fetch of any invoice marked flaky fails, so the
// demo always has something to debug.
const failedOnce = new Set();
async function erpFetchInvoice(invoiceId) {
  if (invoiceId.startsWith('flaky') && !failedOnce.has(invoiceId)) {
    failedOnce.add(invoiceId);
    throw new Error(`ERP 503 fetching ${invoiceId} (simulated — retry me, or inject an invoice)`);
  }
  const amount = invoiceId.includes('big') ? 25_000 : 420;
  return { invoiceId, amount, customer: 'acme' };
}

export const triageInvoice = workflow(
  {
    name: 'triage-invoice',
    input: z.object({ invoiceId: z.string() }),
    retries: 1, // fail fast in the demo so the error gate shows immediately
  },
  async (ctx, input) => {
    const invoice = await ctx.step('fetch-invoice', () => erpFetchInvoice(input.invoiceId));

    if (invoice.amount > 10_000) {
      const signoff = await ctx.approval('finance-signoff', {
        approvers: ['role:finance'],
        timeout: '48h',
        context: invoice,
      });
      if (!signoff.approved) return { status: 'escalated', invoiceId: input.invoiceId };
    }

    const settled = await ctx.waitForEvent('payment', {
      name: 'payment.settled',
      match: { invoiceId: input.invoiceId },
      timeout: '3d',
    });
    return { status: settled === null ? 'escalated' : 'paid', invoiceId: input.invoiceId };
  },
);

/**
 * Uses an MCP server (billing-mcp-server.mjs, configured in circuit.mcp.json).
 * Every refund needs a human: the policy in circuit.mcp.json is "approve".
 *
 *   circuit dev --workflows workflows.mjs --mcp circuit.mcp.json
 */
export const refundRequest = workflow(
  { name: 'refund-request', input: z.object({ chargeId: z.string(), reason: z.string() }), retries: 1 },
  async (ctx, input) => {
    const charge = await ctx.mcp('billing').call('get_charge', { chargeId: input.chargeId });
    const refund = await ctx.mcp('billing').call('refund', { chargeId: charge.chargeId, amount: charge.amount });
    return { refunded: refund.amount, refundId: refund.refundId, reason: input.reason };
  },
);
