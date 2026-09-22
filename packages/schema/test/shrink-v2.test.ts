/**
 * Shrink v2, rule by rule: the key cap (MAX_SHRINK_KEYS), the optional event
 * type, the skeleton tier and its three attempts, the unserializable path
 * with a type, and the single-pass field sizing. The fixture pins exact
 * bytes; these pin the behaviour behind them, including what JSON cannot
 * carry (getters, cycles, BigInt, toJSON).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, PROTOCOL_VERSION, parseEnvelope, type EventType } from '../src/index.js';
import {
  MAX_PAYLOAD_BYTES,
  MAX_SHRINK_KEYS,
  PREVIEW_CHARS,
  SKELETON_CHARS,
  SKELETON_MIN_CHARS,
  TRUNCATION_SUFFIX,
  isTruncatedPayload,
  serializePayload,
  topLevelSpans,
  utf8ByteLength,
} from '../src/shrink.js';

type Json = Record<string, unknown>;

function valid(type: EventType, payload: unknown): boolean {
  return parseEnvelope({ gm: PROTOCOL_VERSION, seq: 1, ts: 1, runId: 'r', type, payload }).kind === 'ok';
}

function keyed(prefix: string, count: number, value: unknown = 1): Json {
  const out: Json = {};
  for (let i = 0; i < count; i += 1) out[`${prefix}${i}`] = value;
  return out;
}

const cut = (text: string, chars: number): string => `${text.slice(0, chars)}${TRUNCATION_SUFFIX}`;

describe('rule A: the key cap', () => {
  const big = 'b'.repeat(600_000);

  it('keeps the first 256 keys of a field object and records how many were dropped', () => {
    const result = serializePayload({ nodeId: 'n', durationMs: 1, status: 'ok', output: { ...keyed('k', 300), body: big } });
    const output = (result.payload as Json)['output'] as Json;
    const keys = Object.keys(output);
    expect(keys.slice(0, MAX_SHRINK_KEYS)).toEqual(Object.keys(keyed('k', 256)));
    expect(keys.slice(MAX_SHRINK_KEYS)).toEqual(['__graphmindTruncated', 'bytes', 'preview', 'keysDropped']);
    expect(output['keysDropped']).toBe(45); // k256..k299 and body
    expect(output['body']).toBeUndefined();
  });

  it('an object of exactly 256 keys is not capped; 257 drops one', () => {
    const exact = serializePayload({ nodeId: 'n', output: { inner: keyed('e', 256), body: big } });
    expect(((exact.payload as Json)['output'] as Json)['inner']).toEqual(keyed('e', 256));
    const over = serializePayload({ nodeId: 'n', output: { inner: keyed('e', 257), body: big } });
    expect(((over.payload as Json)['output'] as Json)['inner']).toEqual({
      ...keyed('e', 256),
      __graphmindTruncated: true,
      keysDropped: 1,
    });
  });

  it('caps at any depth, with only __graphmindTruncated and keysDropped below the top', () => {
    const result = serializePayload({ output: { a: { b: { c: keyed('x', 1000) } }, body: big } });
    const c = (((((result.payload as Json)['output'] as Json)['a'] as Json)['b'] as Json)['c']) as Json;
    expect(Object.keys(c)).toHaveLength(258);
    expect(c['__graphmindTruncated']).toBe(true);
    expect(c['keysDropped']).toBe(744);
    expect(c['bytes']).toBeUndefined();
  });

  it('reads the values of only the first 256 keys (the rest are counted, never shrunk)', () => {
    let reads = 0;
    const output: Json = {};
    for (let i = 0; i < 10_000; i += 1) {
      Object.defineProperty(output, `g${i}`, {
        enumerable: true,
        get() {
          reads += 1;
          return 'x'.repeat(100);
        },
      });
    }
    const result = serializePayload({ nodeId: 'n', durationMs: 1, status: 'ok', output }, MAX_PAYLOAD_BYTES, 'node.finished');
    // JSON.stringify reads every value once; the shrink adds exactly 256 more.
    expect(reads).toBe(10_000 + MAX_SHRINK_KEYS);
    expect(((result.payload as Json)['output'] as Json)['keysDropped']).toBe(10_000 - MAX_SHRINK_KEYS);
    expect(valid('node.finished', result.payload)).toBe(true);
  });

  it('enumerates in JavaScript key order: integer-like keys first', () => {
    const output = JSON.parse(`{"name":"first-in-text",${Array.from({ length: 300 }, (_, i) => `"${i}":0`).join(',')}}`) as Json;
    output['body'] = big;
    const result = serializePayload({ output });
    const kept = Object.keys((result.payload as Json)['output'] as Json);
    expect(kept).toHaveLength(MAX_SHRINK_KEYS + 4);
    expect(kept[0]).toBe('0');
    expect(kept).not.toContain('name');
  });

  it('the field trim is gated by MAX_TRIM_FIELDS (4,096), not MAX_SHRINK_KEYS: 257 small fields survive', () => {
    const payload = { ...keyed('s', 300), giant: big };
    expect((serializePayload(payload).payload as Json)['fields']).toEqual(['giant']);
    expect((serializePayload(payload).payload as Json)['s0']).toBe(payload['s0' as keyof typeof payload]);
    // ...and above 4,096 top-level fields the trim is not attempted (untyped -> whole marker).
    const huge = { ...keyed('s', 4097), giant: big };
    expect(serializePayload(huge).payload).toEqual({
      __graphmindTruncated: true,
      bytes: utf8ByteLength(JSON.stringify(huge)),
      preview: JSON.stringify(huge).slice(0, PREVIEW_CHARS),
    });
  });
});

describe('rule B: the optional type', () => {
  const medium = keyed('f', 300, 'm'.repeat(3000));

  it('without a type, or with a type the schema does not know, the tiers are unchanged', () => {
    const payload = { nodeId: 'n', durationMs: 1, status: 'ok', ...medium };
    const plain = serializePayload(payload);
    expect(Object.keys(plain.payload as Json)).toEqual(['__graphmindTruncated', 'bytes', 'preview']);
    for (const type of ['node.custom', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
      expect(serializePayload(payload, MAX_PAYLOAD_BYTES, type).json, type).toBe(plain.json);
    }
  });

  it('under budget a payload is returned as is, even an invalid one, whatever the type', () => {
    const payload = { nodeId: 5 };
    expect(serializePayload(payload, MAX_PAYLOAD_BYTES, 'node.finished')).toEqual({
      json: '{"nodeId":5}',
      payload,
      truncated: false,
    });
  });
});

describe('rule C: the skeleton', () => {
  it('replaces the whole-payload marker for a known type: required fields, plus optional scalars, in schema order', () => {
    const payload = {
      ...keyed('f', 300, 'm'.repeat(3000)),
      status: 'ok',
      durationMs: 2,
      heldMs: 1.5,
      usage: { inputTokens: 1, outputTokens: 2 },
      output: 'short text',
      instanceId: 'i',
      nodeId: 'tool:t',
    };
    const result = serializePayload(payload, MAX_PAYLOAD_BYTES, 'node.finished');
    const out = result.payload as Json;
    expect(Object.keys(out)).toEqual([
      'nodeId',
      'instanceId',
      'output',
      'durationMs',
      'heldMs',
      'status',
      '__graphmindTruncated',
      'bytes',
      'preview',
      'fields',
    ]);
    // usage is an optional OBJECT: dropped and listed.
    expect(out['fields']).toEqual([...Object.keys(keyed('f', 300)), 'usage']);
    expect(out['output']).toBe('short text');
    expect(out['bytes']).toBe(utf8ByteLength(JSON.stringify(payload)));
    expect(out['preview']).toBe(JSON.stringify(payload).slice(0, PREVIEW_CHARS));
    expect(valid('node.finished', out)).toBe(true);
    expect(isTruncatedPayload(out)).toBe(true);
  });

  it('is used when the field trim fits but is not valid (a required object capped before its own fields)', () => {
    const error = JSON.parse(`{"name":"APIError","message":"boom",${Array.from({ length: 5000 }, (_, i) => `"${i}":"x"`).join(',')}}`) as Json;
    error['message'] = `provider said: ${'e'.repeat(700_000)}`;
    const payload = { nodeId: 'llm:x', error };
    // Without the type the trim result is returned — and it is not a valid node.error.
    const untyped = serializePayload(payload);
    expect(valid('node.error', untyped.payload)).toBe(false);
    const typed = serializePayload(payload, MAX_PAYLOAD_BYTES, 'node.error');
    expect(valid('node.error', typed.payload)).toBe(true);
    expect((typed.payload as Json)['error']).toEqual({ name: 'APIError', message: cut(error['message'] as string, SKELETON_CHARS) });
    expect((typed.payload as Json)['fields']).toEqual(['error']);
  });

  it('verbatim: a short string, a number, an empty array or an exact planned object is not listed in fields', () => {
    const pad = keyed('p', 300, 'z'.repeat(2000));
    const exactSdk = serializePayload({ ...pad, app: 'a'.repeat(SKELETON_CHARS), sdk: { name: 'ai', version: '1' } }, MAX_PAYLOAD_BYTES, 'run.started');
    expect((exactSdk.payload as Json)['fields']).toEqual(Object.keys(pad));
    expect((exactSdk.payload as Json)['app']).toBe('a'.repeat(SKELETON_CHARS));

    const extraSdk = serializePayload({ ...pad, app: 'a'.repeat(SKELETON_CHARS + 1), sdk: { version: '1', name: 'ai', extra: true } }, MAX_PAYLOAD_BYTES, 'run.started');
    const out = extraSdk.payload as Json;
    expect(out['fields']).toEqual([...Object.keys(pad), 'app', 'sdk']);
    expect(out['app']).toBe(cut('a'.repeat(SKELETON_CHARS + 1), SKELETON_CHARS));
    // Planned keys come out in schema order.
    expect(out['sdk']).toEqual({ name: 'ai', version: '1' });
    expect(Object.keys(out['sdk'] as Json)).toEqual(['name', 'version']);

    const emptyNodes = serializePayload({ ...pad, nodes: [] }, MAX_PAYLOAD_BYTES, 'graph.hint');
    expect((emptyNodes.payload as Json)['fields']).toEqual(Object.keys(pad));
    const someNodes = serializePayload({ ...pad, nodes: [{ nodeId: 'a', kind: 'tool', name: 'a' }] }, MAX_PAYLOAD_BYTES, 'graph.hint');
    expect((someNodes.payload as Json)['fields']).toEqual([...Object.keys(pad), 'nodes']);
    expect((someNodes.payload as Json)['nodes']).toEqual([]);
  });

  it('second attempt: no preview and no fields when the field names alone exceed the budget', () => {
    const payload: Json = { nodeId: 'n', durationMs: 1, status: 'ok' };
    for (let i = 0; i < 5; i += 1) payload[`${i}-${'k'.repeat(2000)}`] = i;
    const result = serializePayload(payload, 4096, 'node.finished');
    expect(result.payload).toEqual({
      nodeId: 'n',
      durationMs: 1,
      status: 'ok',
      __graphmindTruncated: true,
      bytes: utf8ByteLength(JSON.stringify(payload)),
      preview: '',
    });
  });

  it('third attempt: strings of SKELETON_MIN_CHARS when 256 units of escapes cannot fit', () => {
    const control = String.fromCharCode(1).repeat(400);
    const payload = { nodeId: control, kind: 'tool', name: control, instanceId: control, input: 'x'.repeat(10_000) };
    const result = serializePayload(payload, 4096, 'node.started');
    expect(result.payload).toEqual({
      nodeId: cut(control, SKELETON_MIN_CHARS),
      kind: 'tool',
      name: cut(control, SKELETON_MIN_CHARS),
      instanceId: cut(control, SKELETON_MIN_CHARS),
      input: cut(payload.input, SKELETON_MIN_CHARS), // optional, but a string: kept
      __graphmindTruncated: true,
      bytes: utf8ByteLength(JSON.stringify(payload)),
      preview: '',
    });
    expect(utf8ByteLength(result.json)).toBeLessThanOrEqual(4096);
  });

  it('an event that was not valid to begin with still gets the whole-payload marker', () => {
    const payload = { nodeId: 'n', durationMs: -1, status: 'ok', blob: 'x'.repeat(600_000), ...keyed('f', 300) };
    const result = serializePayload(payload, MAX_PAYLOAD_BYTES, 'node.finished');
    expect(Object.keys(result.payload as Json)).toEqual(['__graphmindTruncated', 'bytes', 'preview']);
  });

  it('a non-plain value in a required field becomes the omitted marker (and fails validation honestly)', () => {
    const payload = { ...keyed('f', 300, 'y'.repeat(2000)), nodeId: 'n', error: 'not an object' };
    const result = serializePayload(payload, MAX_PAYLOAD_BYTES, 'node.error');
    // "not an object" is a string, so it stays a string, the skeleton is invalid, and the marker wins.
    expect(Object.keys(result.payload as Json)).toEqual(['__graphmindTruncated', 'bytes', 'preview']);
  });

  it('a key named __proto__ stays an ordinary own key through the skeleton', () => {
    const payload = JSON.parse(`{"__proto__":{"polluted":true},"pauseId":"p","action":"continue","big":"${'q'.repeat(10_000)}"}`) as Json;
    const result = serializePayload(payload, 4096, 'exec.resumed');
    const out = JSON.parse(result.json) as Json;
    expect(out['fields']).toEqual(['__proto__', 'big']);
    expect(({} as Json)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(result.payload)).toBe(Object.prototype);
  });

  it('holds for random valid node.error payloads at arbitrary budgets >= 4096', () => {
    const unit = fc.constantFrom('a', 'é', '中', '😀', '\ud83d', '"', '\\', String.fromCharCode(1));
    fc.assert(
      fc.property(
        unit,
        fc.integer({ min: 0, max: 900_000 }),
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 4096, max: 700_000 }),
        fc.boolean(),
        (u, messageLength, extraKeys, maxBytes, extrasFirst) => {
          const extras = keyed('x', extraKeys, u.repeat(20));
          const own = { name: u.repeat(300), message: u.repeat(messageLength) };
          const payload = { nodeId: u.repeat(500), error: extrasFirst ? { ...extras, ...own } : { ...own, ...extras } };
          const result = serializePayload(payload, maxBytes, 'node.error');
          const again = serializePayload(result.payload, maxBytes, 'node.error');
          return (
            valid('node.error', result.payload) &&
            utf8ByteLength(result.json) <= maxBytes &&
            again.json === result.json &&
            !again.truncated
          );
        },
      ),
      { numRuns: 120 },
    );
  });
});

describe('unserializable payloads with a type', () => {
  it('a cyclic REQUIRED object: the skeleton keeps the event valid', () => {
    const error: Json = { name: 'LoopError', message: 'm' };
    error['self'] = error;
    const result = serializePayload({ nodeId: 'n', error }, MAX_PAYLOAD_BYTES, 'node.error');
    expect(result.payload).toEqual({
      nodeId: 'n',
      error: { name: 'LoopError', message: 'm' },
      __graphmindTruncated: true,
      bytes: 0,
      preview: '[unserializable payload]',
      fields: ['error'],
    });
    expect(valid('node.error', result.payload)).toBe(true);
    // Without the type: the v1 marker in place of error — not a valid node.error.
    expect(valid('node.error', serializePayload({ nodeId: 'n', error }).payload)).toBe(false);
  });

  it('a cycle next to a 17 MB field: valid AND within budget in one call', () => {
    const cyclic: Json = {};
    cyclic['self'] = cyclic;
    const payload = { nodeId: 'n', durationMs: 1, status: 'ok', output: cyclic, big: 'b'.repeat(17 * 1024 * 1024) };
    const result = serializePayload(payload, MAX_PAYLOAD_BYTES, 'node.finished');
    expect(valid('node.finished', result.payload)).toBe(true);
    expect(utf8ByteLength(result.json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(((result.payload as Json)['big'] as string).endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('JSON that cannot be built as a whole although every field serializes alone (the engine string limit)', () => {
    // Stands in for a payload longer than V8's maximum string length: the
    // whole stringify throws a RangeError, each field on its own does not.
    const output = {
      toJSON(key: string): string {
        if (key === 'output') throw new RangeError('Invalid string length');
        return 'fine alone';
      },
    };
    const payload = { nodeId: 'n', durationMs: 1, status: 'ok', output };
    const untyped = serializePayload(payload);
    expect(untyped.payload).toEqual({ __graphmindTruncated: true, bytes: 0, preview: '[unserializable payload]' });
    const typed = serializePayload(payload, MAX_PAYLOAD_BYTES, 'node.finished');
    expect(typed.payload).toEqual({
      nodeId: 'n',
      durationMs: 1,
      status: 'ok',
      __graphmindTruncated: true,
      bytes: 0,
      preview: '[unserializable payload]',
      fields: ['output'],
    });
    expect(valid('node.finished', typed.payload)).toBe(true);
  });

  it('a BigInt where the schema wants a number cannot be made valid: whole marker', () => {
    const result = serializePayload({ nodeId: 'n', durationMs: 10n, status: 'ok' }, MAX_PAYLOAD_BYTES, 'node.finished');
    expect(result.payload).toEqual({ __graphmindTruncated: true, bytes: 0, preview: '[unserializable payload]' });
  });

  it('with an unbounded budget (the client makes a value serializable first) the fields are kept', () => {
    const cyclic: Json = {};
    cyclic['self'] = cyclic;
    const result = serializePayload({ nodeId: 'n', durationMs: 1, status: 'ok', output: cyclic, big: 'b'.repeat(600_000) }, Number.POSITIVE_INFINITY, 'node.finished');
    expect((result.payload as Json)['big']).toHaveLength(600_000);
    expect((result.payload as Json)['fields']).toEqual(['output']);
  });
});

describe('field sizing from the payload JSON (topLevelSpans)', () => {
  const key = fc.string({ unit: 'binary', maxLength: 6 });
  const value = fc.oneof(
    fc.jsonValue({ maxDepth: 3 }),
    fc.string({ unit: 'binary', maxLength: 30 }),
    fc.constantFrom('{', '}', '[', ']', ',', ':', '"', '\\', '\\"', '"}', '\\\\"', undefined),
  );

  it('each span is exactly JSON.stringify of that field; omitted values have none', () => {
    fc.assert(
      fc.property(fc.dictionary(key, value, { maxKeys: 12 }), (payload) => {
        const json = JSON.stringify(payload);
        const spans = topLevelSpans(json);
        if (spans === undefined) return false;
        for (const name of Object.keys(payload)) {
          const encoded = JSON.stringify(payload[name]);
          const span = spans.get(name);
          if (encoded === undefined) {
            if (span !== undefined) return false;
          } else if (span === undefined || json.slice(span[0], span[1]) !== encoded) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 3000 },
    );
  });

  it('refuses text that is not a JSON object', () => {
    for (const text of ['"x"', '[1,2]', '42', 'null', '{"a":1', '{"a"1}', '{"a":}', '{a:1}', '{"a":1}x']) {
      expect(topLevelSpans(text), text).toBeUndefined();
    }
    expect(topLevelSpans('{}')).toEqual(new Map());
  });

  it('a payload with its own toJSON is sized field by field (its JSON is not its fields)', () => {
    const payload = { nodeId: 'n', durationMs: 1, status: 'ok', toJSON: () => ({ nodeId: 'n', durationMs: 1, status: 'ok', blob: 'x'.repeat(600_000) }) };
    const result = serializePayload(payload, MAX_PAYLOAD_BYTES, 'node.finished');
    expect(utf8ByteLength(result.json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(result.truncated).toBe(true);
  });
});

describe('every known event type has a skeleton', () => {
  it('so the whole-payload marker is never the answer for a valid event', () => {
    for (const type of EVENT_TYPES) {
      const huge = { ...keyed('f', 400, 'h'.repeat(3000)) };
      const base: Record<EventType, Json> = {
        'run.started': { app: 'a', sdk: { name: 'n', version: 'v' } },
        'run.finished': { status: 'ok' },
        'graph.hint': { nodes: [] },
        'node.started': { nodeId: 'n', kind: 'tool', name: 'x', instanceId: 'i' },
        'node.token': { nodeId: 'n', deltas: [] },
        'node.finished': { nodeId: 'n', durationMs: 0, status: 'ok' },
        'node.error': { nodeId: 'n', error: { name: 'E', message: 'm' } },
        'exec.paused': { pauseId: 'p', nodeId: 'n', point: 'before' },
        'exec.resumed': { pauseId: 'p', action: 'abort' },
        'exec.refused': { pauseId: 'p', code: 'shape' },
      };
      const payload = { ...huge, ...base[type] };
      for (const maxBytes of [4096, 5000, 65_536, MAX_PAYLOAD_BYTES]) {
        const result = serializePayload(payload, maxBytes, type);
        expect(valid(type, result.payload), `${type} @ ${maxBytes}`).toBe(true);
        expect(utf8ByteLength(result.json)).toBeLessThanOrEqual(maxBytes);
      }
    }
  });
});
