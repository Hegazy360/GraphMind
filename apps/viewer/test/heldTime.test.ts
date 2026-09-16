/**
 * Held time is not run time — the viewer side.
 *
 * `durationMs` includes time the debugger held a node at a gate. Every place
 * the viewer shows, sums, filters or lays out a duration must use "ran" =
 * durationMs - heldMs, preferring the SDK's `heldMs` and deriving it from
 * exec.paused/exec.resumed timestamps for streams that predate the field.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { slowThresholdMs, matchingNodeIds } from '../src/store/filters.js';
import { failureContext, nodeStats, runStats } from '../src/store/stats.js';
import { buildTimeline } from '../src/store/timeline.js';
import type { RunState } from '../src/store/types.js';
import {
  derivedHeldMs,
  fmtRanHeld,
  heldIntervalsFor,
  heldMsOf,
  ranMs,
  runHeldMs,
  unionMs,
} from '../src/lib/duration.js';
import { RUN, ev, resetCounters, started } from './helpers.js';

beforeEach(resetCounters);

function buildRun(events: ReturnType<typeof ev>[]): RunState {
  const runs = events.reduce<RunsMap>((acc, event) => applyEvent(acc, event, 'fixture'), {});
  const run = runs[RUN];
  if (run === undefined) throw new Error('run not built');
  return run;
}

const exec = (run: RunState, nodeId: string, index = 0) => {
  const e = run.nodes[nodeId]?.executions[index];
  if (e === undefined) throw new Error(`no execution ${nodeId}#${index}`);
  return e;
};

const finished = (nodeId: string, durationMs: number, ts: number, extra: Record<string, unknown> = {}) =>
  ev('node.finished', { nodeId, output: 1, durationMs, status: 'ok', instanceId: `${nodeId}#1`, ...extra } as never, { ts });

describe('lib/duration — pure helpers', () => {
  it('unionMs counts overlapping intervals once', () => {
    expect(unionMs([])).toBe(0);
    expect(unionMs([{ start: 0, end: 10 }])).toBe(10);
    expect(unionMs([{ start: 0, end: 10 }, { start: 5, end: 20 }])).toBe(20);
    expect(unionMs([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toBe(20);
    expect(unionMs([{ start: 0, end: 10 }, { start: 20, end: 25 }])).toBe(15);
    expect(unionMs([{ start: 20, end: 25 }, { start: 0, end: 10 }, { start: 2, end: 3 }])).toBe(15);
    expect(unionMs([{ start: 10, end: 5 }, { start: Number.NaN, end: 3 }])).toBe(0);
  });

  it('ranMs subtracts heldMs and never goes negative; heldMsOf prefers the emitted value', () => {
    const base = { instanceId: 'i', input: undefined, status: 'ok' as const, startedTs: 0 };
    expect(ranMs({ ...base })).toBeUndefined();
    expect(ranMs({ ...base, durationMs: 38_102.4 })).toBe(38_102.4);
    expect(ranMs({ ...base, durationMs: 38_102.4, heldMs: 38_100 })).toBeCloseTo(2.4, 5);
    expect(ranMs({ ...base, durationMs: 100, derivedHeldMs: 30 })).toBe(70);
    // emitted wins over derived, even when smaller
    expect(ranMs({ ...base, durationMs: 100, heldMs: 10, derivedHeldMs: 90 })).toBe(90);
    // a held value larger than the duration (clock skew) clamps to zero, not negative
    expect(ranMs({ ...base, durationMs: 100, heldMs: 500 })).toBe(0);
    expect(heldMsOf({ ...base, heldMs: Number.NaN })).toBe(0);
    expect(heldMsOf({ ...base, heldMs: -3 })).toBe(0);
    expect(heldMsOf({ ...base })).toBe(0);
  });

  it('fmtRanHeld shows both halves only when something was held', () => {
    const base = { instanceId: 'i', input: undefined, status: 'ok' as const, startedTs: 0 };
    expect(fmtRanHeld({ ...base, durationMs: 38_102.4, heldMs: 38_100 })).toBe('ran 2.4ms · held 38.1s');
    expect(fmtRanHeld({ ...base, durationMs: 312, heldMs: 0 })).toBe('312ms');
    expect(fmtRanHeld({ ...base, durationMs: 312 })).toBe('312ms');
    expect(fmtRanHeld({ ...base, status: 'running' })).toBe('running');
    expect(fmtRanHeld({ ...base, status: 'aborted' })).toBe('—');
  });
});

describe('applyEvent — heldMs from the SDK', () => {
  it('keeps durationMs as sent and stores heldMs from node.finished', () => {
    const run = buildRun([
      started('tool:search', 'tool', { ts: 1000 }),
      finished('tool:search', 38_102.4, 40_000, { heldMs: 38_100 }),
    ]);
    const e = exec(run, 'tool:search');
    expect(e.durationMs).toBe(38_102.4);
    expect(e.heldMs).toBe(38_100);
    expect(ranMs(e)).toBeCloseTo(2.4, 5);
  });

  it('ignores a heldMs that is not a usable number', () => {
    for (const bad of ['38100', -1, Number.NaN, null, {}]) {
      resetCounters();
      const run = buildRun([
        started('tool:t', 'tool', { ts: 1000 }),
        finished('tool:t', 50, 1100, { heldMs: bad }),
      ]);
      expect(exec(run, 'tool:t').heldMs, String(bad)).toBeUndefined();
      expect(ranMs(exec(run, 'tool:t'))).toBe(50);
    }
  });

  it('accepts heldMs === 0 as measured (not missing)', () => {
    const run = buildRun([started('tool:t', 'tool', { ts: 1000 }), finished('tool:t', 0.07, 1001, { heldMs: 0 })]);
    expect(exec(run, 'tool:t').heldMs).toBe(0);
    expect(ranMs(exec(run, 'tool:t'))).toBe(0.07);
  });

  it('takes heldMs from node.error too (the running total at that point)', () => {
    const run = buildRun([
      started('tool:t', 'tool', { ts: 1000 }),
      ev('node.error', { nodeId: 'tool:t', instanceId: 'tool:t#1', error: { name: 'E', message: 'x' }, heldMs: 1000 } as never, { ts: 2100 }),
    ]);
    expect(exec(run, 'tool:t').heldMs).toBe(1000);
  });
});

describe('applyEvent — heldMs derived from exec.paused / exec.resumed', () => {
  it('attributes a before-gate hold to the running instance and subtracts it', () => {
    const run = buildRun([
      started('tool:search', 'tool', { ts: 1000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:search', point: 'before' }, { ts: 1010 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 39_110 }),
      finished('tool:search', 38_112.4, 39_112),
    ]);
    const e = exec(run, 'tool:search');
    expect(e.heldMs).toBeUndefined(); // an old stream: nothing emitted
    expect(e.derivedHeldMs).toBe(38_100);
    expect(heldMsOf(e)).toBe(38_100);
    expect(ranMs(e)).toBeCloseTo(12.4, 5);
    expect(run.pauses['p1']?.resolvedTs).toBe(39_110);
    expect(run.pauses['p1']?.heldBy).toEqual([{ nodeId: 'tool:search', instanceId: 'tool:search#1' }]);
  });

  it('prefers the emitted heldMs over the derived one when both exist', () => {
    const run = buildRun([
      started('tool:t', 'tool', { ts: 1000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'before' }, { ts: 1000 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 2000 }),
      finished('tool:t', 1005, 2005, { heldMs: 999.5 }),
    ]);
    const e = exec(run, 'tool:t');
    expect(e.derivedHeldMs).toBe(1000);
    expect(heldMsOf(e)).toBe(999.5);
  });

  it('sums several holds inside one instance (before, error → retry, before again)', () => {
    const run = buildRun([
      started('tool:flaky', 'tool', { ts: 1000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:flaky', point: 'before' }, { ts: 1000 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 2000 }),
      ev('node.error', { nodeId: 'tool:flaky', instanceId: 'tool:flaky#1', error: { name: 'E', message: 'boom' } }, { ts: 2005 }),
      ev('exec.paused', { pauseId: 'p2', nodeId: 'tool:flaky', point: 'error' }, { ts: 2005 }),
      ev('exec.resumed', { pauseId: 'p2', action: 'retry' }, { ts: 4005 }),
      ev('exec.paused', { pauseId: 'p3', nodeId: 'tool:flaky', point: 'before' }, { ts: 4005 }),
      ev('exec.resumed', { pauseId: 'p3', action: 'continue' }, { ts: 4305 }),
      finished('tool:flaky', 3310, 4310),
    ]);
    expect(derivedHeldMs(run, 'tool:flaky', exec(run, 'tool:flaky'), 9999)).toBe(3300);
    expect(ranMs(exec(run, 'tool:flaky'))).toBe(10);
  });

  it('a hold that opens after the instance finished belongs to nobody (LangGraph error-gate ordering)', () => {
    const run = buildRun([
      started('tool:t', 'tool', { ts: 1000, instanceId: 'c1' }),
      ev('node.finished', { nodeId: 'tool:t', instanceId: 'c1', output: 1, durationMs: 12, status: 'error' }, { ts: 1012 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'error' }, { ts: 1013 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 41_013 }),
      started('tool:t', 'tool', { ts: 41_020, instanceId: 'c2' }),
      ev('node.finished', { nodeId: 'tool:t', instanceId: 'c2', output: 1, durationMs: 9, status: 'ok' }, { ts: 41_029 }),
    ]);
    expect(run.pauses['p1']?.heldBy).toEqual([]);
    expect(ranMs(exec(run, 'tool:t', 0))).toBe(12);
    expect(ranMs(exec(run, 'tool:t', 1))).toBe(9);
  });

  it('a hold that opens after the node finished is still held time on its open ancestors and the run root', () => {
    // LangGraph's handler emits node.finished and THEN gates error/after: the
    // tool never contained the hold, but the graph node and the agent did.
    const run = buildRun([
      ev('run.started', { app: 'a', sdk: { name: 'langgraph', version: '7' } }, { ts: 900 }),
      started('agent:graph', 'agent', { ts: 1000, instanceId: RUN }),
      started('chain:node', 'custom', { ts: 1001, instanceId: 'n1', parentId: 'agent:graph' }),
      started('tool:t', 'tool', { ts: 1002, instanceId: 'c1', parentId: 'chain:node' }),
      ev('node.finished', { nodeId: 'tool:t', instanceId: 'c1', output: 1, durationMs: 12, status: 'error' }, { ts: 1014 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'error' }, { ts: 1015 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 41_015 }),
      started('tool:t', 'tool', { ts: 41_020, instanceId: 'c2', parentId: 'chain:node' }),
      ev('node.finished', { nodeId: 'tool:t', instanceId: 'c2', output: 1, durationMs: 9, status: 'ok' }, { ts: 41_029 }),
      ev('node.finished', { nodeId: 'chain:node', instanceId: 'n1', output: 1, durationMs: 40_029, status: 'ok' }, { ts: 41_030 }),
      ev('node.finished', { nodeId: 'agent:graph', instanceId: RUN, output: 1, durationMs: 40_031, status: 'ok' }, { ts: 41_031 }),
    ]);
    expect(run.pauses['p1']?.heldBy).toEqual([
      { nodeId: 'chain:node', instanceId: 'n1' },
      { nodeId: 'agent:graph', instanceId: RUN },
    ]);
    expect(ranMs(exec(run, 'tool:t', 0))).toBe(12);
    expect(ranMs(exec(run, 'tool:t', 1))).toBe(9);
    expect(heldMsOf(exec(run, 'chain:node'))).toBe(40_000);
    expect(ranMs(exec(run, 'chain:node'))).toBe(29);
    expect(heldMsOf(exec(run, 'agent:graph'))).toBe(40_000);
    expect(ranMs(exec(run, 'agent:graph'))).toBe(31);
  });

  it('clamps a derived hold to the execution\'s own lifetime (fixture replay: synthetic resume after a recorded finish)', () => {
    // The recording says the node finished 340 ms after the pause opened
    // (durationMs 1710 covers exactly that), but the interactive replay's
    // synthetic exec.resumed carries real wall time — long after.
    const run = buildRun([
      started('tool:currencyConvert', 'tool', { ts: 4715, instanceId: 'call_c1' }),
      ev('exec.paused', { pauseId: 'pause-8f31', nodeId: 'tool:currencyConvert', point: 'error' }, { ts: 6335 }),
      ev('exec.resumed', { pauseId: 'pause-8f31', action: 'continue' }, { ts: 60_000 }),
      ev('node.finished', { nodeId: 'tool:currencyConvert', instanceId: 'call_c1', output: 1, durationMs: 1710, status: 'error' }, { ts: 6675 }),
    ]);
    const e = exec(run, 'tool:currencyConvert');
    expect(e.derivedHeldMs).toBe(340);
    expect(ranMs(e)).toBe(1370);
  });

  it('credits the hold to open ancestors and the run root, once, as a union', () => {
    const run = buildRun([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }, { ts: 900 }),
      started('agent:trip', 'agent', { ts: 1000, instanceId: RUN }), // root: instanceId === runId
      started('llm:step', 'llm', { ts: 1000, parentId: 'agent:trip' }),
      finished('llm:step', 50, 1050),
      started('tool:weather', 'tool', { ts: 1100, parentId: 'llm:step' }), // parent already finished
      ev('exec.paused', { pauseId: 'pw', nodeId: 'tool:weather', point: 'before' }, { ts: 1100 }),
      started('tool:currency', 'tool', { ts: 2100, parentId: 'llm:step' }),
      ev('exec.paused', { pauseId: 'pc', nodeId: 'tool:currency', point: 'before' }, { ts: 2100 }),
      ev('exec.resumed', { pauseId: 'pw', action: 'continue' }, { ts: 4100 }),
      ev('exec.resumed', { pauseId: 'pc', action: 'continue' }, { ts: 4600 }),
      finished('tool:weather', 3001, 4101),
      finished('tool:currency', 2502, 4602),
      ev('node.finished', { nodeId: 'agent:trip', instanceId: RUN, output: 1, durationMs: 3610, status: 'ok' }, { ts: 4610 }),
    ]);
    expect(run.pauses['pw']?.heldBy).toEqual([
      { nodeId: 'tool:weather', instanceId: 'tool:weather#1' },
      { nodeId: 'agent:trip', instanceId: RUN },
    ]);
    expect(ranMs(exec(run, 'tool:weather'))).toBe(1);
    expect(ranMs(exec(run, 'tool:currency'))).toBe(2);
    // The agent was held for 3.5 s of wall time (1100→4600), not 5.5 s.
    expect(heldMsOf(exec(run, 'agent:trip'))).toBe(3500);
    expect(ranMs(exec(run, 'agent:trip'))).toBe(110);
    // The step had finished before the tools ran: nothing to subtract there.
    expect(ranMs(exec(run, 'llm:step'))).toBe(50);
  });

  it('a hold that opens while an instance is still running is reflected once it resolves, then finalised at finish', () => {
    const events = [
      started('tool:t', 'tool', { ts: 1000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'before' }, { ts: 1000 }),
    ];
    let run = buildRun(events);
    expect(heldIntervalsFor(run, 'tool:t', exec(run, 'tool:t'), 1500)).toEqual([{ start: 1000, end: 1500 }]);
    expect(exec(run, 'tool:t').derivedHeldMs).toBeUndefined(); // nothing final yet
    run = buildRun([...events, ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 3000 })]);
    expect(exec(run, 'tool:t').derivedHeldMs).toBe(2000);
    run = buildRun([
      ...events,
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 3000 }),
      finished('tool:t', 2004, 3004),
    ]);
    expect(ranMs(exec(run, 'tool:t'))).toBe(4);
  });

  it('after-gates go to the oldest running instance; before-gates to the newest', () => {
    const run = buildRun([
      started('tool:t', 'tool', { ts: 1000, instanceId: 'A' }),
      started('tool:t', 'tool', { ts: 1001, instanceId: 'B' }),
      ev('exec.paused', { pauseId: 'pa', nodeId: 'tool:t', point: 'after' }, { ts: 1100 }),
      ev('exec.paused', { pauseId: 'pb', nodeId: 'tool:t', point: 'before' }, { ts: 1100 }),
    ]);
    expect(run.pauses['pa']?.heldBy).toEqual([{ nodeId: 'tool:t', instanceId: 'A' }]);
    expect(run.pauses['pb']?.heldBy).toEqual([{ nodeId: 'tool:t', instanceId: 'B' }]);
  });

  it('runHeldMs is the union of every pause in the run, open ones running to now', () => {
    const run = buildRun([
      started('tool:a', 'tool', { ts: 1000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'before' }, { ts: 1000 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 2000 }),
      started('tool:b', 'tool', { ts: 1500 }),
      ev('exec.paused', { pauseId: 'p2', nodeId: 'tool:b', point: 'before' }, { ts: 1500 }),
    ]);
    expect(runHeldMs(run, 2500)).toBe(1500); // 1000→2000 ∪ 1500→2500
  });
});

describe('every consumer uses ran, not wall', () => {
  function heldRun(): RunState {
    return buildRun([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }, { ts: 1000 }),
      started('agent:a', 'agent', { ts: 1000, instanceId: RUN }),
      started('tool:fast', 'tool', { ts: 1000, parentId: 'agent:a' }),
      finished('tool:fast', 20, 1020),
      started('tool:held', 'tool', { ts: 1100, parentId: 'agent:a' }),
      finished('tool:held', 40_005, 41_105, { heldMs: 40_000 }), // 5 ms of work, 40 s of thinking
      started('tool:slow', 'tool', { ts: 41_200, parentId: 'agent:a' }),
      finished('tool:slow', 900, 42_100),
      ev('node.finished', { nodeId: 'agent:a', instanceId: RUN, output: 1, durationMs: 41_200, status: 'ok', heldMs: 40_000 }, { ts: 42_200 }),
      ev('run.finished', { status: 'ok' }, { ts: 42_200 }),
    ]);
  }

  it('the slow filter ignores held time', () => {
    const run = heldRun();
    // durations (ran): 20, 5, 900, 1200 → p90 = 1200 (the agent); with wall it would be 40 s.
    expect(slowThresholdMs(run)).toBe(1200);
    const lit = matchingNodeIds(run, { kinds: null, status: 'slow', errorPathOnly: false });
    expect(lit.has('tool:held')).toBe(false);
    expect(lit.has('agent:a')).toBe(true);
  });

  it('node and run stats sum ran and report held separately', () => {
    const run = heldRun();
    const held = run.nodes['tool:held'];
    if (held === undefined) throw new Error('missing');
    const stats = nodeStats(held);
    expect(stats.totalMs).toBe(5);
    expect(stats.maxMs).toBe(5);
    expect(stats.avgMs).toBe(5);
    expect(stats.heldMs).toBe(40_000);
    const rs = runStats(run, 99_999);
    expect(rs.wallMs).toBe(41_200);
    expect(rs.heldMs).toBe(0); // no exec.paused envelopes in this stream — heldMs came from the SDK only
    expect(rs.ranMs).toBe(41_200);
  });

  it('run stats subtract a union of pauses from wall time', () => {
    const run = buildRun([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }, { ts: 1000 }),
      started('tool:a', 'tool', { ts: 1000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'before' }, { ts: 1000 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 31_000 }),
      finished('tool:a', 30_010, 31_010),
      ev('run.finished', { status: 'ok' }, { ts: 31_020 }),
    ]);
    const rs = runStats(run, 99_999);
    expect(rs.wallMs).toBe(30_020);
    expect(rs.heldMs).toBe(30_000);
    expect(rs.ranMs).toBe(20);
  });

  it('the failure context reports siblings by ran time', () => {
    const run = buildRun([
      started('llm:s', 'llm', { ts: 1000 }),
      started('tool:bad', 'tool', { ts: 1000, parentId: 'llm:s' }),
      ev('node.error', { nodeId: 'tool:bad', instanceId: 'tool:bad#1', error: { name: 'E', message: 'x' } }, { ts: 1005 }),
      finished('tool:bad', 5, 1005, { status: 'error' }),
      started('tool:held', 'tool', { ts: 1000, parentId: 'llm:s' }),
      finished('tool:held', 10_007, 11_007, { heldMs: 10_000 }),
    ]);
    const context = failureContext(run, 'tool:bad');
    expect(context.siblings).toEqual([{ nodeId: 'tool:held', name: 'held', status: 'ok', ranMs: 7 }]);
  });

  it('timeline bars keep wall geometry but label, total and hatch by held time', () => {
    const run = buildRun([
      started('tool:t', 'tool', { ts: 1000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'before' }, { ts: 1010 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 39_110 }),
      finished('tool:t', 38_112.4, 39_112),
    ]);
    const model = buildTimeline(run, 99_999);
    const row = model.rows[0];
    const bar = row?.bars[0];
    if (row === undefined || bar === undefined) throw new Error('no bar');
    expect(bar.startTs).toBe(1000);
    expect(bar.endTs).toBe(39_112); // geometry is wall: the bar spans the hold
    expect(bar.heldMs).toBe(38_100);
    expect(bar.ranMs).toBeCloseTo(12.4, 5);
    expect(bar.held).toEqual([{ start: 1010, end: 39_110 }]);
    expect(row.totalMs).toBeCloseTo(12.4, 5);
    expect(row.heldMs).toBe(38_100);
  });

  it('an open bar with an open hold reports ran-so-far without the hold', () => {
    const run = buildRun([
      started('tool:t', 'tool', { ts: 1000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'before' }, { ts: 1200 }),
    ]);
    const bar = buildTimeline(run, 5000).rows[0]?.bars[0];
    expect(bar?.running).toBe(true);
    expect(bar?.endTs).toBe(5000);
    expect(bar?.heldMs).toBe(3800);
    expect(bar?.ranMs).toBe(200);
    expect(bar?.held).toEqual([{ start: 1200, end: 5000 }]);
  });

  it('a bar with an SDK heldMs but no pause envelopes has nothing to hatch, and still labels ran', () => {
    const run = buildRun([
      started('tool:t', 'tool', { ts: 1000 }),
      finished('tool:t', 40_005, 41_005, { heldMs: 40_000 }),
    ]);
    const bar = buildTimeline(run, 99_999).rows[0]?.bars[0];
    expect(bar?.held).toEqual([]);
    expect(bar?.heldMs).toBe(40_000);
    expect(bar?.ranMs).toBe(5);
  });
});
