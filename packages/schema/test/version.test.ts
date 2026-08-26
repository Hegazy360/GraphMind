/**
 * Version negotiation: any `gm` other than PROTOCOL_VERSION is rejected as
 * `version-mismatch` — even if everything else looks valid — because `gm` is
 * the protocol MAJOR and majors are incompatible by definition.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROTOCOL_VERSION, parseEnvelope } from '../src/index.js';

function envelopeWithGm(gm: unknown): unknown {
  return {
    gm,
    seq: 0,
    ts: 1,
    runId: '*',
    type: 'mode.set',
    payload: { mode: 'run' },
  };
}

describe('version negotiation', () => {
  it('accepts the supported version', () => {
    expect(parseEnvelope(envelopeWithGm(PROTOCOL_VERSION)).kind).toBe('ok');
  });

  it('rejects any other integer gm (property)', () => {
    fc.assert(
      fc.property(
        fc.integer().filter((gm) => gm !== PROTOCOL_VERSION),
        (gm) => {
          const result = parseEnvelope(envelopeWithGm(gm));
          expect(result.kind).toBe('version-mismatch');
          if (result.kind === 'version-mismatch') {
            expect(result.received).toBe(gm);
            expect(result.supported).toBe(PROTOCOL_VERSION);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('version check happens before payload validation', () => {
    const result = parseEnvelope({
      gm: 2,
      seq: 0,
      ts: 1,
      runId: '*',
      type: 'mode.set',
      payload: { mode: 'some-v2-only-mode' },
    });
    expect(result.kind).toBe('version-mismatch');
  });

  it('non-integer or missing gm is invalid, not a mismatch', () => {
    expect(parseEnvelope(envelopeWithGm('1')).kind).toBe('invalid');
    expect(parseEnvelope(envelopeWithGm(1.5)).kind).toBe('invalid');
    expect(parseEnvelope(envelopeWithGm(undefined)).kind).toBe('invalid');
  });
});
