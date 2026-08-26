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
 * Payloads are developer data (prompts, tool results) and are usually small,
 * but a single embedding array or scraped page can be enormous. Anything past
 * this is stored as a marker so one event cannot bloat the database or wedge
 * the viewer.
 */
export const MAX_PAYLOAD_BYTES = 512 * 1024;

export interface TruncatedPayload {
  __graphmindTruncated: true;
  bytes: number;
  preview: string;
}

export function isTruncatedPayload(value: unknown): value is TruncatedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __graphmindTruncated?: unknown }).__graphmindTruncated === true
  );
}

/**
 * Serialize a payload, replacing it with a truncation marker when it exceeds
 * `MAX_PAYLOAD_BYTES`. Returns the JSON text to store plus the effective
 * payload, so callers can fan out exactly what was persisted.
 */
export function serializePayload(
  payload: unknown,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): { json: string; payload: unknown; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(payload) ?? 'null';
  } catch {
    // Cyclic or non-serializable: keep the run alive, lose the payload.
    const marker: TruncatedPayload = {
      __graphmindTruncated: true,
      bytes: 0,
      preview: '[unserializable payload]',
    };
    return { json: JSON.stringify(marker), payload: marker, truncated: true };
  }
  const bytes = Buffer.byteLength(json);
  if (bytes <= maxBytes) return { json, payload, truncated: false };
  const marker: TruncatedPayload = {
    __graphmindTruncated: true,
    bytes,
    preview: json.slice(0, 2000),
  };
  return { json: JSON.stringify(marker), payload: marker, truncated: true };
}
