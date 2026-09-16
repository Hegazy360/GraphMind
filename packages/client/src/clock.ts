/**
 * Duration clock.
 *
 * Every GraphMind duration (`durationMs`, `heldMs`) is measured on a
 * monotonic, high-resolution clock — `performance.now()`, global in Node
 * >= 16 and in every browser — never on `Date.now()`. Wall-clock time has
 * millisecond granularity (an MCP handler that takes 80µs reads as `0ms`)
 * and can step backwards under NTP adjustment (a negative duration). Wall
 * clock fields on the wire (`ts`, `startedAt`) stay integer epoch ms; only
 * elapsed-time measurement moves here.
 *
 * The contract for a number that goes on the wire as a duration:
 *   - rounded to 0.01 ms (two decimals),
 *   - clamped to >= 0,
 *   - never NaN / Infinity (those become 0).
 *
 * The clock is read through `monotonicNow()` at call time — never cached as
 * a bound reference — so tests can substitute it with `setClock()` or by
 * spying on `performance.now`.
 */

export type Clock = () => number;

let override: Clock | undefined;

/** Milliseconds on the monotonic clock. Fractional. Only meaningful as a difference. */
export function monotonicNow(): number {
  if (override !== undefined) return override();
  return performance.now();
}

/**
 * Install a clock for tests (`undefined` restores `performance.now`).
 * Returns the previous override so a test can restore it in `finally`.
 */
export function setClock(clock: Clock | undefined): Clock | undefined {
  const previous = override;
  override = clock;
  return previous;
}

/**
 * Normalise a raw millisecond measurement into the wire contract:
 * finite, >= 0, rounded to 0.01 ms.
 */
export function normalizeDurationMs(raw: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  // Two decimals. `Math.round(x * 100) / 100` can produce 0.30000000000000004
  // style noise for some inputs; going through Number(toFixed) does not.
  return Number(raw.toFixed(2));
}

/** Elapsed since a `monotonicNow()` reading, already normalised for the wire. */
export function elapsedMs(startedAt: number, now: number = monotonicNow()): number {
  return normalizeDurationMs(now - startedAt);
}
