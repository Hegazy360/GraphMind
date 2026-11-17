/**
 * PgJackStore — JackStore on Postgres (`@graphmind-ai/db`), for the hosted
 * service. Same contract and semantics as SqliteStore; differences are only
 * where Postgres can do better under concurrency:
 *
 *   - slug uniqueness is the UNIQUE constraint itself (the INSERT fails with
 *     23505 → SlugTakenError), not a read-then-insert race;
 *   - the next deployment version is assigned while holding the project
 *     row's lock (`SELECT … FOR UPDATE`), so two concurrent deploys get
 *     consecutive versions instead of one failing on UNIQUE (project, version);
 *   - updateProject is read-modify-write under the same lock, so concurrent
 *     patches to different fields do not lose each other.
 *
 * Every table is `jack_*` and qualified with the quoted schema (default
 * 'graphmind', shared with Circuit's tables); nothing relies on search_path,
 * which does not survive Supabase's transaction pooler. Row level security
 * is enabled on every table with no policies, so the Supabase Data API sees
 * nothing; the service connects as the owning role.
 *
 * JSON is JSONB, timestamps BIGINT milliseconds. Note that JSONB does not
 * keep object key order; every JSON value read back goes through its zod
 * schema (as with SQLite), which restores field order for fixed shapes.
 * Secrets arrive already sealed (SecretBox); this file never sees plaintext.
 */
import { randomUUID } from 'node:crypto';
import { ident, migrate, type Migration, type Row, type Sql } from '@graphmind-ai/db';
import { authConfig, jackConfig, manifest as manifestSchema, type JackConfig, type Project } from '@graphmind-ai/jack-schema';
import {
  NotFoundError,
  SlugTakenError,
  type CallRow,
  type JackStore,
  type NewDeployment,
  type NewProject,
  type OwnedProject,
  type SecretInfo,
  type SourceRecord,
  type StoredDeployment,
} from './store.js';

export interface PgJackStoreOptions {
  /** Schema holding the tables (default 'graphmind'). */
  schema?: string;
  now?: () => number;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: 'jack-001-init',
    statements: [
      `CREATE TABLE {schema}.jack_projects (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        upstream TEXT NOT NULL,
        auth JSONB NOT NULL,
        active_version INTEGER,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        CONSTRAINT jack_projects_slug_key UNIQUE (slug)
      )`,
      `CREATE INDEX jack_projects_owner ON {schema}.jack_projects (owner_id, created_at, slug)`,
      `CREATE TABLE {schema}.jack_deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES {schema}.jack_projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        manifest JSONB NOT NULL,
        manifest_hash TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        config JSONB,
        message TEXT,
        UNIQUE (project_id, version)
      )`,
      `CREATE TABLE {schema}.jack_sources (
        project_id TEXT PRIMARY KEY REFERENCES {schema}.jack_projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        url TEXT,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE {schema}.jack_drafts (
        project_id TEXT PRIMARY KEY REFERENCES {schema}.jack_projects(id) ON DELETE CASCADE,
        config JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE {schema}.jack_secrets (
        project_id TEXT NOT NULL REFERENCES {schema}.jack_projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sealed TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (project_id, name)
      )`,
      `CREATE TABLE {schema}.jack_calls (
        id BIGSERIAL PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES {schema}.jack_projects(id) ON DELETE CASCADE,
        version INTEGER,
        tool TEXT NOT NULL,
        status TEXT NOT NULL,
        upstream_status INTEGER,
        ms INTEGER NOT NULL,
        request_bytes INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        subject TEXT,
        client_id TEXT,
        at BIGINT NOT NULL
      )`,
      `CREATE INDEX jack_calls_by_project ON {schema}.jack_calls (project_id, id DESC)`,
      ...['projects', 'deployments', 'sources', 'drafts', 'secrets', 'calls'].map((t) => `ALTER TABLE {schema}.jack_${t} ENABLE ROW LEVEL SECURITY`),
    ],
  },
];

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const rowToProject = (r: Row): OwnedProject => ({
  id: String(r.id),
  ownerId: str(r.owner_id),
  slug: String(r.slug),
  name: String(r.name),
  upstream: String(r.upstream),
  auth: authConfig.parse(r.auth),
  activeVersion: num(r.active_version),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const rowToDeployment = (r: Row): StoredDeployment => ({
  id: String(r.id),
  projectId: String(r.project_id),
  version: Number(r.version),
  manifest: manifestSchema.parse(r.manifest),
  manifestHash: String(r.manifest_hash),
  createdBy: String(r.created_by),
  createdAt: Number(r.created_at),
  config: r.config ? jackConfig.parse(r.config) : null,
  message: str(r.message),
});

const rowToCall = (r: Row): CallRow => ({
  id: Number(r.id),
  projectId: String(r.project_id),
  version: num(r.version),
  tool: String(r.tool),
  status: String(r.status),
  upstreamStatus: num(r.upstream_status),
  ms: Number(r.ms),
  requestBytes: Number(r.request_bytes),
  responseBytes: Number(r.response_bytes),
  subject: str(r.subject),
  clientId: str(r.client_id),
  at: Number(r.at),
});

const isUniqueViolation = (err: unknown, constraint: string) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505' && (err as { constraint?: unknown }).constraint === constraint;

export class PgJackStore implements JackStore {
  /** Apply with `migrate(sql, schema, PgJackStore.migrations)` or `store.migrate()`; ids are prefixed `jack-`. */
  static readonly migrations = MIGRATIONS;

  readonly schema: string;
  private readonly now: () => number;
  private readonly t: (name: string) => string;

  constructor(
    private readonly sql: Sql,
    opts: PgJackStoreOptions = {},
  ) {
    this.schema = opts.schema ?? 'graphmind';
    this.now = opts.now ?? (() => Date.now());
    const s = ident(this.schema);
    this.t = (name) => `${s}.jack_${name}`;
  }

  /** Create or upgrade the tables (idempotent; serialized across concurrent cold starts). */
  migrate(): Promise<string[]> {
    return migrate(this.sql, this.schema, MIGRATIONS);
  }

  private async one(text: string, params: readonly unknown[], on: Sql = this.sql): Promise<Row | null> {
    return (await on.query(text, params))[0] ?? null;
  }

  async createProject(p: NewProject): Promise<OwnedProject> {
    const t = this.now();
    const id = `prj_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    try {
      const r = await this.one(
        `INSERT INTO ${this.t('projects')} (id, owner_id, slug, name, upstream, auth, active_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, $7, $7) RETURNING *`,
        [id, p.ownerId ?? null, p.slug, p.name, p.upstream, JSON.stringify(p.auth), t],
      );
      return rowToProject(r as Row);
    } catch (err) {
      if (isUniqueViolation(err, 'jack_projects_slug_key')) throw new SlugTakenError(p.slug);
      throw err;
    }
  }

  async getProject(id: string): Promise<OwnedProject | null> {
    const r = await this.one(`SELECT * FROM ${this.t('projects')} WHERE id = $1`, [id]);
    return r ? rowToProject(r) : null;
  }

  async getProjectBySlug(slug: string): Promise<OwnedProject | null> {
    const r = await this.one(`SELECT * FROM ${this.t('projects')} WHERE slug = $1`, [slug]);
    return r ? rowToProject(r) : null;
  }

  async listProjects(ownerId?: string): Promise<OwnedProject[]> {
    const rows =
      ownerId === undefined
        ? await this.sql.query(`SELECT * FROM ${this.t('projects')} ORDER BY created_at, slug COLLATE "C"`)
        : await this.sql.query(`SELECT * FROM ${this.t('projects')} WHERE owner_id = $1 ORDER BY created_at, slug COLLATE "C"`, [ownerId]);
    return rows.map(rowToProject);
  }

  async updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'upstream' | 'auth' | 'activeVersion'>>): Promise<OwnedProject> {
    return this.sql.tx(async (tx) => {
      const r = await this.one(`SELECT * FROM ${this.t('projects')} WHERE id = $1 FOR UPDATE`, [id], tx);
      if (!r) throw new NotFoundError(`project ${id}`);
      const next = { ...rowToProject(r), ...patch, updatedAt: this.now() };
      await tx.query(`UPDATE ${this.t('projects')} SET name = $2, upstream = $3, auth = $4::jsonb, active_version = $5, updated_at = $6 WHERE id = $1`, [
        id,
        next.name,
        next.upstream,
        JSON.stringify(next.auth),
        next.activeVersion,
        next.updatedAt,
      ]);
      return next;
    });
  }

  async deleteProject(id: string): Promise<boolean> {
    return (await this.sql.query(`DELETE FROM ${this.t('projects')} WHERE id = $1 RETURNING id`, [id])).length > 0;
  }

  async getSource(projectId: string): Promise<SourceRecord | null> {
    const r = await this.one(`SELECT * FROM ${this.t('sources')} WHERE project_id = $1`, [projectId]);
    return r ? { text: String(r.text), url: str(r.url), updatedAt: Number(r.updated_at) } : null;
  }

  async putSource(projectId: string, s: Omit<SourceRecord, 'updatedAt'>): Promise<void> {
    await this.sql.query(
      `INSERT INTO ${this.t('sources')} (project_id, text, url, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id) DO UPDATE SET text = EXCLUDED.text, url = EXCLUDED.url, updated_at = EXCLUDED.updated_at`,
      [projectId, s.text, s.url, this.now()],
    );
  }

  async getDraft(projectId: string): Promise<{ config: JackConfig; updatedAt: number } | null> {
    const r = await this.one(`SELECT * FROM ${this.t('drafts')} WHERE project_id = $1`, [projectId]);
    return r ? { config: jackConfig.parse(r.config), updatedAt: Number(r.updated_at) } : null;
  }

  async putDraft(projectId: string, config: JackConfig): Promise<void> {
    await this.sql.query(
      `INSERT INTO ${this.t('drafts')} (project_id, config, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (project_id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`,
      [projectId, JSON.stringify(config), this.now()],
    );
  }

  async createDeployment(d: NewDeployment): Promise<StoredDeployment> {
    return this.sql.tx(async (tx) => {
      // The project row lock serializes version assignment per project.
      if (!(await this.one(`SELECT id FROM ${this.t('projects')} WHERE id = $1 FOR UPDATE`, [d.projectId], tx))) throw new NotFoundError(`project ${d.projectId}`);
      const id = `dep_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      const r = await this.one(
        `INSERT INTO ${this.t('deployments')} (id, project_id, version, manifest, manifest_hash, created_by, created_at, config, message)
         SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3::jsonb, $4, $5, $6, $7::jsonb, $8 FROM ${this.t('deployments')} WHERE project_id = $2
         RETURNING *`,
        [id, d.projectId, JSON.stringify(d.manifest), d.manifestHash, d.createdBy, this.now(), d.config ? JSON.stringify(d.config) : null, d.message ?? null],
        tx,
      );
      return rowToDeployment(r as Row);
    });
  }

  async getDeployment(projectId: string, version: number): Promise<StoredDeployment | null> {
    const r = await this.one(`SELECT * FROM ${this.t('deployments')} WHERE project_id = $1 AND version = $2`, [projectId, version]);
    return r ? rowToDeployment(r) : null;
  }

  async listDeployments(projectId: string): Promise<StoredDeployment[]> {
    return (await this.sql.query(`SELECT * FROM ${this.t('deployments')} WHERE project_id = $1 ORDER BY version DESC`, [projectId])).map(rowToDeployment);
  }

  /** One round trip: this runs on every data-plane request. */
  async activeDeployment(projectId: string): Promise<StoredDeployment | null> {
    const r = await this.one(
      `SELECT d.* FROM ${this.t('projects')} p JOIN ${this.t('deployments')} d ON d.project_id = p.id AND d.version = p.active_version WHERE p.id = $1`,
      [projectId],
    );
    return r ? rowToDeployment(r) : null;
  }

  async putSecret(projectId: string, name: string, sealed: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO ${this.t('secrets')} (project_id, name, sealed, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, name) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = EXCLUDED.updated_at`,
      [projectId, name, sealed, this.now()],
    );
  }

  async getSecret(projectId: string, name: string): Promise<string | null> {
    const r = await this.one(`SELECT sealed FROM ${this.t('secrets')} WHERE project_id = $1 AND name = $2`, [projectId, name]);
    return r ? String(r.sealed) : null;
  }

  async listSecrets(projectId: string): Promise<SecretInfo[]> {
    // COLLATE "C": byte order, as SQLite's default BINARY collation sorts.
    return (await this.sql.query(`SELECT name, updated_at FROM ${this.t('secrets')} WHERE project_id = $1 ORDER BY name COLLATE "C"`, [projectId])).map((r) => ({
      name: String(r.name),
      updatedAt: Number(r.updated_at),
    }));
  }

  async deleteSecret(projectId: string, name: string): Promise<boolean> {
    return (await this.sql.query(`DELETE FROM ${this.t('secrets')} WHERE project_id = $1 AND name = $2 RETURNING name`, [projectId, name])).length > 0;
  }

  async insertCall(c: Omit<CallRow, 'id'>): Promise<void> {
    await this.sql.query(
      `INSERT INTO ${this.t('calls')} (project_id, version, tool, status, upstream_status, ms, request_bytes, response_bytes, subject, client_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [c.projectId, c.version, c.tool, c.status, c.upstreamStatus, Math.round(c.ms), c.requestBytes, c.responseBytes, c.subject, c.clientId, c.at],
    );
  }

  async listCalls(projectId: string, opts: { limit?: number; before?: number } = {}): Promise<CallRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows =
      opts.before !== undefined
        ? await this.sql.query(`SELECT * FROM ${this.t('calls')} WHERE project_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3`, [projectId, opts.before, limit])
        : await this.sql.query(`SELECT * FROM ${this.t('calls')} WHERE project_id = $1 ORDER BY id DESC LIMIT $2`, [projectId, limit]);
    return rows.map(rowToCall);
  }

  /** No-op: the Sql pool is shared (Circuit, accounts) and owned by whoever created it. */
  async close(): Promise<void> {}
}
