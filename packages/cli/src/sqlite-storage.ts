/**
 * SQLite-backed storage using `node:sqlite` (built into Node >= 22.13,
 * zero native dependencies). WAL mode; dedup via the `(run_id, seq)`
 * primary key + INSERT OR IGNORE.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { RunStatus } from '@graphmind/schema';
import type {
  EventPage,
  EventQuery,
  RunLifecycleStatus,
  RunSource,
  RunSummary,
  Storage,
  StoredEvent,
} from './storage.js';

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  app            TEXT NOT NULL,
  started_at     REAL NOT NULL,
  finished_at    REAL,
  status         TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  source         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  run_id       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           REAL NOT NULL,
  type         TEXT NOT NULL,
  node_id      TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_run_type ON events (run_id, type);
`;

const RUN_COLUMNS = `
  r.id, r.app, r.started_at, r.finished_at, r.status, r.schema_version, r.source,
  (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id) AS event_count,
  (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id AND e.type = 'node.error') AS error_count
`;

interface RunRow {
  id: string;
  app: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  schema_version: number;
  source: string;
  event_count: number;
  error_count: number;
}

interface EventRow {
  run_id: string;
  seq: number;
  ts: number;
  type: string;
  node_id: string | null;
  payload_json: string;
}

function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    app: row.app,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as RunLifecycleStatus,
    schemaVersion: row.schema_version,
    source: row.source as RunSource,
    eventCount: row.event_count,
    errorCount: row.error_count,
  };
}

function toStoredEvent(row: EventRow): StoredEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null; // corrupt row; never throw out of storage reads
  }
  return {
    runId: row.run_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    nodeId: row.node_id,
    payload,
  };
}

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;
  private closed = false;

  private readonly stmtEnsureRun: StatementSync;
  private readonly stmtRunStarted: StatementSync;
  private readonly stmtRunFinished: StatementSync;
  private readonly stmtInsertEvent: StatementSync;
  private readonly stmtGetRun: StatementSync;
  private readonly stmtListRuns: StatementSync;
  private readonly stmtListEvents: StatementSync;
  private readonly stmtCountEvents: StatementSync;

  constructor(public readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(DDL);

    this.stmtEnsureRun = this.db.prepare(
      `INSERT OR IGNORE INTO runs (id, app, started_at, finished_at, status, schema_version, source)
       VALUES (?, ?, ?, NULL, 'running', ?, ?)`,
    );
    this.stmtRunStarted = this.db.prepare(`UPDATE runs SET app = ?, started_at = ? WHERE id = ?`);
    this.stmtRunFinished = this.db.prepare(
      `UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`,
    );
    this.stmtInsertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO events (run_id, seq, ts, type, node_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetRun = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM runs r WHERE r.id = ?`);
    this.stmtListRuns = this.db.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs r ORDER BY r.started_at DESC, r.id DESC`,
    );
    this.stmtListEvents = this.db.prepare(
      `SELECT run_id, seq, ts, type, node_id, payload_json FROM events
       WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    );
    this.stmtCountEvents = this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE run_id = ?`);
  }

  ensureRun(run: {
    id: string;
    app: string;
    startedAt: number;
    schemaVersion: number;
    source: RunSource;
  }): void {
    this.stmtEnsureRun.run(run.id, run.app, run.startedAt, run.schemaVersion, run.source);
  }

  markRunStarted(id: string, app: string, startedAt: number): void {
    this.stmtRunStarted.run(app, startedAt, id);
  }

  markRunFinished(id: string, status: RunStatus, finishedAt: number): void {
    this.stmtRunFinished.run(status, finishedAt, id);
  }

  insertEvent(event: StoredEvent): boolean {
    const result = this.stmtInsertEvent.run(
      event.runId,
      event.seq,
      event.ts,
      event.type,
      event.nodeId,
      JSON.stringify(event.payload) ?? 'null',
    );
    return result.changes > 0;
  }

  getRun(id: string): RunSummary | undefined {
    const row = this.stmtGetRun.get(id) as RunRow | undefined;
    return row === undefined ? undefined : toRunSummary(row);
  }

  listRuns(): RunSummary[] {
    return (this.stmtListRuns.all() as unknown as RunRow[]).map(toRunSummary);
  }

  listEvents(runId: string, query: EventQuery = {}): EventPage {
    const afterSeq = query.afterSeq ?? -1;
    const limit = query.limit;
    // Fetch one extra row to learn whether more events follow the page.
    const sqlLimit = limit === undefined ? -1 : limit + 1;
    const rows = this.stmtListEvents.all(runId, afterSeq, sqlLimit) as unknown as EventRow[];
    const hasMore = limit !== undefined && rows.length > limit;
    const events = (hasMore ? rows.slice(0, limit) : rows).map(toStoredEvent);
    const countRow = this.stmtCountEvents.get(runId) as { n: number } | undefined;
    return { events, total: countRow?.n ?? 0, hasMore };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // best-effort checkpoint; close regardless
    }
    this.db.close();
  }
}
