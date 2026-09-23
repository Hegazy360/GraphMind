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
 *  4. Authentication (0.6.0+): a browser presents the viewer token as the
 *     subprotocol `gm.auth.<token>` next to `graphmind.v1` (the only one the
 *     server selects); a non-browser client may send `Authorization: Bearer`.
 *     No credential = `anonymous`: continue/retry/inject/abort and debug
 *     state as in 0.5 (deprecated), never input edits. An unknown token is
 *     refused at the upgrade (401). `exec.resume` is first-writer-wins per
 *     pause: a second resume for a pause already being answered gets
 *     `error {code:'pause-taken'}`; one the hub knows is closed gets
 *     `no-such-pause`. The app's answer comes back as `resume.result`.
 *
 * Dedup rule (internal/decisions.md #5): replayed envelopes keep their
 * original `seq`; viewers dedupe on `(runId, seq)`.
 */
import type { BreakpointMatcher, RunMode } from '@graphmind-ai/schema';
import type { ControlLevel, Principal } from './control-auth.js';
import type { ResumeOutcomeKind } from './pause-registry.js';
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
  /**
   * `finishedAt - startedAt`, or null while the run is in flight. Derived
   * server-side so consumers do not have to subtract envelope timestamps —
   * `run.finished` carries only `{status}` on the wire.
   */
  durationMs: number | null;
}

export type UiClientMessage =
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'control'; envelope: WireEnvelope };

/**
 * What this viewer socket may do (0.6.0+, on `welcome`). `principal` is how
 * the socket authenticated: `viewer` (the `#token=` credential), `agent`, or
 * `anonymous` (no credential: continue/retry/inject/abort only, deprecated).
 * `agentLevel` is the server's `--allow-control` level for the agent token,
 * shown so the human can see what a coding agent is allowed to do.
 */
export interface UiControlInfo {
  principal: Principal;
  agentLevel: ControlLevel;
  /** False under `serve --no-edit-input`. */
  editInput: boolean;
  hubCapabilities: string[];
}

export type UiServerMessage =
  | {
      type: 'welcome';
      versions: { protocol: number; server: string };
      breakpoints: BreakpointMatcher[];
      mode: RunMode;
      control?: UiControlInfo;
    }
  | { type: 'state'; breakpoints: BreakpointMatcher[]; mode: RunMode }
  | { type: 'runs'; runs: RunInfo[] }
  | { type: 'run.update'; run: RunInfo }
  | { type: 'replay.start'; runId: string; count: number }
  | { type: 'event'; runId: string; envelope: WireEnvelope }
  | { type: 'replay.end'; runId: string }
  | {
      type: 'error';
      message: string;
      runId?: string;
      /** Machine-readable reason (0.6.0+): `pause-taken`, `no-such-pause`, `edit-refused`, ... */
      code?: string;
      pauseId?: string;
      requestId?: string;
    }
  /**
   * The answer to an `exec.resume` this socket sent (0.6.0+): `resumed`,
   * `refused` (the app would not run the edit; the gate is still held),
   * `taken`, `timeout` or `no-such-pause`. Immediate refusals arrive as
   * `error` frames instead.
   */
  | {
      type: 'resume.result';
      runId: string;
      pauseId: string;
      requestId: string;
      outcome: ResumeOutcomeKind;
      code?: string;
      message?: string;
    };
