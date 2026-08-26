/**
 * The `/ws/ui` wire protocol between the CLI server and this viewer.
 * Mirrored locally from the `graphmind-ai` CLI package (packages/cli) to
 * avoid a build-order dependency — keep in sync.
 *
 * JSON text frames, discriminated on `type`. Schema envelopes never travel
 * bare — they are wrapped in `event` / `control` frames.
 *
 * Server → viewer:
 *  - `welcome {versions:{protocol,server}, breakpoints, mode}` on connect
 *  - `state {breakpoints, mode}` on every breakpoint/mode change
 *  - `runs {runs: RunInfo[]}` — reply to subscribing `'*'`
 *  - `run.update {run: RunInfo}` — pushed to `'*'` subscribers
 *  - `replay.start {runId, count}` → `event {runId, envelope}` per event
 *    (original seq preserved; the viewer dedupes on `(runId, seq)`) →
 *    `replay.end {runId}` → live `event` frames continue (tail)
 *  - `error {message, runId?}`
 *
 * Viewer → server:
 *  - `subscribe {runId}` — a run id for replay-then-tail, `'*'` for the run
 *    list. Subscribing to a not-yet-existing run is legal.
 *  - `unsubscribe {runId}`
 *  - `control {envelope}` — a FULL schema control envelope (`exec.resume`,
 *    `breakpoint.set/clear`, `mode.set`); the server re-mints `seq`.
 *    `exec.resume` must carry the owning run's `runId`.
 */
import type { BreakpointMatcher, RunMode } from '@graphmind-ai/schema';

export interface RunInfo {
  id: string;
  app: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'ok' | 'error' | 'aborted';
  schemaVersion: number;
  source: string;
  eventCount: number;
  errorCount: number;
  live: boolean;
}

export interface WelcomeFrame {
  type: 'welcome';
  versions: { protocol: number; server: string };
  breakpoints: BreakpointMatcher[];
  mode: RunMode;
}

export interface StateFrame {
  type: 'state';
  breakpoints: BreakpointMatcher[];
  mode: RunMode;
}

export interface RunsFrame {
  type: 'runs';
  runs: RunInfo[];
}

export interface RunUpdateFrame {
  type: 'run.update';
  run: RunInfo;
}

export interface ReplayStartFrame {
  type: 'replay.start';
  runId: string;
  count: number;
}

export interface EventFrame {
  type: 'event';
  runId: string;
  envelope: unknown;
}

export interface ReplayEndFrame {
  type: 'replay.end';
  runId: string;
}

export interface ErrorFrame {
  type: 'error';
  message: string;
  runId?: string;
}

export type UiServerFrame =
  | WelcomeFrame
  | StateFrame
  | RunsFrame
  | RunUpdateFrame
  | ReplayStartFrame
  | EventFrame
  | ReplayEndFrame
  | ErrorFrame;
