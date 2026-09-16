/**
 * The duration formatter — one binding contract used everywhere a duration
 * is shown (docs quote these exact strings).
 */
import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtExactMs } from '../src/lib/format.js';

describe('fmtDuration', () => {
  it('follows the binding thresholds', () => {
    expect(fmtDuration(0)).toBe('<1ms'); // an integer-clock zero from an old recording
    expect(fmtDuration(0.04)).toBe('<0.1ms');
    expect(fmtDuration(0.099)).toBe('<0.1ms');
    expect(fmtDuration(0.1)).toBe('0.1ms');
    expect(fmtDuration(2.4)).toBe('2.4ms');
    expect(fmtDuration(2.44)).toBe('2.4ms');
    expect(fmtDuration(9.94)).toBe('9.9ms');
    // Tier boundaries are chosen AFTER rounding: a value that rounds up into
    // the next tier is rendered in that tier's style, never as `10.0ms` or
    // `1000ms` beside a neighbour that reads `10ms` / `1.0s`.
    expect(fmtDuration(9.96)).toBe('10ms');
    expect(fmtDuration(10)).toBe('10ms');
    expect(fmtDuration(312.6)).toBe('313ms');
    expect(fmtDuration(999.4)).toBe('999ms');
    expect(fmtDuration(999.5)).toBe('1.0s');
    expect(fmtDuration(999.6)).toBe('1.0s');
    expect(fmtDuration(1000)).toBe('1.0s');
    expect(fmtDuration(1500)).toBe('1.5s');
    expect(fmtDuration(38_100)).toBe('38.1s');
    expect(fmtDuration(125_000)).toBe('125.0s');
  });

  it('never renders NaN or negative time', () => {
    expect(fmtDuration(Number.NaN)).toBe('—');
    expect(fmtDuration(Number.POSITIVE_INFINITY)).toBe('—');
    expect(fmtDuration(-5)).toBe('<1ms');
  });
});

describe('fmtExactMs', () => {
  it('keeps milliseconds past a second, and shares the sub-10ms rules', () => {
    expect(fmtExactMs(0)).toBe('<1ms');
    expect(fmtExactMs(0.05)).toBe('<0.1ms');
    expect(fmtExactMs(2.44)).toBe('2.4ms');
    expect(fmtExactMs(9.96)).toBe('10ms');
    expect(fmtExactMs(38_100.4)).toBe(`${(38_100).toLocaleString()}ms`);
    expect(fmtExactMs(Number.NaN)).toBe('—');
  });
});
