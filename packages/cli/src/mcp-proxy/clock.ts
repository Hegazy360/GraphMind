/**
 * Timing for the proxy's graph.
 *
 * Durations come from a monotonic high-resolution clock (`performance.now()`
 * deltas), so a sub-millisecond `ping` reports `0.12` rather than `0`, and a
 * wall-clock step (NTP, suspend) can never produce a negative or wildly wrong
 * duration. Wall-clock instants (`ts` on every envelope) stay integer epoch
 * ms and are minted by `@graphmind-ai/client`, not here.
 *
 * Shared contract (internal/research/phase6-plan-2026-09.md): `durationMs` is
 * fractional, rounded to 0.01 ms, clamped >= 0.
 */

/** A monotonic clock in milliseconds. Injectable for tests. */
export type Clock = () => number;

export const monotonicNow: Clock = () => performance.now();

/** `end - start` as a `durationMs`: rounded to 0.01 ms, never negative. */
export function durationBetween(start: number, end: number): number {
  return roundDurationMs(end - start);
}

/** Round to 0.01 ms and clamp at zero; `NaN`/`Infinity` become 0. */
export function roundDurationMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms * 100) / 100;
}
