/**
 * Loop kinds v4 (0.6.0, contract C4) on the LoopGuard itself: `cycle` and
 * `error-repeat` from the completed-call history, their precedence under the
 * v3 identical-repeat rule, the per-process salted digests, bounded memory,
 * and the conformance fixture (test/fixtures/loop-kinds.json) the Python port
 * is held to. The session wiring is in loop-kinds-session.test.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NodeKind } from '@graphmind-ai/schema';
import {
  CYCLE_LAPS,
  ERROR_REPEAT_COUNT,
  LOOP_HISTORY_SIZE,
  LoopGuard,
  MAX_LOOP_RUNS,
  MAX_OPEN_CALLS_PER_RUN,
  MAX_OUTPUT_CANONICAL_CHARS,
  canonicalize,
  errorTextKey,
  fingerprintCall,
  resolveLoopGuard,
  saltedDigest,
  type LoopGuardOptions,
  type LoopInfo,
} from '../src/loop-guard.js';
import { errorResultShape, parseBreakOn, truncatedToolCall } from '../src/smart.js';

const RUN = 'run_1';
const T: NodeKind = 'tool';

function guard(options: LoopGuardOptions = {}, salt?: Uint8Array): LoopGuard {
  return new LoopGuard(resolveLoopGuard(options, {}), salt);
}

/** Drives one guard the way the session does, with seq = a running counter. */
class Driver {
  seq = 0;
  instances = 0;
  constructor(readonly g: LoopGuard, readonly run = RUN) {}

  /** Start a call and consult its before-gate; returns what held (or undefined). */
  start(nodeId: string, input: unknown, kind: NodeKind = T): { info: LoopInfo | undefined; seq: number; id: string } {
    const seq = (this.seq += 1);
    const id = `i${(this.instances += 1)}`;
    const name = nodeId.split(':').slice(1).join(':');
    this.g.record(this.run, kind, nodeId, name, input, seq, id);
    const info = this.g.consult(this.run, kind, nodeId, name);
    // A retry re-enters the same before-gate: never a second hold.
    expect(this.g.consult(this.run, kind, nodeId, name)).toBeUndefined();
    return { info, seq, id };
  }

  ok(nodeId: string, input: unknown, output: unknown, kind: NodeKind = T): LoopInfo | undefined {
    const started = this.start(nodeId, input, kind);
    this.g.complete(this.run, nodeId, started.id, 'ok', output, true);
    return started.info;
  }

  thrown(nodeId: string, input: unknown, message: string, name = 'Error'): LoopInfo | undefined {
    const started = this.start(nodeId, input);
    this.g.noteError(this.run, nodeId, started.id, name, message);
    this.g.complete(this.run, nodeId, started.id, 'error', undefined, true);
    return started.info;
  }
}

describe('error-repeat', () => {
  it('three identical errors with varying arguments, then the fourth call holds', () => {
    const d = new Driver(guard());
    const seqs: number[] = [];
    for (let i = 0; i < ERROR_REPEAT_COUNT; i += 1) {
      expect(d.thrown('tool:sql', { q: `select ${i}` }, 'relation "users" does not exist')).toBeUndefined();
      seqs.push(d.seq);
    }
    const fourth = d.start('tool:sql', { q: 'select 99' });
    expect(fourth.info).toEqual({
      repeats: 3,
      firstSeq: seqs[0],
      lastSeq: fourth.seq,
      fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
      kind: 'error-repeat',
    });
  });

  it('a success of that node in between resets it; other nodes in between do not', () => {
    const d = new Driver(guard());
    d.thrown('tool:sql', { q: 1 }, 'boom');
    d.thrown('tool:sql', { q: 2 }, 'boom');
    d.ok('tool:sql', { q: 3 }, { rows: [] });
    d.thrown('tool:sql', { q: 4 }, 'boom');
    d.thrown('tool:sql', { q: 5 }, 'boom');
    expect(d.start('tool:sql', { q: 6 }).info).toBeUndefined();

    const e = new Driver(guard());
    e.thrown('tool:sql', { q: 1 }, 'boom');
    e.ok('tool:read', { p: 1 }, 'x');
    e.thrown('tool:sql', { q: 2 }, 'boom');
    e.ok('tool:list', {}, []);
    e.thrown('tool:sql', { q: 3 }, 'boom');
    expect(e.start('tool:sql', { q: 4 }).info).toMatchObject({ kind: 'error-repeat', repeats: 3 });
  });

  it('different messages or names do not; collapsed whitespace does', () => {
    const d = new Driver(guard());
    d.thrown('tool:a', { n: 1 }, 'boom 1');
    d.thrown('tool:a', { n: 2 }, 'boom 2');
    d.thrown('tool:a', { n: 3 }, 'boom 1');
    expect(d.start('tool:a', { n: 4 }).info).toBeUndefined();

    const n = new Driver(guard());
    n.thrown('tool:a', { n: 1 }, 'boom', 'Error');
    n.thrown('tool:a', { n: 2 }, 'boom', 'TypeError');
    n.thrown('tool:a', { n: 3 }, 'boom', 'Error');
    expect(n.start('tool:a', { n: 4 }).info).toBeUndefined();

    const w = new Driver(guard());
    w.thrown('tool:a', { n: 1 }, 'no  such\nfile');
    w.thrown('tool:a', { n: 2 }, ' no such file ');
    w.thrown('tool:a', { n: 3 }, 'no\tsuch file');
    expect(w.start('tool:a', { n: 4 }).info).toMatchObject({ kind: 'error-repeat' });
  });

  it('an error-shaped result counts as a failure; its canonical result is the error', () => {
    const d = new Driver(guard());
    for (let i = 0; i < 3; i += 1) d.ok('tool:fs', { path: `p${i}` }, { isError: true, content: 'denied' });
    expect(d.start('tool:fs', { path: 'p9' }).info).toMatchObject({ kind: 'error-repeat', repeats: 3 });

    // ...but an error-shaped LLM output is not a tool error-result (kinds [tool, llm]).
    const l = new Driver(guard({ kinds: ['tool', 'llm'] }));
    for (let i = 0; i < 3; i += 1) l.ok('llm:step', { m: i }, { success: false }, 'llm');
    expect(l.start('llm:step', { m: 9 }, 'llm').info).toBeUndefined();
  });

  it('the held call failing the same way holds the next one with repeats 4; a retry never re-holds', () => {
    const d = new Driver(guard());
    for (let i = 0; i < 3; i += 1) d.thrown('tool:a', { n: i }, 'boom');
    const held = d.start('tool:a', { n: 3 });
    expect(held.info?.repeats).toBe(3);
    // The retry (same instance) fails again: one failure, recorded once, at node.finished.
    d.g.noteError(RUN, 'tool:a', held.id, 'Error', 'boom');
    d.g.noteError(RUN, 'tool:a', held.id, 'Error', 'boom');
    d.g.complete(RUN, 'tool:a', held.id, 'error', undefined, true);
    expect(d.start('tool:a', { n: 4 }).info).toMatchObject({ kind: 'error-repeat', repeats: 4 });
  });

  it('a completion that never reached the wire, an unreadable output, or an aborted call ends the streak', () => {
    for (const finish of [
      (g: LoopGuard, id: string) => g.complete(RUN, 'tool:a', id, 'error', undefined, false),
      (g: LoopGuard, id: string) => g.complete(RUN, 'tool:a', id, 'aborted', undefined, true),
      (g: LoopGuard, id: string) => g.complete(RUN, 'tool:a', id, 'ok', Symbol.for('nope'), true),
    ]) {
      const d = new Driver(guard());
      d.thrown('tool:a', { n: 1 }, 'boom');
      const middle = d.start('tool:a', { n: 2 });
      d.g.noteError(RUN, 'tool:a', middle.id, 'Error', 'boom');
      finish(d.g, middle.id);
      d.thrown('tool:a', { n: 3 }, 'boom');
      d.thrown('tool:a', { n: 4 }, 'boom');
      // Only 2 identical failures after the break.
      expect(d.start('tool:a', { n: 5 }).info).toBeUndefined();
    }
  });

  it('an unreadable error (non-string name or message) is an unknown failure', () => {
    const d = new Driver(guard());
    d.thrown('tool:a', { n: 1 }, 'boom');
    const s = d.start('tool:a', { n: 2 });
    d.g.noteError(RUN, 'tool:a', s.id, 'Error', { not: 'a string' });
    d.g.complete(RUN, 'tool:a', s.id, 'error', undefined, true);
    d.thrown('tool:a', { n: 3 }, 'boom');
    expect(d.start('tool:a', { n: 4 }).info).toBeUndefined();
  });

  it('the fingerprint is the salted error digest: same error, same salt -> same; other salt -> different', () => {
    const run = (salt: Uint8Array) => {
      const d = new Driver(guard({}, salt));
      for (let i = 0; i < 3; i += 1) d.thrown('tool:a', { n: i }, 'boom');
      return d.start('tool:a', { n: 9 }).info?.fingerprint;
    };
    const one = new Uint8Array(32).fill(1);
    const two = new Uint8Array(32).fill(2);
    expect(run(one)).toBe(run(one));
    expect(run(one)).not.toBe(run(two));
    // Never an unsalted digest of what it summarises.
    const key = JSON.stringify([errorTextKey('Error'), errorTextKey('boom')]);
    for (const text of [key, `err\u0000${key}`, 'boom', 'Error: boom']) {
      expect(run(one)).not.toBe(createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32));
    }
  });
});

describe('cycle', () => {
  const lapOf = (k: number) => Array.from({ length: k }, (_v, i) => [`tool:n${i}`, { i }, { out: i }] as const);

  it.each([2, 3, 4])('k=%i: three identical laps, then the first call of lap 4 holds', (k) => {
    const d = new Driver(guard());
    const lap = lapOf(k);
    let firstSeq = -1;
    for (let l = 0; l < CYCLE_LAPS; l += 1) {
      for (const [nodeId, input, output] of lap) {
        expect(d.ok(nodeId, input, output)).toBeUndefined();
        if (firstSeq < 0) firstSeq = d.seq;
      }
    }
    const [nodeId, input] = lap[0] as (typeof lap)[number];
    const held = d.start(nodeId, input);
    expect(held.info).toEqual({
      repeats: 3,
      firstSeq,
      lastSeq: held.seq,
      fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
      kind: 'cycle',
      period: k,
      laps: 3,
    });
  });

  it('two laps never hold; a different starting call never holds', () => {
    const d = new Driver(guard());
    for (let l = 0; l < 2; l += 1) {
      d.ok('tool:a', {}, 1);
      d.ok('tool:b', {}, 2);
    }
    expect(d.start('tool:a', {}).info).toBeUndefined();

    const e = new Driver(guard());
    for (let l = 0; l < 3; l += 1) {
      e.ok('tool:a', {}, 1);
      e.ok('tool:b', {}, 2);
    }
    expect(e.start('tool:c', {}).info).toBeUndefined();
    expect(e.start('tool:a', { other: true }).info).toBeUndefined();
  });

  it('identical inputs but different outputs never hold', () => {
    const d = new Driver(guard());
    for (let l = 0; l < 5; l += 1) {
      expect(d.ok('tool:status', { job: 1 }, { progress: l })).toBeUndefined();
      expect(d.ok('tool:sleep', { s: 1 }, null)).toBeUndefined();
    }
  });

  it('interleaved unwatched calls (another kind, allow-listed) are invisible', () => {
    const d = new Driver(guard({ allowNodes: ['heartbeat'] }));
    for (let l = 0; l < 3; l += 1) {
      d.ok('llm:step', { messages: l }, 'text', 'llm');
      d.ok('tool:a', {}, 1);
      d.ok('tool:heartbeat', { t: l }, l);
      d.ok('tool:b', {}, 2);
    }
    d.ok('llm:step', { messages: 9 }, 'text', 'llm');
    expect(d.start('tool:a', {}).info).toMatchObject({ kind: 'cycle', period: 2, laps: 3 });
  });

  it('laps made only of allow-listed nodes never hold', () => {
    const d = new Driver(guard({ allowNodes: ['poll', 'tool:sleep'] }));
    for (let l = 0; l < 6; l += 1) {
      expect(d.ok('tool:poll', { job: 1 }, 'pending')).toBeUndefined();
      expect(d.ok('tool:sleep', { s: 5 }, null)).toBeUndefined();
    }
    expect(d.g.trackedCalls).toBe(0);
  });

  it('overlap with the v3 rule: identical back-to-back calls are v3, v3 wins at a shared gate', () => {
    // A,A,A is never a cycle (one distinct call per lap).
    const d = new Driver(guard({ threshold: 100 }));
    for (let i = 0; i < 12; i += 1) expect(d.ok('tool:a', { same: 1 }, 'r')).toBeUndefined();

    // Laps A,B,A,A: at the start of lap 4 both qualify; v3 holds, the cycle is spent.
    const e = new Driver(guard());
    const holds: (LoopInfo | undefined)[] = [];
    for (let l = 0; l < 3; l += 1) {
      holds.push(e.ok('tool:a', { q: 1 }, 'r'), e.ok('tool:b', {}, 'b'), e.ok('tool:a', { q: 1 }, 'r'), e.ok('tool:a', { q: 1 }, 'r'));
    }
    const shared = e.start('tool:a', { q: 1 }).info;
    expect(shared?.kind).toBeUndefined(); // v3
    expect(shared?.repeats).toBe(3);
    expect(holds.filter((h) => h !== undefined).every((h) => h?.kind === undefined)).toBe(true);
  });

  it('holds once per lap: a rotation of the same cycle is quiet, the next lap holds with laps 4', () => {
    const d = new Driver(guard());
    for (let l = 0; l < 3; l += 1) {
      d.ok('tool:a', {}, 1);
      d.ok('tool:b', {}, 2);
    }
    expect(d.ok('tool:a', {}, 1)).toMatchObject({ kind: 'cycle', laps: 3 });
    expect(d.ok('tool:b', {}, 2)).toBeUndefined();
    expect(d.start('tool:a', {}).info).toMatchObject({ kind: 'cycle', laps: 4, repeats: 4 });
  });

  it('smallest k wins', () => {
    const d = new Driver(guard());
    const seen: (LoopInfo | undefined)[] = [];
    for (let l = 0; l < 6; l += 1) seen.push(d.ok('tool:a', {}, 1), d.ok('tool:b', {}, 2));
    const info = d.start('tool:a', {}).info;
    expect(info).toMatchObject({ kind: 'cycle', period: 2, laps: 6 });
    expect(seen.filter((h) => h !== undefined).every((h) => h?.period === 2)).toBe(true);
  });

  it('an output over the digest budget equals nothing (and is never walked in full)', () => {
    const d = new Driver(guard());
    const huge = { text: 'x'.repeat(MAX_OUTPUT_CANONICAL_CHARS + 1) };
    for (let l = 0; l < 3; l += 1) {
      d.ok('tool:a', {}, huge);
      d.ok('tool:b', {}, 2);
    }
    expect(d.start('tool:a', {}).info).toBeUndefined();

    const small = new Driver(guard());
    const fits = { text: 'x'.repeat(MAX_OUTPUT_CANONICAL_CHARS - 100) };
    for (let l = 0; l < 3; l += 1) {
      small.ok('tool:a', {}, fits);
      small.ok('tool:b', {}, 2);
    }
    expect(small.start('tool:a', {}).info).toMatchObject({ kind: 'cycle' });
  });

  it('many small values still hit the budget (arrays and keys are charged)', () => {
    const d = new Driver(guard());
    const wide = Array.from({ length: MAX_OUTPUT_CANONICAL_CHARS + 10 }, () => 0);
    for (let l = 0; l < 3; l += 1) {
      d.ok('tool:a', {}, wide);
      d.ok('tool:b', {}, 2);
    }
    expect(d.start('tool:a', {}).info).toBeUndefined();
  });

  it('an output whose getter throws equals nothing', () => {
    const d = new Driver(guard());
    const hostile = {
      get secret(): never {
        throw new Error('no');
      },
    };
    for (let l = 0; l < 3; l += 1) {
      d.ok('tool:a', {}, hostile);
      d.ok('tool:b', {}, 2);
    }
    expect(d.start('tool:a', {}).info).toBeUndefined();
  });

  it('the fingerprint is salted: stable within a salt, different across salts, never an unsalted digest', () => {
    const run = (salt?: Uint8Array) => {
      const d = new Driver(guard({}, salt));
      for (let l = 0; l < 3; l += 1) {
        d.ok('tool:a', { q: 'secret' }, { v: 1 });
        d.ok('tool:b', {}, 2);
      }
      return d.start('tool:a', { q: 'secret' }).info?.fingerprint as string;
    };
    const one = new Uint8Array(32).fill(7);
    const two = new Uint8Array(32).fill(8);
    expect(run(one)).toBe(run(one));
    expect(run(one)).not.toBe(run(two));
    expect(run()).toBe(run()); // the process salt is stable within the process
    expect(run()).not.toBe(run(one));
    const unsalted = [
      fingerprintCall('tool:a', { q: 'secret' }, new Set(['_meta'])),
      fingerprintCall('tool:b', {}, new Set(['_meta'])),
      createHash('sha256').update(canonicalize({ v: 1 }), 'utf8').digest('hex').slice(0, 32),
    ];
    for (const digest of unsalted) {
      expect(run(one)).not.toBe(digest);
      expect(run()).not.toBe(digest);
    }
  });

  it('saltedDigest is an HMAC of the text with the salt', () => {
    const salt = new Uint8Array(32).fill(3);
    expect(saltedDigest('abc', salt)).toMatch(/^[0-9a-f]{32}$/);
    expect(saltedDigest('abc', salt)).toBe(saltedDigest('abc', new Uint8Array(32).fill(3)));
    expect(saltedDigest('abc', salt)).not.toBe(saltedDigest('abd', salt));
    expect(saltedDigest('abc', salt)).not.toBe(createHash('sha256').update('abc').digest('hex').slice(0, 32));
  });
});

describe('configuration and memory', () => {
  it('mode off or threshold 0 switch the new kinds off too', () => {
    for (const options of [{ mode: 'off' as const }, { threshold: 0 }]) {
      const d = new Driver(guard(options));
      for (let i = 0; i < 3; i += 1) d.thrown('tool:a', { n: i }, 'boom');
      for (let l = 0; l < 3; l += 1) {
        d.ok('tool:x', {}, 1);
        d.ok('tool:y', {}, 2);
      }
      expect(d.start('tool:a', { n: 9 }).info).toBeUndefined();
      expect(d.start('tool:x', {}).info).toBeUndefined();
      expect(d.g.trackedCalls).toBe(0);
    }
  });

  it('the threshold governs only v3: threshold 10 still holds a cycle and an error-repeat at 3', () => {
    const d = new Driver(guard({ threshold: 10 }));
    for (let i = 0; i < 3; i += 1) d.thrown('tool:a', { n: i }, 'boom');
    expect(d.start('tool:a', { n: 9 }).info).toMatchObject({ kind: 'error-repeat', repeats: 3 });
  });

  it('memory is bounded: 64 completed calls per (run, kind), 256 open calls per run, 64 runs', () => {
    const g = guard({ kinds: ['tool', 'llm'] });
    const d = new Driver(g);
    for (let i = 0; i < 5_000; i += 1) {
      d.ok(`tool:n${i % 97}`, { i }, { i });
      d.ok(`llm:n${i % 89}`, { i }, { i }, 'llm');
    }
    expect(g.trackedCalls).toBe(2 * LOOP_HISTORY_SIZE);
    // Calls that never finish.
    for (let i = 0; i < 5_000; i += 1) d.start(`tool:open${i}`, { i });
    expect(g.trackedCalls).toBe(2 * LOOP_HISTORY_SIZE + MAX_OPEN_CALLS_PER_RUN);
    // Many runs: LRU-bounded as v3.
    for (let r = 0; r < MAX_LOOP_RUNS * 3; r += 1) {
      const other = new Driver(g, `run_${r}`);
      for (let i = 0; i < 70; i += 1) other.ok('tool:a', { i }, i);
    }
    expect(g.trackedRuns).toBeLessThanOrEqual(MAX_LOOP_RUNS);
    expect(g.trackedCalls).toBeLessThanOrEqual(MAX_LOOP_RUNS * (LOOP_HISTORY_SIZE + MAX_OPEN_CALLS_PER_RUN) * 2);
  });

  it('a completion for a call it never saw (unwatched, another run, evicted) changes nothing and never throws', () => {
    const g = guard();
    expect(() => g.complete('nope', 'tool:a', 'x', 'ok', {}, true)).not.toThrow();
    expect(() => g.noteError('nope', 'tool:a', undefined, 'Error', 'x')).not.toThrow();
    const d = new Driver(g);
    d.ok('tool:a', {}, 1);
    expect(() => g.complete(RUN, 'tool:a', 'unknown-instance', 'ok', {}, true)).not.toThrow();
    expect(() => g.complete(RUN, 42 as unknown as string, undefined, 'ok', {}, true)).not.toThrow();
    expect(g.trackedCalls).toBe(1);
  });

  it('a start whose nodeId is not a string enters the history as a call that equals nothing', () => {
    const d = new Driver(guard());
    d.ok('tool:a', {}, 1);
    d.ok('tool:b', {}, 2);
    d.ok('tool:a', {}, 1);
    d.g.record(RUN, T, 7 as unknown as string, 'x', {}, (d.seq += 1));
    d.ok('tool:a', {}, 1);
    d.ok('tool:b', {}, 2);
    expect(d.start('tool:a', {}).info).toBeUndefined();
  });
});

// -- conformance fixture ---------------------------------------------------------

interface FixtureEvent {
  event: 'start' | 'error' | 'finish';
  nodeId: string;
  kind?: NodeKind;
  input?: unknown;
  unreadable?: boolean;
  instanceId?: string;
  name?: string;
  message?: string;
  status?: string;
  output?: unknown;
}

interface Fixture {
  version: number;
  defaults: {
    threshold: number;
    mode: string;
    kinds: string[];
    ignoreKeys: string[];
    historySize: number;
    cycleLaps: number;
    cyclePeriods: [number, number];
    errorRepeatCount: number;
  };
  errorResult: { name: string; result: unknown; shape: string | null }[];
  truncated: { name: string; result: unknown; fires: unknown }[];
  breakOnEnv: { raw: string | null; on: boolean }[];
  errorText: { name: string; text: string; key: string }[];
  sequences: {
    name: string;
    allowNodes?: string[];
    events: FixtureEvent[];
    holds: { at: number; kind: string; repeats: number; firstAt: number; period?: number; laps?: number }[];
  }[];
}

describe('conformance fixture (test/fixtures/loop-kinds.json)', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/loop-kinds.json', import.meta.url), 'utf8')) as Fixture;

  it('states the constants this implementation uses', () => {
    expect(fixture.version).toBe(4);
    expect(fixture.defaults).toEqual({
      threshold: 3,
      mode: 'pause',
      kinds: ['tool'],
      ignoreKeys: ['_meta'],
      historySize: LOOP_HISTORY_SIZE,
      cycleLaps: CYCLE_LAPS,
      cyclePeriods: [2, 4],
      errorRepeatCount: ERROR_REPEAT_COUNT,
    });
    // Not vacuous.
    expect(fixture.sequences.filter((s) => s.holds.length > 0).length).toBeGreaterThanOrEqual(15);
    expect(fixture.sequences.filter((s) => s.holds.length === 0).length).toBeGreaterThanOrEqual(12);
    expect(fixture.errorResult.filter((c) => c.shape === null).length).toBeGreaterThanOrEqual(12);
    expect(fixture.truncated.filter((c) => c.fires === null).length).toBeGreaterThanOrEqual(8);
  });

  it('error-result shapes', () => {
    for (const c of fixture.errorResult) expect(errorResultShape(c.result) ?? null, c.name).toBe(c.shape);
  });

  it('truncated-tool-call', () => {
    for (const c of fixture.truncated) expect(truncatedToolCall(c.result) ?? null, c.name).toEqual(c.fires);
  });

  it('GRAPHMIND_BREAK_ON_* spellings', () => {
    for (const c of fixture.breakOnEnv) expect(parseBreakOn(c.raw ?? undefined), JSON.stringify(c.raw)).toBe(c.on);
  });

  it('error text keys', () => {
    for (const c of fixture.errorText) expect(errorTextKey(c.text), c.name).toBe(c.key);
  });

  it('every sequence holds exactly where it says', () => {
    for (const s of fixture.sequences) {
      const g = guard(s.allowNodes === undefined ? {} : { allowNodes: s.allowNodes });
      const holds: Fixture['sequences'][number]['holds'] = [];
      s.events.forEach((event, index) => {
        const kind = event.kind ?? T;
        const name = event.nodeId.split(':').slice(1).join(':');
        if (event.event === 'start') {
          const input = event.unreadable
            ? {
                get boom(): never {
                  throw new Error('unreadable');
                },
              }
            : event.input;
          g.record('run', kind, event.nodeId, name, input, index, event.instanceId);
          const info = g.consult('run', kind, event.nodeId, name);
          if (info !== undefined) {
            expect(info.lastSeq, `${s.name}[${index}] lastSeq`).toBe(index);
            const hold: Fixture['sequences'][number]['holds'][number] = {
              at: index,
              kind: info.kind ?? 'repeat',
              repeats: info.repeats,
              firstAt: info.firstSeq,
            };
            if (info.period !== undefined) hold.period = info.period;
            if (info.laps !== undefined) hold.laps = info.laps;
            holds.push(hold);
          }
          expect(g.consult('run', kind, event.nodeId, name), `${s.name}[${index}] retry`).toBeUndefined();
        } else if (event.event === 'error') {
          g.noteError('run', event.nodeId, event.instanceId, event.name, event.message);
        } else {
          g.complete('run', event.nodeId, event.instanceId, event.status, event.output, true);
        }
      });
      expect(holds, s.name).toEqual(s.holds);
    }
  });
});
