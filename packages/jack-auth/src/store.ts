/**
 * AuthStore — persistence for the authorization server. One interface; the
 * SQLite backend here serves `jack preview`, tests and single-node
 * self-hosting, and the hosted service gets Postgres (`PgAuthStore`,
 * ./pg-store.ts) behind the same calls.
 *
 * Every method is async: the SQLite backend is synchronous underneath and
 * simply resolves immediately, but a network database cannot be. One store
 * instance is ONE project's issuer — the SQLite file is per project, and a
 * Postgres handle is scoped to one project id.
 *
 * What is stored, and how:
 *   clients          DCR registrations (public clients only; no secrets exist)
 *   auth_requests    an in-flight sign-in, ≤ 10 minutes; browser-bound by a hashed cookie value
 *   auth_codes       hashed, single use, ≤ 60 seconds
 *   grants           one per (user, client) authorization; revocation is immediate
 *   refresh_tokens   hashed; rotated on every use; reuse revokes the grant
 *   upstream         the user's credential for the customer API, sealed with SecretBox
 *   signing_keys     the issuer's ES256 keys, private half sealed
 */
import { DatabaseSync } from 'node:sqlite';

export interface ClientRecord {
  clientId: string;
  kind: 'dcr';
  metadata: Record<string, unknown>;
  createdAt: number;
  lastUsedAt: number;
}

export interface AuthRequestRecord {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scopes: string[];
  resource: string;
  /** sha256 of the browser-binding cookie value. */
  browserHash: string;
  /** Mode-specific progress: upstream PKCE/nonce/state, the resolved subject, sealed upstream credential. */
  data: Record<string, unknown>;
  expiresAt: number;
}

export interface CodeRecord {
  codeHash: string;
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
  usedAt: number | null;
}

export interface GrantRecord {
  id: string;
  clientId: string;
  subject: string;
  /** Who the user is, as shown on consent and in the dashboard (name or email). */
  display: string;
  scopes: string[];
  resource: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface RefreshRecord {
  tokenHash: string;
  grantId: string;
  expiresAt: number;
  rotatedAt: number | null;
}

export interface SigningKeyRecord {
  kid: string;
  publicJwk: Record<string, unknown>;
  sealedPrivateJwk: string;
  createdAt: number;
}

export interface AuthStore {
  putClient(c: ClientRecord): Promise<void>;
  getClient(clientId: string): Promise<ClientRecord | null>;
  touchClient(clientId: string, at: number): Promise<void>;
  countClientsSince(since: number): Promise<number>;

  putAuthRequest(r: AuthRequestRecord): Promise<void>;
  getAuthRequest(id: string): Promise<AuthRequestRecord | null>;
  updateAuthRequest(id: string, data: Record<string, unknown>): Promise<void>;
  deleteAuthRequest(id: string): Promise<void>;

  putCode(c: CodeRecord): Promise<void>;
  getCode(codeHash: string): Promise<CodeRecord | null>;
  /** Atomically mark used. Returns false if it was already used (a replay). */
  useCode(codeHash: string, at: number): Promise<boolean>;

  putGrant(g: GrantRecord): Promise<void>;
  getGrant(id: string): Promise<GrantRecord | null>;
  listGrants(): Promise<GrantRecord[]>;
  revokeGrant(id: string, at: number): Promise<void>;

  putRefresh(r: RefreshRecord): Promise<void>;
  getRefresh(tokenHash: string): Promise<RefreshRecord | null>;
  /** Atomically mark rotated. Returns false if it already was (a replay). */
  rotateRefresh(tokenHash: string, at: number): Promise<boolean>;

  putUpstream(grantId: string, sealed: string, at: number): Promise<void>;
  getUpstream(grantId: string): Promise<string | null>;

  putSigningKey(k: SigningKeyRecord): Promise<void>;
  listSigningKeys(): Promise<SigningKeyRecord[]>;

  /**
   * Remove every row this store holds (project deletion). For the per-project
   * SQLite file that is the whole database; for a project-scoped Postgres
   * handle it is that project's rows only.
   */
  purge(): Promise<void>;

  /** Remove expired requests, codes and refresh tokens. */
  sweep(now: number): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, kind TEXT NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS clients_created ON clients(created_at);
CREATE TABLE IF NOT EXISTS auth_requests (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, state TEXT, scopes TEXT NOT NULL, resource TEXT NOT NULL, browser_hash TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_codes (code_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, subject TEXT NOT NULL, display TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS refresh_tokens (token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, expires_at INTEGER NOT NULL, rotated_at INTEGER);
CREATE TABLE IF NOT EXISTS upstream (grant_id TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS signing_keys (kid TEXT PRIMARY KEY, public_jwk TEXT NOT NULL, sealed_private_jwk TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

type Row = Record<string, unknown>;
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown) => JSON.parse(String(v)) as T;

export class SqliteAuthStore implements AuthStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  private one(sql: string, ...args: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private run(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).run(...args);
  }

  async putClient(c: ClientRecord) {
    this.run('INSERT INTO clients VALUES (?, ?, ?, ?, ?)', c.clientId, c.kind, json(c.metadata), c.createdAt, c.lastUsedAt);
  }
  async getClient(id: string): Promise<ClientRecord | null> {
    const r = this.one('SELECT * FROM clients WHERE client_id = ?', id);
    return r
      ? { clientId: String(r.client_id), kind: 'dcr', metadata: parse(r.metadata), createdAt: Number(r.created_at), lastUsedAt: Number(r.last_used_at) }
      : null;
  }
  async touchClient(id: string, at: number) {
    this.run('UPDATE clients SET last_used_at = ? WHERE client_id = ?', at, id);
  }
  async countClientsSince(since: number) {
    return Number(this.one('SELECT COUNT(*) AS n FROM clients WHERE created_at >= ?', since)?.n ?? 0);
  }

  async putAuthRequest(r: AuthRequestRecord) {
    this.run(
      'INSERT INTO auth_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.id,
      r.clientId,
      r.redirectUri,
      r.codeChallenge,
      r.state,
      json(r.scopes),
      r.resource,
      r.browserHash,
      json(r.data),
      r.expiresAt,
    );
  }
  async getAuthRequest(id: string): Promise<AuthRequestRecord | null> {
    const r = this.one('SELECT * FROM auth_requests WHERE id = ?', id);
    if (!r) return null;
    return {
      id: String(r.id),
      clientId: String(r.client_id),
      redirectUri: String(r.redirect_uri),
      codeChallenge: String(r.code_challenge),
      state: r.state === null ? null : String(r.state),
      scopes: parse(r.scopes),
      resource: String(r.resource),
      browserHash: String(r.browser_hash),
      data: parse(r.data),
      expiresAt: Number(r.expires_at),
    };
  }
  async updateAuthRequest(id: string, data: Record<string, unknown>) {
    this.run('UPDATE auth_requests SET data = ? WHERE id = ?', json(data), id);
  }
  async deleteAuthRequest(id: string) {
    this.run('DELETE FROM auth_requests WHERE id = ?', id);
  }

  async putCode(c: CodeRecord) {
    this.run('INSERT INTO auth_codes VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', c.codeHash, c.grantId, c.clientId, c.redirectUri, c.codeChallenge, c.resource, c.expiresAt);
  }
  async getCode(hash: string): Promise<CodeRecord | null> {
    const r = this.one('SELECT * FROM auth_codes WHERE code_hash = ?', hash);
    if (!r) return null;
    return {
      codeHash: String(r.code_hash),
      grantId: String(r.grant_id),
      clientId: String(r.client_id),
      redirectUri: String(r.redirect_uri),
      codeChallenge: String(r.code_challenge),
      resource: String(r.resource),
      expiresAt: Number(r.expires_at),
      usedAt: r.used_at === null ? null : Number(r.used_at),
    };
  }
  async useCode(hash: string, at: number) {
    return this.run('UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', at, hash).changes > 0;
  }

  async putGrant(g: GrantRecord) {
    this.run('INSERT INTO grants VALUES (?, ?, ?, ?, ?, ?, ?, ?)', g.id, g.clientId, g.subject, g.display, json(g.scopes), g.resource, g.createdAt, g.revokedAt);
  }
  private toGrant(r: Row): GrantRecord {
    return {
      id: String(r.id),
      clientId: String(r.client_id),
      subject: String(r.subject),
      display: String(r.display),
      scopes: parse(r.scopes),
      resource: String(r.resource),
      createdAt: Number(r.created_at),
      revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    };
  }
  async getGrant(id: string) {
    const r = this.one('SELECT * FROM grants WHERE id = ?', id);
    return r ? this.toGrant(r) : null;
  }
  async listGrants() {
    return (this.db.prepare('SELECT * FROM grants ORDER BY created_at').all() as Row[]).map((r) => this.toGrant(r));
  }
  async revokeGrant(id: string, at: number) {
    this.run('UPDATE grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', at, id);
    this.run('DELETE FROM upstream WHERE grant_id = ?', id);
  }

  async putRefresh(r: RefreshRecord) {
    this.run('INSERT INTO refresh_tokens VALUES (?, ?, ?, NULL)', r.tokenHash, r.grantId, r.expiresAt);
  }
  async getRefresh(hash: string): Promise<RefreshRecord | null> {
    const r = this.one('SELECT * FROM refresh_tokens WHERE token_hash = ?', hash);
    return r
      ? { tokenHash: String(r.token_hash), grantId: String(r.grant_id), expiresAt: Number(r.expires_at), rotatedAt: r.rotated_at === null ? null : Number(r.rotated_at) }
      : null;
  }
  async rotateRefresh(hash: string, at: number) {
    return this.run('UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL', at, hash).changes > 0;
  }

  async putUpstream(grantId: string, sealed: string, at: number) {
    this.run('INSERT INTO upstream VALUES (?, ?, ?) ON CONFLICT(grant_id) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at', grantId, sealed, at);
  }
  async getUpstream(grantId: string) {
    const r = this.one('SELECT sealed FROM upstream WHERE grant_id = ?', grantId);
    return r ? String(r.sealed) : null;
  }

  async putSigningKey(k: SigningKeyRecord) {
    this.run('INSERT INTO signing_keys VALUES (?, ?, ?, ?)', k.kid, json(k.publicJwk), k.sealedPrivateJwk, k.createdAt);
  }
  async listSigningKeys(): Promise<SigningKeyRecord[]> {
    return (this.db.prepare('SELECT * FROM signing_keys ORDER BY created_at DESC').all() as Row[]).map((r) => ({
      kid: String(r.kid),
      publicJwk: parse(r.public_jwk),
      sealedPrivateJwk: String(r.sealed_private_jwk),
      createdAt: Number(r.created_at),
    }));
  }

  async sweep(now: number) {
    this.run('DELETE FROM auth_requests WHERE expires_at < ?', now);
    // Keep used codes a little past expiry so a late replay is still recognised (and revokes).
    this.run('DELETE FROM auth_codes WHERE expires_at < ?', now - 3_600_000);
    this.run('DELETE FROM refresh_tokens WHERE expires_at < ?', now);
  }

  async purge() {
    this.db.exec('DELETE FROM clients; DELETE FROM auth_requests; DELETE FROM auth_codes; DELETE FROM grants; DELETE FROM refresh_tokens; DELETE FROM upstream; DELETE FROM signing_keys;');
  }

  async close() {
    this.db.close();
  }
}
