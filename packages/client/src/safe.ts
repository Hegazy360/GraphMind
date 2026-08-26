/**
 * "Never throw into the host app" plumbing.
 *
 * All internal failures degrade to a no-op plus a rate-limited console.warn:
 * at most one warning per key per interval, so a permanently broken transport
 * cannot spam the host's logs.
 */

export type WarnSink = (message: string) => void;

export class RateLimitedWarner {
  private readonly lastAt = new Map<string, number>();

  constructor(
    private readonly intervalMs: number = 60_000,
    private readonly sink: WarnSink = (message) => console.warn(message),
  ) {}

  warn(key: string, message: string, cause?: unknown): void {
    try {
      const now = Date.now();
      const prev = this.lastAt.get(key);
      if (prev !== undefined && now - prev < this.intervalMs) return;
      this.lastAt.set(key, now);
      const suffix =
        cause instanceof Error
          ? ` (${cause.name}: ${cause.message})`
          : cause !== undefined
            ? ` (${String(cause)})`
            : '';
      this.sink(`[graphmind] ${message}${suffix}`);
    } catch {
      // Even a throwing sink must not propagate into the host.
    }
  }
}
