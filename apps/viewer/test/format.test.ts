/**
 * The duration formatter — one binding contract used everywhere a duration
 * is shown (docs quote these exact strings).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fmtCost, fmtCostExact, fmtDuration, fmtExactMs } from '../src/lib/format.js';
import { activePrices, calcCost, resolveModel, type PriceTable } from '../src/prices/engine.js';

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

describe('fmtCost', () => {
  /** Every digit 0: what a reader takes for "free". */
  const readsAsZero = (text: string): boolean => !/[1-9]/.test(text);

  it('a cheap step that is not free never reads as zero', () => {
    // A gpt-4o-mini step of 20 input / 12 output tokens, priced by the bundled
    // table: about a thousandth of a cent.
    const table = JSON.parse(
      readFileSync(fileURLToPath(new URL('../src/prices/data_slim.json', import.meta.url)), 'utf8'),
    ) as PriceTable;
    const hit = resolveModel(table, { model: 'gpt-4o-mini', provider: 'openai' });
    const prices = hit === undefined ? undefined : activePrices(hit.model, new Date('2026-09-20T12:00:00Z'));
    const cost = prices === undefined ? undefined : calcCost({ inputTokens: 20, outputTokens: 12 }, prices);
    expect(cost?.total).toBeGreaterThan(0);
    const total = cost?.total ?? 0;
    expect(fmtCost(total)).toBe('<$0.0001');
    for (const usd of [total, 0.00001, 0.000049, 0.0000001, 3e-6]) {
      expect(readsAsZero(fmtCost(usd)), `fmtCost(${usd}) = ${fmtCost(usd)}`).toBe(false);
      expect(readsAsZero(fmtCostExact(usd)), `fmtCostExact(${usd}) = ${fmtCostExact(usd)}`).toBe(false);
    }
  });

  it('keeps its thresholds above the floor; zero is still $0', () => {
    expect(fmtCost(0)).toBe('$0');
    expect(fmtCost(0.0001)).toBe('$0.0001');
    expect(fmtCost(0.00234)).toBe('$0.0023');
    expect(fmtCost(0.0971)).toBe('$0.097');
    expect(fmtCost(12.345)).toBe('$12.35');
    expect(fmtCost(Number.NaN)).toBe('—');
  });

  it('fmtCostExact: two significant digits below the floor, fmtCost above it', () => {
    expect(fmtCostExact(0.0000102)).toBe('$0.000010');
    expect(fmtCostExact(3e-6)).toBe('$0.0000030');
    expect(fmtCostExact(1e-7)).toBe('$0.00000010');
    expect(fmtCostExact(0)).toBe('$0');
    expect(fmtCostExact(0.0971)).toBe('$0.097');
  });
});
