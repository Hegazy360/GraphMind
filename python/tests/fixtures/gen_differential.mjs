// Generates python/tests/fixtures/differential.json from the TypeScript
// reference implementation (packages/client/dist), so the Python and Ruby
// ports can be held to thousands of randomised cases on top of the hand-written
// conformance fixtures in packages/client/test/fixtures/.
//
//   pnpm --filter @graphmind-ai/client build
//   node python/tests/fixtures/gen_differential.mjs
//
// Deterministic (seeded PRNG): re-running it on an unchanged client with the
// SAME Node major produces a byte-identical file (the checked-in file came from
// Node 24; Node 22 computes some random doubles differently, e.g. `10 ** n`, so
// its file differs in inputs — each file is still self-consistent, and both
// pass). The Python suite (tests/test_loop_guard.py, tests/test_redaction.py,
// class TestDifferential) and the Ruby suite (ruby/test/test_loop_guard.rb,
// ruby/test/test_redaction.rb) read it.
//
// Contents: `canonical` (loop-guard canonical JSON + fingerprints; the loop
// COUNTING rule is not in this file — its v3 sequences live in
// packages/client/test/fixtures/loop-guard.json) and `redaction` (random event
// streams). A redaction `out` entry is `{type, payload}`, or `{type, dropped:
// true}` when the TS Redactor returned undefined (fail closed).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const client = await import(join(here, '../../../packages/client/dist/index.js'));
const { canonicalCall, fingerprintCall, Redactor } = client;

let seed = 0x5eed1234;
function rand() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (items) => items[Math.floor(rand() * items.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const SPECIAL_NUMBERS = [
  0, 1, -1, 0.1, 0.2, 0.1 + 0.2, 1e21, 1e-7, 1e-6, 1.5e-7, 123456789012345680000, 1e20, 9.999e20,
  5e-324, 1.7976931348623157e308, -2.5e-8, 100, 1e16, 12345678901234567, 0.000001, 0.0000001,
  2 ** 53, 2 ** 53 + 2, -(2 ** 31), 3.14159, 1 / 3, 2 / 3, 1e300, 123e-20, 4.35, 0.5, 1e15 + 0.3,
];
const STRING_PIECES = [
  'a', 'Z', ' ', '  ', '"', '\\', '/', '\n', '\r', '\t', '\b', '\f', '\u0000', '\u0001', '\u001f',
  '\u007f', 'é', 'ß', '日本', '😀', '\u2028', '\u2029',
  '<script>', '__REDACTED__', 'cursor', '_meta', '\uffff', '\ue000',
];
const KEYS = [
  'a', 'b', 'A', 'B', '_', '1', '10', '2', 'é', 'z', '\uffff', '😀', '\ue000', 'aa', 'a b', '',
  '_meta', 'meta', 'cursor', 'page', 'progressToken', 'Z', '日', 'ß',
];

// Unpaired UTF-16 surrogates: legal in a JS string, impossible in a Ruby one.
const LONE_PIECES = ['\ud800', '\udfff', '\ud83d', 'x\ude00'];

function randomString() {
  let out = '';
  const n = int(0, 6);
  for (let i = 0; i < n; i += 1) out += rand() < 0.01 ? pick(LONE_PIECES) : pick(STRING_PIECES);
  return out;
}

function randomNumber() {
  const r = rand();
  if (r < 0.3) return pick(SPECIAL_NUMBERS) * (rand() < 0.2 ? -1 : 1);
  if (r < 0.55) return int(-1000000, 1000000);
  if (r < 0.8) return (rand() - 0.5) * 10 ** int(-12, 25);
  return Number((rand() * 1000).toFixed(int(0, 6)));
}

function randomValue(depth) {
  const r = rand();
  if (depth > 5 || r < 0.35) {
    return pick([() => null, () => true, () => false, randomNumber, randomString, randomNumber])();
  }
  if (r < 0.65) {
    const n = int(0, 4);
    return Array.from({ length: n }, () => randomValue(depth + 1));
  }
  const out = {};
  const n = int(0, 5);
  for (let i = 0; i < n; i += 1) out[rand() < 0.2 ? randomString() : pick(KEYS)] = randomValue(depth + 1);
  return out;
}

function deep(levels, leaf) {
  let value = leaf;
  for (let i = 0; i < levels; i += 1) value = { child: value, i };
  return value;
}

const canonical = [];
for (let i = 0; i < 400; i += 1) {
  const nodeId = rand() < 0.1 ? `tool:${randomString()}` : `tool:t${int(0, 3)}`;
  const input = randomValue(0);
  const ignoreKeys = pick([['_meta'], [], ['cursor', 'page'], ['a', '_meta']]);
  const set = new Set(ignoreKeys);
  canonical.push({
    nodeId,
    input,
    ignoreKeys,
    canonical: canonicalCall(nodeId, input, set),
    fingerprint: fingerprintCall(nodeId, input, set),
  });
}
for (const levels of [60, 63, 64, 65, 66, 100]) {
  const input = deep(levels, { secret: 1 });
  const set = new Set(['_meta']);
  canonical.push({
    nodeId: 'tool:deep',
    input,
    ignoreKeys: ['_meta'],
    canonical: canonicalCall('tool:deep', input, set),
    fingerprint: fingerprintCall('tool:deep', input, set),
  });
}

// -- redaction: random event streams under random switches ------------------
const NODES = [
  ['tool:search', 'tool'],
  ['tool:search', 'tool'],
  ['llm:step', 'llm'],
  ['agent:run', 'agent'],
  ['custom:x', 'custom'],
  ['tool:odd', 'llm'],
  ['mcp:session', 'server'],
];
const CHANNELS = ['text', 'reasoning', 'tool-args', 'weird'];

function randomRedaction() {
  const r = rand();
  if (r < 0.7) return undefined;
  return pick([
    { count: int(0, 5), keys: ['messages'] },
    { count: 1.5, keys: ['input'] },
    { count: -1, keys: [] },
    { count: 2 ** 53, keys: ['a', 7, 'b'] },
    { count: '3', keys: ['x'] },
    'garbage',
    { keys: ['k'] },
    { count: 1, keys: 'nope' },
    [1, 2],
  ]);
}

function randomEvent(open) {
  const r = rand();
  if (r < 0.35 || open.length === 0) {
    const [nodeId, kind] = pick(NODES);
    const payload = { nodeId, kind, name: nodeId.split(':')[1] };
    if (rand() < 0.8) payload.instanceId = `i${int(0, 9)}`;
    if (rand() < 0.85) payload.input = rand() < 0.1 ? '__REDACTED__' : randomValue(4);
    if (rand() < 0.1) payload.input = null;
    const red = randomRedaction();
    if (red !== undefined) payload.redaction = red;
    open.push(payload);
    return { type: 'node.started', payload };
  }
  if (r < 0.6) {
    const started = pick(open);
    const payload = { nodeId: rand() < 0.1 ? `tool:${int(0, 3)}` : started.nodeId, durationMs: int(0, 99), status: 'ok' };
    if (started.instanceId !== undefined && rand() < 0.85) payload.instanceId = started.instanceId;
    if (rand() < 0.85) payload.output = rand() < 0.1 ? '__REDACTED__' : randomValue(4);
    if (rand() < 0.1) payload.output = null;
    const red = randomRedaction();
    if (red !== undefined) payload.redaction = red;
    return { type: 'node.finished', payload };
  }
  if (r < 0.85) {
    const [nodeId] = pick(NODES);
    const deltas = Array.from({ length: int(0, 4) }, () =>
      rand() < 0.1 ? pick([null, 'x', { t: 'text' }, { t: 'text', v: 3 }]) : { t: pick(CHANNELS), v: randomString() },
    );
    const payload = { nodeId, deltas };
    const red = randomRedaction();
    if (red !== undefined) payload.redaction = red;
    return { type: 'node.token', payload };
  }
  if (r < 0.93) {
    const [nodeId] = pick(NODES);
    return { type: 'node.error', payload: { nodeId, instanceId: 'i1', error: { name: 'E', message: randomString() } } };
  }
  return pick([
    { type: 'run.started', payload: { app: 'a', sdk: { name: 't', version: '1' } } },
    { type: 'exec.paused', payload: { pauseId: 'p', nodeId: 'tool:search', point: 'before' } },
    { type: 'node.started', payload: 'not an object' },
    { type: 'node.token', payload: { nodeId: 'llm:step', deltas: 'nope' } },
    { type: 'node.finished', payload: { output: 'no node id', durationMs: 1, status: 'ok' } },
  ]);
}

const redaction = [];
for (let i = 0; i < 120; i += 1) {
  const switches = {
    hideInputs: rand() < 0.3,
    hideOutputs: rand() < 0.3,
    hideToolArgs: rand() < 0.4,
    hideToolResults: rand() < 0.4,
  };
  const redactor = new Redactor(switches);
  const open = [];
  const events = [];
  const out = [];
  const count = int(1, 25);
  for (let j = 0; j < count; j += 1) {
    const event = randomEvent(open);
    events.push(event);
    const runId = rand() < 0.15 ? 'run-b' : 'run-a';
    event.runId = runId;
    // Fail closed: `undefined` = the event must not be emitted (decisions.md
    // "Redaction fails closed on internal error"); recorded as `dropped: true`.
    const result = redactor.apply(event.type, event.payload, runId);
    out.push(result === undefined ? { type: event.type, dropped: true } : { type: event.type, payload: result });
  }
  redaction.push({ switches, in: events, out });
}

// JSON.stringify escapes exactly the LONE surrogates (well-formed pairs are
// written raw), so this finds every case a Ruby String cannot hold: Ruby
// strings are UTF-8 and JSON.parse refuses an unpaired surrogate escape.
// Those cases are stored double-encoded (a JSON string of JSON) under the
// `*LoneSurrogates` keys, which the Ruby suite skips and the Python suite
// decodes and runs.
const LONE = /\\ud[89a-f][0-9a-f]{2}/i;
const split = (cases) => {
  const portable = [];
  const lone = [];
  for (const c of cases) (LONE.test(JSON.stringify(c)) ? lone : portable).push(c);
  return [portable, lone];
};
const [canonicalPortable, canonicalLone] = split(canonical);
const [redactionPortable, redactionLone] = split(redaction);

const file = join(here, 'differential.json');
writeFileSync(
  file,
  `${JSON.stringify({
    $comment:
      'GENERATED by gen_differential.mjs from packages/client/dist (the TypeScript reference). Do not edit by hand; regenerate after changing loop-guard.ts or redaction.ts.',
    canonical: canonicalPortable,
    redaction: redactionPortable,
    canonicalLoneSurrogates: JSON.stringify(canonicalLone),
    redactionLoneSurrogates: JSON.stringify(redactionLone),
  })}\n`,
);
console.log(
  `wrote ${file}: ${canonicalPortable.length}+${canonicalLone.length} canonical cases, ` +
    `${redactionPortable.length}+${redactionLone.length} redaction streams (portable+lone surrogates)`,
);
