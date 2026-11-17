/**
 * PgAuthStore — AuthStore on Postgres (`@graphmind-ai/db`), for the hosted
 * service.
 *
 * Tenancy. Locally each project keeps its sign-in state in its own SQLite
 * file, so tenants share nothing by construction. Here all projects share one
 * set of `jack_auth_*` tables, and isolation is enforced by this class
 * instead: a handle is bound to ONE project id, every statement filters on
 * `project_id`, and every primary key / unique index starts with
 * `project_id`. A code, refresh token, client or grant of project A can
 * therefore never resolve through project B's handle — even if B somehow
 * learnt the (hashed) value — and the same random id may exist in two
 * projects without colliding.
 *
 * Every table is qualified with the quoted schema (never search_path: we run
 * behind Supabase's transaction pooler, where session state does not carry
 * over), and has row level security enabled with no policies, so the
 * Supabase Data API (anon / authenticated roles) sees nothing. The service
 * connects as the owning role, which RLS does not restrict.
 *
 * Concurrency. The single-use guarantees are enforced in the database, not
 * by read-then-write in JS: `useCode` and `rotateRefresh` are one
 * `UPDATE … WHERE used_at/rotated_at IS NULL RETURNING`, so of N concurrent
 * callers exactly one gets a row back (under READ COMMITTED the losers block
 * on the row lock, re-check the predicate and match nothing). The server
 * treats a loser as a replay and revokes the grant, as with SQLite.
 *
 * JSON columns are JSONB; timestamps are BIGINT milliseconds (parsed back to
 * numbers by @graphmind-ai/db).
 */
import { ident, migrate, type Migration, type Row, type Sql } from '@graphmind-ai/db';
import type { AuthRequestRecord, AuthStore, ClientRecord, CodeRecord, GrantRecord, RefreshRecord, SigningKeyRecord } from './store.js';

export interface PgAuthStoreOptions {
  /** The project whose rows this handle reads and writes. Required: there is no unscoped handle. */
  projectId: string;
  /** Schema holding the tables (default 'graphmind', shared with Circuit's and Jack's tables). */
  schema?: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: 'jack-auth-001-init',
    statements: [
      `CREATE TABLE {schema}.jack_auth_clients (
        project_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        last_used_at BIGINT NOT NULL,
        PRIMARY KEY (project_id, client_id)
      )`,
      `CREATE INDEX jack_auth_clients_created ON {schema}.jack_auth_clients (project_id, created_at)`,
      `CREATE TABLE {schema}.jack_auth_requests (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        state TEXT,
        scopes JSONB NOT NULL,
        resource TEXT NOT NULL,
        browser_hash TEXT NOT NULL,
        data JSONB NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (project_id, id)
      )`,
      `CREATE INDEX jack_auth_requests_expiry ON {schema}.jack_auth_requests (project_id, expires_at)`,
      `CREATE TABLE {schema}.jack_auth_codes (
        project_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        used_at BIGINT,
        PRIMARY KEY (project_id, code_hash)
      )`,
      `CREATE INDEX jack_auth_codes_expiry ON {schema}.jack_auth_codes (project_id, expires_at)`,
      // seq breaks created_at ties in insertion order, as SQLite's rowid does.
      `CREATE TABLE {schema}.jack_auth_grants (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        seq BIGSERIAL NOT NULL,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        display TEXT NOT NULL,
        scopes JSONB NOT NULL,
        resource TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        revoked_at BIGINT,
        PRIMARY KEY (project_id, id)
      )`,
      `CREATE INDEX jack_auth_grants_created ON {schema}.jack_auth_grants (project_id, created_at, seq)`,
      `CREATE TABLE {schema}.jack_auth_refresh_tokens (
        project_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        rotated_at BIGINT,
        PRIMARY KEY (project_id, token_hash)
      )`,
      `CREATE INDEX jack_auth_refresh_expiry ON {schema}.jack_auth_refresh_tokens (project_id, expires_at)`,
      `CREATE TABLE {schema}.jack_auth_upstream (
        project_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        sealed TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (project_id, grant_id)
      )`,
      `CREATE TABLE {schema}.jack_auth_signing_keys (
        project_id TEXT NOT NULL,
        kid TEXT NOT NULL,
        seq BIGSERIAL NOT NULL,
        public_jwk JSONB NOT NULL,
        sealed_private_jwk TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (project_id, kid)
      )`,
      ...['clients', 'requests', 'codes', 'grants', 'refresh_tokens', 'upstream', 'signing_keys'].map(
        (t) => `ALTER TABLE {schema}.jack_auth_${t} ENABLE ROW LEVEL SECURITY`,
      ),
    ],
  },
];

const json = (v: unknown) => JSON.stringify(v);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export class PgAuthStore implements AuthStore {
  /** Apply with `migrate(sql, schema, PgAuthStore.migrations)` or `PgAuthStore.migrate(sql)`; ids are prefixed `jack-auth-`. */
  static readonly migrations = MIGRATIONS;

  /** Create or upgrade the tables in `schema` (idempotent; safe under concurrent cold starts). */
  static migrate(sql: Sql, schema = 'graphmind'): Promise<string[]> {
    return migrate(sql, schema, MIGRATIONS);
  }

  /** A handle scoped to `projectId`. Cheap (no I/O): build one per request if convenient. */
  static forProject(sql: Sql, projectId: string, opts: { schema?: string } = {}): PgAuthStore {
    return new PgAuthStore(sql, { ...opts, projectId });
  }

  readonly schema: string;
  readonly projectId: string;
  private readonly t: (name: string) => string;

  constructor(
    private readonly sql: Sql,
    opts: PgAuthStoreOptions,
  ) {
    if (!opts.projectId) throw new Error('PgAuthStore needs a projectId');
    this.schema = opts.schema ?? 'graphmind';
    this.projectId = opts.projectId;
    const s = ident(this.schema);
    this.t = (name) => `${s}.jack_auth_${name}`;
  }

  /** Same as the static form, for this handle's schema. */
  migrate(): Promise<string[]> {
    return PgAuthStore.migrate(this.sql, this.schema);
  }

  /** $1 is always the project id; callers' parameters start at $2. */
  private q<T extends Row = Row>(text: string, params: readonly unknown[] = [], on: Sql = this.sql) {
    return on.query<T>(text, [this.projectId, ...params]);
  }
  private async one(text: string, params: readonly unknown[] = []): Promise<Row | null> {
    return (await this.q(text, params))[0] ?? null;
  }

  async putClient(c: ClientRecord) {
    await this.q(`INSERT INTO ${this.t('clients')} (project_id, client_id, kind, metadata, created_at, last_used_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`, [
      c.clientId,
      c.kind,
      json(c.metadata),
      c.createdAt,
      c.lastUsedAt,
    ]);
  }
  async getClient(id: string): Promise<ClientRecord | null> {
    const r = await this.one(`SELECT * FROM ${this.t('clients')} WHERE project_id = $1 AND client_id = $2`, [id]);
    return r
      ? { clientId: String(r.client_id), kind: 'dcr', metadata: r.metadata as Record<string, unknown>, createdAt: Number(r.created_at), lastUsedAt: Number(r.last_used_at) }
      : null;
  }
  async touchClient(id: string, at: number) {
    await this.q(`UPDATE ${this.t('clients')} SET last_used_at = $3 WHERE project_id = $1 AND client_id = $2`, [id, at]);
  }
  async countClientsSince(since: number) {
    const r = await this.one(`SELECT COUNT(*)::int AS n FROM ${this.t('clients')} WHERE project_id = $1 AND created_at >= $2`, [since]);
    return Number(r?.n ?? 0);
  }

  async putAuthRequest(r: AuthRequestRecord) {
    await this.q(
      `INSERT INTO ${this.t('requests')} (project_id, id, client_id, redirect_uri, code_challenge, state, scopes, resource, browser_hash, data, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11)`,
      [r.id, r.clientId, r.redirectUri, r.codeChallenge, r.state, json(r.scopes), r.resource, r.browserHash, json(r.data), r.expiresAt],
    );
  }
  async getAuthRequest(id: string): Promise<AuthRequestRecord | null> {
    const r = await this.one(`SELECT * FROM ${this.t('requests')} WHERE project_id = $1 AND id = $2`, [id]);
    if (!r) return null;
    return {
      id: String(r.id),
      clientId: String(r.client_id),
      redirectUri: String(r.redirect_uri),
      codeChallenge: String(r.code_challenge),
      state: r.state === null ? null : String(r.state),
      scopes: r.scopes as string[],
      resource: String(r.resource),
      browserHash: String(r.browser_hash),
      data: r.data as Record<string, unknown>,
      expiresAt: Number(r.expires_at),
    };
  }
  async updateAuthRequest(id: string, data: Record<string, unknown>) {
    await this.q(`UPDATE ${this.t('requests')} SET data = $3::jsonb WHERE project_id = $1 AND id = $2`, [id, json(data)]);
  }
  async deleteAuthRequest(id: string) {
    await this.q(`DELETE FROM ${this.t('requests')} WHERE project_id = $1 AND id = $2`, [id]);
  }

  async putCode(c: CodeRecord) {
    await this.q(
      `INSERT INTO ${this.t('codes')} (project_id, code_hash, grant_id, client_id, redirect_uri, code_challenge, resource, expires_at, used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)`,
      [c.codeHash, c.grantId, c.clientId, c.redirectUri, c.codeChallenge, c.resource, c.expiresAt],
    );
  }
  async getCode(hash: string): Promise<CodeRecord | null> {
    const r = await this.one(`SELECT * FROM ${this.t('codes')} WHERE project_id = $1 AND code_hash = $2`, [hash]);
    if (!r) return null;
    return {
      codeHash: String(r.code_hash),
      grantId: String(r.grant_id),
      clientId: String(r.client_id),
      redirectUri: String(r.redirect_uri),
      codeChallenge: String(r.code_challenge),
      resource: String(r.resource),
      expiresAt: Number(r.expires_at),
      usedAt: num(r.used_at),
    };
  }
  /** One conditional UPDATE: exactly one concurrent caller sees a row come back. */
  async useCode(hash: string, at: number) {
    const rows = await this.q(`UPDATE ${this.t('codes')} SET used_at = $3 WHERE project_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING code_hash`, [hash, at]);
    return rows.length > 0;
  }

  async putGrant(g: GrantRecord) {
    await this.q(
      `INSERT INTO ${this.t('grants')} (project_id, id, client_id, subject, display, scopes, resource, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [g.id, g.clientId, g.subject, g.display, json(g.scopes), g.resource, g.createdAt, g.revokedAt],
    );
  }
  private toGrant(r: Row): GrantRecord {
    return {
      id: String(r.id),
      clientId: String(r.client_id),
      subject: String(r.subject),
      display: String(r.display),
      scopes: r.scopes as string[],
      resource: String(r.resource),
      createdAt: Number(r.created_at),
      revokedAt: num(r.revoked_at),
    };
  }
  async getGrant(id: string) {
    const r = await this.one(`SELECT * FROM ${this.t('grants')} WHERE project_id = $1 AND id = $2`, [id]);
    return r ? this.toGrant(r) : null;
  }
  async listGrants() {
    return (await this.q(`SELECT * FROM ${this.t('grants')} WHERE project_id = $1 ORDER BY created_at, seq`)).map((r) => this.toGrant(r));
  }
  /** Revocation and dropping the upstream credential commit together. */
  async revokeGrant(id: string, at: number) {
    await this.sql.tx(async (tx) => {
      await this.q(`UPDATE ${this.t('grants')} SET revoked_at = COALESCE(revoked_at, $3) WHERE project_id = $1 AND id = $2`, [id, at], tx);
      await this.q(`DELETE FROM ${this.t('upstream')} WHERE project_id = $1 AND grant_id = $2`, [id], tx);
    });
  }

  async putRefresh(r: RefreshRecord) {
    await this.q(`INSERT INTO ${this.t('refresh_tokens')} (project_id, token_hash, grant_id, expires_at, rotated_at) VALUES ($1, $2, $3, $4, NULL)`, [
      r.tokenHash,
      r.grantId,
      r.expiresAt,
    ]);
  }
  async getRefresh(hash: string): Promise<RefreshRecord | null> {
    const r = await this.one(`SELECT * FROM ${this.t('refresh_tokens')} WHERE project_id = $1 AND token_hash = $2`, [hash]);
    return r ? { tokenHash: String(r.token_hash), grantId: String(r.grant_id), expiresAt: Number(r.expires_at), rotatedAt: num(r.rotated_at) } : null;
  }
  /** As useCode: the database decides the single winner. */
  async rotateRefresh(hash: string, at: number) {
    const rows = await this.q(
      `UPDATE ${this.t('refresh_tokens')} SET rotated_at = $3 WHERE project_id = $1 AND token_hash = $2 AND rotated_at IS NULL RETURNING token_hash`,
      [hash, at],
    );
    return rows.length > 0;
  }

  async putUpstream(grantId: string, sealed: string, at: number) {
    await this.q(
      `INSERT INTO ${this.t('upstream')} (project_id, grant_id, sealed, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, grant_id) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = EXCLUDED.updated_at`,
      [grantId, sealed, at],
    );
  }
  async getUpstream(grantId: string) {
    const r = await this.one(`SELECT sealed FROM ${this.t('upstream')} WHERE project_id = $1 AND grant_id = $2`, [grantId]);
    return r ? String(r.sealed) : null;
  }

  async putSigningKey(k: SigningKeyRecord) {
    await this.q(`INSERT INTO ${this.t('signing_keys')} (project_id, kid, public_jwk, sealed_private_jwk, created_at) VALUES ($1, $2, $3::jsonb, $4, $5)`, [
      k.kid,
      json(k.publicJwk),
      k.sealedPrivateJwk,
      k.createdAt,
    ]);
  }
  async listSigningKeys(): Promise<SigningKeyRecord[]> {
    return (await this.q(`SELECT * FROM ${this.t('signing_keys')} WHERE project_id = $1 ORDER BY created_at DESC, seq DESC`)).map((r) => ({
      kid: String(r.kid),
      publicJwk: r.public_jwk as Record<string, unknown>,
      sealedPrivateJwk: String(r.sealed_private_jwk),
      createdAt: Number(r.created_at),
    }));
  }

  /** This project's expired rows only (other projects sweep on their own traffic). */
  async sweep(now: number) {
    await this.q(`DELETE FROM ${this.t('requests')} WHERE project_id = $1 AND expires_at < $2`, [now]);
    // Keep used codes a little past expiry so a late replay is still recognised (and revokes).
    await this.q(`DELETE FROM ${this.t('codes')} WHERE project_id = $1 AND expires_at < $2`, [now - 3_600_000]);
    await this.q(`DELETE FROM ${this.t('refresh_tokens')} WHERE project_id = $1 AND expires_at < $2`, [now]);
  }

  /** Delete every row of this project, atomically (project deletion). */
  async purge() {
    await this.sql.tx(async (tx) => {
      for (const t of ['clients', 'requests', 'codes', 'grants', 'refresh_tokens', 'upstream', 'signing_keys']) {
        await this.q(`DELETE FROM ${this.t(t)} WHERE project_id = $1`, [], tx);
      }
    });
  }

  /** No-op: the Sql pool is shared across projects and owned by whoever created it. */
  async close() {}
}
