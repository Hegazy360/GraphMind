/**
 * The parser, attacked directly.
 *
 * `parseEnvelope` and `parseEnvelopeJson` are the only thing standing between
 * a socket anyone on the machine can open and the rest of the server. Their
 * contract is unusually strong for a parser — *never throws*, total over every
 * possible input — and until now nothing had ever handed them anything a
 * cooperating `JSON.stringify` would not produce.
 *
 * The properties below are the contract, stated as invariants:
 *
 *   1. total: no input of any kind makes either function throw;
 *   2. sound: an `ok` result really is a well-formed envelope of a known type;
 *   3. stable: an `ok` envelope survives serialize -> parse unchanged, which is
 *      what the server relies on when it stores an envelope and replays it;
 *   4. pure: parsing mutates neither the input nor `Object.prototype`;
 *   5. text and value doors agree.
 *
 * @graphmind-ai/schema's own suite already property-tests the happy path
 * (well-formed envelopes round-trip). This file only sends things that
 * should not work.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  parseEnvelope,
  parseEnvelopeJson,
  serializeEnvelope,
  type EnvelopeParseResult,
  type MessageType,
} from '@graphmind-ai/schema';
import {
  NASTY_NUMBERS,
  NASTY_STRINGS,
  anyValueArb,
  deformedEnvelopeArb,
  hostileText,
  hostileTextArb,
  prototypeSnapshot,
  validShapeHostilePayloadArb,
} from '../src/fuzz.js';

const KINDS = ['ok', 'unknown-type', 'version-mismatch', 'invalid'];

function classify(result: EnvelopeParseResult): string {
  return result.kind;
}

describe('parseEnvelopeJson is total over arbitrary text', () => {
  it('never throws, for any string at all (property)', () => {
    fc.assert(
      fc.property(hostileTextArb, (text) => {
        const result = parseEnvelopeJson(text);
        expect(KINDS).toContain(classify(result));
      }),
      { numRuns: 2_000 },
    );
  });

  it('never throws on the hand-written hostile corpus, giant frames included', () => {
    for (const text of hostileText()) {
      const result = parseEnvelopeJson(text);
      expect(KINDS, `frame: ${text.slice(0, 80)}`).toContain(classify(result));
    }
  });

  it('reports a reason for every rejection, and never an empty one', () => {
    fc.assert(
      fc.property(hostileTextArb, (text) => {
        const result = parseEnvelopeJson(text);
        if (result.kind === 'invalid') expect(result.reason.length).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  it('agrees with parseEnvelope on any text JSON can decode', () => {
    fc.assert(
      fc.property(hostileTextArb, (text) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(text) as unknown;
        } catch {
          // Not JSON: the text door must say so and the value door is not
          // reachable. Nothing to compare.
          expect(parseEnvelopeJson(text).kind).toBe('invalid');
          return;
        }
        expect(classify(parseEnvelopeJson(text))).toBe(classify(parseEnvelope(decoded)));
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('parseEnvelope is total over arbitrary decoded values', () => {
  it('never throws, for any JSON value (property)', () => {
    fc.assert(
      fc.property(anyValueArb, (value) => {
        expect(KINDS).toContain(classify(parseEnvelope(value)));
      }),
      { numRuns: 2_000 },
    );
  });

  it('never throws for envelope-shaped values with every field deformed (property)', () => {
    fc.assert(
      fc.property(deformedEnvelopeArb, (value) => {
        expect(KINDS).toContain(classify(parseEnvelope(value)));
      }),
      { numRuns: 3_000 },
    );
  });

  it('never throws for a valid envelope shape carrying a hostile payload (property)', () => {
    fc.assert(
      fc.property(validShapeHostilePayloadArb, (value) => {
        expect(KINDS).toContain(classify(parseEnvelope(value)));
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('an `ok` result really is a valid envelope', () => {
  it('soundness (property)', () => {
    fc.assert(
      fc.property(deformedEnvelopeArb, (value) => {
        const result = parseEnvelope(value);
        if (result.kind !== 'ok') return;
        const envelope = result.envelope;
        expect(envelope.gm).toBe(PROTOCOL_VERSION);
        expect(MESSAGE_TYPES as readonly string[]).toContain(envelope.type);
        expect(Number.isInteger(envelope.seq)).toBe(true);
        expect(envelope.seq).toBeGreaterThanOrEqual(0);
        expect(typeof envelope.runId).toBe('string');
        expect(typeof envelope.ts).toBe('number');
        expect(Number.isFinite(envelope.ts)).toBe(true);
      }),
      { numRuns: 3_000 },
    );
  });

  it('rejects every non-integer, negative or out-of-range seq', () => {
    const base = {
      gm: PROTOCOL_VERSION,
      ts: 1,
      runId: 'r',
      type: 'node.token' as MessageType,
      payload: { nodeId: 'n', deltas: [] },
    };
    for (const seq of NASTY_NUMBERS) {
      const result = parseEnvelope({ ...base, seq });
      const acceptable = Number.isSafeInteger(seq) && seq >= 0;
      expect(result.kind === 'ok', `seq=${String(seq)} -> ${result.kind}`).toBe(acceptable);
    }
    // -0 is a non-negative safe integer and must be accepted, as `0`.
    const negZero = parseEnvelope({ ...base, seq: -0 });
    expect(negZero.kind).toBe('ok');
  });

  it('accepts any string as a runId except one that cannot be stored', () => {
    // A run id has to survive a round trip through SQLite unchanged. Most of
    // these hostile strings do — RTL overrides, `__proto__`, 2 MB of text —
    // and are accepted as ordinary text. Two do not, and are refused at the
    // parse boundary: a lone surrogate (SQLite's text binding rewrites it to
    // U+FFFD) and a NUL byte (`node:sqlite` mangles it on Node 22 and not on
    // Node 24). Both would leave the app streaming under one id while the
    // server stored another.
    for (const runId of NASTY_STRINGS) {
      const result = parseEnvelope({
        gm: PROTOCOL_VERSION,
        seq: 0,
        ts: 1,
        runId,
        type: 'node.token',
        payload: { nodeId: 'n', deltas: [] },
      });
      const storable =
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(runId) &&
        !runId.includes('\u0000');
      expect(result.kind, `runId of ${runId.length} chars`).toBe(storable ? 'ok' : 'invalid');
    }
  });
});

describe('an `ok` envelope survives the store-and-replay round trip', () => {
  it('serialize -> parse is stable (property)', () => {
    fc.assert(
      fc.property(deformedEnvelopeArb, (value) => {
        const first = parseEnvelope(value);
        if (first.kind !== 'ok') return;
        // This is exactly what the server does: it persists an accepted
        // envelope and later hands it back to a viewer, which parses it
        // again. A parser that accepted something it cannot re-accept would
        // make events vanish on reload.
        const second = parseEnvelopeJson(serializeEnvelope(first.envelope));
        expect(second.kind).toBe('ok');
      }),
      { numRuns: 2_000 },
    );
  });

  it('an unknown-type envelope stays unknown-type after a round trip (property)', () => {
    fc.assert(
      fc.property(deformedEnvelopeArb, (value) => {
        const first = parseEnvelope(value);
        if (first.kind !== 'unknown-type') return;
        // See the `payload` asymmetry pinned below: an absent payload cannot
        // survive JSON, so it is excluded rather than silently tolerated.
        if (first.envelope.payload === undefined) return;
        const again = parseEnvelope(JSON.parse(JSON.stringify(first.envelope)) as unknown);
        expect(again.kind).toBe('unknown-type');
      }),
      { numRuns: 2_000 },
    );
  });

  it('an envelope with NO payload key round-trips as unknown-type', () => {
    // `RawEnvelopeSchema` used to require the `payload` KEY to exist, and
    // `JSON.stringify` drops a key whose value is `undefined` — so an
    // accepted unknown-type envelope with no payload did not survive being
    // written down and read back. Harmless in the shipped pipeline, but a
    // hole in the stated forward-compatibility contract: a future v1.x
    // message type carrying no payload would have been rejected rather than
    // tolerated. `payload` is now optional.
    const noPayload = { gm: PROTOCOL_VERSION, seq: 0, ts: 1, runId: 'r', type: 'future.type' };
    expect(parseEnvelope(noPayload).kind).toBe('unknown-type');
    expect(parseEnvelope({ ...noPayload, payload: null }).kind).toBe('unknown-type');
    // The idempotency the property above checks: through JSON and back.
    const first = parseEnvelope(noPayload);
    if (first.kind !== 'unknown-type') throw new Error('precondition');
    const again = parseEnvelope(JSON.parse(JSON.stringify(first.envelope)) as unknown);
    expect(again.kind).toBe('unknown-type');
  });
});

describe('parsing has no side effects', () => {
  it('never pollutes Object.prototype (property)', () => {
    const before = prototypeSnapshot();
    fc.assert(
      fc.property(hostileTextArb, (text) => {
        parseEnvelopeJson(text);
      }),
      { numRuns: 1_000 },
    );
    for (const text of hostileText()) parseEnvelopeJson(text);
    expect(prototypeSnapshot()).toBe(before);
    expect(Object.hasOwn(Object.prototype, 'pwned')).toBe(false);
    expect(({} as Record<string, unknown>)['pwned']).toBeUndefined();
  });

  it('a `__proto__` key in a payload stays an ordinary own property', () => {
    const text =
      `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"r","type":"node.started",` +
      '"payload":{"nodeId":"n","kind":"tool","name":"x","instanceId":"i","__proto__":{"pwned":true}}}';
    const result = parseEnvelopeJson(text);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const payload = result.envelope.payload as Record<string, unknown>;
    // The value must not have become the payload's prototype.
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect((payload as { pwned?: unknown }).pwned).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, 'pwned')).toBe(false);
  });

  it('does not mutate the value it was given (property)', () => {
    fc.assert(
      fc.property(deformedEnvelopeArb, (value) => {
        const before = JSON.stringify(value);
        parseEnvelope(value);
        expect(JSON.stringify(value)).toBe(before);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('version negotiation', () => {
  it('rejects every gm that is not this protocol version (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000, max: 1_000 }), (gm) => {
        const result = parseEnvelope({
          gm,
          seq: 0,
          ts: 1,
          runId: 'r',
          type: 'node.token',
          payload: { nodeId: 'n', deltas: [] },
        });
        expect(result.kind).toBe(gm === PROTOCOL_VERSION ? 'ok' : 'version-mismatch');
      }),
      { numRuns: 300 },
    );
  });

  it('a non-integer or non-numeric gm is invalid, not a version mismatch', () => {
    for (const gm of [1.5, '1', null, true, [], {}, Number.NaN]) {
      const result = parseEnvelope({
        gm,
        seq: 0,
        ts: 1,
        runId: 'r',
        type: 'node.token',
        payload: { nodeId: 'n', deltas: [] },
      });
      expect(result.kind, `gm=${JSON.stringify(gm)}`).toBe('invalid');
    }
  });

  it('a version mismatch is decided before the payload is looked at', () => {
    // Order matters: a v2 peer's payloads are none of our business, so a
    // foreign `gm` must short-circuit rather than produce schema noise.
    const result = parseEnvelope({
      gm: PROTOCOL_VERSION + 1,
      seq: 0,
      ts: 1,
      runId: 'r',
      type: 'node.token',
      payload: 'not even an object',
    });
    expect(result.kind).toBe('version-mismatch');
  });
});

describe('duplicate keys and unicode', () => {
  it('a duplicate key resolves to the last occurrence, as JSON requires', () => {
    const result = parseEnvelopeJson(
      `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"first","runId":"second",` +
        '"type":"node.token","payload":{"nodeId":"n","deltas":[]}}',
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.envelope.runId).toBe('second');
  });

  it('a duplicate key cannot smuggle a second type past the type check', () => {
    // If the parser read `type` twice from different objects it could
    // validate one payload and dispatch another.
    const result = parseEnvelopeJson(
      `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"r","type":"node.token",` +
        '"type":"run.finished","payload":{"status":"ok"}}',
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.envelope.type).toBe('run.finished');
  });

  it('carries lone surrogates, NUL, U+2028/9 and RTL overrides through unchanged', () => {
    for (const value of NASTY_STRINGS) {
      const result = parseEnvelope({
        gm: PROTOCOL_VERSION,
        seq: 0,
        ts: 1,
        runId: 'r',
        type: 'node.error',
        payload: { nodeId: 'n', error: { name: 'E', message: value } },
      });
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') continue;
      const payload = result.envelope.payload as { error: { message: string } };
      expect(payload.error.message).toBe(value);
    }
  });

  it('re-serializes a lone surrogate into something JSON.parse accepts', () => {
    // JSON.stringify escapes lone surrogates (well-formed JSON.stringify,
    // ES2019), so the stored text stays decodable even though the string is
    // not valid UTF-16. If that ever regressed, every downstream reader of a
    // stored event would throw instead of the parser rejecting it.
    const result = parseEnvelope({
      gm: PROTOCOL_VERSION,
      seq: 0,
      ts: 1,
      runId: 'r',
      type: 'node.error',
      payload: { nodeId: 'n', error: { name: 'E', message: '\ud800' } },
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = serializeEnvelope(result.envelope);
    expect(text).toContain('\\ud800');
    expect(() => JSON.parse(text)).not.toThrow();
    expect(parseEnvelopeJson(text).kind).toBe('ok');
  });
});
