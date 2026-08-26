/**
 * Anonymous usage telemetry: event name + random install id + version, nothing
 * else — no payloads, no PII, no run data. Disclosed in README; disabled with
 * GRAPHMIND_TELEMETRY=0 (and always a silent no-op on failure).
 */

export function recordTelemetry(event: string): void {
  void event; // not implemented yet — wired as a no-op so call sites exist
}
