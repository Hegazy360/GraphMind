/**
 * The duration clock: monotonic, sub-millisecond, and normalised for the
 * wire (finite, >= 0, 0.01 ms resolution).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { elapsedMs, monotonicNow, normalizeDurationMs, setClock } from '../src/clock.js';

afterEach(() => {
  setClock(undefined);
});

describe('normalizeDurationMs', () => {
  it('rounds to 0.01 ms', () => {
    expect(normalizeDurationMs(1.23456)).toBe(1.23);
    expect(normalizeDurationMs(1.235)).toBe(1.24);
    expect(normalizeDurationMs(0.004)).toBe(0);
    expect(normalizeDurationMs(0.005)).toBe(0.01);
    expect(normalizeDurationMs(38_100.004)).toBe(38_100);
  });

  it('never emits float noise for two-decimal results', () => {
    // 0.1 + 0.2 style inputs must come out as the number a human wrote.
    expect(normalizeDurationMs(0.1 + 0.2)).toBe(0.3);
    expect(normalizeDurationMs(1.1 * 3)).toBe(3.3);
    // Whatever the input, the output prints with at most two decimals.
    let seed = 42;
    for (let i = 0; i < 2000; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const raw = (seed / 2147483648) * 100_000;
      const text = String(normalizeDurationMs(raw));
      const decimals = text.includes('.') ? text.split('.')[1]?.length ?? 0 : 0;
      expect(decimals, text).toBeLessThanOrEqual(2);
    }
  });

  it('clamps negatives and non-finite values to 0', () => {
    expect(normalizeDurationMs(-1)).toBe(0);
    expect(normalizeDurationMs(-0.001)).toBe(0);
    expect(normalizeDurationMs(Number.NaN)).toBe(0);
    expect(normalizeDurationMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeDurationMs(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normalizeDurationMs(undefined as unknown as number)).toBe(0);
    expect(Object.is(normalizeDurationMs(-0), 0)).toBe(true);
  });

  it('keeps large values intact', () => {
    expect(normalizeDurationMs(86_400_000.129)).toBe(86_400_000.13);
  });
});

describe('monotonicNow / elapsedMs', () => {
  it('reads performance.now() by default and has sub-millisecond resolution', async () => {
    const a = monotonicNow();
    // Spin for well under a millisecond: two consecutive reads must not be
    // forced to the same integer the way Date.now() would be.
    let spin = 0;
    for (let i = 0; i < 20_000; i += 1) spin += i % 7;
    const b = monotonicNow();
    expect(spin).toBeGreaterThan(0);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(Number.isInteger(a) && Number.isInteger(b) && a === b).toBe(false);
  });

  it('measures a real sleep as a non-zero fractional duration', async () => {
    const t0 = monotonicNow();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const elapsed = elapsedMs(t0);
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it('honours an injected clock and reads it at call time', () => {
    let t = 100;
    setClock(() => t);
    const start = monotonicNow();
    t = 100.123456;
    expect(elapsedMs(start)).toBe(0.12);
    t = 99; // a clock that goes backwards still cannot produce a negative duration
    expect(elapsedMs(start)).toBe(0);
    setClock(undefined);
    expect(monotonicNow()).not.toBe(99);
  });

  it('elapsedMs accepts an explicit `now`', () => {
    expect(elapsedMs(10, 12.345)).toBe(2.35);
    expect(elapsedMs(10, 10)).toBe(0);
    expect(elapsedMs(10, 5)).toBe(0);
  });
});
