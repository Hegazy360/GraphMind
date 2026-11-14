/**
 * SqliteAccountStore — AccountStore on `node:sqlite` (built into Node >= 22.13,
 * zero native dependencies). Used by `jack serve --accounts` and
 * `circuit dev --accounts`, by the tests, and by single-node self-hosting.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EmailTakenError, type AccountStore, type ApiToken, type Session, type User, type UserWithPassword } from './store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_tokens_by_user ON api_tokens(user_id);
`;

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

const rowToUser = (r: Row): User => ({ id: String(r.id), email: String(r.email), name: str(r.name), createdAt: Number(r.created_at) });
const rowToSession = (r: Row): Session => ({
  id: String(r.id),
  userId: String(r.user_id),
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  lastSeenAt: Number(r.last_seen_at),
});
const rowToToken = (r: Row): ApiToken => ({
  id: String(r.id),
  userId: String(r.user_id),
  name: String(r.name),
  prefix: String(r.prefix),
  createdAt: Number(r.created_at),
  lastUsedAt: num(r.last_used_at),
  revokedAt: num(r.revoked_at),
});

export class SqliteAccountStore implements AccountStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  private one(sql: string, ...args: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  createUser(u: { email: string; passwordHash: string; name: string | null }): User {
    if (this.one('SELECT id FROM users WHERE email = ?', u.email)) throw new EmailTakenError();
    const id = `usr_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    this.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(id, u.email, u.passwordHash, u.name, this.now());
    return this.getUser(id) as User;
  }

  getUser(id: string): User | null {
    const r = this.one('SELECT * FROM users WHERE id = ?', id);
    return r ? rowToUser(r) : null;
  }

  getUserByEmail(email: string): UserWithPassword | null {
    const r = this.one('SELECT * FROM users WHERE email = ?', email);
    return r ? { ...rowToUser(r), passwordHash: String(r.password_hash) } : null;
  }

  countUsers(): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
  }

  createSession(s: { tokenHash: string; userId: string; expiresAt: number }): Session {
    const id = `ses_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const t = this.now();
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(id, s.tokenHash, s.userId, t, s.expiresAt, t);
    return { id, userId: s.userId, createdAt: t, expiresAt: s.expiresAt, lastSeenAt: t };
  }

  getSession(tokenHash: string): Session | null {
    const r = this.one('SELECT * FROM sessions WHERE token_hash = ?', tokenHash);
    return r ? rowToSession(r) : null;
  }

  touchSession(id: string, lastSeenAt: number): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, id);
  }

  deleteSession(tokenHash: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes > 0;
  }

  deleteUserSessions(userId: string): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes);
  }

  purgeExpiredSessions(now: number): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
  }

  createToken(t: { userId: string; name: string; prefix: string; tokenHash: string }): ApiToken {
    const id = `tok_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    this.db.prepare('INSERT INTO api_tokens VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)').run(id, t.userId, t.name, t.prefix, t.tokenHash, this.now());
    return rowToToken(this.one('SELECT * FROM api_tokens WHERE id = ?', id) as Row);
  }

  getTokenByHash(tokenHash: string): ApiToken | null {
    const r = this.one('SELECT * FROM api_tokens WHERE token_hash = ?', tokenHash);
    return r ? rowToToken(r) : null;
  }

  touchToken(id: string, lastUsedAt: number): void {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(lastUsedAt, id);
  }

  listTokens(userId: string): ApiToken[] {
    return this.all('SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId).map(rowToToken);
  }

  revokeToken(userId: string, id: string): boolean {
    return this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(this.now(), id, userId).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
