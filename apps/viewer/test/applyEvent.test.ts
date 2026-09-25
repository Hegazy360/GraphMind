import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { matchingNodeIds } from '../src/store/filters.js';
import { NODE_DIMENSIONS, PAUSE_BANNER_HEIGHT, nodeDimensions } from '../src/store/runStateToFlow.js';
import { heldExecutionIndex } from '../src/lib/gate.js';
import {
  executionError,
  nodeStatus,
  recoveredError,
  runBadgeStatus,
  runHasActivePause,
  type NodeExecution,
  type NodeState,
  type RunState,
} from '../src/store/types.js';
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

  it('two parallel holds on one node: releasing one leaves the node showing the other', () => {
    const TOOL = 'tool:convertCurrency';
    const runs = reduce([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }),
      started(TOOL, 'tool', { instanceId: 'call-a' }),
      started(TOOL, 'tool', { instanceId: 'call-b' }),
      ev('exec.paused', { pauseId: 'pause_1', nodeId: TOOL, point: 'error', instanceId: 'call-a' }),
      ev('exec.paused', { pauseId: 'pause_2', nodeId: TOOL, point: 'error', instanceId: 'call-b' }),
      ev('exec.resumed', { pauseId: 'pause_2', action: 'continue' }),
      ev('node.finished', { nodeId: TOOL, instanceId: 'call-b', durationMs: 9, status: 'error' }),
    ]);
    const run = runs[RUN];
    const node = run?.nodes[TOOL];
    if (run === undefined || node === undefined) throw new Error('missing state');
    expect(run.pauses['pause_1']?.active).toBe(true);
    expect(runBadgeStatus(run)).toBe('paused');
    expect({
      activePauseId: node.activePauseId,
      status: nodeStatus(node),
      height: nodeDimensions(node).height,
      pausedFilter: matchingNodeIds(run, { kinds: null, status: 'paused', errorPathOnly: false }).has(TOOL),
    }).toEqual({
      activePauseId: 'pause_1',
      status: 'paused',
      height: NODE_DIMENSIONS.tool.height + PAUSE_BANNER_HEIGHT,
      pausedFilter: true,
    });
    // …and once the last one goes, the node is released for good.
    const done = applyEvent(runs, ev('exec.resumed', { pauseId: 'pause_1', action: 'continue' }), 'fixture');
    expect(done[RUN]?.nodes[TOOL]?.activePauseId).toBeUndefined();
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

describe('applyEvent — the sender\'s `collapsed` hint (0.5.0)', () => {
  it('keeps the hint on the node, sticky across later executions that omit it', () => {
    const runs1 = reduce([
      ev('node.started', {
        nodeId: 'mcp:protocol',
        kind: 'custom',
        name: 'protocol',
        instanceId: 'p1',
        collapsed: true,
      }),
    ]);
    expect(runs1[RUN]?.nodes['mcp:protocol']?.collapsed).toBe(true);

    const runs2 = reduce(
      [
        ev('node.finished', { nodeId: 'mcp:protocol', instanceId: 'p1', durationMs: 1, status: 'ok' }),
        ev('node.started', { nodeId: 'mcp:protocol', kind: 'custom', name: 'protocol', instanceId: 'p2' }),
      ],
      runs1,
    );
    expect(runs2[RUN]?.nodes['mcp:protocol']?.collapsed).toBe(true);
  });

  it('is absent for a node that was never hinted', () => {
    const runs = reduce([
      ev('node.started', { nodeId: 'tool:t', kind: 'tool', name: 't', instanceId: 't1' }),
    ]);
    expect(runs[RUN]?.nodes['tool:t']?.collapsed).toBeUndefined();
  });
});

/**
 * Parallel calls, one failing while a sibling still runs: `node.error` must
 * land on the call that threw, and the inspector must open on the call the
 * pause names — the same one the editor pre-fills from.
 */
describe.each([
  ['node.error without instanceId (the AI SDK adapter)', false],
  ['node.error with instanceId (openai / anthropic / mcp / langgraph)', true],
])('applyEvent — which parallel call failed: %s', (_label, withId) => {
  const NODE = 'tool:currencyConvert';
  const ERR = { name: 'Error', message: 'unknown currency code "XYZ"' };
  const held = (): RunsMap =>
    reduce([
      ev('run.started', { app: 'fx-agent', sdk: { name: 'ai', version: '7' } }),
      started('llm:step', 'llm', { instanceId: 'step-1' }),
      started(NODE, 'tool', { parentId: 'llm:step', instanceId: 'call-a', input: { amount: 50, from: 'EUR', to: 'XYZ' } }),
      started(NODE, 'tool', { parentId: 'llm:step', instanceId: 'call-b', input: { amount: 50, from: 'EUR', to: 'GBP' } }),
      ev('node.error', withId ? { nodeId: NODE, instanceId: 'call-a', error: ERR } : { nodeId: NODE, error: ERR }),
      ev('exec.paused', { pauseId: 'p-err', nodeId: NODE, point: 'error', instanceId: 'call-a' }),
    ]);
  const byId = (node: NodeState | undefined, id: string): NodeExecution => {
    const exec = node?.executions.find((e) => e.instanceId === id);
    if (exec === undefined) throw new Error(`no execution ${id}`);
    return exec;
  };

  it('while held: the error belongs to the call that threw, not the one still running', () => {
    const node = held()[RUN]?.nodes[NODE];
    expect(byId(node, 'call-a').error).toEqual(ERR);
    expect(byId(node, 'call-b').error).toBeUndefined();
  });

  it('while held: the inspector opens on the execution the pause names', () => {
    const run = held()[RUN] as RunState;
    expect(heldExecutionIndex(run, NODE)).toBe(0); // call-a, not the latest (call-b)
  });

  it('after the run: the successful call shows no failure; the failed one owns its error', () => {
    const runs = reduce(
      [
        ev('node.finished', { nodeId: NODE, instanceId: 'call-b', output: { converted: 42.5 }, durationMs: 30, status: 'ok' }),
        ev('exec.resumed', { pauseId: 'p-err', action: 'continue' }),
        ev('node.finished', { nodeId: NODE, instanceId: 'call-a', durationMs: 40, status: 'error' }),
        ev('run.finished', { status: 'error', error: ERR }),
      ],
      held(),
    );
    const run = runs[RUN] as RunState;
    const node = run.nodes[NODE] as NodeState;
    expect(executionError(run, node, byId(node, 'call-b'))).toBeUndefined();
    expect(recoveredError(byId(node, 'call-b'))).toBeUndefined();
    expect(executionError(run, node, byId(node, 'call-a'))).toEqual(ERR);
  });
});

/**
 * "Why this failed" leads only for an execution that owns the error: never
 * for a call held BEFORE it runs (an error-repeat hold on the 4th call), and
 * a call that failed and then succeeded on retry shows the failure as
 * history, not as the headline.
 */
describe('applyEvent — which execution owns the node\'s error', () => {
  const SQL = 'tool:runSql';
  const DB_ERROR = { name: 'DatabaseError', message: 'relation "t" does not exist' };
  function failing(n: number): ReturnType<typeof ev>[] {
    const out: ReturnType<typeof ev>[] = [];
    for (let i = 0; i < n; i++) {
      out.push(started(SQL, 'tool', { instanceId: `c${i}`, name: 'runSql', input: { sql: `SELECT * FROM t${i}` } }));
      out.push(ev('node.error', { nodeId: SQL, error: DB_ERROR }));
      out.push(ev('node.finished', { nodeId: SQL, instanceId: `c${i}`, durationMs: 4, status: 'error' }));
    }
    return out;
  }

  it('a call held at its before gate (error-repeat) has not failed', () => {
    const runs = reduce([
      ev('run.started', { app: 'sql-agent', sdk: { name: 'ai', version: '7' } }),
      ...failing(3),
      started(SQL, 'tool', { instanceId: 'c3', name: 'runSql', input: { sql: 'SELECT * FROM t3' } }),
      ev('exec.paused', {
        pauseId: 'p-er',
        nodeId: SQL,
        point: 'before',
        reason: 'loop',
        instanceId: 'c3',
        loop: { repeats: 3, firstSeq: 4, lastSeq: 13, fingerprint: 'salted-1', kind: 'error-repeat' },
      }),
    ]);
    const run = runs[RUN] as RunState;
    const node = run.nodes[SQL] as NodeState;
    const heldCall = node.executions.at(-1) as NodeExecution;
    expect(heldCall.status).toBe('running');
    expect(node.lastError).toEqual(DB_ERROR);
    expect(executionError(run, node, heldCall)).toBeUndefined();
    // The earlier calls did fail.
    expect(executionError(run, node, node.executions[0] as NodeExecution)).toEqual(DB_ERROR);
  });

  it('a running call held at its error gate does own the error', () => {
    const runs = reduce([
      started(SQL, 'tool', { instanceId: 'c0', name: 'runSql' }),
      ev('node.error', { nodeId: SQL, error: DB_ERROR }),
      ev('exec.paused', { pauseId: 'p-err', nodeId: SQL, point: 'error', instanceId: 'c0' }),
    ]);
    const run = runs[RUN] as RunState;
    const node = run.nodes[SQL] as NodeState;
    expect(executionError(run, node, node.executions[0] as NodeExecution)).toEqual(DB_ERROR);
  });

  it('a retry that succeeds shows the earlier failure as history, not as the headline', () => {
    const runs = reduce([
      started(SQL, 'tool', { instanceId: 'c0', name: 'runSql', input: { sql: 'SELECT * FROM t' } }),
      ev('node.error', { nodeId: SQL, error: DB_ERROR }),
      ev('exec.paused', { pauseId: 'p-err', nodeId: SQL, point: 'error', instanceId: 'c0', editable: true }),
      ev('exec.resumed', { pauseId: 'p-err', action: 'retry', edited: { after: { sql: 'SELECT * FROM users' } } }),
      ev('node.finished', { nodeId: SQL, instanceId: 'c0', output: { rows: 3 }, durationMs: 9, status: 'ok' }),
    ]);
    const run = runs[RUN] as RunState;
    const node = run.nodes[SQL] as NodeState;
    const exec = node.executions[0] as NodeExecution;
    expect(exec.status).toBe('ok');
    expect(executionError(run, node, exec)).toBeUndefined();
    expect(recoveredError(exec)).toEqual(DB_ERROR);
  });
});
