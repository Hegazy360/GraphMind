/**
 * Five support tickets, each engineered so a specific GraphMind feature has
 * something real to catch. The prompts are ordinary tickets; the traps are
 * in the tools (tools.ts) and in one deliberately risky line of the system
 * prompt ("retry transient carrier errors") — exactly the kind of line real
 * agents ship with.
 */

export interface Scenario {
  name: string;
  /** The run node's label in the viewer. */
  runName: string;
  /** What this ticket is, in one line, for the console. */
  ticket: string;
  prompt: string;
  /** Step cap for the agent loop (generous; the debugger is the show). */
  maxSteps: number;
  /** What to watch for, printed before the run. */
  expect: string[];
}

export const SYSTEM_PROMPT = `You are the support agent for Fernweh Home Goods.

Rules:
- Always look the order up before answering questions about it.
- Carrier tracking APIs are flaky: a timeout or 5xx from trackShipment is
  usually transient, so retry the lookup when it fails.
- When a backend reports it cannot answer (an unavailable service, a failed
  lookup), say so honestly and tell the customer when to check back. Do not
  guess.
- Refunds: verify the order first, then refund the exact item total using
  refundPayment with the amount in US dollars.
- Keep the final reply to the customer short and warm.`;

export const SCENARIOS: Record<string, Scenario> = {
  happy: {
    name: 'happy',
    runName: 'ticket-where-is-1042',
    ticket: 'Where is my order? (everything works)',
    prompt:
      'Customer message: "Hi, I\'m Sam Ortega — where is my order #1042, and when will it arrive?"',
    maxSteps: 6,
    expect: [
      'a clean run: lookupOrder, then trackShipment, all green',
      'the Behaviour strip says "No wasted work detected..."',
      'this is the baseline — every other scenario should look different',
    ],
  },

  refund: {
    name: 'refund',
    runName: 'ticket-refund-1042',
    ticket: 'Refund a broken item (the planted 100× bug throws)',
    prompt:
      'Customer message: "My Aria wireless keyboard from order #1042 arrived broken. ' +
      'Please refund it." Process the refund for the item total.',
    maxSteps: 6,
    expect: [
      'refundPayment throws RefundRejectedError — the run FREEZES there (pause-on-error)',
      'inspect the held call: input says amountUsd: 89, the error says the gateway saw $8,900',
      'prove the 100× hypothesis: RETRY with amountUsd edited to 0.89 — it succeeds',
      'or INJECT {"success":true,"refundId":"rf_1042_01","amountUsd":89,"status":"approved"}',
      'or CONTINUE to let the error through — the agent apologizes to the customer',
    ],
  },

  stock: {
    name: 'stock',
    runName: 'ticket-stock-pillow',
    ticket: 'Stock check during a warehouse outage (a failure that never throws)',
    prompt:
      'Customer message: "Do you have the SleepRight pillow, SKU PLW-SLP-01? I\'d like two."',
    maxSteps: 6,
    expect: [
      'checkInventory RETURNS {success: false, ...} — nothing throws',
      'the run still holds: the error-result smart breakpoint caught the shape',
      'CONTINUE and the agent (per its rules) tells the customer to check back',
      '`graphmind runs --behavior last` counts it under SILENT failures',
    ],
  },

  loop: {
    name: 'loop',
    runName: 'ticket-where-is-1041',
    ticket: 'Tracking a shipment on a dead carrier lane (the retry loop)',
    prompt:
      'Customer message: "It\'s Dana — order #1041 was shipped a week ago and I still have ' +
      'nothing. Where is it right now?"',
    maxSteps: 8,
    expect: [
      'trackShipment times out; the system prompt says carrier errors are transient — so the agent retries',
      'the SAME call fails the SAME way: the loop guard holds the third identical failure',
      'the hold names the streak; CONTINUE a couple of times or ABORT',
      'then `graphmind runs --behavior last`: a repeat incident (identical calls), wasted calls, and the tokens the loop burned',
    ],
  },

  research: {
    name: 'research',
    runName: 'ticket-warranty-research',
    ticket: 'A policy question that floods the context (watch the token curve)',
    prompt:
      'Customer message: "I bought the Bellagio espresso machine about 400 days ago (order ' +
      '#1041) and it just stopped heating. Am I covered?" Research the warranty policy, the ' +
      'returns policy, and the extended protection terms separately, then draft the reply.',
    maxSteps: 10,
    expect: [
      'three searchKnowledgeBase calls, each returning a deliberately long article',
      'watch input tokens climb step over step (the Behaviour strip\'s context line, or Context & cost on an LLM step)',
      'nothing fails here — this is what context pressure looks like before it hurts',
    ],
  },
};

export const SCENARIO_ORDER = ['happy', 'refund', 'stock', 'loop', 'research'] as const;
