import { describe, expect, it } from 'vitest';
import {
  breakpointMatcher,
  InvalidDurationError,
  journalEntry,
  NotJsonSerializableError,
  parseDuration,
  toJsonValue,
} from '../src/index.js';

describe('parseDuration', () => {
  it('parses units', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('48h')).toBe(172_800_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('1.5m')).toBe(90_000);
    expect(parseDuration(1234)).toBe(1234);
  });

  it('rejects junk loudly', () => {
    for (const bad of ['10', 'tomorrow', '-5s', '5 months', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseDuration(bad as never)).toThrow(InvalidDurationError);
    }
  });
});

describe('toJsonValue', () => {
  it('round-trips JSON and normalizes non-JSON leaves the way replay will see them', () => {
    expect(toJsonValue({ a: [1, 'x', null] }, 't')).toEqual({ a: [1, 'x', null] });
    expect(toJsonValue(undefined, 't')).toBeUndefined();
    // Dates become strings — the recorded value is what a replay returns.
    expect(toJsonValue(new Date(0), 't')).toBe('1970-01-01T00:00:00.000Z');
  });

  it('refuses values that cannot replay identically', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toJsonValue(cyclic, 'step out')).toThrow(NotJsonSerializableError);
    expect(() => toJsonValue(() => 1, 'step out')).toThrow(NotJsonSerializableError);
    expect(() => toJsonValue(10n, 'step out')).toThrow(NotJsonSerializableError);
  });
});

describe('schemas', () => {
  it('accepts a minimal journal entry', () => {
    const entry = journalEntry.parse({
      runId: 'run_1',
      seq: 0,
      kind: 'step',
      name: 'fetch',
      ordinal: 0,
      key: '["fetch"]',
      status: 'completed',
      attempts: [{ startedAt: 1 }],
      interventions: [],
      startedAt: 1,
    });
    expect(entry.name).toBe('fetch');
  });

  it('defaults breakpoint point to before', () => {
    expect(breakpointMatcher.parse({ step: 'classify' }).point).toBe('before');
  });
});
