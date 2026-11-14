/**
 * createAccounts — self-serve accounts for a GraphMind dashboard server.
 *
 *   POST /auth/signup   { email, password, name? }  → 201 { user }   sets the session cookie
 *   POST /auth/login    { email, password }         → 200 { user }   sets the session cookie
 *   POST /auth/logout                               → 204            clears it
 *   GET  /auth/me                                   → 200 { user, via } | 401
 *   GET  /auth/status                               → 200 { accounts: true, signup, users }
 *   GET  /auth/tokens                               → 200 { tokens }          (session only)
 *   POST /auth/tokens   { name }                    → 201 { token, ... }      shown once
 *   DELETE /auth/tokens/:id                         → 204
 *
 * Two credentials are accepted on protected routes: the session cookie the
 * browser holds (HttpOnly, SameSite=Lax, Secure on https) and a personal API
 * token (`Authorization: Bearer gmt_…`) for CLIs such as `jack deploy`.
 * Session-authenticated requests that change state must come from the
 * server's own origin (Origin / Sec-Fetch-Site), which is the CSRF defence.
 *
 * Registration is open by default (`allowSignup: true`): there are no plans,
 * quotas or payment here, by decision. Errors follow RFC 9457.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { hashPassword, verifyPassword } from './password.js';
import { EmailTakenError, type AccountStore, type User } from './store.js';

export interface AccountsOptions {
  store: AccountStore;
  /** The origin browsers use to reach this server, e.g. https://app.graphmind.ai or http://127.0.0.1:4820. */
  publicOrigin: string;
  /** Anyone may create an account (default true). */
  allowSignup?: boolean;
  /** Session lifetime; default 30 days. */
  sessionTtlMs?: number;
  /** Failed sign-ins allowed per (address, email) in the window; default 10 per 15 minutes. */
  loginRateLimit?: { max: number; windowMs: number };
  now?: () => number;
}

export interface Principal {
  user: User;
  via: 'session' | 'token';
}

export interface Accounts {
  /** Mount on the app: `app.route('/', accounts.routes)`. */
  routes: Hono;
  /** Resolve the caller, or null. Never throws. */
  authenticate(req: Request): Promise<Principal | null>;
  /** Middleware for protected routes: 401 without a principal, 403 on a cross-site session mutation. */
  requireUser(): MiddlewareHandler;
  /** The principal `requireUser()` stored on the context. */
  principal(c: Context): Principal | null;
  /** Public state for health endpoints and dashboards. */
  status(): { accounts: true; signup: boolean; users: number };
  cookieName: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .refine((v) => EMAIL_RE.test(v), 'enter a valid email address');
const password = z.string().min(10, 'use at least 10 characters').max(256);
const signupBody = z.object({ email, password, name: z.string().trim().min(1).max(120).optional() });
const loginBody = z.object({ email, password: z.string().min(1).max(256) });
const tokenBody = z.object({ name: z.string().trim().min(1).max(80).default('cli') });

const TOKEN_PREFIX = 'gmt_';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function problem(status: number, title: string, detail?: string, headers: Record<string, string> = {}) {
  return Response.json(
    { type: 'about:blank', title, status, ...(detail !== undefined ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && out[k] === undefined) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** A sliding-window counter for failed sign-ins, in memory (one process; the hosted tier adds a shared one). */
class Attempts {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}
  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }
  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }
  fail(key: string): void {
    if (this.hits.size > 10_000) this.hits.clear(); // a bound, not a policy
    this.hits.set(key, [...this.recent(key), this.now()]);
  }
  clear(key: string): void {
    this.hits.delete(key);
  }
}

export function createAccounts(opts: AccountsOptions): Accounts {
  const { store } = opts;
  const now = opts.now ?? (() => Date.now());
  const allowSignup = opts.allowSignup ?? true;
  const ttl = opts.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  const origin = new URL(opts.publicOrigin).origin;
  const secure = origin.startsWith('https:');
  const cookieName = secure ? '__Host-gm_session' : 'gm_session';
  const limit = opts.loginRateLimit ?? { max: 10, windowMs: 15 * 60 * 1000 };
  const attempts = new Attempts(limit.max, limit.windowMs, now);

  const cookie = (value: string, maxAgeSec: number) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;

  const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt });

  const clientKey = (req: Request, mail: string) => {
    const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    return `${fwd ?? 'local'}|${mail}`;
  };

  function sessionFor(req: Request): Principal | null {
    const raw = parseCookies(req.headers.get('cookie') ?? undefined)[cookieName];
    if (!raw) return null;
    const s = store.getSession(sha256(raw));
    if (!s) return null;
    if (s.expiresAt <= now()) {
      store.deleteSession(sha256(raw));
      return null;
    }
    const user = store.getUser(s.userId);
    if (!user) return null;
    if (now() - s.lastSeenAt > 60_000) store.touchSession(s.id, now());
    return { user, via: 'session' };
  }

  function tokenFor(req: Request): Principal | null {
    const header = req.headers.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const raw = header.slice(7).trim();
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const t = store.getTokenByHash(sha256(raw));
    if (!t || t.revokedAt !== null) return null;
    const user = store.getUser(t.userId);
    if (!user) return null;
    if (t.lastUsedAt === null || now() - t.lastUsedAt > 60_000) store.touchToken(t.id, now());
    return { user, via: 'token' };
  }

  async function authenticate(req: Request): Promise<Principal | null> {
    return tokenFor(req) ?? sessionFor(req);
  }

  /** Same-origin check for session-authenticated state changes. */
  function sameOrigin(req: Request): boolean {
    const o = req.headers.get('origin');
    if (o !== null) return o === origin;
    const site = req.headers.get('sec-fetch-site');
    return site === 'same-origin' || site === 'none';
  }

  function startSession(user: User): string {
    const raw = randomBytes(32).toString('base64url');
    store.createSession({ tokenHash: sha256(raw), userId: user.id, expiresAt: now() + ttl });
    return cookie(raw, Math.floor(ttl / 1000));
  }

  const routes = new Hono();

  routes.onError((err) => {
    if (err instanceof z.ZodError) return problem(400, 'Invalid request body', z.prettifyError(err));
    if (err instanceof SyntaxError) return problem(400, 'Invalid JSON', err.message);
    if (err instanceof EmailTakenError) return problem(409, 'Email taken', err.message);
    console.error('[accounts] unhandled:', err);
    return problem(500, 'Internal error');
  });

  routes.get('/auth/status', (c) => c.json(status()));

  routes.post('/auth/signup', async (c) => {
    if (!allowSignup) return problem(403, 'Sign-up closed', 'this server does not accept new accounts');
    if (!sameOrigin(c.req.raw)) return problem(403, 'Cross-site request refused');
    const body = signupBody.parse(await c.req.json());
    const user = store.createUser({ email: body.email, passwordHash: await hashPassword(body.password), name: body.name ?? null });
    c.header('set-cookie', startSession(user));
    c.header('cache-control', 'no-store');
    return c.json({ user: publicUser(user) }, 201);
  });

  routes.post('/auth/login', async (c) => {
    if (!sameOrigin(c.req.raw)) return problem(403, 'Cross-site request refused');
    const body = loginBody.parse(await c.req.json());
    const key = clientKey(c.req.raw, body.email);
    if (attempts.blocked(key)) return problem(429, 'Too many attempts', 'wait a few minutes and try again', { 'retry-after': String(Math.ceil(limit.windowMs / 1000)) });
    const user = store.getUserByEmail(body.email);
    // Verify against a real hash even for unknown emails so timing does not reveal which emails exist.
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : await verifyPassword(body.password, DUMMY_HASH).then(() => false);
    if (!ok || !user) {
      attempts.fail(key);
      return problem(401, 'Sign-in failed', 'wrong email or password');
    }
    attempts.clear(key);
    c.header('set-cookie', startSession(user));
    c.header('cache-control', 'no-store');
    return c.json({ user: publicUser(user) });
  });

  routes.post('/auth/logout', (c) => {
    const raw = parseCookies(c.req.header('cookie'))[cookieName];
    if (raw) store.deleteSession(sha256(raw));
    c.header('set-cookie', cookie('', 0));
    return c.body(null, 204);
  });

  routes.get('/auth/me', async (c) => {
    const p = await authenticate(c.req.raw);
    if (!p) return problem(401, 'Not signed in');
    c.header('cache-control', 'no-store');
    return c.json({ user: publicUser(p.user), via: p.via });
  });

  // Personal API tokens: managed from a browser session only, never with another token.
  const sessionOnly = async (c: Context): Promise<Principal | Response> => {
    const p = sessionFor(c.req.raw);
    if (!p) return problem(401, 'Not signed in', 'sign in to the dashboard to manage API tokens');
    if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c.req.raw)) return problem(403, 'Cross-site request refused');
    return p;
  };

  routes.get('/auth/tokens', async (c) => {
    const p = await sessionOnly(c);
    if (p instanceof Response) return p;
    return c.json({ tokens: store.listTokens(p.user.id) });
  });

  routes.post('/auth/tokens', async (c) => {
    const p = await sessionOnly(c);
    if (p instanceof Response) return p;
    const body = tokenBody.parse(await c.req.json().catch(() => ({})));
    const raw = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const prefix = raw.slice(0, TOKEN_PREFIX.length + 6);
    const t = store.createToken({ userId: p.user.id, name: body.name, prefix, tokenHash: sha256(raw) });
    c.header('cache-control', 'no-store');
    return c.json({ token: raw, id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt }, 201);
  });

  routes.delete('/auth/tokens/:id', async (c) => {
    const p = await sessionOnly(c);
    if (p instanceof Response) return p;
    if (!store.revokeToken(p.user.id, c.req.param('id'))) return problem(404, 'Token not found');
    return c.body(null, 204);
  });

  function requireUser(): MiddlewareHandler {
    return async (c, next) => {
      const p = await authenticate(c.req.raw);
      if (!p) return problem(401, 'Not signed in', 'sign in, or send a personal API token as a bearer', { 'www-authenticate': 'Bearer' });
      if (p.via === 'session' && !SAFE_METHODS.has(c.req.method) && !sameOrigin(c.req.raw)) {
        return problem(403, 'Cross-site request refused');
      }
      c.set('principal' as never, p as never);
      await next();
    };
  }

  function status() {
    return { accounts: true as const, signup: allowSignup, users: store.countUsers() };
  }

  return {
    routes,
    authenticate,
    requireUser,
    principal: (c) => (c.get('principal' as never) as Principal | undefined) ?? null,
    status,
    cookieName,
  };
}

/** A valid scrypt hash of a random password, so unknown-email sign-ins cost the same as wrong-password ones. */
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
