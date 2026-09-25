/**
 * Context & cost on an LLM step, in the built viewer: the price table is a
 * separate chunk, fetched once a run has token usage to price (never for a
 * run without); the step shows usage, a snapshot-priced cost, the held-cache
 * note and the prompt diff — including a tool whose schema changed, opened
 * as a definition diff; the top bar carries the priced run cost; the
 * bundled demo shows what changed between its steps.
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

test('the bundled demo: inclusive usage, and each step shows what changed since the one before', async ({ page }) => {
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
  // The demo records every step as it was sent (C1): step 2 is step 1 plus
  // the model's first turn and both tool results.
  await expect(ctx.getByTestId('diff-refused')).toHaveCount(0);
  const summary = ctx.getByTestId('prompt-diff').getByTestId('diff-summary');
  await expect(summary).toContainText('+2 added');
  await expect(summary).not.toContainText('removed');
  // claude-sonnet-4-5 is in the snapshot: priced.
  const priceNote = ctx.getByTestId('price-note');
  await expect(priceNote).toContainText('Priced as Anthropic claude-sonnet-4-5');
  await expect(priceNote).not.toContainText('recorded before GraphMind 0.6');
});

test('an OPEN before-gate hold: the held-cache note appears once it crosses the 5-minute cache lifetime', async ({ page }) => {
  // The previous step finished at T0+0.9 s; the next one was held at its
  // before gate at T0+1.1 s and is never released, so no event arrives while
  // the developer decides. The page clock starts 296 s after that finish.
  const OPEN = 'run-context-open-hold';
  const prevFinished = T0 + 900;
  let seq = 0;
  const e = (dt: number, type: string, payload: Record<string, unknown>) => ({ gm: 1, seq: ++seq, ts: T0 + dt, runId: OPEN, type, payload });
  const input = (content: string) => ({ prompt: [{ role: 'user', content }], modelId: 'claude-sonnet-4-5', provider: 'anthropic.messages' });
  const run = [
    e(0, 'run.started', { app: 'open-hold', sdk: { name: 'ai', version: '7.0.0' } }),
    e(0, 'node.started', { nodeId: 'agent:trip', kind: 'agent', name: 'trip', instanceId: OPEN }),
    e(10, 'node.started', { nodeId: 'llm:step', parentId: 'agent:trip', kind: 'llm', name: 'step', instanceId: 'i:s0', input: input('hi') }),
    e(900, 'node.finished', {
      nodeId: 'llm:step',
      instanceId: 'i:s0',
      output: { text: 'ok' },
      durationMs: 890,
      status: 'ok',
      usage: { inputTokens: 12_000, outputTokens: 300, inclusive: true, cacheReadTokens: 0, cacheWriteTokens: 11_000 },
    }),
    e(1_000, 'node.started', { nodeId: 'llm:step', parentId: 'agent:trip', kind: 'llm', name: 'step', instanceId: 'i:s1', input: input('hi again') }),
    e(1_100, 'exec.paused', { pauseId: 'p1', nodeId: 'llm:step', instanceId: 'i:s1', point: 'before', reason: 'breakpoint' }),
  ];
  await page.clock.install({ time: new Date(prevFinished + 296_000) });
  await openViewer(page, { embeddedRun: run });
  await expect(nodeCard(page, 'llm:step')).toBeVisible();
  // The price table lands first, so no later prop change re-runs the view by accident.
  await expect(page.locator('.gm-topbar-stats')).toContainText('est. cost');
  await nodeCard(page, 'llm:step').locator('.gm-node-title').click();
  const ctx = inspector(page).getByTestId('context-cost');
  await expect(ctx).toContainText('No usage yet — the step is still running.');
  await expect(ctx.getByTestId('cache-gap')).toHaveCount(0); // ≈ 296 s: inside the lifetime

  // 20 s of wall clock on the same open hold (≈ 316 s): the note is up.
  await page.clock.fastForward(20_000);
  await expect(ctx.getByTestId('cache-gap')).toHaveText(
    /^Held 5\.\d min before this call — the provider's 5-minute prompt cache has likely expired$/,
  );
  // And it keeps counting while the hold stays open.
  await page.clock.fastForward(5 * MIN);
  await expect(ctx.getByTestId('cache-gap')).toHaveText(/^Held 10 min before this call/);
  await expect(ctx).toContainText('No usage yet — the step is still running.'); // same view, never reloaded
});

/** A parallel multi-agent run: four sub-agents with steps and tools, one held gate, optionally one failure. */
function parallelRun(runId: string, withError: boolean): unknown[] {
  let seq = 0;
  const e = (dt: number, type: string, payload: Record<string, unknown>) => ({ gm: 1, seq: ++seq, ts: T0 + dt, runId, type, payload });
  const out: unknown[] = [
    e(0, 'run.started', { app: 'parallel-research', sdk: { name: 'ai', version: '7.0.0' } }),
    e(0, 'node.started', { nodeId: 'agent:orchestrator', kind: 'agent', name: 'orchestrator', instanceId: runId }),
  ];
  let t = 10;
  ['alpha', 'bravo', 'charlie', 'delta'].forEach((name, a) => {
    const agentId = `agent:${name}`;
    out.push(e(t, 'node.started', { nodeId: agentId, parentId: 'agent:orchestrator', kind: 'agent', name, instanceId: `i:${name}` }));
    for (let s = 0; s < 3; s += 1) {
      const stepId = `llm:${name}-step`;
      const inst = `i:${name}:s${s}`;
      t += 10;
      out.push(
        e(t, 'node.started', {
          nodeId: stepId,
          parentId: agentId,
          kind: 'llm',
          name: 'step',
          instanceId: inst,
          input: { prompt: [{ role: 'user', content: `task ${name} ${s}` }], modelId: 'claude-sonnet-4-5', provider: 'anthropic.messages' },
        }),
      );
      t += 900;
      out.push(
        e(t, 'node.finished', {
          nodeId: stepId,
          instanceId: inst,
          output: { text: 'ok' },
          durationMs: 900,
          status: 'ok',
          usage: { inputTokens: 21_000, outputTokens: 800, inclusive: true },
        }),
      );
      for (let k = 0; k < 2; k += 1) {
        const toolId = `tool:${name}-search-${k}`;
        const tInst = `c:${name}:${s}:${k}`;
        t += 10;
        out.push(e(t, 'node.started', { nodeId: toolId, parentId: stepId, kind: 'tool', name: `search${k}`, instanceId: tInst, input: { q: name } }));
        const fail = withError && a === 2 && s === 1 && k === 1;
        t += 300;
        out.push(
          e(
            t,
            'node.finished',
            fail
              ? { nodeId: toolId, instanceId: tInst, durationMs: 300, status: 'error', error: { name: 'RateLimitError', message: '429' } }
              : { nodeId: toolId, instanceId: tInst, output: { hits: 3 }, durationMs: 300, status: 'ok' },
          ),
        );
      }
    }
    t += 10;
    out.push(e(t, 'node.finished', { nodeId: agentId, instanceId: `i:${name}`, output: { done: true }, durationMs: 100, status: 'ok' }));
  });
  t += 10;
  out.push(e(t, 'node.started', { nodeId: 'tool:publish', parentId: 'agent:orchestrator', kind: 'tool', name: 'publish', instanceId: 'c:pub', input: {} }));
  out.push(e(t + 5, 'exec.paused', { pauseId: 'p1', nodeId: 'tool:publish', point: 'before', reason: 'breakpoint' }));
  out.push(e(t + 95_005, 'exec.resumed', { pauseId: 'p1', action: 'continue' }));
  t += 95_200;
  out.push(e(t, 'node.finished', { nodeId: 'tool:publish', instanceId: 'c:pub', output: { ok: true }, durationMs: 95_190, heldMs: 95_000, status: 'ok' }));
  t += 50;
  out.push(e(t, 'node.finished', { nodeId: 'agent:orchestrator', instanceId: runId, output: { ok: true }, durationMs: t, status: 'ok' }));
  out.push(e(t + 10, 'run.finished', { status: withError ? 'error' : 'ok' }));
  return out;
}

for (const [width, withError] of [
  [1440, false],
  [1440, true],
  [1200, true],
] as const) {
  test(`the est. cost stays whole in the top bar: ${width} px, runs rail open${withError ? ', with an error count' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openViewer(page, { embeddedRun: parallelRun(`run-topbar-${width}-${String(withError)}`, withError) });
    await expect(nodeCard(page, 'agent:orchestrator')).toBeVisible();
    await expect(page.locator('.gm-rail')).toBeVisible();
    const cost = page.locator('.gm-topbar-stats .gm-stat').filter({ hasText: 'est. cost' });
    await expect(cost).toBeVisible();
    await expect(cost.locator('.gm-stat-value')).toHaveText('$0.900');
    if (withError) await expect(page.locator('.gm-topbar-stats .gm-stat').filter({ hasText: 'errors' })).toBeVisible();
    // Geometry, not text content: nothing in the stats row sits past the
    // box's clip edge — the lowest-priority stats were shed instead.
    const g = await page.evaluate(() => {
      const box = document.querySelector('.gm-topbar-stats') as HTMLElement;
      const row = box.querySelector<HTMLElement>('.gm-topbar-stats-row');
      const edge = box.getBoundingClientRect().left + box.clientLeft;
      const right = edge + box.clientWidth;
      const shown = Array.from(box.querySelectorAll<HTMLElement>('.gm-stat')).filter((el) => !el.hidden);
      return {
        fits: row === null ? box.scrollWidth <= box.clientWidth : row.offsetWidth <= box.clientWidth,
        clipped: shown
          .filter((el) => el.getBoundingClientRect().right > right + 0.5 || el.getBoundingClientRect().left < edge - 0.5)
          .map((el) => el.textContent),
        shown: shown.map((el) => el.querySelector('.gm-stat-label')?.textContent),
      };
    });
    expect(g.clipped, `stats cut at the edge (shown: ${g.shown.join(', ')})`).toEqual([]);
    expect(g.fits).toBe(true);
  });
}
