/**
 * PgJournalStore — JournalStore on Postgres (@graphmind-ai/db), for the
 * hosted service: many workers, serverless instances that come and go, one
 * database. A faithful port of SqliteJournalStore; the shared contract suite
 * (test/store-contract.test.ts) runs against both.
 *
 * Deployment constraints this file is written for:
 *  - Supabase's transaction pooler: consecutive statements may land on
 *    different server connections, so nothing relies on session state.
 *    Every table is qualified with the quoted schema (never search_path),
 *    and multi-statement work goes through sql.tx() (one connection).
 *  - Multi-worker: claimDue is a single UPDATE over a FOR UPDATE SKIP LOCKED
 *    selection, so two workers never claim the same run; appendEntry keeps
 *    per-run seqs dense by retrying on the (run_id, seq) primary key.
 *  - Row level security is ENABLED on every table with no policies: the app
 *    connects as the table owner (which bypasses RLS), while Supabase's
 *    Data API roles see nothing.
 *
 * Column types: JSON columns are JSONB, ms timestamps BIGINT, ids TEXT.
 * JSON columns are always read back as `col::text` and parsed in JS, so SQL
 * NULL ("absent") stays distinct from a stored JSON null — node-postgres
 * would otherwise parse both to `null`. Values are written as JSON text with
 * an explicit `::jsonb` cast (node-postgres would turn a JS array into a
 * Postgres array literal). Caveat inherited from JSONB: object key order is
 * not preserved and strings may not contain U+0000. Nothing in the engine
 * depends on key order (keys and comparisons are canonical); a step output
 * containing U+0000 fails its write here where SQLite would accept it.
 *
 * Ties in list ordering are broken by an identity column `pos` (insertion
 * order), mirroring SQLite's rowid.
 */
import type { BreakpointMatcher, JournalEntry, JsonValue, Run, WorkflowEvent } from '@graphmind-ai/circuit-schema';
import { ident, migrate, type Migration, type Sql } from '@graphmind-ai/db';
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

const TABLES = ['runs', 'journal', 'waits', 'events', 'breakpoints'] as const;

/** SELECT list for runs (optionally qualified by a table alias): JSON columns as text, see the header. */
function runSelect(t = ''): string {
  const p = t === '' ? '' : `${t}.`;
  return `${p}id, ${p}workflow, ${p}status, ${p}input::text AS input, ${p}output::text AS output,
  ${p}error::text AS error, ${p}idempotency_key, ${p}parent_run_id, ${p}parent_seq,
  ${p}forked_from::text AS forked_from, ${p}wake_at, ${p}lease_owner, ${p}lease_expires_at, ${p}paused_seq,
  ${p}created_at, ${p}started_at, ${p}finished_at`;
}
const RUN_SELECT = runSelect();

const ENTRY_SELECT = `run_id, seq, kind, name, ordinal, "key", status, pause_point, input::text AS input,
  output::text AS output, error::text AS error, attempts::text AS attempts, interventions::text AS interventions,
  wake_at, wait_event, wait_match::text AS wait_match, expires_at, child_run_id, started_at, finished_at`;

/** Postgres type per non-JSON column, for explicit parameter casts in dynamic UPDATEs. */
const INT_COLUMNS = new Set(['parent_seq', 'paused_seq', 'ordinal']);
const BIGINT_COLUMNS = new Set(['wake_at', 'lease_expires_at', 'created_at', 'started_at', 'finished_at', 'expires_at']);

function cast(column: string, isJson: boolean): string {
  if (isJson) return '::jsonb';
  if (INT_COLUMNS.has(column)) return '::int';
  if (BIGINT_COLUMNS.has(column)) return '::bigint';
  return '::text';
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}

export interface PgJournalStoreOptions {
  /** Schema holding the tables (default 'graphmind'). Must exist; migrate() creates the tables. */
  schema?: string;
}

export class PgJournalStore implements JournalStore {
  /**
   * The circuit tables, as @graphmind-ai/db migrations. Ids are prefixed
   * `circuit-` because one schema is shared with the other hosted stores
   * (accounts, …) and their migration ids live in the same `_migrations`.
   * Never edit an applied migration; append a new one.
   */
  static readonly migrations: Migration[] = [
    {
      id: 'circuit-001-init',
      statements: [
        `CREATE TABLE {schema}.runs (
          id TEXT PRIMARY KEY,
          pos BIGINT GENERATED ALWAYS AS IDENTITY,
          workflow TEXT NOT NULL,
          status TEXT NOT NULL,
          input JSONB NOT NULL,
          output JSONB,
          error JSONB,
          idempotency_key TEXT,
          parent_run_id TEXT,
          parent_seq INTEGER,
          forked_from JSONB,
          wake_at BIGINT,
          lease_owner TEXT,
          lease_expires_at BIGINT,
          paused_seq INTEGER,
          created_at BIGINT NOT NULL,
          started_at BIGINT,
          finished_at BIGINT
        )`,
        `CREATE UNIQUE INDEX runs_idem ON {schema}.runs (workflow, idempotency_key) WHERE idempotency_key IS NOT NULL`,
        `CREATE INDEX runs_due ON {schema}.runs (status, wake_at)`,
        `CREATE INDEX runs_created ON {schema}.runs (created_at DESC, pos DESC)`,
        `CREATE TABLE {schema}.journal (
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          "key" TEXT NOT NULL,
          status TEXT NOT NULL,
          pause_point TEXT,
          input JSONB,
          output JSONB,
          error JSONB,
          attempts JSONB NOT NULL,
          interventions JSONB NOT NULL,
          wake_at BIGINT,
          wait_event TEXT,
          wait_match JSONB,
          expires_at BIGINT,
          child_run_id TEXT,
          started_at BIGINT NOT NULL,
          finished_at BIGINT,
          PRIMARY KEY (run_id, seq)
        )`,
        `CREATE TABLE {schema}.waits (
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          pos BIGINT GENERATED ALWAYS AS IDENTITY,
          event_name TEXT NOT NULL,
          "match" JSONB,
          expires_at BIGINT NOT NULL,
          PRIMARY KEY (run_id, seq)
        )`,
        `CREATE INDEX waits_event ON {schema}.waits (event_name, pos)`,
        `CREATE TABLE {schema}.events (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          data JSONB NOT NULL,
          received_at BIGINT NOT NULL
        )`,
        `CREATE TABLE {schema}.breakpoints (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          matcher JSONB NOT NULL
        )`,
        ...TABLES.map((t) => `ALTER TABLE {schema}.${t} ENABLE ROW LEVEL SECURITY`),
      ],
    },
  ];

  private readonly schema: string;
  private readonly runs: string;
  private readonly journal: string;
  private readonly waits: string;
  private readonly events: string;
  private readonly breakpoints: string;

  /**
   * `sql` is the caller's (usually one createSql() pool per process, shared
   * by every hosted store); close() does not end it.
   */
  constructor(
    private readonly sql: Sql,
    opts: PgJournalStoreOptions = {},
  ) {
    this.schema = opts.schema ?? 'graphmind';
    const s = ident(this.schema);
    this.runs = `${s}.runs`;
    this.journal = `${s}.journal`;
    this.waits = `${s}.waits`;
    this.events = `${s}.events`;
    this.breakpoints = `${s}.breakpoints`;
  }

  /** Create/upgrade the tables. Idempotent and safe under concurrent cold starts. Returns the ids applied now. */
  async migrate(): Promise<string[]> {
    return migrate(this.sql, this.schema, PgJournalStore.migrations);
  }

  async createRun(run: Run): Promise<Run> {
    // ON CONFLICT instead of SQLite's check-then-insert: two workers racing
    // on one idempotency key must both get the single winning run.
    const inserted = await this.sql.query(
      `INSERT INTO ${this.runs} (id, workflow, status, input, output, error, idempotency_key, parent_run_id, parent_seq,
         forked_from, wake_at, lease_owner, lease_expires_at, paused_seq, created_at, started_at, finished_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::int, $10::jsonb, $11::bigint, $12,
         $13::bigint, $14::int, $15::bigint, $16::bigint, $17::bigint)
       ON CONFLICT (workflow, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
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
      ],
    );
    if (inserted.length === 0 && run.idempotencyKey !== undefined) {
      const existing = await this.findByIdempotencyKey(run.workflow, run.idempotencyKey);
      if (existing) return existing;
    }
    return run;
  }

  async getRun(id: string): Promise<Run | undefined> {
    const [row] = await this.sql.query(`SELECT ${RUN_SELECT} FROM ${this.runs} WHERE id = $1`, [id]);
    return row ? rowToRun(row) : undefined;
  }

  async findByIdempotencyKey(workflow: string, key: string): Promise<Run | undefined> {
    const [row] = await this.sql.query(
      `SELECT ${RUN_SELECT} FROM ${this.runs} WHERE workflow = $1 AND idempotency_key = $2`,
      [workflow, key],
    );
    return row ? rowToRun(row) : undefined;
  }

  async listRuns(filter?: RunFilter): Promise<Run[]> {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter?.workflow !== undefined) {
      args.push(filter.workflow);
      clauses.push(`workflow = $${args.length}`);
    }
    if (filter?.status !== undefined) {
      args.push(filter.status);
      clauses.push(`status = $${args.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    args.push(filter?.limit ?? 100);
    const rows = await this.sql.query(
      `SELECT ${RUN_SELECT} FROM ${this.runs}${where} ORDER BY created_at DESC, pos DESC LIMIT $${args.length}::int`,
      args,
    );
    return rows.map(rowToRun);
  }

  async updateRun(id: string, patch: Patch<Run>): Promise<void> {
    const { sets, args } = buildSets(patch, RUN_COLUMNS, RUN_JSON_COLUMNS);
    if (sets.length === 0) return;
    args.push(id);
    await this.sql.query(`UPDATE ${this.runs} SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
  }

  async claimDue(now: number, owner: string, leaseMs: number, limit: number): Promise<Run[]> {
    // One statement, so it is atomic on its own (and pooler-safe). The CTE
    // is evaluated once; FOR UPDATE SKIP LOCKED makes a concurrent claimer
    // skip rows this one is taking instead of waiting for (or double-
    // claiming) them. A row another claimer committed meanwhile is
    // re-checked against the WHERE on its newest version by Postgres
    // (READ COMMITTED), so its fresh lease excludes it. Same due rules as
    // SQLite: queued; suspended/paused with a due wakeAt; and any status
    // (in practice 'running') whose lease has expired — a dead worker's run.
    const rows = await this.sql.query(
      `WITH due AS (
         SELECT id FROM ${this.runs}
         WHERE (lease_expires_at IS NULL OR lease_expires_at <= $1::bigint)
           AND (
             status = 'queued'
             OR (status IN ('suspended','paused') AND wake_at IS NOT NULL AND wake_at <= $1::bigint)
             OR status = 'running'
           )
         ORDER BY COALESCE(wake_at, created_at) ASC, pos ASC
         LIMIT $4::int
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ${this.runs} AS r SET lease_owner = $2, lease_expires_at = $3::bigint
       FROM due WHERE r.id = due.id
       RETURNING r.pos, ${runSelect('r')}`,
      [now, owner, now + leaseMs, limit],
    );
    // RETURNING has no defined order; restore the claim order.
    rows.sort((a, b) => dueKey(a) - dueKey(b) || Number(a.pos) - Number(b.pos));
    return rows.map(rowToRun);
  }

  async releaseLease(id: string): Promise<void> {
    await this.sql.query(`UPDATE ${this.runs} SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [id]);
  }

  async listJournal(runId: string): Promise<JournalEntry[]> {
    const rows = await this.sql.query(`SELECT ${ENTRY_SELECT} FROM ${this.journal} WHERE run_id = $1 ORDER BY seq ASC`, [
      runId,
    ]);
    return rows.map(rowToEntry);
  }

  async getEntry(runId: string, seq: number): Promise<JournalEntry | undefined> {
    const [row] = await this.sql.query(`SELECT ${ENTRY_SELECT} FROM ${this.journal} WHERE run_id = $1 AND seq = $2::int`, [
      runId,
      seq,
    ]);
    return row ? rowToEntry(row) : undefined;
  }

  async appendEntry(entry: Omit<JournalEntry, 'seq'>): Promise<JournalEntry> {
    // MAX(seq)+1 computed inside the INSERT; two concurrent appenders to the
    // same run compute the same seq, one hits the primary key and retries
    // with the now-larger max. Seqs stay dense and unique without locking
    // the run row (which may not exist yet in tests) and without a
    // transaction (one statement per attempt — pooler-friendly).
    const params = [
      entry.runId,
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
    ];
    for (let attempt = 0; ; attempt++) {
      try {
        const [row] = await this.sql.query<{ seq: number }>(
          `INSERT INTO ${this.journal} (run_id, seq, kind, name, ordinal, "key", status, pause_point, input, output,
             error, attempts, interventions, wake_at, wait_event, wait_match, expires_at, child_run_id, started_at,
             finished_at)
           SELECT $1::text, COALESCE(MAX(seq) + 1, 0), $2::text, $3::text, $4::int, $5::text, $6::text, $7::text,
             $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::bigint, $14::text, $15::jsonb,
             $16::bigint, $17::text, $18::bigint, $19::bigint
           FROM ${this.journal} WHERE run_id = $1::text
           RETURNING seq`,
          params,
        );
        return { ...entry, seq: Number(row!.seq) };
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= 100) throw err;
      }
    }
  }

  async updateEntry(runId: string, seq: number, patch: Patch<JournalEntry>): Promise<void> {
    const { sets, args } = buildSets(patch, ENTRY_COLUMNS, ENTRY_JSON_COLUMNS);
    if (sets.length === 0) return;
    args.push(runId, seq);
    await this.sql.query(
      `UPDATE ${this.journal} SET ${sets.join(', ')} WHERE run_id = $${args.length - 1} AND seq = $${args.length}::int`,
      args,
    );
  }

  async addWait(wait: WaitRow): Promise<void> {
    // DELETE + INSERT (not ON CONFLICT UPDATE) to match SQLite's INSERT OR
    // REPLACE exactly: a re-registered wait gets a fresh `pos` and moves to
    // the end of findWaits' order.
    await this.sql.tx(async (q) => {
      await q.query(`DELETE FROM ${this.waits} WHERE run_id = $1 AND seq = $2::int`, [wait.runId, wait.seq]);
      await q.query(
        `INSERT INTO ${this.waits} (run_id, seq, event_name, "match", expires_at) VALUES ($1, $2::int, $3, $4::jsonb, $5::bigint)`,
        [wait.runId, wait.seq, wait.eventName, maybeJson(wait.match), wait.expiresAt],
      );
    });
  }

  async removeWait(runId: string, seq: number): Promise<void> {
    await this.sql.query(`DELETE FROM ${this.waits} WHERE run_id = $1 AND seq = $2::int`, [runId, seq]);
  }

  async findWaits(eventName: string): Promise<WaitRow[]> {
    const rows = await this.sql.query(
      `SELECT run_id, seq, event_name, "match"::text AS "match", expires_at FROM ${this.waits}
       WHERE event_name = $1 ORDER BY pos ASC`,
      [eventName],
    );
    return rows.map((row) => ({
      runId: row.run_id as string,
      seq: Number(row.seq),
      eventName: row.event_name as string,
      match: parseMaybe<Record<string, JsonValue>>(row.match),
      expiresAt: Number(row.expires_at),
    }));
  }

  async insertEvent(event: WorkflowEvent): Promise<void> {
    await this.sql.query(
      `INSERT INTO ${this.events} (id, name, data, received_at) VALUES ($1, $2, $3::jsonb, $4::bigint)`,
      [event.id, event.name, json(event.data), event.receivedAt],
    );
  }

  async listBreakpoints(): Promise<BreakpointMatcher[]> {
    const rows = await this.sql.query(`SELECT matcher::text AS matcher FROM ${this.breakpoints} ORDER BY id ASC`);
    return rows.map((row) => JSON.parse(row.matcher as string) as BreakpointMatcher);
  }

  async setBreakpoint(matcher: BreakpointMatcher): Promise<void> {
    await this.sql.query(`INSERT INTO ${this.breakpoints} (matcher) VALUES ($1::jsonb)`, [json(matcher)]);
  }

  async clearBreakpoints(): Promise<void> {
    await this.sql.query(`DELETE FROM ${this.breakpoints}`);
  }

  /** No-op: the Sql pool belongs to the caller (shared across stores); end it there. */
  async close(): Promise<void> {}
}

function dueKey(row: Row): number {
  return Number(row.wake_at ?? row.created_at);
}

/**
 * SET list for a Patch: a present key with value undefined clears the
 * column (NULL) — the Patch<T> contract; absent keys are untouched.
 */
function buildSets(
  patch: object,
  columns: Record<string, string>,
  jsonFields: ReadonlySet<string>,
): { sets: string[]; args: unknown[] } {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [field, column] of Object.entries(columns)) {
    if (!(field in patch)) continue;
    const value = (patch as Record<string, unknown>)[field];
    const isJson = jsonFields.has(field);
    if (value === undefined) args.push(null);
    else if (isJson) args.push(json(value));
    else args.push(value);
    sets.push(`"${column}" = $${args.length}${cast(column, isJson)}`);
  }
  return { sets, args };
}
