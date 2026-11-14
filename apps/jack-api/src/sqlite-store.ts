/**
 * SqliteStore — JackStore on `node:sqlite` (built into Node >= 22.13, zero
 * native dependencies, the same choice as Circuit and the GraphMind CLI).
 *
 * JSON columns are TEXT. Secrets arrive already sealed (SecretBox); this
 * file never sees a plaintext secret. Databases from earlier milestones are
 * migrated in place (new tables, new nullable columns).
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  upstream TEXT NOT NULL,
  auth TEXT NOT NULL,
  active_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, version)
);
CREATE TABLE IF NOT EXISTS sources (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  url TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sealed TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER,
  tool TEXT NOT NULL,
  status TEXT NOT NULL,
  upstream_status INTEGER,
  ms INTEGER NOT NULL,
  request_bytes INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL,
  subject TEXT,
  client_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_by_project ON calls(project_id, id DESC);
`;

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

const rowToProject = (r: Row): OwnedProject => ({
  id: String(r.id),
  ownerId: str(r.owner_id),
  slug: String(r.slug),
  name: String(r.name),
  upstream: String(r.upstream),
  auth: authConfig.parse(JSON.parse(String(r.auth))),
  activeVersion: r.active_version === null ? null : Number(r.active_version),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const rowToDeployment = (r: Row): StoredDeployment => ({
  id: String(r.id),
  projectId: String(r.project_id),
  version: Number(r.version),
  manifest: manifestSchema.parse(JSON.parse(String(r.manifest))),
  manifestHash: String(r.manifest_hash),
  createdBy: String(r.created_by),
  createdAt: Number(r.created_at),
  config: r.config ? jackConfig.parse(JSON.parse(String(r.config))) : null,
  message: str(r.message),
});

const rowToCall = (r: Row): CallRow => ({
  id: Number(r.id),
  projectId: String(r.project_id),
  version: r.version === null ? null : Number(r.version),
  tool: String(r.tool),
  status: String(r.status),
  upstreamStatus: r.upstream_status === null ? null : Number(r.upstream_status),
  ms: Number(r.ms),
  requestBytes: Number(r.request_bytes),
  responseBytes: Number(r.response_bytes),
  subject: str(r.subject),
  clientId: str(r.client_id),
  at: Number(r.at),
});

export class SqliteStore implements JackStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // M0 databases: deployments gained the config they were built from.
    this.ensureColumn('deployments', 'config', 'TEXT');
    this.ensureColumn('deployments', 'message', 'TEXT');
    // Accounts: who owns each project (null = the single local workspace).
    this.ensureColumn('projects', 'owner_id', 'TEXT');
  }

  private ensureColumn(table: string, column: string, type: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private one(sql: string, ...args: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  createProject(p: NewProject): OwnedProject {
    if (this.getProjectBySlug(p.slug)) throw new SlugTakenError(p.slug);
    const t = this.now();
    const id = `prj_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    this.db
      .prepare('INSERT INTO projects (id, slug, name, upstream, auth, active_version, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)')
      .run(id, p.slug, p.name, p.upstream, JSON.stringify(p.auth), t, t, p.ownerId ?? null);
    return this.getProject(id) as OwnedProject;
  }

  getProject(id: string): OwnedProject | null {
    const r = this.one('SELECT * FROM projects WHERE id = ?', id);
    return r ? rowToProject(r) : null;
  }

  getProjectBySlug(slug: string): OwnedProject | null {
    const r = this.one('SELECT * FROM projects WHERE slug = ?', slug);
    return r ? rowToProject(r) : null;
  }

  listProjects(ownerId?: string): OwnedProject[] {
    return ownerId === undefined
      ? this.all('SELECT * FROM projects ORDER BY created_at, slug').map(rowToProject)
      : this.all('SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at, slug', ownerId).map(rowToProject);
  }

  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'upstream' | 'auth' | 'activeVersion'>>): OwnedProject {
    const current = this.getProject(id);
    if (!current) throw new NotFoundError(`project ${id}`);
    const next = { ...current, ...patch, updatedAt: this.now() };
    this.db
      .prepare('UPDATE projects SET name = ?, upstream = ?, auth = ?, active_version = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.upstream, JSON.stringify(next.auth), next.activeVersion, next.updatedAt, id);
    return next;
  }

  deleteProject(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  getSource(projectId: string): SourceRecord | null {
    const r = this.one('SELECT * FROM sources WHERE project_id = ?', projectId);
    return r ? { text: String(r.text), url: str(r.url), updatedAt: Number(r.updated_at) } : null;
  }

  putSource(projectId: string, s: Omit<SourceRecord, 'updatedAt'>): void {
    this.db
      .prepare('INSERT INTO sources VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET text = excluded.text, url = excluded.url, updated_at = excluded.updated_at')
      .run(projectId, s.text, s.url, this.now());
  }

  getDraft(projectId: string): { config: JackConfig; updatedAt: number } | null {
    const r = this.one('SELECT * FROM drafts WHERE project_id = ?', projectId);
    return r ? { config: jackConfig.parse(JSON.parse(String(r.config))), updatedAt: Number(r.updated_at) } : null;
  }

  putDraft(projectId: string, config: JackConfig): void {
    this.db
      .prepare('INSERT INTO drafts VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at')
      .run(projectId, JSON.stringify(config), this.now());
  }

  createDeployment(d: NewDeployment): StoredDeployment {
    if (!this.getProject(d.projectId)) throw new NotFoundError(`project ${d.projectId}`);
    const last = this.one('SELECT COALESCE(MAX(version), 0) AS v FROM deployments WHERE project_id = ?', d.projectId);
    const version = Number(last?.v ?? 0) + 1;
    const id = `dep_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    this.db
      .prepare(
        'INSERT INTO deployments (id, project_id, version, manifest, manifest_hash, created_by, created_at, config, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, d.projectId, version, JSON.stringify(d.manifest), d.manifestHash, d.createdBy, this.now(), d.config ? JSON.stringify(d.config) : null, d.message ?? null);
    return this.getDeployment(d.projectId, version) as StoredDeployment;
  }

  getDeployment(projectId: string, version: number): StoredDeployment | null {
    const r = this.one('SELECT * FROM deployments WHERE project_id = ? AND version = ?', projectId, version);
    return r ? rowToDeployment(r) : null;
  }

  listDeployments(projectId: string): StoredDeployment[] {
    return this.all('SELECT * FROM deployments WHERE project_id = ? ORDER BY version DESC', projectId).map(rowToDeployment);
  }

  activeDeployment(projectId: string): StoredDeployment | null {
    const p = this.getProject(projectId);
    if (!p || p.activeVersion === null) return null;
    return this.getDeployment(projectId, p.activeVersion);
  }

  putSecret(projectId: string, name: string, sealed: string): void {
    this.db
      .prepare('INSERT INTO secrets VALUES (?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at')
      .run(projectId, name, sealed, this.now());
  }

  getSecret(projectId: string, name: string): string | null {
    const r = this.one('SELECT sealed FROM secrets WHERE project_id = ? AND name = ?', projectId, name);
    return r ? String(r.sealed) : null;
  }

  listSecrets(projectId: string): SecretInfo[] {
    return this.all('SELECT name, updated_at FROM secrets WHERE project_id = ? ORDER BY name', projectId).map((r) => ({
      name: String(r.name),
      updatedAt: Number(r.updated_at),
    }));
  }

  deleteSecret(projectId: string, name: string): boolean {
    return this.db.prepare('DELETE FROM secrets WHERE project_id = ? AND name = ?').run(projectId, name).changes > 0;
  }

  insertCall(c: Omit<CallRow, 'id'>): void {
    this.db
      .prepare(
        'INSERT INTO calls (project_id, version, tool, status, upstream_status, ms, request_bytes, response_bytes, subject, client_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(c.projectId, c.version, c.tool, c.status, c.upstreamStatus, c.ms, c.requestBytes, c.responseBytes, c.subject, c.clientId, c.at);
  }

  listCalls(projectId: string, opts: { limit?: number; before?: number } = {}): CallRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    return opts.before !== undefined
      ? this.all('SELECT * FROM calls WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?', projectId, opts.before, limit).map(rowToCall)
      : this.all('SELECT * FROM calls WHERE project_id = ? ORDER BY id DESC LIMIT ?', projectId, limit).map(rowToCall);
  }

  close(): void {
    this.db.close();
  }
}
