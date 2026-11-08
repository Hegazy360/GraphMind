/**
 * Human durations for the SDK surface: '30s', '10m', '48h', '7d', or a plain
 * number of milliseconds. Strict on purpose — a typo'd duration becomes a
 * thrown error at definition or call time, never a silent 0ms sleep.
 */
export type Duration = number | string;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;

export class InvalidDurationError extends Error {
  override name = 'InvalidDurationError';
  constructor(input: unknown) {
    super(`Invalid duration ${JSON.stringify(input)} — use a number of milliseconds or '<n><unit>' with unit ms|s|m|h|d, e.g. '30s', '10m', '48h', '7d'.`);
  }
}

export function parseDuration(input: Duration): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new InvalidDurationError(input);
    return Math.floor(input);
  }
  const match = PATTERN.exec(input.trim());
  if (!match) throw new InvalidDurationError(input);
  const amount = Number(match[1]);
  const unit = UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (!Number.isFinite(amount) || unit === undefined) throw new InvalidDurationError(input);
  return Math.floor(amount * unit);
}
