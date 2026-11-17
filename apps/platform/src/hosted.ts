/**
 * The hosted platform: graphmind.ai on Vercel, built from environment variables.
 *
 *   production (POSTGRES_URL set)  Supabase Postgres for Circuit, Jack and Jack's sign-in;
 *                                  Supabase Auth for accounts (createSupabaseAccounts)
 *   preview / local (no POSTGRES_URL)
 *                                  SQLite in the instance's temp directory and the in-house
 *                                  accounts: enough to review a change end to end, and it
 *                                  never touches production data. State is lost when the
 *                                  instance goes away, by design.
 *
 * The hub is at /app, Jack's MCP servers at /p/<slug>/mcp, the engine tick at
 * /api/internal/tick. The homepage, /docs and /try are static files served by
 * the CDN in front (see scripts/build-vercel.mjs); this app never sees them.
 *
 * The Circuit engine has no resident loop here. Work is drained:
 *   - right after a request that created work (Circuit's onWork hook), inside
 *     waitUntil so the response is not delayed;
 *   - by the tick, which Supabase pg_cron calls every minute (sql/engine-tick.sql)
 *     for timers nobody is waiting on, and which a drain calls itself while work
 *     remains, so a long backlog advances across invocations.
 * Leases in the journal make concurrent drains on many instances safe.
 *
 * Secrets are read from the environment and passed to the components that use
 * them; nothing here logs or returns a value. A missing required variable fails
 * the boot naming the variable only.
 */
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { createAccounts, createSupabaseAccounts, SqliteAccountStore, accountsMigrations, type Accounts } from '@graphmind-ai/accounts';
import { createSql, ident, migrate, type Sql } from '@graphmind-ai/db';
import { Executor, PgJournalStore, SqliteJournalStore, type JournalStore } from '@graphmind-ai/circuit-engine';
import { isWorkflowDefinition } from '@graphmind-ai/circuit-cli';
import { McpConnections, type McpConfig, type PinStore } from '@graphmind-ai/circuit-mcp';
import { PgAuthStore } from '@graphmind-ai/jack-auth';
import { createApi as createCircuit } from 'circuit-api';
import { createJack, PgJackStore, SqliteStore as SqliteJackStore, type JackStore } from 'jack-api';
import * as onboarding from 'circuit-onboarding/workflows.mjs';
import { createBillingServer } from 'circuit-onboarding/billing-server.mjs';
import { createPlatform } from './index.js';
import { redact } from './redact.js';

export const HUB_PATH = '/app';
/**
 * Drain budgets, kept well under the function's maxDuration (60s on Vercel Hobby,
 * see scripts/build-vercel.mjs): the budget is checked between runs, so one long
 * invocation can overrun it. Work left over is handed to a fresh invocation.
 */
const AFTER_REQUEST_BUDGET_MS = 20_000;
const TICK_BUDGET_MS = 45_000;
const SCHEMA = 'graphmind';

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const required = (env: Env, name: string): string => {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`missing environment variable ${name}`);
  return v;
};

/** The origin browsers use: PUBLIC_ORIGIN in production, the deployment URL on previews. */
export function publicOriginFrom(env: Env): string {
  const explicit = env.PUBLIC_ORIGIN?.trim();
  if (explicit) return new URL(explicit).origin;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return 'http://127.0.0.1:4800';
}

/** Jack's sealing key: 32 bytes, base64. Every instance must share it, or one cannot read what another sealed. */
function jackKey(env: Env, hosted: boolean): Uint8Array {
  const raw = env.JACK_SECRET_KEY?.trim();
  if (!raw) {
    if (hosted) throw new ConfigError('missing environment variable JACK_SECRET_KEY');
    return randomBytes(32); // preview: one instance, throwaway state
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new ConfigError('JACK_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return key;
}

/** MCP tool pins in Postgres, so every instance agrees on what each tool looked like when first seen. */
class PgPinStore implements PinStore {
  private readonly table: string;
  constructor(
    private readonly sql: Sql,
    schema: string,
  ) {
    this.table = `${ident(schema)}.circuit_mcp_pins`;
  }
  async get(connection: string, tool: string) {
    const [row] = await this.sql.query<{ hash: string }>(`SELECT hash FROM ${this.table} WHERE connection = $1 AND tool = $2`, [connection, tool]);
    return row?.hash;
  }
  async set(connection: string, tool: string, hash: string) {
    await this.sql.query(
      `INSERT INTO ${this.table} (connection, tool, hash, pinned_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (connection, tool) DO UPDATE SET hash = EXCLUDED.hash, pinned_at = EXCLUDED.pinned_at`,
      [connection, tool, hash, Date.now()],
    );
  }
}

const platformMigrations = [
  {
    id: 'platform-001-mcp-pins',
    statements: [
      `CREATE TABLE IF NOT EXISTS {schema}.circuit_mcp_pins (
        connection TEXT NOT NULL,
        tool TEXT NOT NULL,
        hash TEXT NOT NULL,
        pinned_at BIGINT NOT NULL,
        PRIMARY KEY (connection, tool)
      )`,
      'ALTER TABLE {schema}.circuit_mcp_pins ENABLE ROW LEVEL SECURITY',
    ],
  },
];

/**
 * Apply every hosted migration (accounts, Circuit, Jack, Jack sign-in, the
 * platform's own), in that order. Run by the build with the session-pooler URL.
 */
export async function migrateAll(url: string, schema = SCHEMA): Promise<string[]> {
  const sql = createSql(url, { max: 1 });
  try {
    return [
      ...(await migrate(sql, schema, accountsMigrations)),
      ...(await new PgJournalStore(sql, { schema }).migrate()),
      ...(await new PgJackStore(sql, { schema }).migrate()),
      ...(await PgAuthStore.migrate(sql, schema)),
      ...(await migrate(sql, schema, platformMigrations)),
    ];
  } finally {
    await sql.end();
  }
}

/** The onboarding example's workflows: what every account's Circuit shows today. */
const WORKFLOWS = Object.values(onboarding).filter(isWorkflowDefinition);
const MCP_CONFIG = {
  connections: {
    // The example's billing server, in-process: no child process on a serverless function.
    billing: { transport: 'inprocess', server: 'billing', policy: { refund: 'approve' } },
  },
} as unknown as McpConfig;

export interface HostedOptions {
  env?: Env;
  /** Vercel's waitUntil; work handed to it continues after the response. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** For tests: replaces global fetch for the engine's self-kick and Supabase calls. */
  fetch?: typeof fetch;
}

export interface Hosted {
  app: Hono;
  mode: 'postgres' | 'preview';
  close(): Promise<void>;
}

export async function createHostedPlatform(opts: HostedOptions = {}): Promise<Hosted> {
  const env = opts.env ?? process.env;
  const waitUntil = opts.waitUntil ?? ((p: Promise<unknown>) => void p.catch(() => {}));
  const fetchImpl = opts.fetch ?? fetch;
  const publicOrigin = publicOriginFrom(env);
  const allowSignup = env.ACCOUNTS_ALLOW_SIGNUP?.trim().toLowerCase() !== 'false';
  const pgUrl = env.POSTGRES_URL?.trim();
  const hosted = pgUrl !== undefined && pgUrl !== '';

  let sql: Sql | null = null;
  let accounts: Accounts;
  let journal: JournalStore;
  let jackStore: JackStore;
  let pins: PinStore | undefined;
  const closers: (() => unknown)[] = [];

  if (hosted) {
    sql = createSql(pgUrl, { max: 3 });
    accounts = createSupabaseAccounts({
      supabaseUrl: required(env, 'SUPABASE_URL'),
      publishableKey: required(env, 'SUPABASE_PUBLISHABLE_KEY'),
      ...(env.SUPABASE_SECRET_KEY?.trim() ? { secretKey: env.SUPABASE_SECRET_KEY.trim() } : {}),
      sql,
      schema: SCHEMA,
      publicOrigin,
      hubPath: HUB_PATH,
      allowSignup,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    journal = new PgJournalStore(sql, { schema: SCHEMA });
    jackStore = new PgJackStore(sql, { schema: SCHEMA });
    pins = new PgPinStore(sql, SCHEMA);
  } else {
    const dir = join(tmpdir(), 'graphmind-preview');
    mkdirSync(dir, { recursive: true });
    const accountStore = new SqliteAccountStore(join(dir, 'accounts.db'));
    closers.push(() => accountStore.close());
    accounts = createAccounts({ store: accountStore, publicOrigin, allowSignup });
    journal = new SqliteJournalStore(join(dir, 'circuit.db'));
    jackStore = new SqliteJackStore(join(dir, 'jack.db'));
  }

  // Circuit.
  const mcp = new McpConnections(MCP_CONFIG, pins, { inprocess: { billing: () => createBillingServer() } });
  const executor = new Executor({ store: journal, workflows: WORKFLOWS, mcp });
  const internalToken = env.CRON_SECRET?.trim() ?? '';
  if (hosted && !internalToken) throw new ConfigError('missing environment variable CRON_SECRET');

  /** Ask a fresh invocation to keep draining (self-kick), authenticated like the cron. */
  const kickTick = () => {
    if (!internalToken) return;
    waitUntil(
      fetchImpl(`${publicOrigin}/api/internal/tick`, { method: 'POST', headers: { authorization: `Bearer ${internalToken}` } })
        .then((r) => r.body?.cancel())
        .catch(() => {}),
    );
  };

  let draining: Promise<void> | null = null;
  /** Drain within a budget; if work remains, hand the rest to a new invocation. One drain per instance at a time. */
  const drain = (budgetMs: number): Promise<void> => {
    draining ??= executor
      .drain({ budgetMs })
      .then((r) => {
        if (r.more) kickTick();
      })
      .catch((err) => console.error('[platform] engine drain failed:', err instanceof Error ? redact(err.message) : 'error'))
      .finally(() => {
        draining = null;
      });
    return draining;
  };

  const circuit = createCircuit({ executor, store: journal, workflows: () => WORKFLOWS, onWork: () => waitUntil(drain(AFTER_REQUEST_BUDGET_MS)), accounts });

  // Jack.
  const jack = createJack({
    store: jackStore,
    accounts,
    publicOrigin,
    secretKey: jackKey(env, hosted),
    egress: 'public',
    dashboardPath: `${HUB_PATH}/jack/`,
    waitUntil,
    ...(sql ? { authStoreFor: (projectId: string) => PgAuthStore.forProject(sql!, projectId, { schema: SCHEMA }) } : { dataDir: join(tmpdir(), 'graphmind-preview', 'jack') }),
  });

  const app = createPlatform({
    accounts,
    circuit,
    jack,
    hubPath: HUB_PATH,
    extend: (root) => {
      // The engine tick: pg_cron every minute, and drains handing over their remainder.
      root.post('/api/internal/tick', (c) => {
        const header = c.req.header('authorization') ?? '';
        const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
        const want = Buffer.from(internalToken);
        if (!internalToken || given.length !== want.length || !timingSafeEqual(given, want)) {
          return c.json({ error: 'unauthorized' }, 401);
        }
        // Answer at once (pg_net waits 10s at most); the drain continues in waitUntil.
        waitUntil(drain(TICK_BUDGET_MS));
        return c.json({ ok: true }, 202);
      });
    },
  });

  return {
    app,
    mode: hosted ? 'postgres' : 'preview',
    close: async () => {
      await draining;
      await jack.close();
      await journal.close();
      await jackStore.close();
      for (const c of closers) await c();
      await sql?.end();
    },
  };
}
