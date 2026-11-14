/**
 * AccountStore — the persistence contract for user accounts. One interface,
 * one backend today (`SqliteAccountStore` on `node:sqlite`, as every other
 * store in this repo); a Postgres store slots in behind the same methods when
 * the hosted service needs it.
 *
 * Nothing here ever holds a plaintext password or token: callers pass
 * scrypt hashes for passwords and SHA-256 hashes for session and API tokens.
 */

export interface User {
  id: string;
  email: string;
  name: string | null;
  createdAt: number;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  /** The first characters of the token, so a user can tell their tokens apart. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface AccountStore {
  createUser(u: { email: string; passwordHash: string; name: string | null }): User;
  getUser(id: string): User | null;
  getUserByEmail(email: string): UserWithPassword | null;
  countUsers(): number;

  createSession(s: { tokenHash: string; userId: string; expiresAt: number }): Session;
  getSession(tokenHash: string): Session | null;
  touchSession(id: string, lastSeenAt: number): void;
  deleteSession(tokenHash: string): boolean;
  deleteUserSessions(userId: string): number;
  purgeExpiredSessions(now: number): number;

  createToken(t: { userId: string; name: string; prefix: string; tokenHash: string }): ApiToken;
  getTokenByHash(tokenHash: string): ApiToken | null;
  touchToken(id: string, lastUsedAt: number): void;
  listTokens(userId: string): ApiToken[];
  revokeToken(userId: string, id: string): boolean;

  close(): void;
}

export class EmailTakenError extends Error {
  override name = 'EmailTakenError';
  constructor() {
    super('an account with this email already exists');
  }
}
