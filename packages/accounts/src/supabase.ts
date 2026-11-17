/**
 * createSupabaseAccounts — the hosted `Accounts`: Supabase Auth owns users,
 * passwords, email confirmation and password reset; this module keeps the
 * same HTTP surface as `createAccounts` so the shell, the hub, Circuit and
 * Jack do not change.
 *
 *   POST /auth/signup    { email, password, name? } → 201 { user } (signed in)
 *                                                    | 202 { confirm: true } (check your email)
 *   POST /auth/login     { email, password }        → 200 { user }
 *   POST /auth/logout                               → 204
 *   GET  /auth/me                                   → 200 { user, via } | 401
 *   GET  /auth/status                               → 200 { accounts, signup, users, reset, provider }
 *   POST /auth/recover   { email }                  → 202 (always; never reveals whether the email exists)
 *   POST /auth/password  { password }               → 204 (session only; after a reset link, or to change it)
 *   GET  /auth/callback?code=…[&next=reset]         → 302 into the hub (email links land here)
 *   GET/POST/DELETE /auth/tokens…                   personal API tokens, as in createAccounts
 *
 * How the pieces fit:
 * - Every call to Supabase Auth is made from this server, never from the
 *   browser, so the pages keep `connect-src 'self'` and no token is readable
 *   by page scripts. The session lives in one HttpOnly `__Host-` cookie
 *   holding Supabase's access and refresh tokens.
 * - Access tokens are verified locally against the project's public JWKS
 *   (ES256/RS256 signing keys), so an ordinary request costs no network call.
 *   An expired access token is refreshed inside `requireUser()` and `/auth/me`,
 *   which can set the rotated cookie on their response.
 * - Email links use PKCE: the server keeps the verifier in a short-lived
 *   HttpOnly cookie and exchanges the one-time `code` on /auth/callback, so
 *   access tokens never appear in a URL.
 * - Rate limits: Supabase limits sign-ins per client IP. Called from a server,
 *   every visitor would share the server's IP, so when a secret key is
 *   configured each call carries `Sb-Forwarded-For` with the visitor's address
 *   (taken from the platform's trusted header, never from client-supplied
 *   X-Forwarded-For) and authenticates with that secret key, which Supabase
 *   requires for the header to count. Without one it still works, with one
 *   shared bucket — fine for development, not for launch.
 * - Personal API tokens and a small mirror of users (id, email, name, created)
 *   live in Postgres (`<schema>.accounts_users`, `<schema>.accounts_api_tokens`),
 *   hashed exactly as the SQLite store hashes them.
 *
 * Nothing here logs a token, a cookie, a key or a password. Errors from
 * Supabase are mapped to fixed messages; their bodies are never echoed.
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySig, type KeyObject } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { ident, migrate, type Migration, type Sql } from '@graphmind-ai/db';
import type { Accounts, Principal } from './accounts.js';
import type { ApiToken, User } from './store.js';

export interface SupabaseAccountsOptions {
  /** https://<ref>.supabase.co */
  supabaseUrl: string;
  /** sb_publishable_… — used when no secret key is configured. */
  publishableKey: string;
  /**
   * sb_secret_… — optional, server-only. When set, Auth calls use it and send
   * `Sb-Forwarded-For`, so Supabase rate-limits each visitor separately.
   * Enable "IP Address Forwarding" under Authentication → Rate Limits.
   */
  secretKey?: string;
  /** Postgres for API tokens and the users mirror. */
  sql: Sql;
  /** Default 'graphmind'. */
  schema?: string;
  /** The origin browsers use, e.g. https://graphmind.ai. */
  publicOrigin: string;
  /** Where the hub is mounted on that origin, e.g. '/app' ('' for the root). Email links come back to `<hubPath>/auth/callback`. */
  hubPath: string;
  allowSignup?: boolean;
  /**
   * The request header holding the client address, set by the hosting
   * platform and not forgeable by the client. Default `x-vercel-forwarded-for`.
   */
  clientIpHeader?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export const accountsMigrations: Migration[] = [
  {
    id: 'accounts-001-init',
    statements: [
      `CREATE TABLE IF NOT EXISTS {schema}.accounts_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        created_at BIGINT NOT NULL,
        seen_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS {schema}.accounts_api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES {schema}.accounts_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at BIGINT NOT NULL,
        last_used_at BIGINT,
        revoked_at BIGINT
      )`,
      'CREATE INDEX IF NOT EXISTS accounts_api_tokens_by_user ON {schema}.accounts_api_tokens(user_id)',
      // The app connects as the owner; RLS without policies shuts out the Data API roles.
      'ALTER TABLE {schema}.accounts_users ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE {schema}.accounts_api_tokens ENABLE ROW LEVEL SECURITY',
    ],
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = z.string().trim().toLowerCase().min(3).max(254).refine((v) => EMAIL_RE.test(v), 'enter a valid email address');
const password = z.string().min(10, 'use at least 10 characters').max(256);
const signupBody = z.object({ email, password, name: z.string().trim().min(1).max(120).optional() });
const loginBody = z.object({ email, password: z.string().min(1).max(256) });
const recoverBody = z.object({ email });
const passwordBody = z.object({ password });
const tokenBody = z.object({ name: z.string().trim().min(1).max(80).default('cli') });

const TOKEN_PREFIX = 'gmt_';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // the cookie; Supabase's refresh token decides the real lifetime
const PKCE_MAX_AGE_S = 24 * 60 * 60; // as long as an email link is worth keeping
const REFRESH_SKEW_S = 30;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');

function problem(status: number, title: string, detail?: string, headers: Record<string, string> = {}) {
  return Response.json(
    { type: 'about:blank', title, status, ...(detail !== undefined ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...headers } },
  );
}

function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && out[k] === undefined) {
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* a malformed cookie is no cookie */
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ JWT --

interface Claims {
  sub: string;
  email?: string;
  exp: number;
  iss?: string;
  aud?: string | string[];
  role?: string;
  user_metadata?: { name?: unknown };
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  crv?: string;
  [k: string]: unknown;
}

/** Verifies Supabase access tokens against the project's JWKS; caches keys, refetches on an unknown kid (rate-limited). */
class JwksVerifier {
  private keys = new Map<string, { key: KeyObject; alg: string }>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly issuer: string,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number,
  ) {}

  private async load(force: boolean): Promise<void> {
    if (!force && this.keys.size > 0 && this.now() - this.fetchedAt < 10 * 60_000) return;
    if (force && this.now() - this.fetchedAt < 30_000) return; // an unknown kid must not turn into a fetch per request
    this.inflight ??= (async () => {
      try {
        const r = await this.fetchImpl(this.url, { headers: { accept: 'application/json' } });
        if (!r.ok) return;
        const body = (await r.json()) as { keys?: Jwk[] };
        const next = new Map<string, { key: KeyObject; alg: string }>();
        for (const jwk of body.keys ?? []) {
          const alg = jwk.alg ?? (jwk.kty === 'EC' ? 'ES256' : jwk.kty === 'RSA' ? 'RS256' : '');
          if (alg !== 'ES256' && alg !== 'RS256') continue;
          try {
            next.set(jwk.kid ?? '', { key: createPublicKey({ key: jwk as never, format: 'jwk' }), alg });
          } catch {
            /* skip a key we cannot import */
          }
        }
        if (next.size > 0) {
          this.keys = next;
          this.fetchedAt = this.now();
        }
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
  }

  /** The verified claims, or null (bad signature, wrong issuer/audience, or not an authenticated user). Expiry is returned, not enforced: the caller decides whether to refresh. */
  async verify(token: string): Promise<Claims | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: Claims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    await this.load(false);
    let entry = this.keys.get(header.kid ?? '');
    if (!entry) {
      await this.load(true);
      entry = this.keys.get(header.kid ?? '');
    }
    if (!entry || entry.alg !== header.alg) return null;
    const ok = verifySig(
      'sha256',
      Buffer.from(`${h}.${p}`),
      entry.alg === 'ES256' ? { key: entry.key, dsaEncoding: 'ieee-p1363' } : entry.key,
      Buffer.from(s, 'base64url'),
    );
    if (!ok) return null;
    if (claims.iss !== this.issuer) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes('authenticated') || claims.role !== 'authenticated') return null;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    return claims;
  }
}

// -------------------------------------------------------------- accounts --

interface Tokens {
  a: string; // access token
  r: string; // refresh token
}

interface Resolved {
  principal: Principal;
  /** A rotated session cookie to set on the response, when the access token was refreshed. */
  setCookie?: string;
  /** The current Supabase access token (session principals only), for calls made on the user's behalf. */
  access?: string;
}

export function createSupabaseAccounts(opts: SupabaseAccountsOptions): Accounts & { migrate(): Promise<string[]> } {
  const { sql } = opts;
  const schema = opts.schema ?? 'graphmind';
  const T = `${ident(schema)}.accounts_api_tokens`;
  const U = `${ident(schema)}.accounts_users`;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const allowSignup = opts.allowSignup ?? true;
  const base = opts.supabaseUrl.replace(/\/$/, '');
  const authBase = `${base}/auth/v1`;
  const origin = new URL(opts.publicOrigin).origin;
  const secure = origin.startsWith('https:');
  const cookieName = secure ? '__Host-gm_session' : 'gm_session';
  const pkceCookie = secure ? '__Host-gm_pkce' : 'gm_pkce';
  const hubPath = opts.hubPath.replace(/\/$/, '');
  const callbackUrl = `${origin}${hubPath}/auth/callback`;
  const ipHeader = (opts.clientIpHeader ?? 'x-vercel-forwarded-for').toLowerCase();
  const jwks = new JwksVerifier(`${authBase}/.well-known/jwks.json`, authBase, fetchImpl, now);
  let userCount = 0;
  let userCountAt = 0;
  const createdAtCache = new Map<string, number>();

  const setCookie = (name: string, value: string, maxAgeSec: number) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  const sessionCookie = (t: Tokens) => setCookie(cookieName, b64url(Buffer.from(JSON.stringify(t))), SESSION_MAX_AGE_S);
  const clearSession = () => setCookie(cookieName, '', 0);

  function readSession(req: Request): Tokens | null {
    const raw = parseCookies(req.headers.get('cookie'))[cookieName];
    if (!raw) return null;
    try {
      const t = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Tokens>;
      return typeof t.a === 'string' && typeof t.r === 'string' ? { a: t.a, r: t.r } : null;
    } catch {
      return null;
    }
  }

  /** One call to Supabase Auth. Returns status and parsed JSON (or null); never throws on HTTP errors. */
  async function gotrue(req: Request | null, method: string, path: string, body?: unknown, bearer?: string): Promise<{ status: number; data: Record<string, unknown> | null }> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    // New Supabase keys go on `apikey` only; Authorization carries a user's access token when there is one.
    headers.apikey = opts.secretKey ?? opts.publishableKey;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (opts.secretKey && req) {
      const ip = req.headers.get(ipHeader)?.split(',')[0]?.trim();
      if (ip) headers['sb-forwarded-for'] = ip;
    }
    let r: Response;
    try {
      r = await fetchImpl(`${authBase}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch {
      return { status: 503, data: null };
    }
    const data = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: r.status, data };
  }

  const errorCode = (d: Record<string, unknown> | null) => (typeof d?.error_code === 'string' ? d.error_code : typeof d?.error === 'string' ? d.error : '');

  /** Map a failed Supabase response to one of our fixed problems. */
  function authProblem(status: number, d: Record<string, unknown> | null, fallback: string) {
    const code = errorCode(d);
    if (status === 429 || code.startsWith('over_')) return problem(429, 'Too many attempts', 'wait a few minutes and try again', { 'retry-after': '300' });
    if (code === 'invalid_credentials' || code === 'invalid_grant') return problem(401, 'Sign-in failed', 'wrong email or password');
    if (code === 'email_not_confirmed') return problem(403, 'Email not confirmed', 'open the link we emailed you, then sign in');
    if (code === 'weak_password') return problem(400, 'Password too weak', 'choose a longer password that is not commonly used');
    if (code === 'user_already_exists' || code === 'email_exists') return problem(409, 'Email taken', 'an account with this email already exists; sign in instead');
    if (code === 'signup_disabled') return problem(403, 'Sign-up closed', 'this server does not accept new accounts');
    if (code === 'same_password') return problem(400, 'Same password', 'choose a password different from the current one');
    if (status >= 500 || status === 503) return problem(503, 'Sign-in unavailable', 'the account service did not answer; try again shortly');
    return problem(400, fallback);
  }

  /** Upsert the mirror row; returns our `User` shape. */
  async function mirror(claims: { sub: string; email?: string | undefined; name?: string | null }): Promise<User> {
    const t = now();
    const [row] = await sql.query<{ id: string; email: string; name: string | null; created_at: number }>(
      `INSERT INTO ${U} (id, email, name, created_at, seen_at) VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = COALESCE(EXCLUDED.name, ${U}.name), seen_at = EXCLUDED.seen_at
       RETURNING id, email, name, created_at`,
      [claims.sub, claims.email ?? '', claims.name ?? null, t],
    );
    createdAtCache.set(row!.id, row!.created_at);
    return { id: row!.id, email: row!.email, name: row!.name, createdAt: row!.created_at };
  }

  const nameOf = (c: Claims): string | null => (typeof c.user_metadata?.name === 'string' && c.user_metadata.name ? c.user_metadata.name : null);

  async function userFromClaims(c: Claims): Promise<User> {
    const createdAt = createdAtCache.get(c.sub);
    if (createdAt === undefined) return mirror({ sub: c.sub, email: c.email, name: nameOf(c) });
    return { id: c.sub, email: c.email ?? '', name: nameOf(c), createdAt };
  }

  /** Start a session from a Supabase token response; returns the user and the cookie. */
  async function startSession(d: Record<string, unknown>): Promise<{ user: User; cookie: string; access: string } | null> {
    const a = typeof d.access_token === 'string' ? d.access_token : null;
    const r = typeof d.refresh_token === 'string' ? d.refresh_token : null;
    if (!a || !r) return null;
    const claims = await jwks.verify(a);
    if (!claims) return null;
    const user = await mirror({ sub: claims.sub, email: claims.email, name: nameOf(claims) });
    return { user, cookie: sessionCookie({ a, r }), access: a };
  }

  /** The session principal; refreshes an expired access token when `allowRefresh`. */
  async function sessionFor(req: Request, allowRefresh: boolean): Promise<Resolved | null> {
    const t = readSession(req);
    if (!t) return null;
    const claims = await jwks.verify(t.a);
    if (claims && claims.exp - REFRESH_SKEW_S > now() / 1000) {
      return { principal: { user: await userFromClaims(claims), via: 'session' }, access: t.a };
    }
    if (!allowRefresh) return null;
    const { status, data } = await gotrue(req, 'POST', '/token?grant_type=refresh_token', { refresh_token: t.r });
    if (status !== 200 || !data) return null;
    const s = await startSession(data);
    return s ? { principal: { user: s.user, via: 'session' }, setCookie: s.cookie, access: s.access } : null;
  }

  async function tokenFor(req: Request): Promise<Principal | null> {
    const header = req.headers.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const raw = header.slice(7).trim();
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const [row] = await sql.query<{ id: string; last_used_at: number | null; user_id: string; email: string; name: string | null; created_at: number }>(
      `SELECT t.id, t.last_used_at, u.id AS user_id, u.email, u.name, u.created_at
         FROM ${T} t JOIN ${U} u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
      [sha256(raw)],
    );
    if (!row) return null;
    if (row.last_used_at === null || now() - row.last_used_at > 60_000) {
      await sql.query(`UPDATE ${T} SET last_used_at = $2 WHERE id = $1`, [row.id, now()]);
    }
    return { user: { id: row.user_id, email: row.email, name: row.name, createdAt: row.created_at }, via: 'token' };
  }

  async function resolve(req: Request, allowRefresh: boolean): Promise<Resolved | null> {
    const tp = await tokenFor(req);
    if (tp) return { principal: tp };
    return sessionFor(req, allowRefresh);
  }

  function sameOrigin(req: Request): boolean {
    const o = req.headers.get('origin');
    if (o !== null) return o === origin;
    const site = req.headers.get('sec-fetch-site');
    return site === 'same-origin' || site === 'none';
  }

  function pkcePair(): { verifier: string; challenge: string } {
    const verifier = b64url(randomBytes(48));
    return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
  }

  const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt });

  async function refreshUserCount(): Promise<number> {
    if (now() - userCountAt > 60_000) {
      try {
        const [r] = await sql.query<{ n: number }>(`SELECT count(*)::bigint AS n FROM ${U}`);
        userCount = r?.n ?? 0;
        userCountAt = now();
      } catch {
        /* status must never fail a page */
      }
    }
    return userCount;
  }

  function status() {
    return { accounts: true as const, signup: allowSignup, users: userCount, reset: true, provider: 'supabase' as const };
  }

  const routes = new Hono();

  routes.onError((err) => {
    if (err instanceof z.ZodError) return problem(400, 'Invalid request body', z.prettifyError(err));
    if (err instanceof SyntaxError) return problem(400, 'Invalid JSON');
    console.error('[accounts] unhandled:', err instanceof Error ? err.name : 'error');
    return problem(500, 'Internal error');
  });

  routes.get('/auth/status', async (c) => {
    await refreshUserCount();
    return c.json(status());
  });

  routes.post('/auth/signup', async (c) => {
    if (!allowSignup) return problem(403, 'Sign-up closed', 'this server does not accept new accounts');
    if (!sameOrigin(c.req.raw)) return problem(403, 'Cross-site request refused');
    const body = signupBody.parse(await c.req.json());
    const { verifier, challenge } = pkcePair();
    const { status: st, data } = await gotrue(c.req.raw, 'POST', `/signup?redirect_to=${encodeURIComponent(callbackUrl)}`, {
      email: body.email,
      password: body.password,
      data: body.name ? { name: body.name } : {},
      code_challenge: challenge,
      code_challenge_method: 's256',
    });
    if (st !== 200 || !data) return authProblem(st, data, 'Sign-up failed');
    const s = await startSession(data);
    c.header('cache-control', 'no-store');
    if (s) {
      // Email confirmation is off for this project: signed in straight away.
      c.header('set-cookie', s.cookie);
      return c.json({ user: publicUser(s.user) }, 201);
    }
    // Confirmation required: the link comes back to /auth/callback with a code for this verifier.
    c.header('set-cookie', setCookie(pkceCookie, verifier, PKCE_MAX_AGE_S));
    return c.json({ confirm: true, email: body.email }, 202);
  });

  routes.post('/auth/login', async (c) => {
    if (!sameOrigin(c.req.raw)) return problem(403, 'Cross-site request refused');
    const body = loginBody.parse(await c.req.json());
    const { status: st, data } = await gotrue(c.req.raw, 'POST', '/token?grant_type=password', { email: body.email, password: body.password });
    if (st !== 200 || !data) return authProblem(st, data, 'Sign-in failed');
    const s = await startSession(data);
    if (!s) return problem(503, 'Sign-in unavailable', 'the account service returned an unexpected answer');
    c.header('set-cookie', s.cookie);
    c.header('cache-control', 'no-store');
    return c.json({ user: publicUser(s.user) });
  });

  routes.post('/auth/logout', async (c) => {
    const t = readSession(c.req.raw);
    // Revoke this browser's refresh token at Supabase; the cookie goes either way.
    if (t) await gotrue(c.req.raw, 'POST', '/logout?scope=local', undefined, t.a);
    c.header('set-cookie', clearSession());
    return c.body(null, 204);
  });

  routes.get('/auth/me', async (c) => {
    const r = await resolve(c.req.raw, true);
    c.header('cache-control', 'no-store');
    if (!r) {
      if (readSession(c.req.raw)) c.header('set-cookie', clearSession());
      return problem(401, 'Not signed in');
    }
    if (r.setCookie) c.header('set-cookie', r.setCookie);
    return c.json({ user: publicUser(r.principal.user), via: r.principal.via });
  });

  routes.post('/auth/recover', async (c) => {
    if (!sameOrigin(c.req.raw)) return problem(403, 'Cross-site request refused');
    const body = recoverBody.parse(await c.req.json());
    const { verifier, challenge } = pkcePair();
    const { status: st, data } = await gotrue(c.req.raw, 'POST', `/recover?redirect_to=${encodeURIComponent(`${callbackUrl}?next=reset`)}`, {
      email: body.email,
      code_challenge: challenge,
      code_challenge_method: 's256',
    });
    if (st === 429 || errorCode(data).startsWith('over_')) return authProblem(429, data, 'Too many attempts');
    // Same answer whether or not the address has an account.
    c.header('set-cookie', setCookie(pkceCookie, verifier, PKCE_MAX_AGE_S));
    c.header('cache-control', 'no-store');
    return c.json({ sent: true }, 202);
  });

  routes.post('/auth/password', async (c) => {
    if (!sameOrigin(c.req.raw)) return problem(403, 'Cross-site request refused');
    const r = await sessionFor(c.req.raw, true);
    if (!r?.access) return problem(401, 'Not signed in', 'open the reset link again, or sign in');
    const body = passwordBody.parse(await c.req.json());
    const { status: st, data } = await gotrue(c.req.raw, 'PUT', '/user', { password: body.password }, r.access);
    if (st !== 200) return authProblem(st, data, 'Password not changed');
    if (r.setCookie) c.header('set-cookie', r.setCookie);
    return c.body(null, 204);
  });

  routes.get('/auth/callback', async (c) => {
    const u = new URL(c.req.url);
    const code = u.searchParams.get('code');
    const next = u.searchParams.get('next') === 'reset' ? 'reset' : '';
    const verifier = parseCookies(c.req.header('cookie'))[pkceCookie];
    const back = (hash: string) => {
      c.header('set-cookie', setCookie(pkceCookie, '', 0), { append: true });
      c.header('cache-control', 'no-store');
      c.header('referrer-policy', 'no-referrer');
      return c.redirect(`${hubPath}/#/${hash}`, 302);
    };
    if (u.searchParams.get('error') || u.searchParams.get('error_code')) {
      return back(`signin?notice=${u.searchParams.get('error_code') === 'otp_expired' ? 'link-expired' : 'link-invalid'}`);
    }
    if (!code) return back('signin?notice=link-invalid');
    // The email was confirmed by Supabase before it redirected here; without the verifier
    // (another browser or device) the visitor simply signs in.
    if (!verifier) return back(`signin?notice=${next === 'reset' ? 'reset-other-browser' : 'confirmed'}`);
    const { status: st, data } = await gotrue(c.req.raw, 'POST', '/token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
    if (st !== 200 || !data) return back('signin?notice=link-invalid');
    const s = await startSession(data);
    if (!s) return back('signin?notice=link-invalid');
    c.header('set-cookie', s.cookie, { append: true });
    return back(next === 'reset' ? 'reset' : '');
  });

  // Personal API tokens: managed from a browser session only, never with another token.
  const sessionOnly = async (c: Context): Promise<Resolved | Response> => {
    const r = await sessionFor(c.req.raw, true);
    if (!r) return problem(401, 'Not signed in', 'sign in to the dashboard to manage API tokens');
    if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c.req.raw)) return problem(403, 'Cross-site request refused');
    if (r.setCookie) c.header('set-cookie', r.setCookie);
    return r;
  };

  const rowToToken = (r: Record<string, unknown>): ApiToken => ({
    id: String(r.id),
    userId: String(r.user_id),
    name: String(r.name),
    prefix: String(r.prefix),
    createdAt: Number(r.created_at),
    lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
    revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
  });

  routes.get('/auth/tokens', async (c) => {
    const r = await sessionOnly(c);
    if (r instanceof Response) return r;
    const rows = await sql.query(`SELECT * FROM ${T} WHERE user_id = $1 ORDER BY created_at DESC`, [r.principal.user.id]);
    c.header('cache-control', 'no-store');
    return c.json({ tokens: rows.map(rowToToken) });
  });

  routes.post('/auth/tokens', async (c) => {
    const r = await sessionOnly(c);
    if (r instanceof Response) return r;
    const body = tokenBody.parse(await c.req.json().catch(() => ({})));
    const raw = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const prefix = raw.slice(0, TOKEN_PREFIX.length + 6);
    const id = randomUUID();
    const createdAt = now();
    await sql.query(`INSERT INTO ${T} (id, user_id, name, prefix, token_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [
      id,
      r.principal.user.id,
      body.name,
      prefix,
      sha256(raw),
      createdAt,
    ]);
    c.header('cache-control', 'no-store');
    return c.json({ token: raw, id, name: body.name, prefix, createdAt }, 201);
  });

  routes.delete('/auth/tokens/:id', async (c) => {
    const r = await sessionOnly(c);
    if (r instanceof Response) return r;
    const rows = await sql.query(`UPDATE ${T} SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`, [
      c.req.param('id'),
      r.principal.user.id,
      now(),
    ]);
    if (rows.length === 0) return problem(404, 'Token not found');
    return c.body(null, 204);
  });

  function requireUser(): MiddlewareHandler {
    return async (c, next) => {
      const r = await resolve(c.req.raw, true);
      if (!r) return problem(401, 'Not signed in', 'sign in, or send a personal API token as a bearer', { 'www-authenticate': 'Bearer' });
      if (r.principal.via === 'session' && !SAFE_METHODS.has(c.req.method) && !sameOrigin(c.req.raw)) {
        return problem(403, 'Cross-site request refused');
      }
      c.set('principal' as never, r.principal as never);
      await next();
      if (r.setCookie) c.res.headers.append('set-cookie', r.setCookie);
    };
  }

  return {
    routes,
    // Without a response to carry a rotated cookie, an expired session is simply "not signed in" here.
    authenticate: async (req) => (await resolve(req, false))?.principal ?? null,
    requireUser,
    principal: (c) => (c.get('principal' as never) as Principal | undefined) ?? null,
    status,
    cookieName,
    migrate: () => migrate(sql, schema, accountsMigrations),
  };
}
