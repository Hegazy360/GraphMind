/**
 * Acme Tasks' own sign-in: a small OpenID Connect provider, so the example
 * looks like a real product (users log in with a password and the API
 * accepts the access tokens it issues). Jack's `oidc` mode federates to it
 * exactly as it would to Auth0, Okta, Cognito, Keycloak or Entra.
 *
 * Deliberately minimal and NOT for production use: in-memory state,
 * demo passwords, one signing key per process. What it does implement
 * correctly is what Jack relies on: authorization code + PKCE, exact
 * redirect URI matching, confidential client auth, nonce in the id_token,
 * scoped access tokens, rotating refresh tokens.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, createLocalJWKSet, type CryptoKey, type JWK } from 'jose';
import type { TasksStore } from './store.js';

export const API_AUDIENCE = 'acme-tasks-api';
export const SCOPES = { 'tasks:read': 'Read your projects, tasks and comments', 'tasks:write': 'Create and change tasks, projects and comments' } as const;
export type Scope = keyof typeof SCOPES;

/** Demo users' passwords (printed by `pnpm start` on purpose). */
export const DEMO_PASSWORDS: Record<string, { userId: string; password: string }> = {
  alice: { userId: 'usr_alice', password: 'alice-password' },
  bob: { userId: 'usr_bob', password: 'bob-password' },
};

export interface OidcClient {
  secret: string;
  name: string;
  redirectUris: string[];
}

export interface IdpOptions {
  issuer: string;
  clients: Record<string, OidcClient>;
  store: TasksStore;
  accessTokenTtlSeconds?: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');
const token = () => randomBytes(24).toString('base64url');

function loginPage(params: Record<string, string>, clientName: string, error?: string) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>Sign in to Acme Tasks</title>
<style>body{font:15px system-ui;background:#eef2ff;display:flex;justify-content:center;padding:60px}form{background:#fff;padding:28px;border-radius:12px;width:340px}input[type=text],input[type=password]{width:100%;padding:8px;margin:4px 0 12px;box-sizing:border-box}button{width:100%;padding:10px;background:#4f46e5;color:#fff;border:0;border-radius:8px;font-weight:600}</style>
<form id="acme-login" method="post" action="/oauth/authorize">
<h2>Acme Tasks</h2><p><b>${esc(clientName)}</b> wants to access your account.</p>
${error ? `<p style="color:#b91c1c">${esc(error)}</p>` : ''}
${hidden}
<label>Username <input type="text" name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>
<p style="font-size:12px;color:#6b7280">Demo users: alice / alice-password · bob / bob-password</p>
</form>`;
}

export async function createIdp(opts: IdpOptions) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const kid = `acme-${randomBytes(4).toString('hex')}`;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const ttl = opts.accessTokenTtlSeconds ?? 600;

  const codes = new Map<string, { userId: string; clientId: string; redirectUri: string; scope: string[]; nonce?: string; challenge?: string; exp: number }>();
  const refreshTokens = new Map<string, { userId: string; clientId: string; scope: string[] }>();

  const sign = (claims: Record<string, unknown>, sub: string, aud: string, seconds: number) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setIssuer(opts.issuer)
      .setSubject(sub)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(`${seconds}s`)
      .sign(privateKey as CryptoKey);

  async function issue(userId: string, clientId: string, scope: string[], nonce?: string) {
    const user = opts.store.users.get(userId)!;
    const apiScopes = scope.filter((s): s is Scope => s in SCOPES);
    const refresh = token();
    refreshTokens.set(refresh, { userId, clientId, scope });
    return {
      token_type: 'Bearer',
      expires_in: ttl,
      scope: scope.join(' '),
      access_token: await sign({ scope: apiScopes.join(' '), client_id: clientId }, userId, API_AUDIENCE, ttl),
      refresh_token: refresh,
      ...(scope.includes('openid')
        ? { id_token: await sign({ ...(nonce ? { nonce } : {}), name: user.name, email: user.email }, userId, clientId, 3600) }
        : {}),
    };
  }

  const app = new Hono();

  app.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer: opts.issuer,
      authorization_endpoint: `${opts.issuer}/oauth/authorize`,
      token_endpoint: `${opts.issuer}/oauth/token`,
      jwks_uri: `${opts.issuer}/oauth/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['openid', 'profile', 'email', ...Object.keys(SCOPES)],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    }),
  );
  app.get('/oauth/jwks', (c) => c.json({ keys: [jwk] }));

  /** Exact match, except loopback http URIs may use any port (RFC 8252 §7.3). */
  const redirectAllowed = (registered: string[], requested: string) => {
    if (registered.includes(requested)) return true;
    let req: URL;
    try {
      req = new URL(requested);
    } catch {
      return false;
    }
    if (req.protocol !== 'http:' || req.hostname !== '127.0.0.1') return false;
    return registered.some((r) => {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.pathname === req.pathname && u.search === req.search;
    });
  };

  const validate = (q: Record<string, string>) => {
    const client = opts.clients[q.client_id ?? ''];
    if (!client) return 'unknown client_id';
    if (!redirectAllowed(client.redirectUris, q.redirect_uri ?? '')) return 'redirect_uri is not registered for this client';
    if (q.response_type !== 'code') return 'only response_type=code is supported';
    if (q.code_challenge && q.code_challenge_method !== 'S256') return 'only S256 PKCE is supported';
    return null;
  };

  app.get('/oauth/authorize', (c) => {
    const q = c.req.query();
    const problem = validate(q);
    if (problem) return c.html(`<h1>Sign-in error</h1><p>${esc(problem)}</p>`, 400);
    return c.html(loginPage(q, opts.clients[q.client_id!]!.name));
  });

  app.post('/oauth/authorize', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    const { username = '', password = '', ...q } = f;
    const problem = validate(q);
    if (problem) return c.html(`<h1>Sign-in error</h1><p>${esc(problem)}</p>`, 400);
    const account = DEMO_PASSWORDS[username.toLowerCase()];
    if (!account || account.password !== password) return c.html(loginPage(q, opts.clients[q.client_id!]!.name, 'Wrong username or password.'), 401);
    const code = token();
    const scope = (q.scope ?? 'openid').split(' ').filter((s) => s === 'openid' || s === 'profile' || s === 'email' || s in SCOPES);
    codes.set(code, {
      userId: account.userId,
      clientId: q.client_id!,
      redirectUri: q.redirect_uri!,
      scope,
      ...(q.nonce ? { nonce: q.nonce } : {}),
      ...(q.code_challenge ? { challenge: q.code_challenge } : {}),
      exp: Date.now() + 60_000,
    });
    const to = new URL(q.redirect_uri!);
    to.searchParams.set('code', code);
    if (q.state) to.searchParams.set('state', q.state);
    return c.redirect(to.href, 302);
  });

  app.post('/oauth/token', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    // Confidential clients: HTTP Basic (preferred) or client_secret_post.
    let clientId = f.client_id;
    let secret = f.client_secret;
    const basic = c.req.header('authorization');
    if (basic?.startsWith('Basic ')) {
      const [id, pw] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id ?? '');
      secret = decodeURIComponent(pw ?? '');
    }
    const client = opts.clients[clientId ?? ''];
    if (!client || client.secret !== secret) return c.json({ error: 'invalid_client' }, 401);

    if (f.grant_type === 'authorization_code') {
      const rec = codes.get(f.code ?? '');
      codes.delete(f.code ?? '');
      if (!rec || rec.exp < Date.now() || rec.clientId !== clientId || rec.redirectUri !== f.redirect_uri) return c.json({ error: 'invalid_grant' }, 400);
      if (rec.challenge && sha256(f.code_verifier ?? '') !== rec.challenge) return c.json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
      return c.json(await issue(rec.userId, clientId!, rec.scope, rec.nonce), 200, { 'cache-control': 'no-store' });
    }
    if (f.grant_type === 'refresh_token') {
      const rec = refreshTokens.get(f.refresh_token ?? '');
      refreshTokens.delete(f.refresh_token ?? ''); // rotate
      if (!rec || rec.clientId !== clientId) return c.json({ error: 'invalid_grant' }, 400);
      const { id_token: _noIdToken, ...rest } = await issue(rec.userId, clientId!, rec.scope);
      return c.json(rest, 200, { 'cache-control': 'no-store' });
    }
    return c.json({ error: 'unsupported_grant_type' }, 400);
  });

  /** For the API: verify an access token this provider issued. */
  async function verifyAccessToken(t: string): Promise<{ userId: string; scopes: Scope[] } | null> {
    try {
      const { payload } = await jwtVerify(t, jwks, { issuer: opts.issuer, audience: API_AUDIENCE, algorithms: ['ES256'] });
      return { userId: String(payload.sub), scopes: String(payload.scope ?? '').split(' ').filter((s): s is Scope => s in SCOPES) };
    } catch {
      return null;
    }
  }

  return { app, verifyAccessToken };
}
