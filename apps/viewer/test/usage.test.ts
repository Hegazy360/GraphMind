/**
 * Token usage in the viewer (contract C1): inclusive totals are trusted,
 * unmarked 0.5 events are labelled "as reported", 0.5 Anthropic TS events
 * (cacheCreationTokens) are recomputed, cache read / write and reasoning are
 * shown only when reported — and the per-model cost (context/cost.ts, the
 * only cost in the viewer) reads the same totals.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { pricedUsage, sumCosts } from '../src/context/cost.js';
import { activePrices, calcCost, resolveModel, type PriceTable } from '../src/prices/engine.js';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { summarizeGroup } from '../src/store/collapse.js';
import { nodeStats, runStats } from '../src/store/stats.js';
import type { RunState } from '../src/store/types.js';
import {
  addUsage,
  detailCells,
  emptyTotals,
  inputLabel,
  inputTitle,
  usageSummary,
  usageView,
} from '../src/lib/usage.js';
import { RUN, ev, resetCounters, started } from './helpers.js';
import demoRun from '../src/fixtures/demo-run.json';

beforeEach(resetCounters);

function buildRun(events: ReturnType<typeof ev>[]): RunState {
  const runs = events.reduce<RunsMap>((acc, event) => applyEvent(acc, event, 'fixture'), {});
  const run = runs[RUN];
  if (run === undefined) throw new Error('run not built');
  return run;
}

function llmStep(instanceId: string, usage: Record<string, unknown>): ReturnType<typeof ev>[] {
  return [
    started('llm:step', 'llm', { instanceId }),
    ev('node.finished', {
      nodeId: 'llm:step',
      instanceId,
      output: { text: 'x' },
      usage: usage as { inputTokens: number; outputTokens: number },
      durationMs: 10,
      status: 'ok',
    }),
  ];
}

const INCLUSIVE = {
  inputTokens: 1205,
  outputTokens: 100,
  inclusive: true,
  cacheReadTokens: 1000,
  cacheWriteTokens: 200,
  reasoningTokens: 12,
};
const LEGACY_ANTHROPIC_TS = { inputTokens: 5, outputTokens: 100, cacheReadTokens: 1000, cacheCreationTokens: 200 };
const LEGACY_OPENAI_TS = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 64 };
const LEGACY_PLAIN = { inputTokens: 7, outputTokens: 3 };

describe('usage view', () => {
  it('trusts inclusive usage and shows the reported extras only', () => {
    const view = usageView(INCLUSIVE);
    expect(view?.basis).toBe('inclusive');
    expect(inputLabel(view?.basis)).toBe('tokens in');
    expect(detailCells(view ?? {}).map((c) => [c.label, c.value])).toEqual([
      ['cache read', '1.0k'],
      ['cache write', '200'],
      ['reasoning', '12'],
    ]);
    expect(usageSummary(view!)).toBe('1205 in · 1000 cache read · 200 cache write · 100 out · 12 reasoning');
    expect(detailCells(usageView({ inputTokens: 1, outputTokens: 1, inclusive: true }) ?? {})).toEqual([]);
  });

  it('recomputes a 0.5 Anthropic TS event into a total', () => {
    const view = usageView(LEGACY_ANTHROPIC_TS);
    expect(view).toMatchObject({ inputTokens: 1205, basis: 'recomputed', cacheReadTokens: 1000, cacheWriteTokens: 200 });
    expect(inputLabel(view?.basis)).toBe('tokens in');
    expect(inputTitle(view?.basis)).toContain('recomputed');
  });

  it('labels an unmarked event "as reported"', () => {
    const view = usageView(LEGACY_PLAIN);
    expect(view?.basis).toBe('reported');
    expect(inputLabel(view?.basis)).toBe('tokens in (as reported)');
    expect(inputTitle(view?.basis)).toContain('may not include cached tokens');
    expect(usageSummary(view!)).toBe('7 in · 3 out (as reported)');
    // The 0.5 OpenAI alias still shows the cache read.
    expect(usageView(LEGACY_OPENAI_TS)).toMatchObject({ basis: 'reported', cacheReadTokens: 64 });
  });

  it('totals track a mixed basis', () => {
    const totals = emptyTotals();
    addUsage(totals, INCLUSIVE);
    expect(totals.basis).toBe('inclusive');
    addUsage(totals, LEGACY_ANTHROPIC_TS);
    expect(totals.basis).toBe('inclusive');
    addUsage(totals, LEGACY_PLAIN);
    expect(totals).toMatchObject({ inputTokens: 1205 + 1205 + 7, basis: 'mixed', cacheReadTokens: 2000, reasoningTokens: 12 });
    expect(inputLabel('mixed')).toBe('tokens in (partly as reported)');
    addUsage(totals, 'not a usage');
    expect(totals.inputTokens).toBe(2417);
  });
});

describe('stats', () => {
  it('node and run totals are inclusive, with cache and reasoning sums', () => {
    const run = buildRun([...llmStep('s1', INCLUSIVE), ...llmStep('s2', LEGACY_ANTHROPIC_TS)]);
    const node = run.nodes['llm:step']!;
    const stats = nodeStats(node);
    expect(stats).toMatchObject({
      tokensIn: 2410,
      tokensOut: 200,
      cacheReadTokens: 2000,
      cacheWriteTokens: 400,
      reasoningTokens: 12,
      tokenBasis: 'inclusive',
    });
    const whole = runStats(run);
    expect(whole).toMatchObject({ tokensIn: 2410, tokensOut: 200, cacheReadTokens: 2000, tokenBasis: 'inclusive' });
    expect(whole).not.toHaveProperty('estCostUsd'); // no blended rate any more
  });

  it('omits the extras when nothing reported them, and says "as reported"', () => {
    const run = buildRun(llmStep('s1', LEGACY_PLAIN));
    const stats = runStats(run);
    expect(stats.tokenBasis).toBe('reported');
    expect(stats).not.toHaveProperty('cacheReadTokens');
    expect(stats).not.toHaveProperty('reasoningTokens');
    expect(stats.tokensIn).toBe(7);
  });

  it('a run without usage has no basis', () => {
    const run = buildRun([started('tool:x', 'tool'), ev('node.finished', { nodeId: 'tool:x', instanceId: 'tool:x#1', output: 1, durationMs: 1, status: 'ok' })]);
    expect(runStats(run)).not.toHaveProperty('tokenBasis');
  });

  it('the cost reads the same inclusive / recomputed totals and prices the cached share per model', () => {
    const table = JSON.parse(
      readFileSync(fileURLToPath(new URL('../src/prices/data_slim.json', import.meta.url)), 'utf8'),
    ) as PriceTable;
    const run = buildRun([...llmStep('s1', INCLUSIVE), ...llmStep('s2', LEGACY_ANTHROPIC_TS)]);
    const node = run.nodes['llm:step']!;
    for (const exec of node.executions) exec.modelHint = { model: 'claude-sonnet-4-5' };
    const prices = activePrices(resolveModel(table, { model: 'claude-sonnet-4-5' })!.model, new Date(node.executions[0]!.startedTs))!;
    // Both executions read as 1,205 prompt tokens, 1,000 of them cache reads and 200 cache writes.
    const one = calcCost(pricedUsage(usageView(INCLUSIVE)!), prices)!;
    expect(one.input).toBeCloseTo((5 * 3) / 1e6, 12);
    expect(one.cacheRead).toBeCloseTo((1000 * 0.3) / 1e6, 12);
    expect(one.cacheWrite).toBeCloseTo((200 * 3.75) / 1e6, 12);
    const total = sumCosts(table, node.executions);
    expect(total).toMatchObject({ priced: 2, unpriced: 0, reported: 0 });
    expect(total.total).toBeCloseTo(2 * one.total, 12);
  });

  it('the folded-group badge sums the same totals', () => {
    const run = buildRun([
      started('agent:a', 'agent'),
      ...llmStep('s1', INCLUSIVE).map((event) => {
        if (event.type === 'node.started') (event.payload as { parentId?: string }).parentId = 'agent:a';
        return event;
      }),
    ]);
    const summary = summarizeGroup(run, 'agent:a');
    expect(summary.tokensIn).toBe(1205);
    expect(summary.tokensOut).toBe(100);
  });
});

describe('the bundled demo recording', () => {
  it('is a 0.6 recording: every LLM usage is inclusive, so the demo is never labelled "as reported"', () => {
    const usages = (demoRun as { payload?: { usage?: unknown } }[])
      .map((envelope) => envelope.payload?.usage)
      .filter((usage) => usage !== undefined);
    expect(usages.length).toBeGreaterThan(0);
    for (const usage of usages) expect(usageView(usage)?.basis).toBe('inclusive');
  });
});
