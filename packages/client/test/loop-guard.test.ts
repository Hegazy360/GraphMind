/**
 * Loop guard, the pure half: canonical JSON + fingerprint, configuration
 * precedence, back-to-back counting (rule v3: one streak per run per kind),
 * and the conformance fixture the Python and Ruby ports are held to. The session wiring is in loop-hold.test.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NodeKind } from '@graphmind-ai/schema';
import {
  DEFAULT_LOOP_IGNORE_KEYS,
  LoopGuard,
  MAX_LOOP_RUNS,
  UNREADABLE_INPUT,
  canonicalCall,
  canonicalize,
  fingerprintCall,
  parseLoopMode,
  parseLoopThreshold,
  resolveLoopGuard,
} from '../src/loop-guard.js';

const IGNORE = new Set(DEFAULT_LOOP_IGNORE_KEYS);

function guard(over: Parameters<typeof resolveLoopGuard>[0] = {}, env: Record<string, string> = {}): LoopGuard {
  return new LoopGuard(resolveLoopGuard(over, env));
}

describe('canonicalize', () => {
  it('is independent of key order at every depth', () => {
    const a = canonicalize({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } });
    const b = canonicalize({ a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":2,"d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it('never contains formatting whitespace but keeps whitespace inside strings', () => {
    expect(canonicalize({ q: 'two  spaces', n: [1, 2] })).toBe('{"n":[1,2],"q":"two  spaces"}');
    expect(canonicalize({ q: 'two spaces' })).not.toBe(canonicalize({ q: 'two  spaces' }));
  });

  it('normalises numbers the way JSON does', () => {
    expect(canonicalize({ n: 1.0 })).toBe(canonicalize({ n: 1 }));
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(1e3)).toBe('1000');
    expect(canonicalize(1e21)).toBe('1e+21');
    expect(canonicalize(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(canonicalize(Number.NaN)).toBe('null');
    expect(canonicalize(Number.POSITIVE_INFINITY)).toBe('null');
    expect(canonicalize(10n)).toBe('10');
  });

  it('drops undefined / functions / symbols from objects and nulls them in arrays', () => {
    expect(canonicalize({ a: undefined, b: () => 1, c: Symbol('s'), d: 1 })).toBe('{"d":1}');
    expect(canonicalize([undefined, () => 1, 1])).toBe('[null,null,1]');
    expect(canonicalize(undefined)).toBe('null');
  });

  it('removes ignored keys at every nesting level, and only exact keys', () => {
    // Default: MCP's per-request `_meta` (progressToken...) at every depth.
    const a = canonicalize({ q: 'x', _meta: { progressToken: 1 }, inner: { _meta: { t: 1 }, q: 'y' } }, IGNORE);
    const b = canonicalize({ q: 'x', _meta: { progressToken: 2 }, inner: { _meta: { t: 2 }, q: 'y' } }, IGNORE);
    expect(a).toBe(b);
    expect(a).toBe('{"inner":{"q":"y"},"q":"x"}');
    // Pagination is part of the call by default: page 2 is not page 1.
    expect(canonicalize({ q: 'x', cursor: 'abc', page: 1 }, IGNORE)).toBe('{"cursor":"abc","page":1,"q":"x"}');
    // A caller-supplied list removes exactly its keys, at every depth.
    const custom = new Set(['cursor', 'pageToken']);
    expect(canonicalize({ q: 'x', cursor: 'abc', inner: { pageToken: 't1', q: 'y' } }, custom)).toBe(
      canonicalize({ q: 'x', cursor: 'def', inner: { pageToken: 't2', q: 'y' } }, custom),
    );
    // `cursorId` is not `cursor`, `meta` is not `_meta`: exact match only.
    expect(canonicalize({ cursorId: 1 }, custom)).toBe('{"cursorId":1}');
    expect(canonicalize({ meta: 1, _metadata: 2 }, IGNORE)).toBe('{"_metadata":2,"meta":1}');
    // An empty ignore set keeps them.
    expect(canonicalize({ _meta: 'abc' }, new Set())).toBe('{"_meta":"abc"}');
  });

  it('escapes strings exactly like JSON.stringify', () => {
    const s = 'quote " backslash \\ newline \n tab \t ctrl  é 😀';
    expect(canonicalize(s)).toBe(JSON.stringify(s));
  });

  it('honours toJSON (Date) and survives cycles and absurd depth without throwing', () => {
    const when = new Date('2026-09-14T04:00:00.000Z');
    expect(canonicalize({ when })).toBe('{"when":"2026-09-14T04:00:00.000Z"}');

    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(canonicalize(cyclic)).toBe('{"a":1,"self":"[circular]"}');
    // The same object appearing twice (not a cycle) is serialised twice.
    const shared = { k: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');

    let deep: unknown = 'leaf';
    for (let i = 0; i < 200; i += 1) deep = { d: deep };
    const out = canonicalize(deep);
    expect(out).toContain('"[depth]"');
    expect(out.startsWith('{"d":{"d":')).toBe(true);
  });

  it('fingerprints [nodeId, input] with sha256 truncated to 32 hex chars', () => {
    const canonical = canonicalCall('tool:searchFlights', { to: 'LIS', from: 'AMS' });
    expect(canonical).toBe('["tool:searchFlights",{"from":"AMS","to":"LIS"}]');
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
    expect(fingerprintCall('tool:searchFlights', { from: 'AMS', to: 'LIS' })).toBe(expected);
    expect(fingerprintCall('tool:searchFlights', { from: 'AMS', to: 'LIS' })).toMatch(/^[0-9a-f]{32}$/);
    // Same input, different node: different fingerprint.
    expect(fingerprintCall('tool:searchHotels', { from: 'AMS', to: 'LIS' })).not.toBe(expected);
  });

  it('fingerprints a 1 KB input in well under 0.05 ms on average', () => {
    const input = {
      query: 'flights from Amsterdam to Lisbon in October for two people, budget conscious',
      filters: { stops: 1, cabin: 'economy', bags: 2, refundable: false, airlines: ['TAP', 'KLM', 'Vueling'] },
      passengers: [
        { type: 'adult', age: 34, loyalty: { program: 'FlyingBlue', tier: 'silver', id: 'FB-88213' } },
        { type: 'adult', age: 31, loyalty: null },
      ],
      dates: { depart: '2026-10-03', return: '2026-10-07', flexible: true, window: 2 },
      notes: 'x'.repeat(560),
      cursor: 'eyJwYWdlIjoxfQ==',
    };
    expect(JSON.stringify(input).length).toBeGreaterThanOrEqual(1000);
    for (let i = 0; i < 500; i += 1) fingerprintCall('tool:searchFlights', input, IGNORE);
    const iterations = 5000;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i += 1) fingerprintCall('tool:searchFlights', input, IGNORE);
    const avg = (performance.now() - t0) / iterations;
    expect(avg).toBeLessThan(0.05);
  });
});

describe('configuration precedence', () => {
  it('parses the env strictly and falls back on nonsense', () => {
    expect(parseLoopThreshold(undefined)).toBe(3);
    expect(parseLoopThreshold('5')).toBe(5);
    expect(parseLoopThreshold(' 0 ')).toBe(0);
    for (const bad of ['', 'three', '-1', '2.5', 'NaN', 'Infinity']) {
      expect(parseLoopThreshold(bad)).toBe(3);
    }
    expect(parseLoopMode(undefined)).toBe('pause');
    expect(parseLoopMode('WARN')).toBe('warn');
    expect(parseLoopMode(' off ')).toBe('off');
    expect(parseLoopMode('0')).toBe('off');
    expect(parseLoopMode('maybe')).toBe('pause');
  });

  it('option > env > default, per field', () => {
    const env = { GRAPHMIND_LOOP_THRESHOLD: '7', GRAPHMIND_ON_LOOP: 'warn' };
    expect(resolveLoopGuard(undefined, {})).toMatchObject({ threshold: 3, mode: 'pause' });
    expect(resolveLoopGuard(undefined, env)).toMatchObject({ threshold: 7, mode: 'warn' });
    expect(resolveLoopGuard({ threshold: 2 }, env)).toMatchObject({ threshold: 2, mode: 'warn' });
    expect(resolveLoopGuard({ mode: 'off' }, env)).toMatchObject({ threshold: 7, mode: 'off' });
    expect(resolveLoopGuard(false, env)).toMatchObject({ threshold: 7, mode: 'off' });
    // Invalid option values do not win over the env.
    expect(resolveLoopGuard({ threshold: -3, mode: 'loud' as 'warn' }, env)).toMatchObject({
      threshold: 7,
      mode: 'warn',
    });
    expect(resolveLoopGuard({ threshold: 1.5 }, {})).toMatchObject({ threshold: 3 });
  });

  it('ignoreKeys and kinds replace the defaults; allowNodes default empty', () => {
    const d = resolveLoopGuard({}, {});
    expect([...d.ignoreKeys]).toEqual([...DEFAULT_LOOP_IGNORE_KEYS]);
    expect([...d.kinds]).toEqual(['tool']);
    expect(d.allowNodes.size).toBe(0);
    const c = resolveLoopGuard({ ignoreKeys: ['requestId'], kinds: ['tool', 'llm'], allowNodes: ['poll'] }, {});
    expect([...c.ignoreKeys]).toEqual(['requestId']);
    expect([...c.kinds]).toEqual(['tool', 'llm']);
    expect([...c.allowNodes]).toEqual(['poll']);
    expect(resolveLoopGuard({ ignoreKeys: [] }, {}).ignoreKeys.size).toBe(0);
    expect(resolveLoopGuard({ kinds: [] }, {}).kinds.size).toBe(0);
  });

  it('is disabled by threshold 0 or mode off', () => {
    expect(guard({ threshold: 0 }).enabled).toBe(false);
    expect(guard({ mode: 'off' }).enabled).toBe(false);
    expect(guard(false).enabled).toBe(false);
    expect(guard({}, { GRAPHMIND_LOOP_THRESHOLD: '0' }).enabled).toBe(false);
    expect(guard().enabled).toBe(true);
  });
});

describe('LoopGuard counting', () => {
  const T = 'tool';
  const RUN = 'run_a';

  it('trips at the Nth consecutive identical call and not before', () => {
    const g = guard({ threshold: 3 });
    expect(g.record(RUN, T, 'tool:s', 's', { q: 1 }, 10)?.atThreshold).toBe(false);
    expect(g.consult(RUN, T, 'tool:s', 's')).toBeUndefined();
    expect(g.record(RUN, T, 'tool:s', 's', { q: 1 }, 14)?.atThreshold).toBe(false);
    expect(g.consult(RUN, T, 'tool:s', 's')).toBeUndefined();
    expect(g.record(RUN, T, 'tool:s', 's', { q: 1 }, 18)?.atThreshold).toBe(true);
    expect(g.consult(RUN, T, 'tool:s', 's')).toEqual({
      repeats: 3,
      firstSeq: 10,
      lastSeq: 18,
      fingerprint: fingerprintCall('tool:s', { q: 1 }, IGNORE),
    });
  });

  it('identical arguments in a different key order are identical', () => {
    const g = guard({ threshold: 2 });
    g.record(RUN, T, 'tool:s', 's', { from: 'AMS', to: 'LIS' }, 1);
    g.record(RUN, T, 'tool:s', 's', { to: 'LIS', from: 'AMS' }, 2);
    expect(g.consult(RUN, T, 'tool:s', 's')?.repeats).toBe(2);
  });

  it('a different argument resets the streak; the streak can then rebuild', () => {
    const g = guard({ threshold: 3 });
    g.record(RUN, T, 'tool:s', 's', { q: 1 }, 1);
    g.record(RUN, T, 'tool:s', 's', { q: 1 }, 2);
    g.record(RUN, T, 'tool:s', 's', { q: 2 }, 3); // reset
    expect(g.consult(RUN, T, 'tool:s', 's')).toBeUndefined();
    g.record(RUN, T, 'tool:s', 's', { q: 2 }, 4);
    expect(g.consult(RUN, T, 'tool:s', 's')).toBeUndefined();
    const info = g.record(RUN, T, 'tool:s', 's', { q: 2 }, 5);
    expect(info?.atThreshold).toBe(true);
    expect(g.consult(RUN, T, 'tool:s', 's')).toMatchObject({ repeats: 3, firstSeq: 3, lastSeq: 5 });
  });

  // v3 (decisions.md "Loop hold v3"): a loop is the same call BACK-TO-BACK.
  // v2 pinned the opposite here ("search, read, search, read is still a loop on
  // search") — under mcp-proxy the whole host session is one run, so a
  // constant-argument tool called at minute 1, 20 and 45 was held as a loop.
  it('another watched call of the same kind between identical calls replaces the streak (v3)', () => {
    const g = guard({ threshold: 3 });
    for (let i = 0; i < 4; i += 1) {
      g.record(RUN, T, 'tool:s', 's', { q: 1 }, i * 2);
      expect(g.consult(RUN, T, 'tool:s', 's')).toBeUndefined();
      g.record(RUN, T, 'tool:r', 'r', { id: i }, i * 2 + 1); // always different
      expect(g.consult(RUN, T, 'tool:r', 'r')).toBeUndefined();
    }
    // A, A, B, A, A never trips either.
    const h = guard({ threshold: 3 });
    h.record(RUN, T, 'tool:s', 's', { q: 1 }, 1);
    h.record(RUN, T, 'tool:s', 's', { q: 1 }, 2);
    h.record(RUN, T, 'tool:r', 'r', { id: 1 }, 3);
    h.record(RUN, T, 'tool:s', 's', { q: 1 }, 4);
    expect(h.record(RUN, T, 'tool:s', 's', { q: 1 }, 5)).toMatchObject({ repeats: 2, firstSeq: 4, atThreshold: false });
    expect(h.consult(RUN, T, 'tool:s', 's')).toBeUndefined();
  });

  it('the long-session shape: identical calls each separated by other tools are never a loop (v3)', () => {
    const g = guard({ threshold: 3 });
    let seq = 0;
    for (let round = 0; round < 10; round += 1) {
      g.record(RUN, T, 'tool:list_issues', 'list_issues', {}, (seq += 1));
      expect(g.consult(RUN, T, 'tool:list_issues', 'list_issues'), `round ${round}`).toBeUndefined();
      for (let k = 0; k < 5; k += 1) {
        g.record(RUN, T, 'tool:read_file', 'read_file', { path: `f${round}-${k}` }, (seq += 1));
        g.record(RUN, 'llm', 'llm:step', 'step', { messages: [round, k] }, (seq += 1));
      }
    }
  });

  it('unwatched starts between identical calls touch no streak: llm steps, allow-listed tools (v3)', () => {
    const g = guard({ threshold: 3, allowNodes: ['pollJob'] });
    g.record(RUN, T, 'tool:s', 's', { q: 1 }, 1);
    expect(g.record(RUN, 'llm', 'llm:step', 'step', { messages: [] }, 2)).toBeUndefined();
    g.record(RUN, T, 'tool:s', 's', { q: 1 }, 3);
    expect(g.record(RUN, T, 'tool:pollJob', 'pollJob', { id: 7 }, 4)).toBeUndefined();
    expect(g.consult(RUN, T, 'tool:pollJob', 'pollJob')).toBeUndefined();
    expect(g.record(RUN, T, 'tool:s', 's', { q: 1 }, 5)?.atThreshold).toBe(true);
    expect(g.consult(RUN, T, 'tool:s', 's')).toMatchObject({ repeats: 3, firstSeq: 1, lastSeq: 5 });
  });

  it('keeps one independent streak per watched kind (v3)', () => {
    const g = guard({ threshold: 3, kinds: ['tool', 'llm'] });
    for (let i = 0; i < 3; i += 1) {
      g.record(RUN, T, 'tool:s', 's', { q: 1 }, i * 2 + 1);
      g.record(RUN, 'llm', 'llm:step', 'step', { messages: ['same'] }, i * 2 + 2);
    }
    expect(g.consult(RUN, T, 'tool:s', 's')).toMatchObject({ repeats: 3, firstSeq: 1, lastSeq: 5 });
    expect(g.consult(RUN, 'llm', 'llm:step', 'step')).toMatchObject({ repeats: 3, firstSeq: 2, lastSeq: 6 });
    // A different llm input replaces only the llm streak.
    g.record(RUN, 'llm', 'llm:step', 'step', { messages: ['other'] }, 7);
    expect(g.record(RUN, T, 'tool:s', 's', { q: 1 }, 8)?.repeats).toBe(4);
  });

  it('a gate whose node is not the one its kind streak belongs to never holds (v3)', () => {
    const g = guard({ threshold: 2 });
    g.record(RUN, T, 'tool:s', 's', {}, 1);
    g.record(RUN, T, 'tool:s', 's', {}, 2);
    // Parallel fan-out: another tool's gate consults while s holds the streak.
    expect(g.consult(RUN, T, 'tool:r', 'r')).toBeUndefined();
    expect(g.consult(RUN, T, 'tool:s', 's')?.repeats).toBe(2);
  });

  it('an unreadable input, or a nodeId that is not a string, clears the kind streak (v3)', () => {
    const g = guard({ threshold: 3 });
    const hostile = {
      get q(): never {
        throw new Error('boom');
      },
    };
    g.record(RUN, T, 'tool:s', 's', { q: 1 }, 1);
    g.record(RUN, T, 'tool:s', 's', { q: 1 }, 2);
    expect(g.record(RUN, T, 'tool:other', 'other', hostile, 3)).toBeUndefined();
    expect(g.record(RUN, T, 'tool:s', 's', { q: 1 }, 4)?.repeats).toBe(1);
    g.record(RUN, T, 'tool:s', 's', { q: 1 }, 5);
    expect(g.record(RUN, T, 7 as unknown as string, 's', { q: 1 }, 6)).toBeUndefined();
    expect(g.record(RUN, T, 'tool:s', 's', { q: 1 }, 7)?.repeats).toBe(1);
    // UNREADABLE_INPUT is how the session says "reading the input threw".
    g.record(RUN, T, 'tool:s', 's', { q: 1 }, 8);
    expect(g.record(RUN, T, 'tool:s', 's', UNREADABLE_INPUT, 9)).toBeUndefined();
    expect(g.record(RUN, T, 'tool:s', 's', { q: 1 }, 10)?.repeats).toBe(1);
    // An unreadable start of an UNWATCHED kind clears nothing.
    g.record(RUN, T, 'tool:s', 's', { q: 1 }, 11);
    expect(g.record(RUN, 'llm', 'llm:x', 'x', hostile, 12)).toBeUndefined();
    expect(g.record(RUN, T, 'tool:s', 's', { q: 1 }, 13)?.repeats).toBe(3);
  });

  it('trips once per repeat: a retry that re-enters the gate does not trip again', () => {
    const g = guard({ threshold: 2 });
    g.record(RUN, T, 'tool:s', 's', {}, 1);
    g.record(RUN, T, 'tool:s', 's', {}, 2);
    expect(g.consult(RUN, T, 'tool:s', 's')?.repeats).toBe(2);
    expect(g.consult(RUN, T, 'tool:s', 's')).toBeUndefined(); // retry, same instance
    g.record(RUN, T, 'tool:s', 's', {}, 3); // a genuinely new call
    expect(g.consult(RUN, T, 'tool:s', 's')?.repeats).toBe(3);
  });

  it('runs are independent, and the same node in two runs does not share a streak', () => {
    const g = guard({ threshold: 2 });
    g.record('run_1', T, 'tool:s', 's', {}, 1);
    g.record('run_2', T, 'tool:s', 's', {}, 1);
    expect(g.consult('run_1', T, 'tool:s', 's')).toBeUndefined();
    expect(g.consult('run_2', T, 'tool:s', 's')).toBeUndefined();
    g.record('run_1', T, 'tool:s', 's', {}, 2);
    expect(g.consult('run_1', T, 'tool:s', 's')?.repeats).toBe(2);
    expect(g.consult('run_2', T, 'tool:s', 's')).toBeUndefined();
  });

  it('watches only the configured kinds and never an allow-listed node (by id or name)', () => {
    const g = guard({ threshold: 1, allowNodes: ['tool:pollJob', 'heartbeat'] });
    expect(g.record(RUN, 'llm', 'llm:step', 'step', {}, 1)).toBeUndefined();
    expect(g.consult(RUN, 'llm', 'llm:step', 'step')).toBeUndefined();
    expect(g.record(RUN, T, 'tool:pollJob', 'pollJob', {}, 2)).toBeUndefined();
    expect(g.record(RUN, T, 'tool:heartbeat', 'heartbeat', {}, 3)).toBeUndefined();
    expect(g.record(RUN, T, 'tool:other', 'other', {}, 4)?.atThreshold).toBe(true);

    const llm = guard({ threshold: 1, kinds: ['llm'] });
    expect(llm.record(RUN, 'llm', 'llm:step', 'step', { messages: [] }, 1)?.atThreshold).toBe(true);
    expect(llm.record(RUN, T, 'tool:s', 's', {}, 2)).toBeUndefined();
  });

  it('claims exactly one warning per streak, and a new streak may warn again', () => {
    const g = guard({ threshold: 2 });
    g.record(RUN, T, 'tool:s', 's', {}, 1);
    g.record(RUN, T, 'tool:s', 's', {}, 2);
    expect(g.claimWarning(RUN, 'tool:s')).toBe(true);
    expect(g.claimWarning(RUN, 'tool:s')).toBe(false);
    g.record(RUN, T, 'tool:s', 's', {}, 3);
    expect(g.claimWarning(RUN, 'tool:s')).toBe(false); // same streak
    g.record(RUN, T, 'tool:s', 's', { other: 1 }, 4); // new streak
    expect(g.claimWarning(RUN, 'tool:s')).toBe(true);
    expect(g.claimWarning('run_never', 'tool:s')).toBe(false);
  });

  it('keeps one streak per kind per run: thousands of distinct calls stay bounded (v3)', () => {
    const g = guard({ threshold: 3, kinds: ['tool', 'llm'] });
    for (let i = 0; i < 20_000; i += 1) {
      g.record(RUN, T, `tool:n${i}`, `n${i}`, { i }, i);
      g.record(RUN, 'llm', `llm:n${i}`, `n${i}`, { i }, i);
    }
    expect(g.trackedStreaks).toBe(2);
    // Only the latest call of each kind is remembered; one more identical one counts.
    expect(g.consult(RUN, T, 'tool:n0', 'n0')).toBeUndefined();
    expect(g.record(RUN, T, 'tool:n19999', 'n19999', { i: 19999 }, 99_999)?.repeats).toBe(2);

    for (let r = 0; r < MAX_LOOP_RUNS + 5; r += 1) g.record(`run_${r}`, T, 'tool:s', 's', {}, r);
    expect(g.trackedRuns).toBeLessThanOrEqual(MAX_LOOP_RUNS);
    g.forget('run_7');
    expect(g.record('run_7', T, 'tool:s', 's', {}, 99)?.repeats).toBe(1);
  });

  it('claimWarning with a kind claims that kind\'s streak only (v3)', () => {
    const g = guard({ threshold: 1, kinds: ['tool', 'llm'] });
    g.record(RUN, T, 'tool:s', 's', {}, 1);
    g.record(RUN, 'llm', 'llm:s', 's', {}, 2);
    expect(g.claimWarning(RUN, 'tool:s', 'llm')).toBe(false); // llm streak is llm:s
    expect(g.claimWarning(RUN, 'tool:s', T)).toBe(true);
    expect(g.claimWarning(RUN, 'llm:s')).toBe(true);
    expect(g.claimWarning(RUN, 'llm:s', 'llm')).toBe(false);
  });
});

// ── conformance fixture: what the Python and Ruby ports must reproduce ──────

interface CanonCase {
  name: string;
  nodeId: string;
  input: unknown;
  ignoreKeys?: string[];
  canonical: string;
  fingerprint: string;
}

interface SequenceCase {
  name: string;
  threshold: number;
  ignoreKeys?: string[];
  allowNodes?: string[];
  kinds?: string[];
  calls: { nodeId: string; kind: string; input?: unknown; inputAbsent?: boolean; unreadable?: boolean; name?: string }[];
  fingerprints: (string | null)[];
  /** Index of the call at whose before-gate the guard first trips, or null. */
  tripsAt: number | null;
  repeatsAtTrip: number | null;
  /** Every trip: call index, repeats reported, index of the streak's first call. */
  trips: { at: number; repeats: number; firstAt: number }[];
}

interface Fixture {
  version: number;
  defaults: { threshold: number; mode: string; kinds: string[]; ignoreKeys: string[] };
  canonical: CanonCase[];
  sequences: SequenceCase[];
}

describe('conformance fixture (test/fixtures/loop-guard.json)', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/loop-guard.json', import.meta.url), 'utf8'),
  ) as Fixture;

  it('states the defaults this implementation uses', () => {
    expect(fixture.defaults).toEqual({
      threshold: 3,
      mode: 'pause',
      kinds: ['tool'],
      ignoreKeys: [...DEFAULT_LOOP_IGNORE_KEYS],
    });
    expect(fixture.canonical.length).toBeGreaterThanOrEqual(12);
    expect(fixture.sequences.length).toBeGreaterThanOrEqual(8);
  });

  it('every canonical case reproduces byte for byte, and every fingerprint is sha256 of it', () => {
    for (const c of fixture.canonical) {
      const ignore = new Set(c.ignoreKeys ?? DEFAULT_LOOP_IGNORE_KEYS);
      expect(canonicalCall(c.nodeId, c.input, ignore), c.name).toBe(c.canonical);
      const hash = createHash('sha256').update(c.canonical, 'utf8').digest('hex').slice(0, 32);
      expect(hash, `${c.name}: fingerprint is sha256(canonical)[0:32]`).toBe(c.fingerprint);
      expect(fingerprintCall(c.nodeId, c.input, ignore), c.name).toBe(c.fingerprint);
    }
  });

  it('is version 3 (loop hold v3: back-to-back) and every call names its kind', () => {
    expect(fixture.version).toBe(3);
    for (const s of fixture.sequences) {
      for (const call of s.calls) expect(typeof call.kind, s.name).toBe('string');
      expect(s.trips[0]?.at ?? null, s.name).toBe(s.tripsAt);
      expect(s.trips[0]?.repeats ?? null, s.name).toBe(s.repeatsAtTrip);
    }
    // Not vacuous: sequences that trip and sequences that never do, both.
    expect(fixture.sequences.filter((s) => s.trips.length > 0).length).toBeGreaterThanOrEqual(10);
    expect(fixture.sequences.filter((s) => s.trips.length === 0).length).toBeGreaterThanOrEqual(10);
  });

  it('every sequence trips exactly at the recorded calls with the recorded repeats and firstSeq', () => {
    for (const s of fixture.sequences) {
      const g = guard({
        threshold: s.threshold,
        ...(s.ignoreKeys !== undefined ? { ignoreKeys: s.ignoreKeys } : {}),
        ...(s.allowNodes !== undefined ? { allowNodes: s.allowNodes } : {}),
        ...(s.kinds !== undefined ? { kinds: s.kinds as NodeKind[] } : {}),
      });
      const trips: { at: number; repeats: number; firstAt: number }[] = [];
      s.calls.forEach((call, index) => {
        const kind = call.kind as NodeKind;
        const name = call.name ?? call.nodeId.split(':').slice(1).join(':');
        const input = call.unreadable
          ? {
              get boom(): never {
                throw new Error('unreadable');
              },
            }
          : call.inputAbsent
            ? undefined
            : call.input;
        const record = g.record('run', kind, call.nodeId, name, input, index);
        const expected = s.fingerprints[index];
        if (expected === null || expected === undefined) {
          expect(record, `${s.name}[${index}] is not fingerprinted`).toBeUndefined();
        } else {
          expect(record?.fingerprint, `${s.name}[${index}]`).toBe(expected);
        }
        const info = g.consult('run', kind, call.nodeId, name);
        if (info !== undefined) {
          expect(info.lastSeq, `${s.name}[${index}] lastSeq`).toBe(index);
          trips.push({ at: index, repeats: info.repeats, firstAt: info.firstSeq });
        }
        // A retry of the same call (no new start) never trips again.
        expect(g.consult('run', kind, call.nodeId, name), `${s.name}[${index}] retry`).toBeUndefined();
      });
      expect(trips, s.name).toEqual(s.trips);
    }
  });
});
