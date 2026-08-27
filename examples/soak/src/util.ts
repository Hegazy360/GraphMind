/**
 * Small shared helpers: flag parsing, deterministic RNG, statistics and
 * human formatting. No dependencies — the soak harness must not add cost of
 * its own to the numbers it reports.
 */

export type Flags = Record<string, string | boolean>;

export function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags[body] = true;
    else flags[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return flags;
}

export function num(flags: Flags, key: string, fallback: number): number {
  const raw = flags[key];
  if (raw === undefined || raw === true) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function str(flags: Flags, key: string, fallback: string): string {
  const raw = flags[key];
  return typeof raw === 'string' && raw !== '' ? raw : fallback;
}

export function bool(flags: Flags, key: string, fallback = false): boolean {
  const raw = flags[key];
  if (raw === undefined) return fallback;
  if (raw === true) return true;
  return raw !== '0' && raw !== 'false';
}

/** Deterministic PRNG so every soak run generates the identical workload. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Percentiles {
  count: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) {
    return { count: 0, min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[index] as number;
  };
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    count: sorted.length,
    min: sorted[0] as number,
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] as number,
    mean: sum / sorted.length,
  };
}

export function fmtBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${sign}${value.toFixed(value < 10 && unit > 0 ? 2 : value < 100 ? 1 : 0)} ${units[unit]}`;
}

export function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtRate(perSecond: number): string {
  if (perSecond >= 1000) return `${Math.round(perSecond).toLocaleString('en-US')}/s`;
  return `${perSecond.toFixed(1)}/s`;
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Yield to the event loop so queued socket writes actually flush. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function until(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<number> {
  const started = performance.now();
  const interval = opts.intervalMs ?? 25;
  for (;;) {
    if (await predicate()) return performance.now() - started;
    if (performance.now() - started > opts.timeoutMs) {
      throw new Error(
        `timed out after ${Math.round(performance.now() - started)}ms waiting for ${opts.label ?? 'condition'}`,
      );
    }
    await delay(interval);
  }
}

/** Build a deterministic string of roughly `bytes` printable characters. */
export function filler(bytes: number, seedText = 'graphmind-soak-payload-'): string {
  if (bytes <= 0) return '';
  const repeats = Math.ceil(bytes / seedText.length);
  return seedText.repeat(repeats).slice(0, bytes);
}

/** `{a:{a:{...}}}` nested `depth` levels deep, with a scalar at the bottom. */
export function deepObject(depth: number): unknown {
  let value: unknown = { leaf: 'bottom' };
  for (let i = 0; i < depth; i += 1) value = { a: value, d: i };
  return value;
}
