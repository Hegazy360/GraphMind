/**
 * The storage boundary of the GraphMind server.
 *
 * Deliberately small and synchronous: the server is a single-process local
 * tool, `node:sqlite` is synchronous by design, and a synchronous API keeps
 * ingest handling atomic (no interleaving between "read history" and
 * "subscribe to live events" — replay-then-tail is race-free because the
 * whole subscribe handler runs in one tick).
 *
 * The default implementation is SQLite (sqlite-storage.ts). This interface
 * is the hedge named in internal/decisions.md: if `node:sqlite` misbehaves,
 * a JSONL-backed implementation can replace it without touching the server.
 */
import type { RunStatus } from '@graphmind-ai/schema';

/** Where a run's events came from. */
export type RunSource = 'live' | 'import' | 'demo';

/**
 * `running` until a `run.finished` event arrives; then its terminal status.
 *
 * `abandoned` is the server's own terminal state, not something an app can
 * report: the connection that owned the run went away without ever sending
 * `run.finished` (the process was killed, often while holding a gate). It is
 * deliberately distinct from `aborted` — nobody decided to stop this run, we
 * simply stopped hearing about it — and it exists so the runs list cannot
 * accumulate phantom rows that claim to be in flight forever.
 */
export type RunLifecycleStatus = 'running' | 'abandoned' | RunStatus;

export interface RunRecord {
  id: string;
  app: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds, or null while the run is still going. */
  finishedAt: number | null;
  status: RunLifecycleStatus;
  /** Envelope `gm` of the run's events. */
  schemaVersion: number;
  source: RunSource;
}

/** A run row plus derived counts (as served by `GET /api/runs`). */
export interface RunSummary extends RunRecord {
  eventCount: number;
  /** Number of `node.error` events. */
  errorCount: number;
}

/** One persisted envelope. `payload` round-trips through JSON. */
export interface StoredEvent {
  runId: string;
  seq: number;
  ts: number;
  type: string;
  /** `payload.nodeId` when present — denormalized for per-node queries. */
  nodeId: string | null;
  payload: unknown;
}

export interface EventQuery {
  /** Return events with `seq > afterSeq` (exclusive cursor). Default: all. */
  afterSeq?: number;
  /** Maximum events to return. Default: unlimited. */
  limit?: number;
}

export interface EventPage {
  /** In ascending `seq` order. */
  events: StoredEvent[];
  /** Total events stored for the run (ignoring the query window). */
  total: number;
  /** True when events beyond this page match the query. */
  hasMore: boolean;
}

export interface Storage {
  /** Create the run row if it does not exist yet (INSERT OR IGNORE). */
  ensureRun(run: {
    id: string;
    app: string;
    startedAt: number;
    schemaVersion: number;
    source: RunSource;
  }): void;

  /** Apply `run.started` metadata (app name, authoritative start time). */
  markRunStarted(id: string, app: string, startedAt: number): void;

  /** Apply `run.finished`: terminal status + finish time. */
  markRunFinished(id: string, status: RunStatus, finishedAt: number): void;

  /**
   * Reconcile a run whose owning app vanished without sending `run.finished`:
   * `status` becomes `abandoned` and `finishedAt` the timestamp of the run's
   * last stored event — the last moment the run is known to have been alive —
   * falling back to `fallbackFinishedAt` for a run with no events.
   *
   * Guarded on `status = 'running'`, so a run that genuinely reported `ok` /
   * `error` / `aborted` is never relabelled. Returns false when nothing
   * changed (unknown run, or already terminal).
   */
  markRunAbandoned(id: string, fallbackFinishedAt: number): boolean;

  /**
   * Undo `markRunAbandoned` because the app reconnected and is streaming the
   * same run again — a run may legitimately span a reconnect. Guarded on
   * `status = 'abandoned'`, so it can never revive a genuinely finished run.
   * Returns false when nothing changed.
   */
  markRunResumed(id: string): boolean;

  /** Ids of every run still marked `running`. */
  listRunningRunIds(): string[];

  /**
   * Persist one event. Returns false when an event with the same
   * `(runId, seq)` already exists — the replay-dedup rule of
   * internal/decisions.md #5 (INSERT OR IGNORE).
   */
  insertEvent(event: StoredEvent): boolean;

  getRun(id: string): RunSummary | undefined;

  /** All runs, most recently started first. */
  listRuns(): RunSummary[];

  /** Events of one run in ascending `seq` order (paginated via `query`). */
  listEvents(runId: string, query?: EventQuery): EventPage;

  /** Delete one run and its events. Returns false when it did not exist. */
  deleteRun(id: string): boolean;

  /**
   * Enforce a retention policy. Runs are kept when they are among the
   * `keepRuns` most recent AND started within `keepDays`; everything else is
   * deleted with its events. Unfinished runs newer than `keepDays` are never
   * pruned (a long-lived run must not vanish while it streams).
   */
  prune(policy: RetentionPolicy): PruneResult;

  /** Reclaim file space after large deletions. Best-effort. */
  vacuum(): void;

  /** Flush (checkpoint) and close. Idempotent. */
  close(): void;
}

export interface RetentionPolicy {
  /** Keep at most this many runs (most recent first). */
  keepRuns?: number | undefined;
  /** Keep runs started within this many days. */
  keepDays?: number | undefined;
  /** Wall-clock now, in ms. Injectable for tests. */
  now?: number | undefined;
}

export interface PruneResult {
  runsDeleted: number;
  eventsDeleted: number;
}

/** Defaults chosen so a laptop never fills up unattended. */
export const DEFAULT_RETENTION: { keepRuns: number; keepDays: number } = {
  keepRuns: 200,
  keepDays: 30,
};

/**
 * The payload budget and its type-preserving shrink now live in
 * @graphmind-ai/schema (src/shrink.ts), unchanged in behaviour, so the client
 * applies the SAME shrink at emit and a live view, a reload and the stored
 * row all agree. Re-exported here under the names this module always had:
 * the server, the MCP tools, the tests and security/ import them from here.
 *
 * Payloads are developer data (prompts, tool results) and are usually small,
 * but a single embedding array or scraped page can be enormous. Anything past
 * MAX_PAYLOAD_BYTES is stored as a marker so one event cannot bloat the
 * database or wedge the viewer.
 */
export {
  MAX_PAYLOAD_BYTES,
  isTruncatedPayload,
  serializePayload,
  type TruncatedPayload,
} from '@graphmind-ai/schema';

/**
 * Largest WebSocket frame the local server will assemble, on either socket.
 *
 * Deliberately much larger than MAX_PAYLOAD_BYTES (so an oversized payload
 * still arrives and degrades to a preview, which is the designed behaviour)
 * and much smaller than the `ws` default of 100 MiB (so a single frame cannot
 * permanently inflate the process). See the call site in `server.ts`.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
