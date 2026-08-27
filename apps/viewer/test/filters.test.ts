/**
 * Canvas filters and rollups: what stays lit, what "slow" means in a given
 * run, and the numbers the inspector and toolbar report.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import {
  EMPTY_FILTER,
  errorPathIds,
  filterSummary,
  isFilterActive,
  matchingNodeIds,
  slowThresholdMs,
} from '../src/store/filters.js';
import { estimateCostUsd, failureContext, nodeStats, runStats } from '../src/store/stats.js';
import { agentCountsFor, childrenIndexOf, forgetRun, hasChildren } from '../src/store/derived.js';
import type { RunState } from '../src/store/types.js';
import { RUN, ev, resetCounters, started } from './helpers.js';

beforeEach(() => {
  resetCounters();
  forgetRun(RUN);
});

function buildRun(events: ReturnType<typeof ev>[]): RunState {
  const runs = events.reduce<RunsMap>((acc, event) => applyEvent(acc, event, 'fixture'), {});
  const run = runs[RUN];
  if (run === undefined) throw new Error('run not built');
  return run;
}

/** agent → llm step → three tools, the last of which fails. */
function runWithFailure(): RunState {
  return buildRun([
    ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }, { ts: 1000 }),
    started('agent:a', 'agent', { ts: 1000 }),
    started('llm:s', 'llm', { parentId: 'agent:a', ts: 1100 }),
    started('tool:fast', 'tool', { parentId: 'llm:s', ts: 1200 }),
    ev('node.finished', { nodeId: 'tool:fast', output: 1, durationMs: 20, status: 'ok' }),
    started('tool:slow', 'tool', { parentId: 'llm:s', ts: 1300 }),
    ev('node.finished', { nodeId: 'tool:slow', output: 1, durationMs: 9000, status: 'ok' }),
    started('tool:bad', 'tool', { parentId: 'llm:s', ts: 1400 }),
    ev('node.error', { nodeId: 'tool:bad', error: { name: 'Boom', message: 'nope' } }),
    ev('node.finished', { nodeId: 'tool:bad', output: null, durationMs: 30, status: 'error' }),
  ]);
}

describe('filters', () => {
  it('is inactive by default and lets everything through', () => {
    const run = runWithFailure();
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(matchingNodeIds(run, EMPTY_FILTER).size).toBe(run.order.length);
  });

  it('error path keeps the failure and its ancestors only', () => {
    const run = runWithFailure();
    expect([...errorPathIds(run)].sort()).toEqual(['agent:a', 'llm:s', 'tool:bad']);
    const lit = matchingNodeIds(run, { ...EMPTY_FILTER, errorPathOnly: true });
    expect(lit.has('tool:bad')).toBe(true);
    expect(lit.has('llm:s')).toBe(true);
    expect(lit.has('tool:fast')).toBe(false);
  });

  it('status filters select the obvious things', () => {
    const run = runWithFailure();
    expect([...matchingNodeIds(run, { ...EMPTY_FILTER, status: 'error' })]).toEqual(['tool:bad']);
    expect([...matchingNodeIds(run, { ...EMPTY_FILTER, status: 'running' })]).toEqual(['agent:a', 'llm:s']);
  });

  it('"slow" is relative to the run, with a floor', () => {
    const run = runWithFailure();
    expect(slowThresholdMs(run)).toBe(9000);
    expect([...matchingNodeIds(run, { ...EMPTY_FILTER, status: 'slow' })]).toEqual(['tool:slow']);
    // A run where everything is fast flags nothing on the 200ms floor.
    const quick = buildRun([
      started('tool:a', 'tool'),
      ev('node.finished', { nodeId: 'tool:a', output: 1, durationMs: 3, status: 'ok' }),
    ]);
    expect(slowThresholdMs(quick)).toBe(200);
    expect(matchingNodeIds(quick, { ...EMPTY_FILTER, status: 'slow' }).size).toBe(0);
  });

  it('kind and status compose', () => {
    const run = runWithFailure();
    const lit = matchingNodeIds(run, { kinds: ['tool'], status: 'error', errorPathOnly: false });
    expect([...lit]).toEqual(['tool:bad']);
    expect(filterSummary({ kinds: ['tool'], status: 'error', errorPathOnly: true })).toBe(
      'tool · error · error path',
    );
  });
});

describe('stats', () => {
  it('rolls up a node across executions', () => {
    const run = buildRun([
      started('tool:w', 'tool', { instanceId: 'c1' }),
      ev('node.finished', { nodeId: 'tool:w', instanceId: 'c1', output: null, durationMs: 100, status: 'error' } as never),
      started('tool:w', 'tool', { instanceId: 'c2' }),
      ev('node.finished', { nodeId: 'tool:w', instanceId: 'c2', output: 1, durationMs: 300, status: 'ok' } as never),
    ]);
    const node = run.nodes['tool:w'];
    if (node === undefined) throw new Error('missing node');
    const stats = nodeStats(node);
    expect(stats).toMatchObject({ executions: 2, retries: 1, errors: 1, totalMs: 400, avgMs: 200, maxMs: 300 });
  });

  it('sums usage and estimates spend', () => {
    const run = buildRun([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }, { ts: 1000 }),
      started('llm:s', 'llm'),
      ev('node.finished', {
        nodeId: 'llm:s',
        output: null,
        durationMs: 100,
        status: 'ok',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
      ev('run.finished', { status: 'ok' }, { ts: 6000 }),
    ]);
    const stats = runStats(run, 9999);
    expect(stats.tokensIn).toBe(1_000_000);
    expect(stats.steps).toBe(1);
    expect(stats.wallMs).toBe(5000);
    expect(stats.estCostUsd).toBeCloseTo(18, 6); // $3 in + $15 out per Mtok
    expect(estimateCostUsd(0, 0)).toBe(0);
  });

  it('collects the parent and siblings of a failure', () => {
    const run = runWithFailure();
    const context = failureContext(run, 'tool:bad');
    expect(context.parent?.nodeId).toBe('llm:s');
    expect(context.siblings.map((s) => s.nodeId)).toEqual(['tool:fast', 'tool:slow']);
    expect(context.siblings[0]?.durationMs).toBe(20);
  });
});

describe('derived caches', () => {
  it('reuses the child index until the structure changes', () => {
    const run = runWithFailure();
    const first = childrenIndexOf(run);
    expect(childrenIndexOf(run)).toBe(first); // same reference — no re-walk
    expect(hasChildren(run, 'llm:s')).toBe(true);
    expect(hasChildren(run, 'tool:fast')).toBe(false);

    const grown = applyEvent({ [RUN]: run }, started('tool:new', 'tool', { parentId: 'llm:s' }), 'fixture')[RUN];
    if (grown === undefined) throw new Error('missing run');
    expect(childrenIndexOf(grown)).not.toBe(first);
    expect(childrenIndexOf(grown).get('llm:s')).toContain('tool:new');
  });

  it('counts an agent subtree once for every card on screen', () => {
    const run = runWithFailure();
    expect(agentCountsFor(run, 'agent:a')).toEqual({ steps: 1, tools: 3 });
    expect(agentCountsFor(run, 'tool:fast')).toEqual({ steps: 0, tools: 0 });
  });
});
