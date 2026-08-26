/**
 * Forward-compatibility contract:
 *  - unknown message types are accepted as opaque envelopes, never errors
 *  - unknown payload fields (and unknown envelope fields) on known types
 *    are preserved, never rejected
 *  - unknown capability strings are fine
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  parseEnvelope,
  parseEnvelopeJson,
} from '../src/index.js';

function envelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    gm: PROTOCOL_VERSION,
    seq: 7,
    ts: 1_756_000_000_000,
    runId: 'run_abc',
    type: 'node.error',
    payload: { nodeId: 'n1', error: { name: 'Error', message: 'boom' } },
    ...overrides,
  };
}

describe('forward compatibility', () => {
  it('accepts an unknown message type as opaque (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((t) => !(MESSAGE_TYPES as readonly string[]).includes(t)),
        fc.jsonValue(),
        (type, payload) => {
          const result = parseEnvelope(envelope({ type, payload }));
          expect(result.kind).toBe('unknown-type');
          if (result.kind === 'unknown-type') {
            expect(result.envelope.type).toBe(type);
            expect(result.envelope.payload).toEqual(payload);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('treats prototype-key type names as unknown types, not schema hits', () => {
    // Regression: found by fast-check — a bare index into the schema map
    // resolved type "constructor" to Object.prototype.constructor.
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const result = parseEnvelope(envelope({ type, payload: {} }));
      expect(result.kind).toBe('unknown-type');
    }
  });

  it('keeps unknown payload fields on known types', () => {
    const result = parseEnvelopeJson(
      JSON.stringify(
        envelope({
          payload: {
            nodeId: 'n1',
            error: { name: 'Error', message: 'boom', futureField: { deep: true } },
            addedInV1_7: 'yes',
          },
        }),
      ),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const payload = result.envelope.payload as Record<string, unknown>;
      expect(payload['addedInV1_7']).toBe('yes');
      expect((payload['error'] as Record<string, unknown>)['futureField']).toEqual({ deep: true });
    }
  });

  it('keeps unknown envelope-level fields', () => {
    const result = parseEnvelope(envelope({ traceparent: '00-abc-def-01' }));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect((result.envelope as unknown as Record<string, unknown>)['traceparent']).toBe(
        '00-abc-def-01',
      );
    }
  });

  it('accepts unknown capability strings in hello', () => {
    const result = parseEnvelope(
      envelope({
        type: 'hello',
        runId: '*',
        payload: {
          versions: { protocol: PROTOCOL_VERSION, client: '9.9.9' },
          capabilities: ['pause', 'inject', 'time-travel-checkpoints'],
        },
      }),
    );
    expect(result.kind).toBe('ok');
  });

  it('still rejects a known type with a broken payload', () => {
    const result = parseEnvelope(envelope({ payload: { nodeId: 42 } }));
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toContain('node.error');
      expect(result.issues?.length).toBeGreaterThan(0);
    }
  });

  it('rejects structurally broken envelopes', () => {
    for (const broken of [
      null,
      42,
      'hi',
      {},
      { gm: PROTOCOL_VERSION },
      envelope({ seq: -1 }),
      envelope({ seq: 1.5 }),
      envelope({ runId: 7 }),
      envelope({ type: 9 }),
    ]) {
      expect(parseEnvelope(broken).kind).toBe('invalid');
    }
  });
});
