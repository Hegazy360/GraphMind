/**
 * The waterfall model: rows, overlap lanes, the streaming phase, gate
 * markers, and the time window.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { buildTimeline, tickStepMs, ticksFor } from '../src/store/timeline.js';
import type { RunState } from '../src/store/types.js';
import { RUN, ev, resetCounters, started } from './helpers.js';

beforeEach(resetCounters);

function buildRun(events: ReturnType<typeof ev>[]): RunState {
  const runs = events.reduce<RunsMap>((acc, event) => applyEvent(acc, event, 'fixture'), {});
  const run = runs[RUN];
  if (run === undefined) throw new Error('run not built');
  return run;
}

describe('buildTimeline — rows and bars', () => {
  it('emits one row per executed node, ordered by first start', () => {
    const run = buildRun([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }, { ts: 1000 }),
      started('agent:a', 'agent', { ts: 1000 }),
      started('tool:late', 'tool', { parentId: 'agent:a', ts: 3000 }),
      started('tool:early', 'tool', { parentId: 'agent:a', ts: 2000 }),
      ev('graph.hint', { nodes: [{ nodeId: 'tool:never', kind: 'tool', name: 'never' }] }),
    ]);
    const model = buildTimeline(run, 5000);
    expect(model.rows.map((r) => r.nodeId)).toEqual(['agent:a', 'tool:early', 'tool:late']);
    // A node known only from a hint has nothing to draw.
    expect(model.rows.some((r) => r.nodeId === 'tool:never')).toBe(false);
  });

  it('indents rows by depth', () => {
    const run = buildRun([
      started('agent:a', 'agent'),
      started('llm:s', 'llm', { parentId: 'agent:a' }),
      started('tool:t', 'tool', { parentId: 'llm:s' }),
    ]);
    const depths = Object.fromEntries(buildTimeline(run, 9999).rows.map((r) => [r.nodeId, r.depth]));
    expect(depths).toEqual({ 'agent:a': 0, 'llm:s': 1, 'tool:t': 2 });
  });

  it('uses durationMs when the finish timestamp is the only thing missing', () => {
    const run = buildRun([
      started('tool:t', 'tool', { ts: 1000 }),
      ev('node.finished', { nodeId: 'tool:t', output: 1, durationMs: 250, status: 'ok' }, { ts: 1400 }),
    ]);
    const bar = buildTimeline(run, 9999).rows[0]?.bars[0];
    // finishedTs (envelope ts) wins when present — it is the observed truth.
    expect(bar?.endTs).toBe(1400);
    expect(bar?.running).toBe(false);
  });

  it('extends an open bar to `now` and marks the model live', () => {
    const run = buildRun([started('tool:t', 'tool', { ts: 1000 })]);
    const model = buildTimeline(run, 4321);
    expect(model.live).toBe(true);
    expect(model.rows[0]?.bars[0]?.endTs).toBe(4321);
    expect(model.t1).toBeGreaterThanOrEqual(4321);
  });
});

describe('buildTimeline — overlap lanes', () => {
  it('puts concurrent instances of one node on separate lanes', () => {
    const run = buildRun([
      started('tool:w', 'tool', { instanceId: 'c1', ts: 1000 }),
      started('tool:w', 'tool', { instanceId: 'c2', ts: 1100 }),
      ev('node.finished', { nodeId: 'tool:w', instanceId: 'c1', output: 1, durationMs: 500, status: 'ok' } as never, { ts: 1500 }),
      ev('node.finished', { nodeId: 'tool:w', instanceId: 'c2', output: 1, durationMs: 400, status: 'ok' } as never, { ts: 1500 }),
    ]);
    const row = buildTimeline(run, 9999).rows[0];
    expect(row?.lanes).toBe(2);
    expect(row?.bars.map((b) => b.lane)).toEqual([0, 1]);
  });

  it('reuses a lane for sequential instances', () => {
    const run = buildRun([
      started('tool:w', 'tool', { instanceId: 'c1', ts: 1000 }),
      ev('node.finished', { nodeId: 'tool:w', instanceId: 'c1', output: 1, durationMs: 100, status: 'ok' } as never, { ts: 1100 }),
      started('tool:w', 'tool', { instanceId: 'c2', ts: 2000 }),
      ev('node.finished', { nodeId: 'tool:w', instanceId: 'c2', output: 1, durationMs: 100, status: 'ok' } as never, { ts: 2100 }),
    ]);
    const row = buildTimeline(run, 9999).rows[0];
    expect(row?.lanes).toBe(1);
    expect(row?.bars.every((b) => b.lane === 0)).toBe(true);
  });
});

describe('buildTimeline — streaming phase and markers', () => {
  it('carries the stream window from the token registry', () => {
    const run = buildRun([
      started('llm:s', 'llm', { ts: 1000 }),
      ev('node.finished', { nodeId: 'llm:s', output: null, durationMs: 900, status: 'ok' }, { ts: 1900 }),
    ]);
    const model = buildTimeline(run, 9999, (nodeId, index, count) =>
      nodeId === 'llm:s' && index === 0 && count === 1 ? { firstTs: 1400, lastTs: 1850 } : undefined,
    );
    const bar = model.rows[0]?.bars[0];
    expect(bar?.streamStartTs).toBe(1400);
    expect(bar?.streamEndTs).toBe(1850);
  });

  it('marks gates as held while unresolved and resolved afterwards', () => {
    const run = buildRun([
      started('tool:t', 'tool', { ts: 1000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'error' }, { ts: 1200 }),
    ]);
    const held = buildTimeline(run, 9999);
    expect(held.markers).toHaveLength(1);
    expect(held.markers[0]?.kind).toBe('pause');
    expect(held.markers[0]?.ts).toBe(1200);

    const resumed = buildTimeline(
      (() => {
        const next = applyEvent({ [RUN]: run }, ev('exec.resumed', { pauseId: 'p1', action: 'retry' }), 'fixture');
        const value = next[RUN];
        if (value === undefined) throw new Error('missing run');
        return value;
      })(),
      9999,
    );
    expect(resumed.markers[0]?.kind).toBe('resume');
    expect(resumed.markers[0]?.label).toContain('retry');
  });
});

describe('timeline ticks', () => {
  it('picks round steps', () => {
    expect(tickStepMs(6000)).toBe(1000);
    expect(tickStepMs(60_000)).toBe(10_000);
    expect(tickStepMs(300)).toBe(50);
  });

  it('covers the whole span', () => {
    const ticks = ticksFor(5000);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(5000 - tickStepMs(5000));
    expect(ticks.every((t, i) => i === 0 || t > (ticks[i - 1] ?? 0))).toBe(true);
  });
});
