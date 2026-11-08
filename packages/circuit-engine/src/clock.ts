/**
 * Injected time, so every durability test drives the clock by hand: retries,
 * sleeps, waits, approval timeouts and lease expiry are all asserted at exact
 * instants instead of with real timers.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private at = 1_700_000_000_000) {}
  now(): number {
    return this.at;
  }
  advance(ms: number): number {
    this.at += ms;
    return this.at;
  }
}
