/**
 * SqliteJournalStore — JournalStore on `node:sqlite` (built into Node >=
 * 22.13, zero native dependencies, the same choice as GraphMind's CLI
 * storage). Single-writer by design: this backend serves `circuit dev`,
 * tests and single-node self-hosting. The hosted multi-worker service uses
 * PgJournalStore (SKIP LOCKED claims) behind the same interface.
 *
 * The methods are async only to satisfy the JournalStore contract; each
 * body runs synchronously to completion before its promise settles (no
 * internal await other than createRun's own lookup), so two calls issued
 * back to back hit the database in issue order — exactly the old sync
 * behavior. List ordering breaks ties by rowid (insertion order), matching
 * PgJournalStore's identity columns.
 *
 * JSON columns are TEXT; absent optionals are NULL, never 'null'.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { BreakpointMatcher, JournalEntry, JsonValue, Run, WorkflowEvent } from '@graphmind-ai/circuit-schema';
import {
  ENTRY_COLUMNS,
  ENTRY_JSON_COLUMNS,
  json,
  maybeJson,
  parseMaybe,
  RUN_COLUMNS,
  RUN_JSON_COLUMNS,
  rowToEntry,
  rowToRun,
  type Row,
} from './rows.js';
import type { JournalStore, Patch, RunFilter, WaitRow } from './store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  idempotency_key TEXT,
  parent_run_id TEXT,
  parent_seq INTEGER,
  forked_from TEXT,
  wake_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  paused_seq INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_idem ON runs(workflow, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_due ON runs(status, wake_at);
CREATE TABLE IF NOT EXISTS journal (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL,
  pause_point TEXT,
  input TEXT,
  output TEXT,
  error TEXT,
  attempts TEXT NOT NULL,
  interventions TEXT NOT NULL,
  wake_at INTEGER,
  wait_event TEXT,
  wait_match TEXT,
  expires_at INTEGER,
  child_run_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS waits (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  match TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS waits_event ON waits(event_name);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS breakpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  matcher TEXT NOT NULL
);
`;

export class SqliteJournalStore implements JournalStore {
  private readonly db: DatabaseSync;

  /** `:memory:` (tests) or a file path (dev / self-host). */
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  private prep(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  async createRun(run: Run): Promise<Run> {
    if (run.idempotencyKey !== undefined) {
      const existing = this.findIdem(run.workflow, run.idempotencyKey);
      if (existing) return existing;
    }
    this.prep(
      `INSERT INTO runs (id, workflow, status, input, output, error, idempotency_key, parent_run_id, parent_seq,
         forked_from, wake_at, lease_owner, lease_expires_at, paused_seq, created_at, started_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      run.id,
      run.workflow,
      run.status,
      json(run.input),
      maybeJson(run.output),
      maybeJson(run.error),
      run.idempotencyKey ?? null,
      run.parentRunId ?? null,
      run.parentSeq ?? null,
      maybeJson(run.forkedFrom),
      run.wakeAt ?? null,
      run.leaseOwner ?? null,
      run.leaseExpiresAt ?? null,
      run.pausedSeq ?? null,
      run.createdAt,
      run.startedAt ?? null,
      run.finishedAt ?? null,
    );
    return run;
  }

  async getRun(id: string): Promise<Run | undefined> {
    const row = this.prep('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToRun(row) : undefined;
  }

  async findByIdempotencyKey(workflow: string, key: string): Promise<Run | undefined> {
    return this.findIdem(workflow, key);
  }

  /** Sync so createRun's check-then-insert never yields between the two. */
  private findIdem(workflow: string, key: string): Run | undefined {
    const row = this.prep('SELECT * FROM runs WHERE workflow = ? AND idempotency_key = ?').get(workflow, key) as
      | Row
      | undefined;
    return row ? rowToRun(row) : undefined;
  }

  async listRuns(filter?: RunFilter): Promise<Run[]> {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (filter?.workflow !== undefined) {
      clauses.push('workflow = ?');
      args.push(filter.workflow);
    }
    if (filter?.status !== undefined) {
      clauses.push('status = ?');
      args.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.prep(`SELECT * FROM runs${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(
      ...args,
      filter?.limit ?? 100,
    ) as Row[];
    return rows.map(rowToRun);
  }

  async updateRun(id: string, patch: Patch<Run>): Promise<void> {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [field, column] of Object.entries(RUN_COLUMNS)) {
      if (!(field in patch)) continue;
      const value = (patch as Record<string, unknown>)[field];
      sets.push(`${column} = ?`);
      if (value === undefined) args.push(null);
      else if (RUN_JSON_COLUMNS.has(field)) args.push(json(value));
      else args.push(value as string | number);
    }
    if (sets.length === 0) return;
    args.push(id);
    this.prep(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  async claimDue(now: number, owner: string, leaseMs: number, limit: number): Promise<Run[]> {
    // Single-writer backend: SELECT then UPDATE is atomic here, because the
    // body never yields (node:sqlite is sync). PgJournalStore uses
    // FOR UPDATE SKIP LOCKED instead.
    const rows = this.prep(
      `SELECT * FROM runs
       WHERE (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND (
           status = 'queued'
           OR (status IN ('suspended','paused') AND wake_at IS NOT NULL AND wake_at <= ?)
           OR status = 'running'
         )
       ORDER BY COALESCE(wake_at, created_at) ASC, rowid ASC
       LIMIT ?`,
    ).all(now, now, limit) as Row[];
    const claimed: Run[] = [];
    for (const row of rows) {
      this.prep('UPDATE runs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?').run(
        owner,
        now + leaseMs,
        row.id as string,
      );
      const run = rowToRun(row);
      run.leaseOwner = owner;
      run.leaseExpiresAt = now + leaseMs;
      claimed.push(run);
    }
    return claimed;
  }

  async releaseLease(id: string): Promise<void> {
    this.prep('UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?').run(id);
  }

  async listJournal(runId: string): Promise<JournalEntry[]> {
    const rows = this.prep('SELECT * FROM journal WHERE run_id = ? ORDER BY seq ASC').all(runId) as Row[];
    return rows.map(rowToEntry);
  }

  async getEntry(runId: string, seq: number): Promise<JournalEntry | undefined> {
    const row = this.prep('SELECT * FROM journal WHERE run_id = ? AND seq = ?').get(runId, seq) as Row | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  async appendEntry(entry: Omit<JournalEntry, 'seq'>): Promise<JournalEntry> {
    const next = this.prep('SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM journal WHERE run_id = ?').get(
      entry.runId,
    ) as Row;
    const seq = Number(next.seq);
    this.prep(
      `INSERT INTO journal (run_id, seq, kind, name, ordinal, key, status, pause_point, input, output, error,
         attempts, interventions, wake_at, wait_event, wait_match, expires_at, child_run_id, started_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entry.runId,
      seq,
      entry.kind,
      entry.name,
      entry.ordinal,
      entry.key,
      entry.status,
      entry.pausePoint ?? null,
      maybeJson(entry.input),
      maybeJson(entry.output),
      maybeJson(entry.error),
      json(entry.attempts),
      json(entry.interventions),
      entry.wakeAt ?? null,
      entry.waitEvent ?? null,
      maybeJson(entry.waitMatch),
      entry.expiresAt ?? null,
      entry.childRunId ?? null,
      entry.startedAt,
      entry.finishedAt ?? null,
    );
    return { ...entry, seq };
  }

  async updateEntry(runId: string, seq: number, patch: Patch<JournalEntry>): Promise<void> {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [field, column] of Object.entries(ENTRY_COLUMNS)) {
      if (!(field in patch)) continue;
      const value = (patch as Record<string, unknown>)[field];
      sets.push(`"${column}" = ?`);
      if (value === undefined) args.push(null);
      else if (ENTRY_JSON_COLUMNS.has(field)) args.push(json(value));
      else args.push(value as string | number);
    }
    if (sets.length === 0) return;
    args.push(runId, seq);
    this.prep(`UPDATE journal SET ${sets.join(', ')} WHERE run_id = ? AND seq = ?`).run(...args);
  }

  async addWait(wait: WaitRow): Promise<void> {
    this.prep('INSERT OR REPLACE INTO waits (run_id, seq, event_name, match, expires_at) VALUES (?,?,?,?,?)').run(
      wait.runId,
      wait.seq,
      wait.eventName,
      maybeJson(wait.match),
      wait.expiresAt,
    );
  }

  async removeWait(runId: string, seq: number): Promise<void> {
    this.prep('DELETE FROM waits WHERE run_id = ? AND seq = ?').run(runId, seq);
  }

  async findWaits(eventName: string): Promise<WaitRow[]> {
    const rows = this.prep('SELECT * FROM waits WHERE event_name = ? ORDER BY rowid ASC').all(eventName) as Row[];
    return rows.map((row) => ({
      runId: row.run_id as string,
      seq: Number(row.seq),
      eventName: row.event_name as string,
      match: parseMaybe<Record<string, JsonValue>>(row.match),
      expiresAt: Number(row.expires_at),
    }));
  }

  async insertEvent(event: WorkflowEvent): Promise<void> {
    this.prep('INSERT INTO events (id, name, data, received_at) VALUES (?,?,?,?)').run(
      event.id,
      event.name,
      json(event.data),
      event.receivedAt,
    );
  }

  async listBreakpoints(): Promise<BreakpointMatcher[]> {
    const rows = this.prep('SELECT matcher FROM breakpoints ORDER BY id ASC').all() as Row[];
    return rows.map((row) => JSON.parse(row.matcher as string) as BreakpointMatcher);
  }

  async setBreakpoint(matcher: BreakpointMatcher): Promise<void> {
    this.prep('INSERT INTO breakpoints (matcher) VALUES (?)').run(json(matcher));
  }

  async clearBreakpoints(): Promise<void> {
    this.prep('DELETE FROM breakpoints').run();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
