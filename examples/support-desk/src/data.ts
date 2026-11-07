/**
 * The shop's "backend": orders, shipments, inventory, policies. All in
 * memory and deterministic, so every scenario reproduces exactly — the
 * point of this example is watching the DEBUGGER, not the data.
 *
 * The planted failures live in tools.ts; this file is just honest records.
 */

export interface Order {
  orderId: string;
  customer: string;
  placedAt: string;
  status: 'delivered' | 'shipped' | 'processing';
  trackingId?: string;
  items: { sku: string; name: string; qty: number; unitPriceUsd: number }[];
  totalUsd: number;
}

export const ORDERS: Record<string, Order> = {
  '1041': {
    orderId: '1041',
    customer: 'Dana Whitfield',
    placedAt: '2026-10-29',
    status: 'shipped',
    trackingId: 'TRK-5520-X', // this carrier lane is down — see trackShipment
    items: [{ sku: 'ESP-MCH-02', name: 'Bellagio espresso machine', qty: 1, unitPriceUsd: 349 }],
    totalUsd: 349,
  },
  '1042': {
    orderId: '1042',
    customer: 'Sam Ortega',
    placedAt: '2026-10-30',
    status: 'delivered',
    trackingId: 'TRK-1042-OK',
    items: [{ sku: 'KBD-WRL-11', name: 'Aria wireless keyboard', qty: 1, unitPriceUsd: 89 }],
    totalUsd: 89,
  },
};

export interface ShipmentEvent {
  at: string;
  location: string;
  event: string;
}

export const SHIPMENTS: Record<string, ShipmentEvent[]> = {
  'TRK-1042-OK': [
    { at: '2026-10-31 08:12', location: 'Oakland, CA', event: 'Picked up' },
    { at: '2026-11-01 14:40', location: 'Reno, NV', event: 'In transit' },
    { at: '2026-11-03 09:05', location: 'Denver, CO', event: 'Out for delivery' },
    { at: '2026-11-03 16:21', location: 'Denver, CO', event: 'Delivered — signed by resident' },
  ],
  // TRK-5520-X exists, but its carrier's tracking API is down (tools.ts).
};

export const INVENTORY: Record<string, { name: string; inStock: number; restockEta?: string }> = {
  'KBD-WRL-11': { name: 'Aria wireless keyboard', inStock: 212 },
  'ESP-MCH-02': { name: 'Bellagio espresso machine', inStock: 17 },
  // PLW-SLP-01 lives behind the warehouse-sync outage — see checkInventory.
};

/**
 * Policy articles the knowledge base returns. Long on purpose: the
 * `research` scenario shows what three of these do to an agent's context
 * window (watch the input-token curve climb step over step).
 */
const FILLER =
  'This section is provided for completeness and restates the general principles above with ' +
  'additional detail regarding carrier responsibilities, claim windows, documentation ' +
  'requirements, regional exceptions, and escalation paths. ';

function article(title: string, body: string): { title: string; body: string } {
  return { title, body: `${body}\n\n${FILLER.repeat(60)}` };
}

export const KNOWLEDGE_BASE: { title: string; body: string }[] = [
  article(
    'Standard warranty policy',
    'All products carry a 12-month limited warranty from the delivery date, covering ' +
      'manufacturing defects. Accidental damage is excluded. Espresso machines and other ' +
      'appliances with water circuits require proof of descaling at least every 90 days for ' +
      'claims after month six. Warranty service is repair-first; replacement is offered when ' +
      'repair exceeds 14 business days.',
  ),
  article(
    'Returns and refunds',
    'Unopened items: 30 days, full refund to the original payment method. Opened items: 30 ' +
      'days, refund minus a 10% restocking fee unless the item is defective. Defective items ' +
      'are refunded in full or replaced at the customer\'s choice within the warranty window. ' +
      'Refunds over $500 require supervisor approval through the payments console.',
  ),
  article(
    'Extended protection plan terms',
    'The extended plan adds 24 months after the standard warranty and covers one accidental ' +
      'damage incident. It must be purchased within 30 days of delivery. Claims under the ' +
      'extended plan are replacement-first. The plan does not renew automatically.',
  ),
];
