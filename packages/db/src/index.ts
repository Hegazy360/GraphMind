/**
 * @graphmind-ai/db — the Postgres layer under the hosted stores.
 *
 *   createSql(url)            a pooled connection: query(), tx(), end()
 *   migrate(sql, schema, …)   idempotent, recorded migrations per schema
 *   ident(name)               quote an identifier (schema/table names)
 *   testSql()                 a fresh schema on PG_TEST_URL for one test file
 *
 * Every hosted store takes `(sql, { schema })` and qualifies its table names
 * with that schema, so nothing depends on a connection's search_path. That
 * matters behind Supabase's transaction pooler, where consecutive queries may
 * run on different server connections and session state does not carry over.
 * For the same reason only unnamed (unprepared) statements are used, which
 * is node-postgres' default for parameterized queries.
 *
 * Connection strings carry credentials: this module never logs or echoes
 * them, and error messages it creates name the operation, not the URL.
 */
import pg from 'pg';
import { SUPABASE_ROOT_CA_2021 } from './supabase-ca.js';

export type Row = Record<string, unknown>;

export interface Sql {
  /** Run one statement; returns its rows (empty for statements without RETURNING). */
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run `fn` inside BEGIN/COMMIT on a single connection; ROLLBACK if it throws. Nested calls reuse the outer transaction. */
  tx<R>(fn: (q: Sql) => Promise<R>): Promise<R>;
  /** Close the pool (no-op inside a transaction handle). */
  end(): Promise<void>;
}

export interface SqlOptions {
  /** Connections per process. Serverless instances should stay small (default 2). */
  max?: number;
  /** Idle connection lifetime in ms (default 10s, so frozen instances do not hold pooler slots). */
  idleTimeoutMs?: number;
}

// int8 (bigint) and numeric come back as strings by default; every bigint here is a
// millisecond timestamp or a counter, which fit a double exactly.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

function handle(q: Queryable, inTx: boolean, pool?: pg.Pool): Sql {
  const self: Sql = {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
      const r = await q.query(text, params as unknown[]);
      return r.rows as T[];
    },
    async tx<R>(fn: (s: Sql) => Promise<R>): Promise<R> {
      if (inTx || !pool) return fn(self);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(handle(client, true));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async end() {
      if (!inTx && pool) await pool.end();
    },
  };
  return self;
}

/**
 * Connection options for a URL. Supabase hosts get TLS verified against the
 * pinned Supabase root CA (full verification: chain and hostname). Any
 * `sslmode` in the URL is dropped for them, because node-postgres lets URL
 * parameters override the `ssl` option and would otherwise verify against
 * the system store and fail. Other hosts are passed through untouched
 * (local Postgres in tests and development, or whatever the URL asks for).
 */
export function connectionOptions(connectionString: string): pg.PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('invalid Postgres connection string'); // never echo it: it holds a password
  }
  const host = url.hostname;
  if (!/(^|\.)supabase\.(com|co)$/.test(host)) return { connectionString };
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) url.searchParams.delete(k);
  return { connectionString: url.toString(), ssl: { ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true, servername: host } };
}

/** A pooled Sql handle for `connectionString` (postgres://…). */
export function createSql(connectionString: string, opts: SqlOptions = {}): Sql {
  const pool = new pg.Pool({
    ...connectionOptions(connectionString),
    max: opts.max ?? 2,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 10_000,
    allowExitOnIdle: true,
  });
  // An idle client erroring (pooler restart) must not crash the process; the next query reconnects.
  pool.on('error', () => {});
  return handle(pool, false, pool);
}

/** Quote an identifier: ident('graphmind') → "graphmind". */
export function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid SQL identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export interface Migration {
  /** Stable, unique within the schema, e.g. 'circuit-001-init'. Never rename an applied one. */
  id: string;
  /** Statements; `{schema}` is replaced with the quoted schema name. */
  statements: readonly string[];
}

/**
 * Apply `migrations` in order to `schema`, each at most once (recorded in
 * `<schema>._migrations`). Serialized with an advisory lock so concurrent
 * cold starts or parallel builds cannot apply the same migration twice.
 * The schema must exist and be owned by (or writable for) the connecting role.
 */
export async function migrate(sql: Sql, schema: string, migrations: readonly Migration[]): Promise<string[]> {
  const s = ident(schema);
  const applied: string[] = [];
  await sql.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`graphmind-migrate:${schema}`]);
    await q.query(`CREATE TABLE IF NOT EXISTS ${s}._migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
    const done = new Set((await q.query<{ id: string }>(`SELECT id FROM ${s}._migrations`)).map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      for (const stmt of m.statements) await q.query(stmt.replaceAll('{schema}', s));
      await q.query(`INSERT INTO ${s}._migrations (id, applied_at) VALUES ($1, $2)`, [m.id, Date.now()]);
      applied.push(m.id);
    }
  });
  return applied;
}

/**
 * For tests: a fresh schema on the database at PG_TEST_URL, or null when the
 * variable is unset (the caller skips its Postgres cases). Each call creates
 * `t_<random>`; `drop()` removes it and closes the pool.
 */
export async function testSql(): Promise<{ sql: Sql; schema: string; drop: () => Promise<void> } | null> {
  const url = process.env.PG_TEST_URL;
  if (!url) return null;
  const sql = createSql(url, { max: 4 });
  const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
  await sql.query(`CREATE SCHEMA ${ident(schema)}`);
  return {
    sql,
    schema,
    drop: async () => {
      await sql.query(`DROP SCHEMA ${ident(schema)} CASCADE`).catch(() => {});
      await sql.end();
    },
  };
}

export { SUPABASE_ROOT_CA_2021 } from './supabase-ca.js';
