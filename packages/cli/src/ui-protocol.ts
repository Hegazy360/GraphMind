/**
 * The viewer <-> server subprotocol on `WS /ws/ui`.
 *
 * Every frame is one JSON object with a `type` discriminant. Schema wire
 * envelopes (@graphmind-ai/schema) are never sent bare on this socket — they
 * ride inside `event` (server -> viewer) and `control` (viewer -> server)
 * messages, keeping the UI protocol independently extensible.
 *
 * Flow:
 *  1. On connect the server immediately sends `welcome` (server version +
 *     current debug state). No handshake is required from the viewer.
 *  2. The viewer subscribes:
 *     - `{ type: 'subscribe', runId: '<runId>' }` -> replay-then-tail:
 *       `replay.start` (with count), one `event` per persisted envelope in
 *       ascending `seq` order, `replay.end`, then live `event`s as they
 *       arrive. Subscribing to a run that does not exist yet is allowed
 *       (empty replay, then a live tail once the run starts).
 *     - `{ type: 'subscribe', runId: '*' }` -> `runs` snapshot now, then
 *       `run.update` pushes on run lifecycle changes (created / finished /
 *       app connection changes).
 *  3. Controls: the viewer sends full schema control envelopes wrapped in
 *     `{ type: 'control', envelope }`. `exec.resume` routes to the app
 *     connection that owns `envelope.runId`; `breakpoint.set/clear` and
 *     `mode.set` update server state (so future `hello.ack`s arm them),
 *     relay to every connected app, and trigger a `state` broadcast to all
 *     viewers.
 *
 * Dedup rule (internal/decisions.md #5): replayed envelopes keep their
 * original `seq`; viewers dedupe on `(runId, seq)`.
 */
import type { BreakpointMatcher, RunMode } from '@graphmind-ai/schema';
import type { RunSummary } from './storage.js';

/** The wire envelope as fanned out to viewers (payload is opaque here). */
export interface WireEnvelope {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: unknown;
}

/** A run row plus whether its app connection is currently attached. */
export interface RunInfo extends RunSummary {
  live: boolean;
}

export type UiClientMessage =
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'control'; envelope: WireEnvelope };

export type UiServerMessage =
  | {
      type: 'welcome';
      versions: { protocol: number; server: string };
      breakpoints: BreakpointMatcher[];
      mode: RunMode;
    }
  | { type: 'state'; breakpoints: BreakpointMatcher[]; mode: RunMode }
  | { type: 'runs'; runs: RunInfo[] }
  | { type: 'run.update'; run: RunInfo }
  | { type: 'replay.start'; runId: string; count: number }
  | { type: 'event'; runId: string; envelope: WireEnvelope }
  | { type: 'replay.end'; runId: string }
  | { type: 'error'; message: string; runId?: string };
