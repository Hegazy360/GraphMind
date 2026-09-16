/**
 * THE shrink invariant: every VALID event, shrunk with its type, is still a
 * valid event of that type, within budget, stable under a second pass, and
 * fast — whatever the payload looks like.
 *
 * The inputs are hostile on purpose (seeded, so a failure reproduces): wide
 * objects of 10,000+ keys, a 2,000,000-key typed-array-shaped object built by
 * JSON.parse, megabyte strings in the REQUIRED string fields, arrays of huge
 * objects, hundreds of medium fields, astral / multi-byte / escape-heavy text
 * at every cut point, huge loose fields inserted BEFORE the required ones,
 * integer-like keys ahead of a required nested object's own fields, and
 * deeply nested wide objects. Before shrink v2 most of these came back as the
 * whole-payload marker (not a valid node.* payload: the server dropped the
 * event and the node stayed "running"), and the 2M-key object took ~1 s and
 * ~700 MB per call.
 *
 * No new dependencies: a tiny seeded PRNG drives the choices.
 */
import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  EventPayloadSchemas,
  PROTOCOL_VERSION,
  parseEnvelope,
  parseEnvelopeJson,
  type EventType,
} from '../src/index.js';
import {
  SKELETON_MIN_CHARS,
  TRUNCATION_SUFFIX,
  serializePayload,
  skeletonPlan,
  type SkeletonPlan,
} from '../src/shrink.js';

const BUDGETS = [4096, 65_536, 524_288] as const;
const TIME_LIMIT_MS = 200;
const SEED = Number(process.env['GM_SHRINK_SEED'] ?? 20260914);

/** mulberry32: a small, well-distributed, seedable PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

/** Text units chosen to land on every awkward boundary: 1-, 2-, 3-, 4-byte, escapes, lone halves. */
const UNITS = ['x', 'é', '中', '😀', 'a😀', '\u0001', '"', '\\', '\n', '\ud83d', '\ude00', 'ü中😀"'] as const;

function hugeString(rng: Rng, minUnits: number, maxUnits: number): string {
  const unit = pick(rng, UNITS);
  const target = int(rng, minUnits, maxUnits);
  return unit.repeat(Math.max(1, Math.ceil(target / unit.length)));
}

/** A valid base payload per event type. The test fails if a type has none. */
const BASES: Record<EventType, () => Record<string, unknown>> = {
  'run.started': () => ({ app: 'demo-app', sdk: { name: 'ai', version: '7.0.79' }, meta: { env: 'dev' } }),
  'run.finished': () => ({ status: 'error', error: { name: 'Error', message: 'boom', stack: 'at x' } }),
  'graph.hint': () => ({ nodes: [{ nodeId: 'tool:a', kind: 'tool', name: 'a' }] }),
  'node.started': () => ({ nodeId: 'tool:search', kind: 'tool', name: 'search', instanceId: 'i1', input: { q: 1 } }),
  'node.token': () => ({ nodeId: 'llm:step', deltas: [{ t: 'text', v: 'hello' }] }),
  'node.finished': () => ({
    nodeId: 'tool:search',
    instanceId: 'i1',
    output: { hits: 3 },
    usage: { inputTokens: 1, outputTokens: 2 },
    durationMs: 4.25,
    heldMs: 0,
    status: 'ok',
  }),
  'node.error': () => ({ nodeId: 'llm:step', instanceId: 'l1', error: { name: 'APIError', message: 'bad', stack: 's' } }),
  'exec.paused': () => ({
    pauseId: 'p1',
    nodeId: 'tool:search',
    point: 'before',
    reason: 'loop',
    loop: { repeats: 3, firstSeq: 1, lastSeq: 3, fingerprint: 'abc' },
  }),
  'exec.resumed': () => ({ pauseId: 'p1', action: 'inject' }),
};

function isValid(type: EventType, payload: unknown): boolean {
  return parseEnvelope({ gm: PROTOCOL_VERSION, seq: 1, ts: 1, runId: 'run-1', type, payload }).kind === 'ok';
}

/** Paths (from the skeleton plan) of fields in the base payload that accept ANY string. */
function freeStringPaths(type: EventType): string[][] {
  const base = BASES[type]();
  const out: string[][] = [];
  const walk = (plan: SkeletonPlan, value: Record<string, unknown>, path: string[]): void => {
    for (const [key, sub] of plan.keys) {
      const child = value[key];
      if (sub !== null && sub !== 'optional' && child !== null && typeof child === 'object') {
        walk(sub, child as Record<string, unknown>, [...path, key]);
      } else if (typeof child === 'string') {
        const probe = structuredClone(base);
        setPath(probe, [...path, key], `${child}\u0001😀 free text`);
        if (isValid(type, probe)) out.push([...path, key]);
      }
    }
  };
  const plan = skeletonPlan(type);
  if (plan !== undefined) walk(plan, base, []);
  return out;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node = target;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[path[path.length - 1] as string] = value;
}

/** Rebuild `payload` with `extra` fields inserted FIRST (JavaScript keeps insertion order). */
function before(extra: Record<string, unknown>, payload: Record<string, unknown>): Record<string, unknown> {
  return { ...extra, ...payload };
}

function wideObject(rng: Rng, keys: number, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys; i += 1) out[`${prefix}${i}`] = pick(rng, ['v', 'é中😀', `record ${i}`, i, null, true]);
  return out;
}

let twoMillionText: string | undefined;
/** `"0":7,"1":7,...` — the JSON body of a 2,000,000-element typed array. */
function typedArrayBody(): string {
  if (twoMillionText === undefined) {
    const parts: string[] = new Array(2_000_000);
    for (let i = 0; i < parts.length; i += 1) parts[i] = `"${i}":7`;
    twoMillionText = parts.join(',');
  }
  return twoMillionText;
}

interface Variant {
  name: string;
  /** A 2M-key case (built once, skipped by the quick non-vacuity pass). */
  huge?: boolean;
  build: (type: EventType, rng: Rng) => Record<string, unknown> | undefined;
}

const VARIANTS: Variant[] = [
  {
    name: 'megabyte strings in every free required string field',
    build: (type, rng) => {
      const paths = freeStringPaths(type);
      if (paths.length === 0) return undefined;
      const payload = BASES[type]();
      for (const path of paths) setPath(payload, path, hugeString(rng, 300_000, 1_200_000));
      return payload;
    },
  },
  {
    name: 'astral / multi-byte / escapes at the 32, 256 and 2000 cut points, forced over budget',
    build: (type, rng) => {
      const paths = freeStringPaths(type);
      const payload = BASES[type]();
      const cut = pick(rng, [32, 256, 2000]);
      const offset = int(rng, -2, 1);
      const odd = pick(rng, ['😀', '中', '\u0001', '"', '\ud83d', 'é']);
      for (const path of paths) setPath(payload, path, `${'a'.repeat(cut + offset)}${odd.repeat(int(rng, 1, 3))}${'b'.repeat(int(rng, 0, 600))}`);
      return before({ blob: `${'c'.repeat(1999 + offset)}${odd}${hugeString(rng, 600_000, 700_000)}` }, payload);
    },
  },
  {
    name: 'escape-heavy required strings (6 bytes of JSON per unit) with a huge loose field',
    build: (type, rng) => {
      const paths = freeStringPaths(type);
      if (paths.length === 0) return undefined;
      const payload = BASES[type]();
      for (const path of paths) setPath(payload, path, pick(rng, ['\u0001', '\ud800', '\u001f']).repeat(int(rng, 257, 5000)));
      return before({ pad: '\u0002'.repeat(int(rng, 100_000, 200_000)) }, payload);
    },
  },
  {
    name: 'a wide loose object of 10,000+ keys placed before the required fields',
    build: (type, rng) => before({ wide: wideObject(rng, int(rng, 12_000, 40_000), pick(rng, ['k', 'ключ', '鍵😀'])) }, BASES[type]()),
  },
  {
    name: 'an object of 6,000 records keyed by id (in output / input / meta, else loose)',
    build: (type) => {
      const records: Record<string, unknown> = {};
      for (let i = 0; i < 6000; i += 1) records[`id${i}`] = { name: `record ${i}`, score: 0.5, desc: 'a short description of the record' };
      const payload = BASES[type]();
      const slot = type === 'node.finished' ? 'output' : type === 'node.started' ? 'input' : type === 'run.started' ? 'meta' : 'records';
      payload[slot] = records;
      return payload;
    },
  },
  {
    name: '300 medium (3 KB) loose fields before the required ones',
    build: (type, rng) => {
      const extra: Record<string, unknown> = {};
      for (let i = 0; i < 300; i += 1) extra[`f${String(i).padStart(3, '0')}`] = pick(rng, ['m', 'é', '😀']).repeat(3000);
      return before(extra, BASES[type]());
    },
  },
  {
    name: 'more top-level fields than MAX_SHRINK_KEYS, one of them huge',
    build: (type, rng) => {
      const extra: Record<string, unknown> = { giant: hugeString(rng, 600_000, 900_000) };
      for (let i = 0; i < 400; i += 1) extra[`s${i}`] = i;
      return { ...BASES[type](), ...extra };
    },
  },
  {
    name: 'arrays of huge objects (in the required array when the type has one)',
    build: (type, rng) => {
      const payload = BASES[type]();
      const rows = Array.from({ length: int(rng, 20, 60) }, (_, i) => ({ id: i, body: hugeString(rng, 20_000, 40_000) }));
      if (type === 'graph.hint') {
        payload['nodes'] = rows.map((row, i) => ({ nodeId: `n${i}`, kind: 'tool', name: row.body }));
      } else if (type === 'node.token') {
        payload['deltas'] = rows.map((row) => ({ t: 'text', v: row.body }));
      } else {
        payload['rows'] = rows;
      }
      return payload;
    },
  },
  {
    name: 'deeply nested wide objects',
    build: (type, rng) => {
      let node: Record<string, unknown> = { leaf: hugeString(rng, 100_000, 200_000) };
      for (let depth = 0; depth < 10; depth += 1) node = { ...wideObject(rng, 400, `d${depth}_`), next: node };
      node['wideAtDepth'] = { a: { b: { c: wideObject(rng, 20_000, 'w') } } };
      return before({ deep: node }, BASES[type]());
    },
  },
  {
    name: 'a required nested object with 10,000 extra keys (integer-like first) and a huge required string',
    build: (type, rng) => {
      const plan = skeletonPlan(type);
      const nested = plan?.keys.find(([, sub]) => sub !== null && sub !== 'optional');
      const payload = BASES[type]();
      if (nested === undefined) return undefined;
      const [key] = nested;
      const own = payload[key] as Record<string, unknown>;
      const crowded: Record<string, unknown> = {};
      for (let i = 0; i < 10_000; i += 1) crowded[pick(rng, [String(i), `x${i}`])] = 'filler text';
      const merged = { ...crowded, ...own };
      const firstFree = freeStringPaths(type).find((path) => path[0] === key);
      if (firstFree !== undefined) merged[firstFree[1] as string] = hugeString(rng, 1_000_000, 1_000_000);
      payload[key] = merged;
      return payload;
    },
  },
  {
    name: 'huge key names (the fields list alone exceeds a small budget)',
    build: (type, rng) => {
      const extra: Record<string, unknown> = {};
      for (let i = 0; i < 12; i += 1) extra[`${pick(rng, ['k', '中', '😀'])}${i}`.repeat(int(rng, 2_000, 60_000))] = i;
      return before(extra, BASES[type]());
    },
  },
  {
    name: 'a 2,000,000-key typed-array-shaped object as a loose field before the required ones',
    huge: true,
    build: (type) => {
      const base = JSON.stringify(BASES[type]());
      return JSON.parse(`{"samples":{${typedArrayBody()}},${base.slice(1)}`) as Record<string, unknown>;
    },
  },
];

const HUGE_TOP_LEVEL: Variant = {
  name: '2,000,000 integer-like keys at the TOP level ahead of the required fields',
  huge: true,
  build: (type) => {
    const base = JSON.stringify(BASES[type]());
    return JSON.parse(`{${typedArrayBody()},${base.slice(1)}`) as Record<string, unknown>;
  },
};

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const timing = { maxMs: 0, maxCase: '', maxStringifyMs: 0, maxOverheadMs: 0 };

/** Which outcome each check produced, so the suite proves every tier is exercised. */
const tally = { trimmed: 0, skeleton: 0, skeletonNoPreview: 0, skeletonMinChars: 0 };

function cutAt(value: unknown, chars: number, depth = 0): boolean {
  if (typeof value === 'string') return value.length === chars + TRUNCATION_SUFFIX.length && value.endsWith(TRUNCATION_SUFFIX);
  if (depth > 1 || value === null || typeof value !== 'object') return false;
  return Object.values(value).some((child) => cutAt(child, chars, depth + 1));
}

function classify(type: EventType, input: Record<string, unknown>, out: Record<string, unknown>): void {
  const allowed = new Set([...(skeletonPlan(type)?.keys.map(([key]) => key) ?? []), '__graphmindTruncated', 'bytes', 'preview', 'fields']);
  const isSkeleton = Object.keys(out).every((key) => allowed.has(key)) && Object.keys(input).some((key) => !allowed.has(key) || typeof input[key] === 'string');
  if (!isSkeleton || Array.isArray(out['fields']) && Object.keys(out).some((key) => !allowed.has(key))) {
    tally.trimmed += 1;
    return;
  }
  tally.skeleton += 1;
  if (out['preview'] === '') tally.skeletonNoPreview += 1;
  if (cutAt(out, SKELETON_MIN_CHARS)) tally.skeletonMinChars += 1;
}

interface Failure {
  type: string;
  variant: string;
  maxBytes: number;
  problem: string;
}

function checkOne(type: EventType, variant: Variant, payload: Record<string, unknown>, failures: Failure[]): void {
  // The one JSON.stringify of the payload is unavoidable (the budget is
  // measured on it) and can itself be slow: ~130-200 ms for a 2M-key object,
  // ~200-390 ms for 3.6 M lone surrogates (V8 escapes each one). The limit is
  // TIME_LIMIT_MS for the shrink's own work on top of twice that.
  let stringifyMs = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const t0 = performance.now();
    JSON.stringify(payload);
    stringifyMs = Math.min(stringifyMs, performance.now() - t0);
  }
  for (const maxBytes of BUDGETS) {
    const fail = (problem: string): void => {
      failures.push({ type, variant: variant.name, maxBytes, problem });
    };
    const limit = TIME_LIMIT_MS + 2 * stringifyMs;
    // Best of three: vitest runs files in parallel and a multi-megabyte heap
    // collects garbage at random; a real regression (v1: seconds) fails all three.
    let started = performance.now();
    const result = serializePayload(payload, maxBytes, type);
    let elapsed = performance.now() - started;
    for (let attempt = 1; attempt < 3 && elapsed >= limit; attempt += 1) {
      started = performance.now();
      serializePayload(payload, maxBytes, type);
      elapsed = Math.min(elapsed, performance.now() - started);
    }
    if (elapsed > timing.maxMs) Object.assign(timing, { maxMs: elapsed, maxCase: `${type} / ${variant.name} / ${maxBytes}`, maxStringifyMs: stringifyMs });
    timing.maxOverheadMs = Math.max(timing.maxOverheadMs, elapsed - stringifyMs);
    if (elapsed >= limit) fail(`took ${elapsed.toFixed(0)} ms (limit ${limit.toFixed(0)} ms), best of 3`);
    const bytes = utf8Bytes(result.json);
    if (bytes > maxBytes) fail(`${bytes} bytes > ${maxBytes}`);
    if (JSON.stringify(result.payload) !== result.json) fail('json and payload disagree');
    const envelope = { gm: PROTOCOL_VERSION, seq: 7, ts: 1, runId: 'run-1', type, payload: result.payload };
    const parsed = parseEnvelope(envelope);
    if (parsed.kind !== 'ok') {
      fail(`result is not a valid ${type}: ${parsed.kind} ${JSON.stringify((parsed as { issues?: unknown }).issues)?.slice(0, 200)}`);
    }
    // The wire form (what a server parses) too.
    const wire = `{"gm":${PROTOCOL_VERSION},"seq":7,"ts":1,"runId":"run-1","type":${JSON.stringify(type)},"payload":${result.json}}`;
    if (parseEnvelopeJson(wire).kind !== 'ok') fail('wire form does not parse');
    if (result.truncated && result.payload !== null && typeof result.payload === 'object') {
      classify(type, payload, result.payload as Record<string, unknown>);
    }
    const again = serializePayload(result.payload, maxBytes, type);
    if (again.json !== result.json || again.truncated) fail('second pass changed it');
    const fromWire = serializePayload(JSON.parse(result.json), maxBytes, type);
    if (fromWire.json !== result.json || fromWire.truncated) fail('second pass over the parsed JSON changed it');
  }
}

describe('shrink invariant: every valid event, shrunk, stays a valid event within budget', () => {
  it('has a valid base payload for every event type', () => {
    expect(Object.keys(BASES).sort()).toEqual([...EVENT_TYPES].sort());
    for (const type of EVENT_TYPES) {
      expect(isValid(type, BASES[type]()), type).toBe(true);
      expect(EventPayloadSchemas[type]).toBeDefined();
    }
  });

  for (const variant of VARIANTS) {
    it(
      variant.name,
      () => {
        const failures: Failure[] = [];
        let checked = 0;
        for (const [index, type] of EVENT_TYPES.entries()) {
          const rng = prng(SEED + index * 7919 + variant.name.length);
          const payload = variant.build(type, rng);
          if (payload === undefined) continue;
          // Only VALID events are in scope, and they must be over budget to exercise anything.
          expect(isValid(type, payload), `${type} input is valid`).toBe(true);
          checkOne(type, variant, payload, failures);
          checked += 1;
        }
        expect(checked).toBeGreaterThan(0);
        expect(failures).toEqual([]);
      },
      120_000,
    );
  }

  it(
    HUGE_TOP_LEVEL.name,
    () => {
      const failures: Failure[] = [];
      for (const type of ['node.finished', 'node.error', 'run.started'] as const) {
        const payload = HUGE_TOP_LEVEL.build(type, prng(SEED)) as Record<string, unknown>;
        expect(isValid(type, payload)).toBe(true);
        checkOne(type, HUGE_TOP_LEVEL, payload, failures);
      }
      expect(failures).toEqual([]);
    },
    120_000,
  );

  it('is not vacuous: every hostile payload really is over the smallest budget', () => {
    for (const variant of VARIANTS.filter((v) => v.huge !== true)) {
      for (const [index, type] of EVENT_TYPES.entries()) {
        const payload = variant.build(type, prng(SEED + index * 7919 + variant.name.length));
        if (payload === undefined) continue;
        expect(serializePayload(payload, 4096, type).truncated, `${variant.name} / ${type}`).toBe(true);
      }
    }
  }, 120_000);

  it('exercised every outcome: the field trim, the full skeleton, and both smaller skeleton attempts', () => {
    expect(tally.trimmed).toBeGreaterThan(0);
    expect(tally.skeleton).toBeGreaterThan(0);
    expect(tally.skeletonNoPreview).toBeGreaterThan(0);
    expect(tally.skeletonMinChars).toBeGreaterThan(0);
    console.info(`[shrink-invariant] outcomes ${JSON.stringify(tally)}; slowest call ${JSON.stringify(timing)}`);
  });

  it('several seeds: the free-string and cut-point variants hold for 25 more seeds', () => {
    const failures: Failure[] = [];
    for (let seed = 1; seed <= 25; seed += 1) {
      for (const variant of VARIANTS.slice(0, 3)) {
        for (const type of EVENT_TYPES) {
          const payload = variant.build(type, prng(seed * 104_729));
          if (payload === undefined) continue;
          checkOne(type, variant, payload, failures);
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 120_000);
});
