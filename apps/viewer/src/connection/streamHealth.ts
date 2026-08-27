/**
 * Is the socket showing you now, or the past?
 *
 * The `/ws/ui` contract answers a `subscribe` with the run's whole history
 * (`replay.start {count}` → one `event` per stored envelope → `replay.end`)
 * and only then tails live. That is the right protocol, but it means an open
 * socket is not evidence of a live tail: under ingest saturation the server
 * services the subscribe late and the viewer receives the entire run as
 * catch-up — measured at 0 live / 72,144 replayed across three viewers. The
 * canvas fills in, nothing errors, and the live debugger has quietly become
 * a log viewer. Whoever is watching deserves to be told.
 *
 * So the socket reports two facts here and this module turns them into the
 * one line the run bar shows:
 *
 *  - a replay is in flight, and how far through it we are → "catching up"
 *  - the newest envelope's age → "behind 34s" once the replay is done but
 *    the events still arriving describe things that happened long ago
 *
 * Writes are throttled. A 72k-event replay must not be 72k store updates,
 * and the progress readout does not need to be exact — it needs to move.
 */
import { IDLE_STREAM, useUiStore, type StreamHealth } from '../store/uiStore.js';

/** Store writes while a replay streams. Fast enough to read as progress. */
export const PROGRESS_THROTTLE_MS = 200;
/** Lag is re-sampled at most this often; between samples the last one stands. */
export const LAG_SAMPLE_THROTTLE_MS = 500;

interface Pending {
  catchUp: Record<string, { count: number; applied: number }>;
  lagMs: number;
  lagAt: number;
}

/**
 * Mutable mirror of the store slice. Kept outside zustand precisely so the
 * hot path (one call per ingested envelope) is a couple of integer writes.
 */
let pending: Pending = { catchUp: {}, lagMs: 0, lagAt: 0 };
let lastFlushAt = 0;
let lastLagSampleAt = 0;

function publish(): void {
  lastFlushAt = Date.now();
  useUiStore.getState().setStream({
    catchUp: { ...pending.catchUp },
    lagMs: pending.lagMs,
    lagAt: pending.lagAt,
  });
}

/** A `replay.start` frame: `count` stored events are about to arrive. */
export function beginReplay(runId: string, count: number): void {
  pending.catchUp[runId] = { count, applied: 0 };
  publish(); // never throttled: this is the transition that matters
}

/** One replayed `event` frame for a run whose replay is still open. */
export function noteReplayEvent(runId: string, now: number = Date.now()): void {
  const entry = pending.catchUp[runId];
  if (entry === undefined) return;
  entry.applied += 1;
  if (now - lastFlushAt >= PROGRESS_THROTTLE_MS) publish();
}

/** A `replay.end` frame: from here the same socket is a live tail. */
export function endReplay(runId: string): void {
  if (pending.catchUp[runId] === undefined) return;
  delete pending.catchUp[runId];
  publish();
}

/**
 * Age of an envelope the socket just delivered. `ts` is when the
 * instrumented app emitted it, so `now - ts` is exactly how far behind the
 * tail is — the measure that catches a stream that is live in name only.
 */
export function noteEventAge(ts: number, now: number = Date.now()): void {
  if (!Number.isFinite(ts) || ts <= 0) return;
  if (now - lastLagSampleAt < LAG_SAMPLE_THROTTLE_MS) return;
  lastLagSampleAt = now;
  pending.lagMs = Math.max(0, now - ts);
  pending.lagAt = now;
  publish();
}

/** Forget everything — a new socket, or a test starting clean. */
export function resetStreamHealth(): void {
  pending = { catchUp: {}, lagMs: 0, lagAt: 0 };
  lastFlushAt = 0;
  lastLagSampleAt = 0;
  useUiStore.getState().setStream(IDLE_STREAM);
}

/** The un-throttled truth, for tests. */
export function pendingStreamHealth(): StreamHealth {
  return { catchUp: { ...pending.catchUp }, lagMs: pending.lagMs, lagAt: pending.lagAt };
}
