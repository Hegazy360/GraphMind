/**
 * The 0.6.0 hold kinds and argument edits in the store, and every sentence
 * the banner says about them:
 *
 *  - the reducer keeps `smart`, `editable`, `loop.kind/period/laps` off
 *    `exec.paused`, records `exec.refused` without releasing the gate, and
 *    puts `exec.resumed.edited` on the pause and on the instance that ran;
 *  - loop kinds (repeat / cycle / error-repeat) and smart rules
 *    (error-result / truncated-tool-call) each read as one sentence, live
 *    and past tense;
 *  - a cycle's lap is the set of nodes the canvas outlines.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { MAX_REFUSALS_PER_PAUSE, applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import {
  EDIT_LIVE_ARGS,
  EDIT_MAX_LIMIT,
  EDIT_NODES,
  EDIT_PAUSE_ID,
  EDIT_RECORDED_ARGS,
  EDIT_RUN_ID,
  generateEditRun,
  simulateEditResume,
} from '../src/store/editFixture.js';
import {
  HOLD_NODES,
  HOLD_RUN_ID,
  generateCycleRun,
  generateErrorRepeatRun,
  generateSmartRun,
} from '../src/store/holdFixtures.js';
import { heldLapNodeIds, holdBannerText, holdHint, smartBannerText } from '../src/store/holds.js';
import { cycleLap, errorStreak, errorStreakArguments, loopBannerText } from '../src/store/loop.js';
import { RUN, ev, resetCounters, started } from './helpers.js';
import type { RunState } from '../src/store/types.js';

beforeEach(resetCounters);

function build(events: ReturnType<typeof ev>[], runId = RUN): RunState {
  const runs = events.reduce<RunsMap>((acc, e) => applyEvent(acc, e, 'fixture'), {});
  const run = runs[runId];
  if (run === undefined) throw new Error('no run');
  return run;
}

function get(run: RunState, nodeId: string, pauseId = 'p1') {
  const node = run.nodes[nodeId];
  const pause = run.pauses[pauseId];
  if (node === undefined || pause === undefined) throw new Error(`missing ${nodeId}/${pauseId}`);
  return { node, pause };
}

describe('applyEvent: exec.paused 0.6.0 fields', () => {
  it('keeps editable only when true, and a smart hold with its rule and detail', () => {
    const run = build([
      started('tool:search', 'tool'),
      ev('exec.paused', {
        pauseId: 'p1',
        nodeId: 'tool:search',
        point: 'after',
        reason: 'breakpoint',
        smart: { rule: 'error-result', detail: 'isError: true' },
        editable: true,
      }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }),
      ev('exec.paused', { pauseId: 'p2', nodeId: 'tool:search', point: 'before', editable: false }),
    ]);
    expect(run.pauses['p1']).toMatchObject({
      reason: 'breakpoint',
      smart: { rule: 'error-result', detail: 'isError: true' },
      editable: true,
    });
    expect(run.pauses['p2']).not.toHaveProperty('editable');
    expect(run.pauses['p2']).not.toHaveProperty('smart');
  });

  it('drops a smart object with an unknown rule, and holds its detail to short plain text', () => {
    const run = build([
      started('tool:a', 'tool'),
      ev('exec.paused', {
        pauseId: 'p1',
        nodeId: 'tool:a',
        point: 'after',
        smart: { rule: 'error-result', detail: `bad\u0007‮ ${'x'.repeat(400)}` },
      }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }),
    ]);
    const detail = run.pauses['p1']?.smart?.detail ?? '';
    expect(detail.startsWith('bad x')).toBe(true);
    expect(detail.length).toBe(200);
    expect(detail.endsWith('…')).toBe(true);
    // A rule a newer sender invents (the schema would reject it; the reducer tolerates it).
    const runs: RunsMap = applyEvent({}, started('tool:b', 'tool'), 'fixture');
    const next = applyEvent(
      runs,
      { ...ev('exec.paused', { pauseId: 'p9', nodeId: 'tool:b', point: 'after' }), payload: { pauseId: 'p9', nodeId: 'tool:b', point: 'after', smart: { rule: 'vibes' } } } as never,
      'fixture',
    );
    expect(next[RUN]?.pauses['p9']).not.toHaveProperty('smart');
  });

  it('keeps loop.kind / period / laps, and ignores a malformed extra without losing the loop', () => {
    const run = build([
      started('tool:s', 'tool'),
      ev('exec.paused', {
        pauseId: 'p1',
        nodeId: 'tool:s',
        point: 'before',
        reason: 'loop',
        loop: { repeats: 3, firstSeq: 1, lastSeq: 1, fingerprint: 'f', kind: 'cycle', period: 2, laps: 3 },
      }),
    ]);
    expect(run.pauses['p1']?.loop).toEqual({
      repeats: 3,
      firstSeq: 1,
      lastSeq: 1,
      fingerprint: 'f',
      kind: 'cycle',
      period: 2,
      laps: 3,
    });
    const odd = applyEvent(
      {},
      { ...ev('exec.paused', { pauseId: 'p2', nodeId: 'tool:s', point: 'before' }), payload: { pauseId: 'p2', nodeId: 'tool:s', point: 'before', reason: 'loop', loop: { repeats: 3, firstSeq: 1, lastSeq: 2, fingerprint: 'f', kind: 'spiral', period: 0, laps: -1 } } } as never,
      'fixture',
    );
    expect(odd[RUN]?.pauses['p2']?.loop).toEqual({ repeats: 3, firstSeq: 1, lastSeq: 2, fingerprint: 'f' });
  });
});

describe('applyEvent: exec.refused keeps the gate held', () => {
  it('records code, message and requestId on the pause; the node stays paused', () => {
    const run = build([
      started('tool:sql', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:sql', point: 'error', editable: true }),
      ev('exec.refused', { pauseId: 'p1', code: 'schema', message: 'limit: too big', requestId: 'req-1' }, { seq: 40, ts: 5000 }),
    ]);
    const { node, pause } = get(run, 'tool:sql');
    expect(pause.active).toBe(true);
    expect(node.activePauseId).toBe('p1');
    expect(pause.refusals).toEqual([{ code: 'schema', message: 'limit: too big', requestId: 'req-1', ts: 5000, seq: 40 }]);
  });

  it('is bounded per pause, and a refusal for an unknown pause changes nothing', () => {
    const events = [
      started('tool:sql', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:sql', point: 'before', editable: true }),
    ];
    for (let i = 0; i < MAX_REFUSALS_PER_PAUSE + 4; i++) {
      events.push(ev('exec.refused', { pauseId: 'p1', code: 'shape', requestId: `r${i}` }));
    }
    const run = build(events);
    const refusals = run.pauses['p1']?.refusals ?? [];
    expect(refusals).toHaveLength(MAX_REFUSALS_PER_PAUSE);
    expect(refusals[refusals.length - 1]?.requestId).toBe(`r${MAX_REFUSALS_PER_PAUSE + 3}`);

    const before = build([started('tool:x', 'tool')]);
    const runs: RunsMap = { [RUN]: before };
    const after = applyEvent(runs, ev('exec.refused', { pauseId: 'nope', code: 'shape' }), 'fixture');
    expect(after[RUN]?.pauses).toEqual({});
  });
});

describe('applyEvent: exec.resumed.edited', () => {
  it('marks the pause and the instance the gate held — not a sibling instance', () => {
    const run = build([
      started('tool:sql', 'tool', { instanceId: 'a', input: { q: 'old' } }),
      started('tool:sql', 'tool', { instanceId: 'b', input: { q: 'other' } }),
      // The pause names the instance it holds (a sender that knows it).
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:sql', point: 'after', editable: true, instanceId: 'a' }),
      ev('exec.resumed', { pauseId: 'p1', action: 'retry', edited: { after: { q: 'new' } }, requestId: 'req-9' }),
    ]);
    const node = run.nodes['tool:sql'];
    const pause = run.pauses['p1'];
    expect(node?.executions.map((e) => e.edited)).toEqual([{ after: { q: 'new' } }, undefined]);
    expect(node?.executions[0]?.input).toEqual({ q: 'old' }); // what the model asked for stays
    expect(pause).toMatchObject({ active: false, resolvedAction: 'retry', edited: { after: { q: 'new' } }, resolvedRequestId: 'req-9' });
    expect(node?.activePauseId).toBeUndefined();
  });

  it('with two calls running and no instanceId on the pause, the pill is pinned to neither (the pause keeps it)', () => {
    const run = build([
      started('tool:sql', 'tool', { instanceId: 'a', input: { q: 'old' } }),
      started('tool:sql', 'tool', { instanceId: 'b', input: { q: 'other' } }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:sql', point: 'after', editable: true }),
      ev('exec.resumed', { pauseId: 'p1', action: 'retry', edited: { after: { q: 'new' } } }),
    ]);
    expect(run.nodes['tool:sql']?.executions.map((e) => e.edited)).toEqual([undefined, undefined]);
    expect(run.pauses['p1']).toMatchObject({ heldAmbiguous: true, edited: { after: { q: 'new' } } });
  });

  it('keeps a redacted after as the placeholder, and marks nothing without edited', () => {
    const run = build([
      started('tool:sql', 'tool', { instanceId: 'a', input: '__REDACTED__' }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:sql', point: 'before', editable: true }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue', edited: { after: '__REDACTED__' } }),
      ev('exec.paused', { pauseId: 'p2', nodeId: 'tool:sql', point: 'after' }),
      ev('exec.resumed', { pauseId: 'p2', action: 'continue' }),
    ]);
    expect(run.nodes['tool:sql']?.executions[0]?.edited).toEqual({ after: '__REDACTED__' });
    expect(run.pauses['p2']).not.toHaveProperty('edited');
  });
});

// ── banner sentences ─────────────────────────────────────────────────────────

/** search → fetch, three identical laps, held at the first call of lap four. */
function cycleRun(extra: { period?: number; laps?: number } = { period: 2, laps: 3 }, withSeqs = true): RunState {
  const events: ReturnType<typeof ev>[] = [];
  let seq = 1;
  const starts: number[] = [];
  for (let lap = 0; lap < 3; lap++) {
    for (const [nodeId, input] of [
      ['tool:search', { q: 'flights' }],
      ['tool:fetch', { url: 'https://x' }],
    ] as const) {
      const s = seq++;
      starts.push(s);
      events.push(started('llm:step', 'llm', { instanceId: `step-${s}`, seq: seq++ }));
      events.push(started(nodeId, 'tool', { instanceId: `i-${s}`, input, seq: s }));
      events.push(ev('node.finished', { nodeId, instanceId: `i-${s}`, durationMs: 1, status: 'ok', output: { n: 1 } }, { seq: seq++ }));
    }
  }
  const held = seq++;
  events.push(started('tool:search', 'tool', { instanceId: 'i-held', input: { q: 'flights' }, seq: held }));
  events.push(
    ev(
      'exec.paused',
      {
        pauseId: 'p1',
        nodeId: 'tool:search',
        point: 'before',
        reason: 'loop',
        loop: { repeats: 7, firstSeq: starts[0] ?? 0, lastSeq: held, fingerprint: 'salted', kind: 'cycle', ...extra },
      },
      { seq: seq++ },
    ),
  );
  const run = build(events);
  if (!withSeqs) {
    for (const node of Object.values(run.nodes)) {
      node.executions = node.executions.map(({ seq: _seq, ...rest }) => rest);
    }
  }
  return run;
}

describe('loop banners', () => {
  it('repeat (explicit kind or none) keeps today’s wording', () => {
    const run = build([
      started('tool:searchFlights', 'tool'),
      ev('exec.paused', {
        pauseId: 'p1',
        nodeId: 'tool:searchFlights',
        point: 'before',
        reason: 'loop',
        loop: { repeats: 3, firstSeq: 1, lastSeq: 1, fingerprint: 'f', kind: 'repeat' },
      }),
    ]);
    const { node, pause } = get(run, 'tool:searchFlights');
    expect(loopBannerText(node, pause)).toBe('Loop: 3× searchFlights with identical arguments');
    expect(holdBannerText(node, pause, true)).toBe('Was held — loop: 3× searchFlights with identical arguments');
  });

  it('cycle names its lap, the rounds and where it holds', () => {
    const run = cycleRun();
    const { node, pause } = get(run, 'tool:search');
    expect(holdBannerText(node, pause, false, run)).toBe(
      'Loop: search → fetch, 3 identical rounds (same arguments, same results). Holding round 4 at search.',
    );
    expect(holdBannerText(node, pause, true, run)).toBe(
      'Was held — loop: search → fetch, 3 identical rounds (same arguments, same results). Holding round 4 at search.',
    );
    expect(cycleLap(run, node, pause).map((c) => c.node.nodeId)).toEqual(['tool:search', 'tool:fetch']);
  });

  it('cycle without a period finds the lap where its first call comes round again', () => {
    const run = cycleRun({ laps: 3 });
    const { node, pause } = get(run, 'tool:search');
    expect(holdBannerText(node, pause, false, run)).toBe(
      'Loop: search → fetch, 3 identical rounds (same arguments, same results). Holding round 4 at search.',
    );
  });

  it('cycle without seqs (or without the run) names the lap by its length', () => {
    const run = cycleRun({ period: 2, laps: 3 }, false);
    const { node, pause } = get(run, 'tool:search');
    expect(holdBannerText(node, pause, false, run)).toBe(
      'Loop: a cycle of 2 calls, 3 identical rounds (same arguments, same results). Holding round 4 at search.',
    );
    const bare = cycleRun({ laps: 3 });
    const held = get(bare, 'tool:search');
    expect(holdBannerText(held.node, held.pause)).toBe(
      'Loop: a repeating cycle of calls, 3 identical rounds (same arguments, same results). Holding round 4 at search.',
    );
  });

  function errorRepeatRun(inputs: unknown[]): RunState {
    const events: ReturnType<typeof ev>[] = [];
    let seq = 1;
    const first = seq;
    inputs.forEach((input, i) => {
      events.push(started('tool:run_sql', 'tool', { instanceId: `c${i}`, input, seq: seq++ }));
      events.push(ev('node.error', { nodeId: 'tool:run_sql', error: { name: 'DatabaseError', message: 'relation "users" does not exist' } }, { seq: seq++ }));
      events.push(ev('node.finished', { nodeId: 'tool:run_sql', instanceId: `c${i}`, durationMs: 1, status: 'error' }, { seq: seq++ }));
    });
    const held = seq++;
    events.push(started('tool:run_sql', 'tool', { instanceId: 'held', input: { q: 'next' }, seq: held }));
    events.push(
      ev(
        'exec.paused',
        {
          pauseId: 'p1',
          nodeId: 'tool:run_sql',
          point: 'before',
          reason: 'loop',
          loop: { repeats: inputs.length, firstSeq: first, lastSeq: held, fingerprint: 'salted', kind: 'error-repeat' },
          editable: true,
        },
        { seq: seq++ },
      ),
    );
    return build(events);
  }

  it('error-repeat says the error repeated and whether the arguments varied', () => {
    const varied = errorRepeatRun([{ q: 'a' }, { q: 'b' }, { q: 'c' }]);
    const v = get(varied, 'tool:run_sql');
    expect(holdBannerText(v.node, v.pause)).toBe(
      'Repeated error: run_sql failed 3× in a row with the same error (arguments varied).',
    );
    expect(holdBannerText(v.node, v.pause, true)).toBe(
      'Was held — repeated error: run_sql failed 3× in a row with the same error (arguments varied).',
    );
    expect(errorStreak(v.node, v.pause.loop).map((e) => e.instanceId)).toEqual(['c0', 'c1', 'c2']);

    resetCounters();
    const same = errorRepeatRun([{ q: 'a' }, { q: 'a' }, { q: 'a' }]);
    const s = get(same, 'tool:run_sql');
    expect(holdBannerText(s.node, s.pause)).toBe(
      'Repeated error: run_sql failed 3× in a row with the same error (same arguments).',
    );
  });

  it('error-repeat claims nothing about hidden arguments', () => {
    const hidden = errorRepeatRun(['__REDACTED__', '__REDACTED__', '__REDACTED__']);
    const h = get(hidden, 'tool:run_sql');
    expect(holdBannerText(h.node, h.pause)).toBe('Repeated error: run_sql failed 3× in a row with the same error.');
    expect(errorStreakArguments([])).toBeUndefined();
  });
});

describe('smart banners', () => {
  function smartRun(rule: 'error-result' | 'truncated-tool-call', kind: 'tool' | 'llm', output?: unknown): RunState {
    const nodeId = kind === 'tool' ? 'tool:search' : 'llm:step';
    return build([
      started(nodeId, kind, { instanceId: 'x' }),
      ...(output !== undefined
        ? [ev('node.finished', { nodeId, instanceId: 'x', durationMs: 1, status: 'ok', output })]
        : []),
      ev('exec.paused', { pauseId: 'p1', nodeId, point: 'after', reason: 'breakpoint', smart: { rule } }),
    ]);
  }

  it('error-result: "<tool> returned an error result without throwing"', () => {
    const run = smartRun('error-result', 'tool');
    const { node, pause } = get(run, 'tool:search');
    expect(holdBannerText(node, pause)).toBe('search returned an error result without throwing');
    expect(holdBannerText(node, pause, true)).toBe('Was held — search returned an error result without throwing');
  });

  it('truncated-tool-call: the token limit, or the content filter when the step says so', () => {
    const run = smartRun('truncated-tool-call', 'llm');
    const { node, pause } = get(run, 'llm:step');
    expect(holdBannerText(node, pause)).toBe('The model stopped at the token limit in the middle of a tool call');
    expect(holdBannerText(node, pause, true)).toBe(
      'Was held — the model stopped at the token limit in the middle of a tool call',
    );
    resetCounters();
    const filtered = smartRun('truncated-tool-call', 'llm', { finishReason: 'content-filter' });
    const f = get(filtered, 'llm:step');
    expect(smartBannerText(f.node, f.pause)).toBe('A content filter stopped the model in the middle of a tool call');
  });

  it('an ordinary gate has no named hold — the usual "Paused before call" stays', () => {
    const run = build([
      started('tool:a', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'before', reason: 'breakpoint' }),
    ]);
    const { node, pause } = get(run, 'tool:a');
    expect(holdBannerText(node, pause)).toBeUndefined();
    expect(holdHint(pause)).toBeUndefined();
  });

  it('every named hold has a tooltip that says what the verbs do and how to turn it off', () => {
    const base = { pauseId: 'p', nodeId: 'n', point: 'before' as const, ts: 0, active: true };
    const loop = { repeats: 3, firstSeq: 1, lastSeq: 2, fingerprint: 'f' };
    expect(holdHint({ ...base, reason: 'loop', loop })).toContain('GRAPHMIND_LOOP_ALLOW');
    expect(holdHint({ ...base, reason: 'loop', loop: { ...loop, kind: 'cycle' } })).toContain('round in circles');
    expect(holdHint({ ...base, reason: 'loop', loop: { ...loop, kind: 'error-repeat' } })).toContain('same error');
    expect(holdHint({ ...base, reason: 'breakpoint', smart: { rule: 'error-result' } })).toContain(
      'GRAPHMIND_BREAK_ON_ERROR_RESULT=0',
    );
    expect(holdHint({ ...base, reason: 'breakpoint', smart: { rule: 'truncated-tool-call' } })).toContain(
      'GRAPHMIND_BREAK_ON_TRUNCATED=0',
    );
  });
});

describe('heldLapNodeIds — what the canvas outlines', () => {
  it('is the lap of the active cycle hold, and empty once it is released', () => {
    const run = cycleRun();
    expect([...heldLapNodeIds(run)].sort()).toEqual(['tool:fetch', 'tool:search']);
    // Same pauses record → the same answer object (computed once per hold).
    expect(heldLapNodeIds(run)).toBe(heldLapNodeIds(run));
    const released = applyEvent({ [RUN]: run }, ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { seq: 999 }), 'fixture');
    const next = released[RUN];
    if (next === undefined) throw new Error('no run');
    expect(heldLapNodeIds(next).size).toBe(0);
  });

  it('is empty for every other hold', () => {
    const run = build([
      started('tool:a', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'before', reason: 'loop', loop: { repeats: 3, firstSeq: 1, lastSeq: 1, fingerprint: 'f' } }),
    ]);
    expect(heldLapNodeIds(run).size).toBe(0);
  });
});

describe('the hold fixtures (behind the browser test)', () => {
  it('are schema-valid streams that end held on the kind they name, read back as that sentence', () => {
    const cases: [ReturnType<typeof generateCycleRun>, string, string][] = [
      [
        generateCycleRun(1_000),
        HOLD_NODES.search,
        'Loop: search → fetch, 3 identical rounds (same arguments, same results). Holding round 4 at search.',
      ],
      [
        generateErrorRepeatRun(1_000),
        HOLD_NODES.sql,
        'Repeated error: run_sql failed 3× in a row with the same error (arguments varied).',
      ],
      [generateSmartRun('error-result', 1_000), HOLD_NODES.search, 'search returned an error result without throwing'],
      [
        generateSmartRun('truncated-tool-call', 1_000),
        HOLD_NODES.llm,
        'The model stopped at the token limit in the middle of a tool call',
      ],
    ];
    for (const [events, nodeId, sentence] of cases) {
      const runs = events.reduce<RunsMap>((acc, e) => {
        const parsed = parseEnvelope(e);
        expect(parsed.kind, `${e.type}#${e.seq}`).toBe('ok');
        return parsed.kind === 'ok' ? applyEvent(acc, parsed.envelope as never, 'fixture') : acc;
      }, {});
      const run = runs[HOLD_RUN_ID];
      if (run === undefined) throw new Error('no run');
      const pause = Object.values(run.pauses).find((p) => p.active);
      const node = run.nodes[nodeId];
      if (pause === undefined || node === undefined) throw new Error(`not held at ${nodeId}`);
      expect(pause.nodeId).toBe(nodeId);
      expect(holdBannerText(node, pause, false, run)).toBe(sentence);
    }
  });
});

describe('the edit fixture (behind ?fixture=edit and the browser test)', () => {
  it('is a schema-valid stream held at an editable error gate on run_sql', () => {
    const events = generateEditRun(1_000_000);
    for (const e of events) expect(parseEnvelope(e).kind, `${e.type}#${e.seq}`).toBe('ok');
    const paused = events.find((e) => e.type === 'exec.paused');
    expect(paused?.payload).toMatchObject({ pauseId: EDIT_PAUSE_ID, nodeId: EDIT_NODES.sql, point: 'error', editable: true });
    const runs = events.reduce<RunsMap>((acc, e) => {
      if (e.seq > (paused?.seq ?? 0)) return acc;
      const parsed = parseEnvelope(e);
      return parsed.kind === 'ok' ? applyEvent(acc, parsed.envelope as never, 'fixture') : acc;
    }, {});
    const run = runs[EDIT_RUN_ID];
    expect(run?.pauses[EDIT_PAUSE_ID]?.editable).toBe(true);
    expect(run?.nodes[EDIT_NODES.sql]?.executions[0]?.input).toEqual(EDIT_RECORDED_ARGS);
  });

  it('answers an edit the way the client would: action, markers, merge, schema', () => {
    expect(simulateEditResume('error', 'continue', { limit: 5 })).toMatchObject({ ok: false, code: 'shape' });
    expect(simulateEditResume('error', 'retry', { limit: '__REDACTED__' })).toMatchObject({ ok: false, code: 'placeholder' });
    expect(simulateEditResume('error', 'retry', { context: EDIT_RECORDED_ARGS.context })).toMatchObject({ ok: false, code: 'truncated' });
    expect(simulateEditResume('error', 'retry', [1])).toMatchObject({ ok: false, code: 'shape' });
    expect(simulateEditResume('error', 'retry', { limit: EDIT_MAX_LIMIT + 1 })).toEqual({
      ok: false,
      code: 'schema',
      message: `limit: must be an integer from 1 to ${EDIT_MAX_LIMIT}`,
    });
    const accepted = simulateEditResume('error', 'retry', { query: 'SELECT name FROM users', limit: 50 });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    // Merged into the LIVE arguments; the big value goes back on the wire as the same preview.
    expect(accepted.after).toEqual({ ...EDIT_LIVE_ARGS, query: 'SELECT name FROM users', limit: 50, context: EDIT_RECORDED_ARGS.context });
  });
});
