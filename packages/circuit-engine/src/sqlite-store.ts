/**
 * SqliteJournalStore — JournalStore on `node:sqlite` (built into Node >=
 * 22.13, zero native dependencies, the same choice as GraphMind's CLI
 * storage). Single-writer by design: this backend serves `circuit dev`,
 * tests and single-node self-hosting. The hosted multi-worker service gets
 * PostgresJournalStore (SKIP LOCKED claims) behind the same interface.
 *
 * JSON columns are TEXT; absent optionals are NULL, never 'null'.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  BreakpointMatcher,
  JournalEntry,
  JsonValue,
  Run,
  Attempt,
  Intervention,
  ErrorShape,
  WorkflowEvent,
} from '@graphmind-ai/circuit-schema';
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

function json(value: unknown): string {
  return JSON.stringify(value);
}

function maybeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseMaybe<T>(text: unknown): T | undefined {
  return text === null || text === undefined ? undefined : (JSON.parse(text as string) as T);
}

type Row = Record<string, unknown>;

function rowToRun(row: Row): Run {
  const run: Run = {
    id: row.id as string,
    workflow: row.workflow as string,
    status: row.status as Run['status'],
    input: JSON.parse(row.input as string) as JsonValue,
    createdAt: Number(row.created_at),
  };
  const output = parseMaybe<JsonValue>(row.output);
  if (output !== undefined) run.output = output;
  const error = parseMaybe<ErrorShape>(row.error);
  if (error !== undefined) run.error = error;
  if (row.idempotency_key != null) run.idempotencyKey = row.idempotency_key as string;
  if (row.parent_run_id != null) run.parentRunId = row.parent_run_id as string;
  if (row.parent_seq != null) run.parentSeq = Number(row.parent_seq);
  const forked = parseMaybe<Run['forkedFrom']>(row.forked_from);
  if (forked !== undefined) run.forkedFrom = forked;
  if (row.wake_at != null) run.wakeAt = Number(row.wake_at);
  if (row.lease_owner != null) run.leaseOwner = row.lease_owner as string;
  if (row.lease_expires_at != null) run.leaseExpiresAt = Number(row.lease_expires_at);
  if (row.paused_seq != null) run.pausedSeq = Number(row.paused_seq);
  if (row.started_at != null) run.startedAt = Number(row.started_at);
  if (row.finished_at != null) run.finishedAt = Number(row.finished_at);
  return run;
}

function rowToEntry(row: Row): JournalEntry {
  const entry: JournalEntry = {
    runId: row.run_id as string,
    seq: Number(row.seq),
    kind: row.kind as JournalEntry['kind'],
    name: row.name as string,
    ordinal: Number(row.ordinal),
    key: row.key as string,
    status: row.status as JournalEntry['status'],
    attempts: JSON.parse(row.attempts as string) as Attempt[],
    interventions: JSON.parse(row.interventions as string) as Intervention[],
    startedAt: Number(row.started_at),
  };
  if (row.pause_point != null) entry.pausePoint = row.pause_point as JournalEntry['pausePoint'];
  const input = parseMaybe<JsonValue>(row.input);
  if (input !== undefined) entry.input = input;
  const output = parseMaybe<JsonValue>(row.output);
  if (output !== undefined) entry.output = output;
  const error = parseMaybe<ErrorShape>(row.error);
  if (error !== undefined) entry.error = error;
  if (row.wake_at != null) entry.wakeAt = Number(row.wake_at);
  if (row.wait_event != null) entry.waitEvent = row.wait_event as string;
  const match = parseMaybe<Record<string, JsonValue>>(row.wait_match);
  if (match !== undefined) entry.waitMatch = match;
  if (row.expires_at != null) entry.expiresAt = Number(row.expires_at);
  if (row.child_run_id != null) entry.childRunId = row.child_run_id as string;
  if (row.finished_at != null) entry.finishedAt = Number(row.finished_at);
  return entry;
}

const RUN_COLUMNS: Record<string, string> = {
  workflow: 'workflow',
  status: 'status',
  input: 'input',
  output: 'output',
  error: 'error',
  idempotencyKey: 'idempotency_key',
  parentRunId: 'parent_run_id',
  parentSeq: 'parent_seq',
  forkedFrom: 'forked_from',
  wakeAt: 'wake_at',
  leaseOwner: 'lease_owner',
  leaseExpiresAt: 'lease_expires_at',
  pausedSeq: 'paused_seq',
  createdAt: 'created_at',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};
const RUN_JSON_COLUMNS = new Set(['input', 'output', 'error', 'forkedFrom']);

const ENTRY_COLUMNS: Record<string, string> = {
  kind: 'kind',
  name: 'name',
  ordinal: 'ordinal',
  key: 'key',
  status: 'status',
  pausePoint: 'pause_point',
  input: 'input',
  output: 'output',
  error: 'error',
  attempts: 'attempts',
  interventions: 'interventions',
  wakeAt: 'wake_at',
  waitEvent: 'wait_event',
  waitMatch: 'wait_match',
  expiresAt: 'expires_at',
  childRunId: 'child_run_id',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};
const ENTRY_JSON_COLUMNS = new Set(['input', 'output', 'error', 'attempts', 'interventions', 'waitMatch']);

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

  createRun(run: Run): Run {
    if (run.idempotencyKey !== undefined) {
      const existing = this.findByIdempotencyKey(run.workflow, run.idempotencyKey);
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

  getRun(id: string): Run | undefined {
    const row = this.prep('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToRun(row) : undefined;
  }

  findByIdempotencyKey(workflow: string, key: string): Run | undefined {
    const row = this.prep('SELECT * FROM runs WHERE workflow = ? AND idempotency_key = ?').get(workflow, key) as
      | Row
      | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(filter?: RunFilter): Run[] {
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
    const rows = this.prep(`SELECT * FROM runs${where} ORDER BY created_at DESC LIMIT ?`).all(
      ...args,
      filter?.limit ?? 100,
    ) as Row[];
    return rows.map(rowToRun);
  }

  updateRun(id: string, patch: Patch<Run>): void {
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

  claimDue(now: number, owner: string, leaseMs: number, limit: number): Run[] {
    // Single-writer backend: SELECT then UPDATE is atomic enough here. The
    // Postgres backend replaces this with FOR UPDATE SKIP LOCKED.
    const rows = this.prep(
      `SELECT * FROM runs
       WHERE (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND (
           status = 'queued'
           OR (status IN ('suspended','paused') AND wake_at IS NOT NULL AND wake_at <= ?)
           OR status = 'running'
         )
       ORDER BY COALESCE(wake_at, created_at) ASC
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

  releaseLease(id: string): void {
    this.prep('UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?').run(id);
  }

  listJournal(runId: string): JournalEntry[] {
    const rows = this.prep('SELECT * FROM journal WHERE run_id = ? ORDER BY seq ASC').all(runId) as Row[];
    return rows.map(rowToEntry);
  }

  getEntry(runId: string, seq: number): JournalEntry | undefined {
    const row = this.prep('SELECT * FROM journal WHERE run_id = ? AND seq = ?').get(runId, seq) as Row | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  appendEntry(entry: Omit<JournalEntry, 'seq'>): JournalEntry {
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

  updateEntry(runId: string, seq: number, patch: Patch<JournalEntry>): void {
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

  addWait(wait: WaitRow): void {
    this.prep('INSERT OR REPLACE INTO waits (run_id, seq, event_name, match, expires_at) VALUES (?,?,?,?,?)').run(
      wait.runId,
      wait.seq,
      wait.eventName,
      maybeJson(wait.match),
      wait.expiresAt,
    );
  }

  removeWait(runId: string, seq: number): void {
    this.prep('DELETE FROM waits WHERE run_id = ? AND seq = ?').run(runId, seq);
  }

  findWaits(eventName: string): WaitRow[] {
    const rows = this.prep('SELECT * FROM waits WHERE event_name = ?').all(eventName) as Row[];
    return rows.map((row) => ({
      runId: row.run_id as string,
      seq: Number(row.seq),
      eventName: row.event_name as string,
      match: parseMaybe<Record<string, JsonValue>>(row.match),
      expiresAt: Number(row.expires_at),
    }));
  }

  insertEvent(event: WorkflowEvent): void {
    this.prep('INSERT INTO events (id, name, data, received_at) VALUES (?,?,?,?)').run(
      event.id,
      event.name,
      json(event.data),
      event.receivedAt,
    );
  }

  listBreakpoints(): BreakpointMatcher[] {
    const rows = this.prep('SELECT matcher FROM breakpoints').all() as Row[];
    return rows.map((row) => JSON.parse(row.matcher as string) as BreakpointMatcher);
  }

  setBreakpoint(matcher: BreakpointMatcher): void {
    this.prep('INSERT INTO breakpoints (matcher) VALUES (?)').run(json(matcher));
  }

  clearBreakpoints(): void {
    this.prep('DELETE FROM breakpoints').run();
  }

  close(): void {
    this.db.close();
  }
}
