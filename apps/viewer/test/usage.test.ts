/**
 * Token usage in the viewer (contract C1): inclusive totals are trusted,
 * unmarked 0.5 events are labelled "as reported", 0.5 Anthropic TS events
 * (cacheCreationTokens) are recomputed, cache read / write and reasoning are
 * shown only when reported, and the blended cost prices the cached share at
 * the cache multipliers.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { summarizeGroup } from '../src/store/collapse.js';
import {
  CACHE_READ_RATE,
  CACHE_WRITE_RATE,
  RATE_IN_PER_MTOK,
  RATE_OUT_PER_MTOK,
  estimateCostUsd,
  nodeStats,
  runStats,
} from '../src/store/stats.js';
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
    expect(whole.estCostUsd).toBeCloseTo(estimateCostUsd(2410, 200, { read: 2000, write: 400 }), 12);
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
    expect(runStats(run).estCostUsd).toBe(0);
  });

  it('prices the cached share at the cache multipliers', () => {
    const plain = estimateCostUsd(1_000_000, 0);
    expect(plain).toBe(RATE_IN_PER_MTOK);
    const cached = estimateCostUsd(1_000_000, 0, { read: 900_000 });
    expect(cached).toBeCloseTo((100_000 + 900_000 * CACHE_READ_RATE) / 1_000_000 * RATE_IN_PER_MTOK, 12);
    const written = estimateCostUsd(1_000_000, 1_000_000, { write: 1_000_000 });
    expect(written).toBeCloseTo(CACHE_WRITE_RATE * RATE_IN_PER_MTOK + RATE_OUT_PER_MTOK, 12);
    // A reported cache larger than the total (inconsistent sender) never goes negative.
    expect(estimateCostUsd(10, 0, { read: 100 })).toBeGreaterThan(0);
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
