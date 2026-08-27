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
  /** Payload fields that were dropped, when only part of it was too big. */
  fields?: string[];
}

export function isTruncatedPayload(value: unknown): value is TruncatedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __graphmindTruncated?: unknown }).__graphmindTruncated === true
  );
}

/** Length of the JSON prefix kept in a truncation marker. */
const PREVIEW_CHARS = 2000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return undefined;
  }
}

/**
 * Trim the offending FIELDS of an oversized object payload instead of
 * discarding the whole thing.
 *
 * This matters more than it looks: payload schemas are per message type
 * (`node.finished` needs `nodeId`, `durationMs`, `status`), and a payload
 * replaced wholesale by a marker no longer satisfies its own schema — the
 * viewer's parser rejects the replayed envelope and the node is stuck
 * "running" forever on reload. Keeping the small structural fields and
 * marking only the huge ones keeps the stored envelope valid, which is what
 * makes an oversized tool result *degrade* rather than disappear.
 *
 * Returns undefined when the payload cannot be trimmed into budget this way
 * (not an object, or still too big) — the caller then falls back to the
 * whole-payload marker.
 */
function truncateFields(
  payload: Record<string, unknown>,
  maxBytes: number,
  totalBytes: number,
  json: string,
): { json: string; payload: unknown } | undefined {
  const sizes: { key: string; bytes: number }[] = [];
  for (const key of Object.keys(payload)) {
    const encoded = safeStringify(payload[key]);
    sizes.push({ key, bytes: encoded === undefined ? Number.MAX_SAFE_INTEGER : encoded.length });
  }
  // Biggest first: drop as few fields as possible to get under budget.
  sizes.sort((a, b) => b.bytes - a.bytes);

  const trimmed: Record<string, unknown> = { ...payload };
  const dropped: string[] = [];
  let remaining = totalBytes;
  for (const { key, bytes } of sizes) {
    if (remaining <= maxBytes / 2) break; // leave room for the marker itself
    const value = payload[key];
    // An array field keeps its type (an empty array still satisfies
    // `z.array(...)`); anything else becomes a nested marker.
    const encoded = safeStringify(value);
    trimmed[key] = Array.isArray(value)
      ? []
      : ({
          __graphmindTruncated: true,
          bytes,
          preview: encoded === undefined ? '[unserializable field]' : encoded.slice(0, PREVIEW_CHARS),
        } satisfies TruncatedPayload);
    dropped.push(key);
    remaining -= bytes;
  }
  if (dropped.length === 0) return undefined;

  // The top-level marker fields stay, so `isTruncatedPayload` still reports
  // true for a partially truncated payload and every consumer keeps working.
  const marker: TruncatedPayload = {
    __graphmindTruncated: true,
    bytes: totalBytes,
    preview: json.slice(0, PREVIEW_CHARS),
    fields: dropped,
  };
  const result = { ...trimmed, ...marker };
  const encoded = safeStringify(result);
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) return undefined;
  return { json: encoded, payload: result };
}

/**
 * Serialize a payload, replacing it with a truncation marker when it exceeds
 * `MAX_PAYLOAD_BYTES`. Returns the JSON text to store plus the effective
 * payload, so callers can fan out exactly what was persisted.
 *
 * An oversized *object* payload keeps its small fields and marks only the
 * large ones (see `truncateFields`); anything else — a giant bare string, a
 * cyclic value — is replaced whole. Either way the result carries the
 * `__graphmindTruncated` marker fields at the top level.
 */

/**
 * Keep every field that still serializes, and replace only the ones that do
 * not (cyclic, or too deeply nested for JSON.stringify) with a marker.
 *
 * The whole point is that the envelope must remain valid against its own
 * schema: `node.finished` keeps nodeId/durationMs/status and loses only the
 * pathological `output`. Returns undefined when the result still cannot be
 * serialized, so the caller can fall back to the whole-payload marker.
 */
function truncateUnserializableFields(
  payload: Record<string, unknown>,
): { json: string; payload: unknown } | undefined {
  const trimmed: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (safeStringify(value) !== undefined) {
      trimmed[key] = value;
      continue;
    }
    dropped.push(key);
    // Arrays keep their type so `z.array(...)` still matches.
    trimmed[key] = Array.isArray(value)
      ? []
      : ({
          __graphmindTruncated: true,
          bytes: 0,
          preview: '[unserializable value]',
        } satisfies TruncatedPayload);
  }
  if (dropped.length === 0) return undefined; // nothing to blame; let the caller decide
  trimmed['__graphmindTruncated'] = true;
  trimmed['fields'] = dropped;
  const json = safeStringify(trimmed);
  return json === undefined ? undefined : { json, payload: trimmed };
}

export function serializePayload(
  payload: unknown,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): { json: string; payload: unknown; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(payload) ?? 'null';
  } catch {
    // Cyclic, or nested deeper than the JSON serializer's stack (the depth at
    // which that bites is platform-dependent — Linux trips on payloads macOS
    // serializes fine, which is how CI caught this).
    //
    // Replacing the WHOLE payload here loses the fields the payload's own
    // schema requires, so the stored envelope no longer validates and the
    // viewer drops the event on replay: the node hangs "running" forever.
    // Trim the offending FIELDS instead, exactly as the oversized path does,
    // so the event still parses and only the unserializable value is lost.
    if (isPlainObject(payload)) {
      const trimmed = truncateUnserializableFields(payload);
      if (trimmed !== undefined) {
        return { json: trimmed.json, payload: trimmed.payload, truncated: true };
      }
    }
    const marker: TruncatedPayload = {
      __graphmindTruncated: true,
      bytes: 0,
      preview: '[unserializable payload]',
    };
    return { json: JSON.stringify(marker), payload: marker, truncated: true };
  }
  const bytes = Buffer.byteLength(json);
  if (bytes <= maxBytes) return { json, payload, truncated: false };

  if (isPlainObject(payload)) {
    const trimmed = truncateFields(payload, maxBytes, bytes, json);
    if (trimmed !== undefined) {
      return { json: trimmed.json, payload: trimmed.payload, truncated: true };
    }
  }

  const marker: TruncatedPayload = {
    __graphmindTruncated: true,
    bytes,
    preview: json.slice(0, PREVIEW_CHARS),
  };
  return { json: JSON.stringify(marker), payload: marker, truncated: true };
}
