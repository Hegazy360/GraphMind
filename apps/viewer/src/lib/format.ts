/**
 * The one duration formatter (binding contract, shared with the docs):
 *   0        -> `<1ms`   (an integer-clock zero from an old recording — it
 *                          means "under a millisecond", not "nothing ran")
 *   < 0.1    -> `<0.1ms`
 *   < 10     -> one decimal, `2.4ms`
 *   < 1000   -> integer ms, `312ms`
 *   else     -> seconds with one decimal, `38.1s`
 * Anything that is not a finite number renders as `—` rather than `NaNms`.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return '<1ms';
  if (ms < 0.1) return '<0.1ms';
  // Round first, then pick the tier: 9.96 reads `10ms` (not `10.0ms`) and
  // 999.6 reads `1.0s` (not `1000ms`), so neighbouring values never
  // straddle a tier boundary in two different styles.
  const tenths = Number(ms.toFixed(1));
  if (tenths < 10) return `${tenths.toFixed(1)}ms`;
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Milliseconds without collapsing to seconds — for tooltips where `38.1s`
 * would hide the answer. Same sub-10ms rules as `fmtDuration`.
 */
export function fmtExactMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return '<1ms';
  if (ms < 0.1) return '<0.1ms';
  const tenths = Number(ms.toFixed(1));
  if (tenths < 10) return `${tenths.toFixed(1)}ms`;
  return `${Math.round(ms).toLocaleString()}ms`;
}

/** Offset from a run's start, e.g. `+1.24s` — the timeline's x axis unit. */
export function fmtOffset(ms: number): string {
  if (ms < 1000) return `+${Math.round(ms)}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = (ms % 60_000) / 1000;
  return `+${m}m ${s.toFixed(0)}s`;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

/** Clock time with milliseconds — timings are the point of this tool. */
export function fmtClockMs(ts: number): string {
  const date = new Date(ts);
  return `${date.toLocaleTimeString(undefined, { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function fmtRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Estimated spend. Sub-cent numbers still need to read as money. */
export function fmtCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString();
}
