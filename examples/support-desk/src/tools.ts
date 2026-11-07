/**
 * The support agent's tool belt. Every tool is deterministic (no network,
 * no clocks), and each planted failure is the realistic kind — the kind
 * GraphMind exists to catch:
 *
 *   lookupOrder          honest. The baseline every scenario starts from.
 *   trackShipment        THROWS CarrierTimeoutError for TRK-5520-X, every
 *                        time — a "transient-looking" failure that is not
 *                        transient. The system prompt tells the agent to
 *                        retry transient carrier errors, so it loops: the
 *                        live error-repeat hold catches the third identical
 *                        failure, and `runs --behavior` prices the loop.
 *   checkInventory       NEVER throws. For PLW-SLP-01 it RETURNS
 *                        { success: false, ... } — the failure shape the
 *                        `error-result` smart breakpoint holds on, and the
 *                        behaviour report counts as a silent failure.
 *   refundPayment        THE PLANTED BUG: the gateway takes cents, the tool
 *                        multiplies by 100 — but the input is already in
 *                        dollars-as-the-schema-says, and a second legacy
 *                        `toMinorUnits` call multiplies AGAIN. The gateway
 *                        sees 100× the intended refund and rejects it.
 *                        Pause-on-error freezes the throw; the fix is
 *                        provable from the debugger (see the README walk).
 *   searchKnowledgeBase  honest, but each article is deliberately long —
 *                        three calls and the context curve tells the story.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { INVENTORY, KNOWLEDGE_BASE, ORDERS, SHIPMENTS } from './data.js';

export class CarrierTimeoutError extends Error {
  override name = 'CarrierTimeoutError';
}

export class RefundRejectedError extends Error {
  override name = 'RefundRejectedError';
}

const usd = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** The legacy helper nobody remembers is already applied upstream. */
function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export const supportTools = {
  lookupOrder: tool({
    description: 'Look up an order by its id: items, totals, status, tracking id.',
    inputSchema: z.object({
      orderId: z.string().describe('The numeric order id, e.g. "1042"'),
    }),
    execute: async ({ orderId }) => {
      const order = ORDERS[orderId.replace(/^#/, '')];
      if (order === undefined) return { success: false as const, error: `no order "${orderId}"` };
      return { success: true as const, order };
    },
  }),

  trackShipment: tool({
    description: 'Current tracking events for a shipment, newest last.',
    inputSchema: z.object({
      trackingId: z.string().describe('Tracking id from the order, e.g. "TRK-1042-OK"'),
    }),
    execute: async ({ trackingId }) => {
      const events = SHIPMENTS[trackingId];
      if (events === undefined) {
        // The lane behind TRK-5520-X is down. It answers with a timeout —
        // the same timeout — every single time. Retrying cannot help, but
        // nothing about the error says so.
        throw new CarrierTimeoutError(
          `carrier tracking API timed out after 10s for ${trackingId} (upstream 504)`,
        );
      }
      return { trackingId, events, lastEvent: events[events.length - 1] };
    },
  }),

  checkInventory: tool({
    description: 'Stock level for a SKU.',
    inputSchema: z.object({
      sku: z.string().describe('The product SKU, e.g. "KBD-WRL-11"'),
    }),
    execute: async ({ sku }) => {
      const entry = INVENTORY[sku];
      if (entry === undefined) {
        // The warehouse sync is mid-run and the service degrades politely:
        // it RETURNS its failure instead of throwing. An uninstrumented
        // agent reads this as data and may tell the customer anything.
        return {
          success: false as const,
          error: 'inventory service: upstream 503 (warehouse sync in progress)',
          sku,
        };
      }
      return { success: true as const, sku, ...entry };
    },
  }),

  refundPayment: tool({
    description:
      'Issue a refund to the original payment method. Amount is in US dollars.',
    inputSchema: z.object({
      orderId: z.string(),
      amountUsd: z.number().positive().describe('Refund amount in US dollars, e.g. 89'),
      reason: z.string(),
    }),
    execute: async ({ orderId, amountUsd, reason }) => {
      const order = ORDERS[orderId.replace(/^#/, '')];
      if (order === undefined) return { success: false as const, error: `no order "${orderId}"` };
      // THE BUG: the gateway client already converts to minor units, and
      // someone "fixed" a rounding issue by converting here as well — so a
      // dollars input is converted to cents twice. $89 reaches the gateway
      // as 890,000 cents: $8,900.
      const gatewayAmountCents = toMinorUnits(toMinorUnits(amountUsd));
      const gatewaySeesUsd = gatewayAmountCents / 100;
      if (gatewaySeesUsd > order.totalUsd) {
        throw new RefundRejectedError(
          `gateway rejected refund of ${usd(gatewaySeesUsd)} on order ${order.orderId}: ` +
            `exceeds the order total ${usd(order.totalUsd)}`,
        );
      }
      return {
        success: true as const,
        refundId: `rf_${order.orderId}_01`,
        orderId: order.orderId,
        amountUsd: gatewaySeesUsd,
        reason,
        status: 'approved',
      };
    },
  }),

  searchKnowledgeBase: tool({
    description: 'Search policy articles (warranty, returns, protection plans) by topic.',
    inputSchema: z.object({
      query: z.string().describe('What to look for, e.g. "warranty coverage appliances"'),
    }),
    execute: async ({ query }) => {
      const terms = query.toLowerCase();
      const scored = KNOWLEDGE_BASE.map((entry) => ({
        entry,
        score: entry.title
          .toLowerCase()
          .split(/\W+/)
          .filter((word) => word.length > 3 && terms.includes(word)).length,
      }));
      scored.sort((a, b) => b.score - a.score);
      const best = (scored[0]?.score ?? 0) > 0 ? scored[0]!.entry : KNOWLEDGE_BASE[0]!;
      return { query, article: best };
    },
  }),
};
