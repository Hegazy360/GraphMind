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

/** `running` until a `run.finished` event arrives; then its terminal status. */
export type RunLifecycleStatus = 'running' | RunStatus;

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

  /** Flush (checkpoint) and close. Idempotent. */
  close(): void;
}
