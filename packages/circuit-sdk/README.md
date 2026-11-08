# @graphmind-ai/circuit-sdk

Author surface of **GraphMind Circuit**: define durable workflows as plain
TypeScript. Only context calls are journaled; the code between them is free.

```ts
import { workflow, z } from '@graphmind-ai/circuit-sdk';

export const triageInvoice = workflow(
  { name: 'triage-invoice', input: z.object({ invoiceId: z.string() }) },
  async (ctx, input) => {
    const invoice = await ctx.step('fetch-invoice', () => erp.fetch(input.invoiceId));
    if (invoice.amount > 10_000) {
      const ok = await ctx.approval('finance-signoff', { approvers: ['role:finance'], timeout: '48h' });
      if (!ok.approved) return { status: 'escalated' };
    }
    const paid = await ctx.waitForEvent('payment', { name: 'payment.settled', match: { invoiceId: input.invoiceId }, timeout: '3d' });
    return { status: paid ? 'paid' : 'escalated' };
  },
);
```

Primitives: `ctx.step` (durable call, retries with visible attempts),
`ctx.sleep` (durable timer, no compute held), `ctx.waitForEvent`,
`ctx.approval` (human gate), `ctx.invoke` (child workflow), `ctx.log`.
Step results must round-trip JSON — enforced loudly, because a recorded
result is exactly what a replay returns.
