import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { nodeStatus, runBadgeStatus, runHasActivePause } from '../src/store/types.js';
import { RUN, ev, resetCounters, started } from './helpers.js';

function reduce(events: ReturnType<typeof ev>[], initial: RunsMap = {}): RunsMap {
  return events.reduce((runs, event) => applyEvent(runs, event, 'fixture'), initial);
}

beforeEach(resetCounters);

describe('applyEvent — run lifecycle', () => {
  it('creates a run on run.started', () => {
    const runs = reduce([
      ev('run.started', { app: 'trip-planner', sdk: { name: 'ai', version: '7.0.79' } }),
    ]);
    const run = runs[RUN];
    expect(run).toBeDefined();
    expect(run?.meta.app).toBe('trip-planner');
    expect(run?.meta.status).toBe('running');
    expect(run?.meta.source).toBe('fixture');
  });

  it('records run.finished status and error', () => {
    const runs = reduce([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }),
      ev('run.finished', { status: 'error', error: { name: 'Boom', message: 'it broke' } }),
    ]);
    expect(runs[RUN]?.meta.status).toBe('error');
    expect(runs[RUN]?.meta.error?.message).toBe('it broke');
  });

  it('tolerates events arriving before run.started (out-of-order)', () => {
    const runs = reduce([
      started('tool:x', 'tool', { seq: 5 }),
      ev('run.started', { app: 'late', sdk: { name: 'ai', version: '7' } }, { seq: 1 }),
    ]);
    expect(runs[RUN]?.meta.app).toBe('late');
    expect(runs[RUN]?.nodes['tool:x']).toBeDefined();
  });
});

describe('applyEvent — dedup on (runId, seq)', () => {
  it('ignores a replayed envelope with an already-seen seq', () => {
    const first = started('tool:x', 'tool', { seq: 2, instanceId: 'call-1' });
    const runs1 = reduce([ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }, { seq: 1 }), first]);
    const runs2 = applyEvent(runs1, first, 'fixture');
    expect(runs2).toBe(runs1); // same reference — nothing changed
    expect(runs2[RUN]?.nodes['tool:x']?.executions).toHaveLength(1);
  });

  it('keeps separate seq spaces per run', () => {
    const runs = reduce([
      started('tool:x', 'tool', { seq: 7 }),
      started('tool:y', 'tool', { seq: 7, runId: 'other-run' }),
    ]);
    // second event used the same seq but a different runId — both applied
    expect(runs[RUN]?.nodes['tool:x']).toBeDefined();
    expect(runs['other-run']?.nodes['tool:y']).toBeDefined();
  });

  it('applies out-of-order seqs (gaps are tolerated, order is arrival order)', () => {
    const runs = reduce([
      started('tool:a', 'tool', { seq: 9 }),
      started('tool:b', 'tool', { seq: 3 }),
    ]);
    expect(runs[RUN]?.order).toEqual(['tool:a', 'tool:b']);
  });
});

describe('applyEvent — node lifecycle', () => {
  it('tracks executions per logical node (decisions #1)', () => {
    const runs = reduce([
      started('tool:getWeather', 'tool', { instanceId: 'call-1' }),
      ev('node.finished', { nodeId: 'tool:getWeather', output: { c: 21 }, durationMs: 50, status: 'ok' }),
      started('tool:getWeather', 'tool', { instanceId: 'call-2' }),
    ]);
    const node = runs[RUN]?.nodes['tool:getWeather'];
    expect(node?.executions).toHaveLength(2);
    expect(node?.executions[0]?.status).toBe('ok');
    expect(node?.executions[1]?.status).toBe('running');
    expect(node !== undefined && nodeStatus(node)).toBe('running');
  });

  it('finishes the latest running execution', () => {
    const runs = reduce([
      started('tool:w', 'tool', { instanceId: 'i1' }),
      started('tool:w', 'tool', { instanceId: 'i2' }),
      ev('node.finished', { nodeId: 'tool:w', output: 1, durationMs: 10, status: 'ok' }),
    ]);
    const node = runs[RUN]?.nodes['tool:w'];
    expect(node?.executions[1]?.status).toBe('ok');
    expect(node?.executions[0]?.status).toBe('running');
  });

  it('attaches node.error to the running execution and the node', () => {
    const runs = reduce([
      started('tool:fx', 'tool', { instanceId: 'c1' }),
      ev('node.error', { nodeId: 'tool:fx', error: { name: 'RateLimitError', message: '429' } }),
    ]);
    const node = runs[RUN]?.nodes['tool:fx'];
    expect(node?.lastError?.name).toBe('RateLimitError');
    expect(node?.executions[0]?.error?.message).toBe('429');
  });

  it('tolerates node.finished for a never-started node', () => {
    const before = reduce([ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } })]);
    const after = applyEvent(
      before,
      ev('node.finished', { nodeId: 'tool:ghost', output: null, durationMs: 1, status: 'ok' }),
      'fixture',
    );
    expect(after[RUN]?.nodes['tool:ghost']).toBeUndefined();
  });

  it('bumps structureVersion on new nodes but not on finish', () => {
    const runs1 = reduce([started('tool:a', 'tool')]);
    const v1 = runs1[RUN]?.structureVersion ?? -1;
    const runs2 = applyEvent(
      runs1,
      ev('node.finished', { nodeId: 'tool:a', output: null, durationMs: 1, status: 'ok' }),
      'fixture',
    );
    expect(runs2[RUN]?.structureVersion).toBe(v1);
    expect(runs2[RUN]?.statusVersion).toBeGreaterThan(runs1[RUN]?.statusVersion ?? 99);
  });
});

describe('applyEvent — graph.hint ghosts', () => {
  it('creates ghost nodes that upgrade on node.started', () => {
    const runs1 = reduce([
      ev('graph.hint', {
        nodes: [
          { nodeId: 'agent:a', kind: 'agent', name: 'a' },
          { nodeId: 'tool:t', kind: 'tool', name: 't', parentId: 'agent:a' },
        ],
      }),
    ]);
    const ghost = runs1[RUN]?.nodes['tool:t'];
    expect(ghost?.ghost).toBe(true);
    expect(ghost !== undefined && nodeStatus(ghost)).toBe('ghost');

    const runs2 = applyEvent(runs1, started('tool:t', 'tool', { parentId: 'agent:a' }), 'fixture');
    const lit = runs2[RUN]?.nodes['tool:t'];
    expect(lit?.ghost).toBe(false);
    expect(lit !== undefined && nodeStatus(lit)).toBe('running');
    // order is preserved from the hint — no duplicate entry
    expect(runs2[RUN]?.order.filter((id) => id === 'tool:t')).toHaveLength(1);
  });

  it('a hint never downgrades an executed node', () => {
    const runs = reduce([
      started('tool:t', 'tool'),
      ev('graph.hint', { nodes: [{ nodeId: 'tool:t', kind: 'tool', name: 't' }] }),
    ]);
    expect(runs[RUN]?.nodes['tool:t']?.ghost).toBe(false);
    expect(runs[RUN]?.nodes['tool:t']?.executions).toHaveLength(1);
  });
});

describe('applyEvent — pause bookkeeping', () => {
  const pauseSetup = () => [
    started('tool:fx', 'tool', { instanceId: 'c1' }),
    ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:fx', point: 'error' }),
  ];

  it('marks the node paused while the gate is held', () => {
    const runs = reduce(pauseSetup());
    const run = runs[RUN];
    expect(run?.pauses['p1']?.active).toBe(true);
    expect(run?.nodes['tool:fx']?.activePauseId).toBe('p1');
    const node = run?.nodes['tool:fx'];
    expect(node !== undefined && nodeStatus(node)).toBe('paused');
    expect(run !== undefined && runHasActivePause(run)).toBe(true);
  });

  it('exec.resumed clears the pause and records the action', () => {
    const runs = reduce([...pauseSetup(), ev('exec.resumed', { pauseId: 'p1', action: 'retry' })]);
    const run = runs[RUN];
    expect(run?.pauses['p1']?.active).toBe(false);
    expect(run?.pauses['p1']?.resolvedAction).toBe('retry');
    expect(run?.nodes['tool:fx']?.activePauseId).toBeUndefined();
    expect(run !== undefined && runHasActivePause(run)).toBe(false);
  });

  it('resume for an unknown pauseId is a no-op', () => {
    const before = reduce(pauseSetup());
    const after = applyEvent(before, ev('exec.resumed', { pauseId: 'nope', action: 'continue' }), 'fixture');
    expect(after[RUN]?.pauses['p1']?.active).toBe(true);
  });

  it('run badge shows paused while running with an active pause', () => {
    const runs = reduce([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }),
      ...pauseSetup(),
    ]);
    const run = runs[RUN];
    expect(run !== undefined && runBadgeStatus(run)).toBe('paused');
  });
});

describe('applyEvent — token + unknown handling', () => {
  it('node.token records its seq but leaves run state untouched', () => {
    const runs1 = reduce([started('llm:s1', 'llm')]);
    const structure = runs1[RUN]?.structureVersion;
    const status = runs1[RUN]?.statusVersion;
    const runs2 = applyEvent(
      runs1,
      ev('node.token', { nodeId: 'llm:s1', deltas: [{ t: 'text', v: 'hi' }] }),
      'fixture',
    );
    expect(runs2[RUN]?.structureVersion).toBe(structure);
    expect(runs2[RUN]?.statusVersion).toBe(status);
    expect(runs2[RUN]?.nodes['llm:s1']?.executions[0]?.status).toBe('running');
  });
});
