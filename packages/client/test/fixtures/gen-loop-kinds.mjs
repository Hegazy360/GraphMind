#!/usr/bin/env node
/**
 * Generates loop-kinds.json — the conformance fixture for the 0.6.0 detectors
 * (smart rules + loop kinds v4) that the Python port must reproduce.
 *
 *   node packages/client/test/fixtures/gen-loop-kinds.mjs
 *
 * Every expected hold below is written BY HAND from the rules in
 * packages/client/src/{smart,loop-guard}.ts (and the comment next to each
 * sequence says why); the generator only expands the compact call notation
 * into events and call indexes into event indexes. loop-kinds.test.ts checks
 * the TypeScript reference against the file.
 */
import { writeFileSync } from 'node:fs';

// -- event notation ------------------------------------------------------------

let instance = 0;
const nextInstance = () => `i${(instance += 1)}`;

/** A completed successful call: start + finish(ok, output). */
const ok = (nodeId, input, output, extra = {}) => ({ nodeId, input, outcome: { status: 'ok', output }, ...extra });
/** A thrown error: start + node.error + finish(status error). */
const thrown = (nodeId, input, name, message, extra = {}) => ({
  nodeId,
  input,
  outcome: { status: 'error', error: { name, message } },
  ...extra,
});
/** Returned (did not throw) with an error-shaped result: start + finish(ok, result). */
const returned = (nodeId, input, result, extra = {}) => ({ nodeId, input, outcome: { status: 'ok', output: result }, ...extra });
/** mcp-proxy's isError failure: node.error (constant message, as under a HIDE switch) + finish(status error, result). */
const proxyIsError = (nodeId, input, text) => ({
  nodeId,
  input,
  outcome: {
    status: 'error',
    output: { isError: true, content: [{ type: 'text', text }] },
    error: { name: 'McpToolError', message: 'tools/call returned isError: true — content hidden' },
  },
});
/** mcp-proxy's JSON-RPC error: node.error JsonRpcError(code) + message, finish(status error, {error}). */
const proxyRpcError = (nodeId, input, code, message, data) => ({
  nodeId,
  input,
  outcome: {
    status: 'error',
    output: { error: data === null ? { code, message } : { code, message, data } },
    error: { name: `JsonRpcError(${code})`, message },
  },
});
/** Ended aborted. */
const aborted = (nodeId, input) => ({ nodeId, input, outcome: { status: 'aborted' } });
/** Started only — the call whose before-gate is checked last. */
const pending = (nodeId, input, extra = {}) => ({ nodeId, input, outcome: undefined, ...extra });

/**
 * Expand calls to events. `holds` are written in CALL indexes; the fixture
 * stores EVENT indexes (the seq a start gets is its event index).
 */
function sequence(name, calls, holds, options = {}) {
  const events = [];
  const startAt = [];
  for (const call of calls) {
    const id = call.noInstance ? undefined : nextInstance();
    const kind = call.kind ?? 'tool';
    startAt.push(events.length);
    const start = { event: 'start', nodeId: call.nodeId, kind };
    if (call.unreadable) start.unreadable = true;
    else start.input = call.input;
    if (id !== undefined) start.instanceId = id;
    events.push(start);
    if (call.outcome === undefined) continue;
    if (call.outcome.error !== undefined) {
      const error = { event: 'error', nodeId: call.nodeId, name: call.outcome.error.name, message: call.outcome.error.message };
      if (id !== undefined && !call.errorWithoutInstance) error.instanceId = id;
      events.push(error);
    }
    const finish = { event: 'finish', nodeId: call.nodeId, status: call.outcome.status };
    if ('output' in call.outcome) finish.output = call.outcome.output;
    if (id !== undefined && !call.finishWithoutInstance) finish.instanceId = id;
    events.push(finish);
  }
  return {
    name,
    ...options,
    events,
    holds: holds.map((hold) => {
      const out = { at: startAt[hold.at], kind: hold.kind, repeats: hold.repeats, firstAt: startAt[hold.firstAt] };
      if (hold.period !== undefined) out.period = hold.period;
      if (hold.laps !== undefined) out.laps = hold.laps;
      return out;
    }),
  };
}

const A = 'tool:search';
const B = 'tool:fetch';
const C = 'tool:parse';
const D = 'tool:store';
const repeatN = (n, calls) => Array.from({ length: n }, () => calls).flat();

// -- sequences -------------------------------------------------------------------

const sequences = [
  // cycle k=2: A,B three identical laps; the 4th lap's first call (call 6) holds.
  sequence(
    'cycle k=2: search, fetch x3 laps, then search holds',
    [...repeatN(3, [ok(A, { q: 'x' }, { hits: 1 }), ok(B, { id: 1 }, { body: 'b' })]), pending(A, { q: 'x' })],
    [{ at: 6, kind: 'cycle', repeats: 3, firstAt: 0, period: 2, laps: 3 }],
  ),
  // cycle k=3.
  sequence(
    'cycle k=3',
    [...repeatN(3, [ok(A, { q: 1 }, 1), ok(B, { q: 2 }, 2), ok(C, { q: 3 }, 3)]), pending(A, { q: 1 })],
    [{ at: 9, kind: 'cycle', repeats: 3, firstAt: 0, period: 3, laps: 3 }],
  ),
  // cycle k=4.
  sequence(
    'cycle k=4',
    [...repeatN(3, [ok(A, {}, 'a'), ok(B, {}, 'b'), ok(C, {}, 'c'), ok(D, {}, 'd')]), pending(A, {})],
    [{ at: 12, kind: 'cycle', repeats: 3, firstAt: 0, period: 4, laps: 3 }],
  ),
  // Two laps are not enough.
  sequence(
    'cycle: two laps never hold',
    [...repeatN(2, [ok(A, { q: 'x' }, 1), ok(B, { id: 1 }, 2)]), pending(A, { q: 'x' })],
    [],
  ),
  // Same inputs, the result of search changes every lap: no cycle (a poll that makes progress).
  sequence(
    'cycle: identical inputs but different outputs never hold',
    [
      ok(A, { q: 'x' }, { n: 1 }),
      ok(B, { id: 1 }, 'same'),
      ok(A, { q: 'x' }, { n: 2 }),
      ok(B, { id: 1 }, 'same'),
      ok(A, { q: 'x' }, { n: 3 }),
      ok(B, { id: 1 }, 'same'),
      ok(A, { q: 'x' }, { n: 4 }),
      ok(B, { id: 1 }, 'same'),
      pending(A, { q: 'x' }),
    ],
    [],
  ),
  // Output key order does not matter (canonical outputs).
  sequence(
    'cycle: outputs compare canonically (key order, _meta ignored)',
    [
      ok(A, { q: 'x' }, { a: 1, b: 2 }),
      ok(B, { id: 1 }, { _meta: { t: 1 }, v: true }),
      ok(A, { q: 'x' }, { b: 2, a: 1 }),
      ok(B, { id: 1 }, { _meta: { t: 2 }, v: true }),
      ok(A, { q: 'x' }, { a: 1, b: 2 }),
      ok(B, { id: 1 }, { v: true, _meta: { t: 3 } }),
      pending(A, { q: 'x' }),
    ],
    [{ at: 6, kind: 'cycle', repeats: 3, firstAt: 0, period: 2, laps: 3 }],
  ),
  // LLM steps (unwatched kind) between the tool calls are invisible.
  sequence(
    'cycle: interleaved unwatched (llm) calls are invisible',
    [
      ...repeatN(3, [
        ok('llm:step', { messages: [1] }, 't', { kind: 'llm' }),
        ok(A, { q: 'x' }, 1),
        ok('llm:step', { messages: [2] }, 't', { kind: 'llm' }),
        ok(B, { id: 1 }, 2),
      ]),
      ok('llm:step', { messages: [3] }, 't', { kind: 'llm' }),
      pending(A, { q: 'x' }),
    ],
    [{ at: 13, kind: 'cycle', repeats: 3, firstAt: 1, period: 2, laps: 3 }],
  ),
  // A lap made only of allow-listed nodes never holds — they are invisible.
  sequence(
    'cycle: a lap of allow-listed nodes never holds',
    [...repeatN(5, [ok('tool:poll', { job: 1 }, 'pending'), ok('tool:sleep', { s: 1 }, null)]), pending('tool:poll', { job: 1 })],
    [],
    { allowNodes: ['poll', 'tool:sleep'] },
  ),
  // An allow-listed poller inside the lap is invisible: search, fetch is the lap.
  sequence(
    'cycle: an allow-listed call inside a lap is invisible',
    [
      ...repeatN(3, [ok(A, { q: 'x' }, 1), ok('tool:poll', {}, 'p'), ok(B, { id: 1 }, 2), ok('tool:poll', {}, 'q')]),
      pending(A, { q: 'x' }),
    ],
    [{ at: 12, kind: 'cycle', repeats: 3, firstAt: 0, period: 2, laps: 3 }],
    { allowNodes: ['poll'] },
  ),
  // One node, two different inputs alternating: 2 distinct calls per lap -> a cycle (v3 never fires: the fingerprint changes every call).
  sequence(
    'cycle: one node alternating two inputs is a cycle',
    [...repeatN(3, [ok(A, { page: 1 }, 'p1'), ok(A, { page: 2 }, 'p2')]), pending(A, { page: 1 })],
    [{ at: 6, kind: 'cycle', repeats: 3, firstAt: 0, period: 2, laps: 3 }],
  ),
  // AAB x3: v3's streak never reaches 3 (B breaks it), the k=3 cycle holds lap 4.
  sequence(
    'cycle: A,A,B laps — v3 never reaches its threshold, the cycle holds',
    [...repeatN(3, [ok(A, { q: 1 }, 'r'), ok(A, { q: 1 }, 'r'), ok(B, {}, 'b')]), pending(A, { q: 1 })],
    [{ at: 9, kind: 'cycle', repeats: 3, firstAt: 0, period: 3, laps: 3 }],
  ),
  // Laps A,B,A,A: A A A across each lap boundary trips v3 at calls 4, 8, 12. At call 12 the k=4 cycle
  // also qualifies; v3 keeps precedence and the cycle is spent with it (quiet for one lap after).
  sequence(
    'cycle: overlap with v3 — v3 keeps precedence',
    [...repeatN(3, [ok(A, { q: 1 }, 'r'), ok(B, {}, 'b'), ok(A, { q: 1 }, 'r'), ok(A, { q: 1 }, 'r')]), pending(A, { q: 1 })],
    [
      { at: 4, kind: 'repeat', repeats: 3, firstAt: 2 },
      { at: 8, kind: 'repeat', repeats: 3, firstAt: 6 },
      { at: 12, kind: 'repeat', repeats: 3, firstAt: 10 },
    ],
  ),
  // After a cycle hold the next one needs a full lap; then laps = 4 and firstSeq stays the first lap's.
  sequence(
    'cycle: one hold per lap, then laps grows',
    [
      ...repeatN(3, [ok(A, { q: 'x' }, 1), ok(B, { id: 1 }, 2)]),
      ok(A, { q: 'x' }, 1), // held (call 6), then continued
      ok(B, { id: 1 }, 2), // a rotation of the same cycle: quiet
      pending(A, { q: 'x' }), // lap 5 starts: holds again
    ],
    [
      { at: 6, kind: 'cycle', repeats: 3, firstAt: 0, period: 2, laps: 3 },
      { at: 8, kind: 'cycle', repeats: 4, firstAt: 0, period: 2, laps: 4 },
    ],
  ),
  // 12 completed calls A,B,...: at call 12 both k=2 (6 laps) and k=4 (3 laps) fit; the smallest k wins.
  // (Holds at 6, 8, 10 on the way: one per lap.)
  sequence(
    'cycle: smallest k wins',
    [...repeatN(6, [ok(A, {}, 1), ok(B, {}, 2)]), pending(A, {})],
    [
      { at: 6, kind: 'cycle', repeats: 3, firstAt: 0, period: 2, laps: 3 },
      { at: 8, kind: 'cycle', repeats: 4, firstAt: 0, period: 2, laps: 4 },
      { at: 10, kind: 'cycle', repeats: 5, firstAt: 0, period: 2, laps: 5 },
      { at: 12, kind: 'cycle', repeats: 6, firstAt: 0, period: 2, laps: 6 },
    ],
  ),
  // A call whose input could not be read equals nothing: the laps are broken.
  sequence(
    'cycle: an unreadable start breaks the laps',
    [
      ok(A, { q: 'x' }, 1),
      ok(B, { id: 1 }, 2),
      ok(A, { q: 'x' }, 1),
      { nodeId: B, unreadable: true, outcome: { status: 'ok', output: 2 } },
      ok(A, { q: 'x' }, 1),
      ok(B, { id: 1 }, 2),
      pending(A, { q: 'x' }),
    ],
    [],
  ),
  // An aborted call equals nothing.
  sequence(
    'cycle: an aborted call breaks the laps',
    [ok(A, { q: 'x' }, 1), ok(B, { id: 1 }, 2), ok(A, { q: 'x' }, 1), aborted(B, { id: 1 }), ok(A, { q: 'x' }, 1), ok(B, { id: 1 }, 2), pending(A, { q: 'x' })],
    [],
  ),
  // A cycle of identical failures is a cycle (cycle is checked before error-repeat).
  sequence(
    'cycle: identical failures in a lap; cycle wins over error-repeat',
    [...repeatN(3, [thrown(A, { q: 1 }, 'Error', 'no such table'), thrown(B, { q: 2 }, 'TypeError', 'x is undefined')]), pending(A, { q: 1 })],
    [{ at: 6, kind: 'cycle', repeats: 3, firstAt: 0, period: 2, laps: 3 }],
  ),

  // error-repeat: 3 identical thrown errors with varying arguments, the 4th call holds.
  sequence(
    'error-repeat: three identical errors (arguments vary), the fourth call holds',
    [
      thrown(A, { sql: 'select 1' }, 'Error', 'relation "users" does not exist'),
      thrown(A, { sql: 'select 2' }, 'Error', 'relation "users" does not exist'),
      thrown(A, { sql: 'select 3' }, 'Error', 'relation "users" does not exist'),
      pending(A, { sql: 'select 4' }),
    ],
    [{ at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
  sequence(
    'error-repeat: two identical errors never hold',
    [thrown(A, { n: 1 }, 'Error', 'boom'), thrown(A, { n: 2 }, 'Error', 'boom'), pending(A, { n: 3 })],
    [],
  ),
  sequence(
    'error-repeat: a success of the node in between resets it',
    [
      thrown(A, { n: 1 }, 'Error', 'boom'),
      thrown(A, { n: 2 }, 'Error', 'boom'),
      ok(A, { n: 3 }, 'fine'),
      thrown(A, { n: 4 }, 'Error', 'boom'),
      thrown(A, { n: 5 }, 'Error', 'boom'),
      pending(A, { n: 6 }),
    ],
    [],
  ),
  sequence(
    'error-repeat: different messages never hold',
    [thrown(A, { n: 1 }, 'Error', 'boom 1'), thrown(A, { n: 2 }, 'Error', 'boom 2'), thrown(A, { n: 3 }, 'Error', 'boom 1'), pending(A, { n: 4 })],
    [],
  ),
  sequence(
    'error-repeat: different error names never hold',
    [thrown(A, { n: 1 }, 'Error', 'boom'), thrown(A, { n: 2 }, 'TypeError', 'boom'), thrown(A, { n: 3 }, 'Error', 'boom'), pending(A, { n: 4 })],
    [],
  ),
  sequence(
    'error-repeat: whitespace is collapsed and trimmed',
    [
      thrown(A, { n: 1 }, 'Error', 'relation  "users"\n\tdoes not exist'),
      thrown(A, { n: 2 }, 'Error', ' relation "users" does not exist '),
      thrown(A, { n: 3 }, 'Error', 'relation "users" does not exist'),
      pending(A, { n: 4 }),
    ],
    [{ at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
  sequence(
    'error-repeat: only the first 512 characters count',
    [
      thrown(A, { n: 1 }, 'Error', `${'e'.repeat(512)} request id 1`),
      thrown(A, { n: 2 }, 'Error', `${'e'.repeat(512)} request id 2`),
      thrown(A, { n: 3 }, 'Error', `${'e'.repeat(512)} request id 3`),
      pending(A, { n: 4 }),
    ],
    [{ at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
  sequence(
    'error-repeat: 511 identical characters then a difference never holds',
    [
      thrown(A, { n: 1 }, 'Error', `${'e'.repeat(511)}1`),
      thrown(A, { n: 2 }, 'Error', `${'e'.repeat(511)}2`),
      thrown(A, { n: 3 }, 'Error', `${'e'.repeat(511)}1`),
      pending(A, { n: 4 }),
    ],
    [],
  ),
  // A tool that returned an error-shaped result failed; identical results are the same error.
  sequence(
    'error-repeat: an error-shaped result counts as a failure',
    [
      returned(A, { path: 'a' }, { isError: true, content: [{ type: 'text', text: 'permission denied' }] }),
      returned(A, { path: 'b' }, { isError: true, content: [{ type: 'text', text: 'permission denied' }] }),
      returned(A, { path: 'c' }, { content: [{ type: 'text', text: 'permission denied' }], isError: true }),
      pending(A, { path: 'd' }),
    ],
    [{ at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
  sequence(
    'error-repeat: every strict error shape is a failure (identical results)',
    [
      returned(A, { n: 1 }, { success: false, reason: 'quota' }),
      returned(A, { n: 2 }, { success: false, reason: 'quota' }),
      returned(A, { n: 3 }, { success: false, reason: 'quota' }),
      returned(B, { n: 1 }, { exitCode: 2, stderr: 'x' }),
      returned(B, { n: 2 }, { exitCode: 2, stderr: 'x' }),
      returned(B, { n: 3 }, { exitCode: 2, stderr: 'x' }),
      pending(A, { n: 4 }),
      pending(B, { n: 4 }),
    ],
    [
      { at: 6, kind: 'error-repeat', repeats: 3, firstAt: 0 },
      { at: 7, kind: 'error-repeat', repeats: 3, firstAt: 3 },
    ],
  ),
  sequence(
    'error-repeat: error-shaped results with different content are different errors',
    [
      returned(A, { n: 1 }, { isError: true, content: 'a' }),
      returned(A, { n: 2 }, { isError: true, content: 'b' }),
      returned(A, { n: 3 }, { isError: true, content: 'a' }),
      pending(A, { n: 4 }),
    ],
    [],
  ),
  sequence(
    'error-repeat: results that are not error-shaped are successes',
    [
      returned(A, { n: 1 }, { isError: false, content: 'x' }),
      returned(A, { n: 2 }, { success: true }),
      returned(A, { n: 3 }, { exitCode: 0 }),
      returned(A, { n: 4 }, { error: 'x', other: 1 }),
      returned(A, { n: 5 }, 'error: something failed'),
      pending(A, { n: 6 }),
    ],
    [],
  ),
  // Calls of other nodes between the failures do not matter.
  sequence(
    'error-repeat: other nodes between the failures are skipped',
    [
      thrown(A, { n: 1 }, 'Error', 'boom'),
      ok(B, { n: 1 }, 'b1'),
      thrown(A, { n: 2 }, 'Error', 'boom'),
      ok(C, { n: 2 }, 'c1'),
      thrown(A, { n: 3 }, 'Error', 'boom'),
      pending(A, { n: 4 }),
    ],
    [{ at: 5, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
  // The held 4th call fails the same way: the 5th holds with repeats 4.
  sequence(
    'error-repeat: the next identical failure holds again with repeats 4',
    [
      thrown(A, { n: 1 }, 'Error', 'boom'),
      thrown(A, { n: 2 }, 'Error', 'boom'),
      thrown(A, { n: 3 }, 'Error', 'boom'),
      thrown(A, { n: 4 }, 'Error', 'boom'),
      pending(A, { n: 5 }),
    ],
    [
      { at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 },
      { at: 4, kind: 'error-repeat', repeats: 4, firstAt: 0 },
    ],
  ),
  // Identical arguments failing: v3 holds the 3rd call and the 4th (precedence); error-repeat never shows.
  sequence(
    'error-repeat: identical arguments are v3 first',
    [thrown(A, { n: 1 }, 'Error', 'boom'), thrown(A, { n: 1 }, 'Error', 'boom'), thrown(A, { n: 1 }, 'Error', 'boom'), pending(A, { n: 1 })],
    [
      { at: 2, kind: 'repeat', repeats: 3, firstAt: 0 },
      { at: 3, kind: 'repeat', repeats: 4, firstAt: 0 },
    ],
  ),
  sequence(
    'error-repeat: an unreadable start ends the streak',
    [
      thrown(A, { n: 1 }, 'Error', 'boom'),
      thrown(A, { n: 2 }, 'Error', 'boom'),
      { nodeId: A, unreadable: true, outcome: { status: 'error', error: { name: 'Error', message: 'boom' } } },
      thrown(A, { n: 3 }, 'Error', 'boom'),
      pending(A, { n: 4 }),
    ],
    [],
  ),
  // The AI SDK emits node.error without an instanceId: it belongs to the node's latest open call.
  sequence(
    'error-repeat: node.error without an instanceId, node.finished without one',
    [
      thrown(A, { n: 1 }, 'Error', 'boom', { errorWithoutInstance: true }),
      thrown(A, { n: 2 }, 'Error', 'boom', { errorWithoutInstance: true, finishWithoutInstance: true }),
      thrown(A, { n: 3 }, 'Error', 'boom', { noInstance: true }),
      pending(A, { n: 4 }),
    ],
    [{ at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
  // status error with no node.error and no error-shaped output: an unknown failure, equals nothing.
  sequence(
    'error-repeat: a failure with no error text is unknown and ends the streak',
    [
      thrown(A, { n: 1 }, 'Error', 'boom'),
      thrown(A, { n: 2 }, 'Error', 'boom'),
      { nodeId: A, input: { n: 3 }, outcome: { status: 'error' } },
      pending(A, { n: 4 }),
    ],
    [],
  ),
  // graphmind mcp-proxy finishes an isError result with status error, after a node.error whose message is one
  // constant sentence under a HIDE switch: the RESULT decides, so different contents are different errors...
  sequence(
    'error-repeat: proxy isError (status error) — different results with a constant message never hold',
    [
      proxyIsError(A, { n: 1 }, 'a'),
      proxyIsError(A, { n: 2 }, 'b'),
      proxyIsError(A, { n: 3 }, 'a'),
      pending(A, { n: 4 }),
    ],
    [],
  ),
  // ...and identical results are the same error.
  sequence(
    'error-repeat: proxy isError (status error) — identical results hold',
    [proxyIsError(A, { n: 1 }, 'denied'), proxyIsError(A, { n: 2 }, 'denied'), proxyIsError(A, { n: 3 }, 'denied'), pending(A, { n: 4 })],
    [{ at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
  // The same result through the proxy (status error) and returned with status ok by an SDK tool: one error.
  sequence(
    'error-repeat: an isError result counts the same with status error or ok',
    [
      proxyIsError(A, { n: 1 }, 'denied'),
      returned(A, { n: 2 }, { isError: true, content: [{ type: 'text', text: 'denied' }] }),
      proxyIsError(A, { n: 3 }, 'denied'),
      pending(A, { n: 4 }),
    ],
    [{ at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
  // A JSON-RPC error through the proxy: output {error: {...}}, node.error name JsonRpcError(code) + message.
  // Name + message decide (the thrown-error rule); a varying `data` does not matter.
  sequence(
    'error-repeat: proxy JSON-RPC error — name + message decide, data ignored',
    [
      proxyRpcError(A, { n: 1 }, -32602, 'bad params', { req: 1 }),
      proxyRpcError(A, { n: 2 }, -32602, 'bad params', { req: 2 }),
      proxyRpcError(A, { n: 3 }, -32602, 'bad params', { req: 3 }),
      pending(A, { n: 4 }),
    ],
    [{ at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
  sequence(
    'error-repeat: proxy JSON-RPC error — different messages never hold',
    [
      proxyRpcError(A, { n: 1 }, -32602, 'bad a', null),
      proxyRpcError(A, { n: 2 }, -32602, 'bad b', null),
      proxyRpcError(A, { n: 3 }, -32602, 'bad a', null),
      pending(A, { n: 4 }),
    ],
    [],
  ),
  // status error, no node.error, an {error} output: the output is the error.
  sequence(
    'error-repeat: status error with only an {error} output uses the output',
    [
      { nodeId: A, input: { n: 1 }, outcome: { status: 'error', output: { error: 'quota' } } },
      { nodeId: A, input: { n: 2 }, outcome: { status: 'error', output: { error: 'quota' } } },
      { nodeId: A, input: { n: 3 }, outcome: { status: 'error', output: { error: 'quota' } } },
      pending(A, { n: 4 }),
    ],
    [{ at: 3, kind: 'error-repeat', repeats: 3, firstAt: 0 }],
  ),
];

// -- smart rules --------------------------------------------------------------------

const errorResult = [
  ['isError true', { isError: true, content: [] }, 'isError'],
  ['success false', { success: false }, 'success'],
  ['exit_code 1', { exit_code: 1 }, 'exit_code'],
  ['exitCode -1', { exitCode: -1, stdout: '' }, 'exitCode'],
  ['exitStatus 127', { exitStatus: 127 }, 'exitStatus'],
  ['only key error (string)', { error: 'not found' }, 'error'],
  ['only key error (object)', { error: { code: 1 } }, 'error'],
  ['isError wins over success true', { isError: true, success: true }, 'isError'],
  ['isError false', { isError: false }, null],
  ['isError "true" (string)', { isError: 'true' }, null],
  ['success true', { success: true }, null],
  ['success 0', { success: 0 }, null],
  ['exitCode 0', { exitCode: 0 }, null],
  ['exitCode "1" (string)', { exitCode: '1' }, null],
  ['exit_code null', { exit_code: null }, null],
  ['error plus another key', { error: 'x', other: 'y' }, null],
  ['error null', { error: null }, null],
  ['error false', { error: false }, null],
  ['empty object', {}, null],
  ['a string containing error', 'Error: something failed', null],
  ['null', null, null],
  ['a number', 1, null],
  ['an array', [{ isError: true }], null],
  ['nested isError', { result: { isError: true } }, null],
  ['an error message field', { message: 'error' }, null],
].map(([name, result, shape]) => ({ name, result, shape }));

const truncated = [
  ['length + one tool call', { finishReason: 'length', toolCalls: [{ id: 'c1', name: 'search', input: {} }] }, { finishReason: 'length', toolCalls: 1, unparsed: 0 }],
  ['content-filter + tool call', { finishReason: 'content-filter', toolCalls: [{ name: 'a', input: {} }, { name: 'b', input: {} }] }, { finishReason: 'content-filter', toolCalls: 2, unparsed: 0 }],
  ['length + unparsed arguments', { finishReason: 'length', toolCalls: [{ name: 'write', input: {}, inputText: '{"path":"a.txt","conte' }] }, { finishReason: 'length', toolCalls: 1, unparsed: 1 }],
  ['length, no tool calls', { finishReason: 'length', toolCalls: [] }, null],
  ['length, toolCalls absent', { finishReason: 'length' }, null],
  ['length, toolCalls not an array', { finishReason: 'length', toolCalls: { 0: {} } }, null],
  ['stop + tool calls', { finishReason: 'stop', toolCalls: [{ name: 'a', input: {} }] }, null],
  ['tool-calls + unparsed', { finishReason: 'tool-calls', toolCalls: [{ name: 'a', inputText: '{' }] }, null],
  ['raw provider reason only', { rawFinishReason: 'max_tokens', toolCalls: [{ name: 'a', input: {} }] }, null],
  ['provider spelling is not normalized', { finishReason: 'max_tokens', toolCalls: [{ name: 'a', input: {} }] }, null],
  ['a string', 'length', null],
  ['null', null, null],
  ['an array', [{ finishReason: 'length', toolCalls: [{}] }], null],
].map(([name, result, fires]) => ({ name, result, fires }));

const breakOnEnv = [
  [null, true],
  ['', true],
  ['   ', true],
  ['0', false],
  ['false', false],
  ['FALSE', false],
  [' off ', false],
  ['No', false],
  ['1', true],
  ['true', true],
  ['on', true],
  ['yes', true],
  ['disabled', true],
].map(([raw, on]) => ({ raw, on }));

const errorText = [
  ['plain', 'boom', 'boom'],
  ['collapsed', ' a  b\n\tc ', 'a b c'],
  ['unicode whitespace (JS \\s)', 'a  b　c', 'a b c'],
  ['cut after collapsing', `${' '.repeat(10)}${'x'.repeat(600)}`, 'x'.repeat(512)],
].map(([name, text, key]) => ({ name, text, key }));

const fixture = {
  version: 4,
  description:
    'Conformance fixture for the GraphMind 0.6.0 detectors (TS reference: packages/client/src/smart.ts and loop-guard.ts; ' +
    'contract C4 in internal/research/phase7-plan-2026-09.md). Generated by gen-loop-kinds.mjs with hand-derived expectations. ' +
    '`errorResult`: the strict error-result shape of a tool result (null = not error-shaped). `truncated`: the truncated-tool-call ' +
    'rule over a normalized LLM output (null = no fire). `breakOnEnv`: a default-on GRAPHMIND_BREAK_ON_* value (null = unset). ' +
    '`errorText`: the error text key (JS \\s runs collapsed to one space, trimmed, first 512 chars). `sequences`: feed the events in ' +
    'order to ONE run of a guard with the defaults (threshold 3, mode pause, kinds [tool], ignoreKeys [_meta]) plus the sequence\'s ' +
    'allowNodes; a node\'s name is its nodeId after the first colon. `start` = node.started (seq = the event index; `unreadable` = an ' +
    'input whose property read throws) then consult the before-gate of that call; `error` = node.error; `finish` = node.finished ' +
    '(every event reached the wire). Expected holds: `at` = event index of the start whose before-gate holds, `kind` (repeat = v3), ' +
    '`repeats`, `firstAt` (what firstSeq points at), `period`/`laps` for cycles; lastSeq is always `at`. A consult repeated right ' +
    'after (a retry) never holds. Fingerprints of the new kinds are salted per process and are not in the fixture.',
  defaults: { threshold: 3, mode: 'pause', kinds: ['tool'], ignoreKeys: ['_meta'], historySize: 64, cycleLaps: 3, cyclePeriods: [2, 4], errorRepeatCount: 3 },
  errorResult,
  truncated,
  breakOnEnv,
  errorText,
  sequences,
};

writeFileSync(new URL('./loop-kinds.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`loop-kinds.json: ${sequences.length} sequences, ${errorResult.length} error-result cases, ${truncated.length} truncated cases`);
