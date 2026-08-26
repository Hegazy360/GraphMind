/**
 * One-shot warnings. The adapter warns at most once per key per Graphmind
 * instance (e.g. "neutralized a timeout") and the sink must never be able to
 * throw into the host app.
 */

export type WarnSink = (message: string) => void;

export class OnceWarner {
  private readonly seen = new Set<string>();

  constructor(private readonly sink: WarnSink = (message) => console.warn(message)) {}

  warn(key: string, message: string): void {
    try {
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.sink(`[graphmind] ${message}`);
    } catch {
      // a throwing sink must not propagate into the host
    }
  }
}
