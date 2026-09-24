/**
 * Context & cost on an LLM step, in the built viewer: the price table is a
 * separate chunk, fetched once a run has token usage to price (never for a
 * run without); the step shows usage, a snapshot-priced cost, the held-cache
 * note and the prompt diff — including a tool whose schema changed, opened
 * as a definition diff; the top bar carries the priced run cost; a preview
 * prompt is refused.
 */
import { readFileSync } from 'node:fs';
import { FIXTURE_NODES, expect, nodeCard, openViewer, test } from './harness.js';

const RUN = 'run-context-e2e';
const T0 = Date.parse('2026-09-01T12:00:00Z');
const MIN = 60_000;

const system = { role: 'system', content: 'You are a travel planner.\nUse tools.' };
const ask = { role: 'user', content: [{ type: 'text', text: 'Plan a trip to Lisbon.' }] };
const call = {
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'searchFlights', input: { to: 'LIS' } }],
};
const result = {
  role: 'tool',
  content: [
    { type: 'tool-result', toolCallId: 'c1', toolName: 'searchFlights', output: { type: 'json', value: { id: 'TP1234' } } },
  ],
};

function envelopes(): unknown[] {
  let seq = 0;
  const e = (dt: number, type: string, payload: Record<string, unknown>) => ({
    gm: 1,
    seq: ++seq,
    ts: T0 + dt,
    runId: RUN,
    type,
    payload,
  });
  // Contract C1 shape: tools by schema hash, each definition once per run.
  const flightsV1 = { type: 'function', name: 'searchFlights', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } };
  const flightsV2 = {
    type: 'function',
    name: 'searchFlights',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, date: { type: 'string' } }, required: ['to'] },
  };
  const llmInput = (prompt: unknown[], hash: string, schema: unknown) => ({
    prompt,
    modelId: 'claude-sonnet-4-5',
    provider: 'anthropic.messages',
    temperature: 0.2,
    tools: [{ name: 'searchFlights', schemaHash: hash }],
    toolSchemas: { [hash]: schema },
  });
  return [
    e(0, 'run.started', { app: 'context-e2e', sdk: { name: 'ai', version: '7.0.0' } }),
    e(0, 'node.started', { nodeId: 'agent:trip', kind: 'agent', name: 'trip', instanceId: RUN }),
    e(10, 'node.started', { nodeId: 'llm:step', parentId: 'agent:trip', kind: 'llm', name: 'step', instanceId: 'i:s0', input: llmInput([system, ask], 'aaaaaaaaaaaaaaaa', flightsV1) }),
    e(900, 'node.finished', {
      nodeId: 'llm:step',
      instanceId: 'i:s0',
      output: { text: '' },
      durationMs: 890,
      status: 'ok',
      usage: { inputTokens: 12_000, outputTokens: 300, inclusive: true, cacheReadTokens: 0, cacheWriteTokens: 11_000 },
    }),
    e(1_000, 'node.started', { nodeId: 'tool:searchFlights', parentId: 'llm:step', kind: 'tool', name: 'searchFlights', instanceId: 'c1', input: { to: 'LIS' } }),
    e(1_100, 'exec.paused', { pauseId: 'p1', nodeId: 'tool:searchFlights', point: 'before', reason: 'breakpoint' }),
    e(1_100 + 8 * MIN, 'exec.resumed', { pauseId: 'p1', action: 'continue' }),
    e(1_200 + 8 * MIN, 'node.finished', { nodeId: 'tool:searchFlights', instanceId: 'c1', output: { id: 'TP1234' }, durationMs: 8 * MIN + 100, heldMs: 8 * MIN, status: 'ok' }),
    e(1_300 + 8 * MIN, 'node.started', { nodeId: 'llm:step', parentId: 'agent:trip', kind: 'llm', name: 'step', instanceId: 'i:s1', input: llmInput([system, ask, call, result], 'bbbbbbbbbbbbbbbb', flightsV2) }),
    e(2_100 + 8 * MIN, 'node.finished', {
      nodeId: 'llm:step',
      instanceId: 'i:s1',
      output: { text: 'Booked TP1234.' },
      durationMs: 800,
      status: 'ok',
      usage: { inputTokens: 12_400, outputTokens: 120, inclusive: true, cacheReadTokens: 0, cacheWriteTokens: 12_300 },
    }),
    e(2_200 + 8 * MIN, 'run.finished', { status: 'ok' }),
  ];
}

function inspector(page: import('@playwright/test').Page) {
  return page.getByRole('complementary', { name: 'Node inspector' });
}

test('a run without token usage never fetches the price table', async ({ page }) => {
  const priceRequests: string[] = [];
  page.on('request', (request) => {
    if (/data_slim/.test(request.url())) priceRequests.push(request.url());
  });
  const noUsage = envelopes().map((envelope) => {
    const copy = structuredClone(envelope) as { payload: Record<string, unknown> };
    delete copy.payload['usage'];
    return copy;
  });
  await openViewer(page, { embeddedRun: noUsage });
  await expect(nodeCard(page, 'llm:step')).toBeVisible();
  await nodeCard(page, 'llm:step').locator('.gm-node-title').click();
  await expect(inspector(page).getByTestId('context-cost')).toContainText('This step reported no token usage.');
  await page.waitForTimeout(300);
  expect(priceRequests).toEqual([]);
  await expect(page.locator('.gm-topbar-stats')).not.toContainText('est. cost');
});

test('prices load lazily, then the step shows usage, cost, the held-cache note and the diff', async ({ page }) => {
  const priceRequests: string[] = [];
  page.on('request', (request) => {
    if (/data_slim/.test(request.url())) priceRequests.push(request.url());
  });

  await openViewer(page, { embeddedRun: envelopes() });
  await expect(nodeCard(page, 'llm:step')).toBeVisible();

  // The run has usage: its priced total reaches the top bar (one fetch of the chunk).
  await expect(page.locator('.gm-topbar-stats')).toContainText('$0.097');
  expect(priceRequests).toHaveLength(1);

  await nodeCard(page, 'llm:step').locator('.gm-node-title').click();
  const ctx = inspector(page).getByTestId('context-cost');
  await expect(ctx).toBeVisible();
  await expect(ctx).toContainText('≈ est. (prices as of 2026-09-22)');
  await expect(ctx.locator('.gm-inspect-stat', { hasText: 'this step' })).toContainText('$0.048');
  await expect(ctx.locator('.gm-inspect-stat', { hasText: 'run so far' })).toContainText('$0.097');
  await expect(ctx.locator('.gm-inspect-stat', { hasText: 'tokens in' })).toContainText('12k');
  await expect(ctx.locator('.gm-inspect-stat', { hasText: 'of context' })).toContainText('6%');
  expect(priceRequests).toHaveLength(1);

  await expect(ctx.getByTestId('cache-gap')).toHaveText(
    "Held 8 min before this call — the provider's 5-minute prompt cache has likely expired",
  );
  const diff = ctx.getByTestId('prompt-diff');
  await expect(diff.getByTestId('diff-summary')).toContainText('first difference at message #2 of 3');
  await expect(diff.getByTestId('diff-summary')).toContainText('+2 added');
  await expect(diff.getByTestId('prefix-break')).toContainText('The tool list changed');
  const added = diff.getByTestId('diff-row-added');
  await expect(added).toHaveCount(2);
  await added.nth(1).getByRole('button').click();
  await expect(added.nth(1)).toContainText('← searchFlights {"id":"TP1234"}');

  // The changed tool opens as a diff of its two recorded definitions.
  await diff.getByRole('button', { name: /searchFlights schema/ }).click();
  const schema = diff.getByTestId('line-diff').last();
  await expect(schema.locator('.gm-ctx-line--ins', { hasText: '"date": {' })).toHaveCount(1);

  // The first step has nothing to compare against.
  await inspector(page).locator('.gm-exec-chip').first().click();
  await expect(ctx.getByTestId('diff-first')).toBeVisible();
  await expect(ctx.getByTestId('cache-gap')).toHaveCount(0);
});

test('the bundled demo: inclusive usage, a preview prompt is refused with the reason', async ({ page }) => {
  const demo = JSON.parse(readFileSync(new URL('../src/fixtures/demo-run.json', import.meta.url), 'utf8')) as unknown[];
  await openViewer(page, { embeddedRun: demo });
  await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Fit view' }).click();
  await page.waitForTimeout(700);
  await nodeCard(page, FIXTURE_NODES.llm).locator('.gm-node-title').click();

  const ctx = inspector(page).getByTestId('context-cost');
  await inspector(page).locator('.gm-exec-chip').nth(1).click();
  // The demo recordings carry `inclusive: true` (0.6.0), so the count is the
  // whole prompt — no "as reported" label, no pre-0.6 caveat on the price.
  const tokensIn = ctx.locator('.gm-inspect-stat', { hasText: 'tokens in' });
  await expect(tokensIn).toHaveAttribute('title', /Total prompt tokens, cached tokens included\./);
  await expect(tokensIn).not.toContainText('as reported');
  await expect(ctx.getByTestId('diff-refused')).toHaveText(
    "Can't compare: This step recorded a preview string instead of the messages.",
  );
  // claude-sonnet-4-5 is in the snapshot: priced.
  const priceNote = ctx.getByTestId('price-note');
  await expect(priceNote).toContainText('Priced as Anthropic claude-sonnet-4-5');
  await expect(priceNote).not.toContainText('recorded before GraphMind 0.6');
});
