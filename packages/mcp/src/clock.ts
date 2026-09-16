/**
 * Timing for the in-process adapter.
 *
 * `durationMs` is a `performance.now()` delta — monotonic and sub-millisecond,
 * so a handler that takes 300 µs reports `0.3` instead of `0` — rounded to
 * 0.01 ms and clamped at zero. Wall-clock instants (`ts` on the envelope) stay
 * integer epoch ms and are minted by `@graphmind-ai/client`. Shared contract:
 * internal/research/phase6-plan-2026-09.md, "Shared contracts".
 */

/** Monotonic milliseconds. */
export function now(): number {
  return performance.now();
}

/** Round to 0.01 ms, clamp at zero; NaN/Infinity become 0. */
export function roundDurationMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms * 100) / 100;
}

/** `durationMs` for something that started at `startedAt` (a `now()` reading). */
export function elapsedMs(startedAt: number): number {
  return roundDurationMs(now() - startedAt);
}
