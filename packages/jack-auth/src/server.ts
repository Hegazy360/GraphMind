/**
 * The authorization server for ONE project (one issuer, one MCP resource).
 *
 *   AI client ──/oauth/authorize──▶ Jack ──(oidc: customer IdP | apikey: Jack's page)──▶ consent
 *            ◀──code──             Jack ◀───────────── user ─────────────────────────────┘
 *            ──/oauth/token (PKCE)──▶ access token (JWT, aud = MCP URL, 15 min) + rotating refresh token
 *            ──/mcp  Bearer ─────────▶ protect(): verify → step-up check → runtime (+ upstream credential)
 *
 * MCP 2026-07-28 authorization: RFC 9728 protected resource metadata,
 * RFC 8414 server metadata, OAuth 2.1 code + PKCE S256 only, RFC 8707
 * resource binding, RFC 9207 `iss` in the response, CIMD first with DCR as
 * a fallback, no token passthrough. The customer's credentials never leave
 * this module except as headers on an upstream request.
 */
import { createLocalJWKSet, jwtVerify, SignJWT } from 'jose';
import { Hono, type Context } from 'hono';
import { bearerAuthChallengeResponse, OAuthError, OAuthErrorCode, verifyBearerToken, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { Manifest } from '@graphmind-ai/jack-schema';
import { CredentialError, guardedFetch, type CredentialResolver, type EgressPolicy } from '@graphmind-ai/jack-runtime';
import { ClientError, ClientRegistry, redirectMatches, type ClientFetch, type ResolvedClient } from './clients.js';
import { randomToken, safeEqual, SecretBox, sha256, verifyPkce } from './crypto.js';
import { KeyRing } from './keys.js';
import { apiKeyPage, consentPage, errorPage, PAGE_HEADERS } from './pages.js';
import type { AuthRequestRecord, AuthStore, GrantRecord } from './store.js';
import {
  apiKeyHeaders,
  identifyApiKey,
  LinkProvider,
  OidcProvider,
  UpstreamAuthError,
  type Fetcher,
  type Identity,
  type ResolvedAuth,
  type UpstreamCredential,
} from './upstream.js';

export interface AuthEvent {
  type: 'client.registered' | 'grant.created' | 'grant.revoked' | 'code.replayed' | 'refresh.replayed' | 'signin.failed';
  clientId?: string;
  grantId?: string;
  detail?: string;
}

export interface AuthServerOptions {
  /** Origin of this project's authorization server, e.g. https://acme.mcp.graphmind.ai */
  issuer: string;
  /** The MCP endpoint tokens are bound to, e.g. https://acme.mcp.graphmind.ai/mcp */
  resource: string;
  projectName: string;
  manifest: () => Manifest;
  auth: ResolvedAuth;
  store: AuthStore;
  /** 32 bytes; seals upstream credentials and signing keys at rest. */
  secretKey: Uint8Array;
  /** Egress policy for calls to the customer's API and identity provider. */
  egress: EgressPolicy;
  /** How CIMD documents are fetched. Default: https only, public addresses only. */
  fetchClientMetadata?: ClientFetch;
  /** How the identity provider is reached. Default: guardedFetch with `egress`. */
  fetcher?: Fetcher;
  now?: () => number;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  dcrLimitPerHour?: number;
  onEvent?: (e: AuthEvent) => void;
}

export interface AuthServer {
  /**
   * Every route, at absolute paths: `<issuer path>/oauth/*` and the
   * `/.well-known/*` documents (path-inserted per RFC 8414 / RFC 9728 when the
   * issuer has a path). Forward requests to `routes.fetch` unchanged.
   */
  routes: Hono;
  verifier: OAuthTokenVerifier;
  /** For the runtime: the signed-in user's upstream credential as headers. */
  credentials: CredentialResolver;
  /** Wrap the MCP handler: bearer auth (401 + resource_metadata), step-up (403 insufficient_scope). */
  protect(mcp: (req: Request, authInfo: AuthInfo) => Promise<Response>): (req: Request) => Promise<Response>;
  resourceMetadataUrl: string;
  listGrants(): GrantRecord[];
  revokeGrant(id: string): void;
}

const COOKIE = 'jack_signin';
const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;

const oauthError = (c: Context, status: number, error: string, description: string) =>
  c.json({ error, error_description: description }, status as 400, { 'cache-control': 'no-store', pragma: 'no-cache' });

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function createAuthServer(opts: AuthServerOptions): AuthServer {
  const now = opts.now ?? (() => Date.now());
  // The issuer may carry a path (one origin hosting many projects: https://host/p/acme).
  const issuerUrl = new URL(opts.issuer);
  if (issuerUrl.search || issuerUrl.hash) throw new Error('issuer must not have a query or fragment');
  const issuerPath = issuerUrl.pathname.replace(/\/+$/, '');
  const issuer = `${issuerUrl.origin}${issuerPath}`;
  const issuerOrigin = issuerUrl.origin;
  const P = issuerPath; // route prefix
  const resource = opts.resource.replace(/\/$/, '');
  const resourcePath = new URL(resource).pathname;
  const resourceMetadataUrl = `${new URL(resource).origin}/.well-known/oauth-protected-resource${resourcePath === '/' ? '' : resourcePath}`;
  const box = new SecretBox(opts.secretKey);
  const keys = new KeyRing(opts.store, box, now);
  const secure = new URL(issuer).protocol === 'https:';
  const accessTtl = opts.accessTokenTtlSeconds ?? 900;
  const refreshTtl = opts.refreshTokenTtlSeconds ?? 30 * 86_400;
  const emit = (e: AuthEvent) => opts.onEvent?.(e);

  const fetcher: Fetcher =
    opts.fetcher ?? ((url, init) => guardedFetch(url, init ?? {}, { policy: opts.egress, timeoutMs: 10_000, maxResponseBytes: 512 * 1024 }));
  const fetchCimd: ClientFetch =
    opts.fetchClientMetadata ??
    ((url) => {
      if (url.protocol !== 'https:') return Promise.reject(new Error('client metadata documents must be served over https'));
      return guardedFetch(url, {}, { policy: 'public', timeoutMs: 3_000, maxResponseBytes: 5 * 1024 });
    });
  const registry = new ClientRegistry(opts.store, fetchCimd, now, opts.dcrLimitPerHour ?? 50);
  const oidc = opts.auth.mode === 'oidc' ? new OidcProvider(opts.auth.oidc, fetcher, now) : null;
  const link = opts.auth.mode === 'link' ? new LinkProvider(opts.auth.link, issuer, opts.manifest().upstream, now) : null;
  const upstreamCallback = `${issuer}/oauth/upstream/callback`;
  const linkCallback = `${issuer}/oauth/link/callback`;

  const scopesSupported = () => opts.manifest().scopes;
  let lastSweep = 0;

  // ------------------------------------------------------------ helpers --

  const redirectTo = (uri: string, params: Record<string, string | null | undefined>) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { location: u.href, 'cache-control': 'no-store' } });
  };
  const page = (html: string, status = 200, extra: Record<string, string> = {}) => new Response(html, { status, headers: { ...PAGE_HEADERS, ...extra } });

  /** Load an in-flight sign-in, enforcing expiry and that it belongs to THIS browser. */
  function loadRequest(c: Context, id: string | undefined): { ok: true; r: AuthRequestRecord } | { ok: false; res: Response } {
    if (!id) return { ok: false, res: page(errorPage('Sign-in not found', 'This sign-in link is incomplete.'), 400) };
    const r = opts.store.getAuthRequest(id);
    if (!r || r.expiresAt < now()) return { ok: false, res: page(errorPage('Sign-in expired', 'This sign-in took too long or was already finished.'), 400) };
    const cookie = cookieValue(c.req.header('cookie'), COOKIE);
    if (!cookie || !safeEqual(sha256(cookie), r.browserHash)) {
      return { ok: false, res: page(errorPage('Sign-in started elsewhere', 'Finish signing in in the same browser where you started.'), 403) };
    }
    return { ok: true, r };
  }

  /** Same-origin POSTs only (with the cookie binding, this is the CSRF defence). */
  function sameOrigin(c: Context): boolean {
    const origin = c.req.header('origin');
    return origin === undefined || origin === issuerOrigin;
  }

  const failToClient = (r: AuthRequestRecord, error: string, description: string) => {
    opts.store.deleteAuthRequest(r.id);
    return redirectTo(r.redirectUri, { error, error_description: description, state: r.state, iss: issuer });
  };

  async function issueTokens(grant: GrantRecord, scopes: string[]) {
    const key = await keys.signingKey();
    const iat = Math.floor(now() / 1000);
    const accessToken = await new SignJWT({ scope: scopes.join(' '), client_id: grant.clientId, grant_id: grant.id })
      .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject(grant.subject)
      .setIssuedAt(iat)
      .setNotBefore(iat)
      .setExpirationTime(iat + accessTtl)
      .setJti(randomToken(12))
      .sign(key.privateKey);
    const refreshToken = `jrt_${randomToken(32)}`;
    opts.store.putRefresh({ tokenHash: sha256(refreshToken), grantId: grant.id, expiresAt: now() + refreshTtl * 1000, rotatedAt: null });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: accessTtl, refresh_token: refreshToken, scope: scopes.join(' ') };
  }

  function revoke(grantId: string, why: AuthEvent['type'] = 'grant.revoked', detail?: string) {
    const g = opts.store.getGrant(grantId);
    if (!g || g.revokedAt !== null) return;
    opts.store.revokeGrant(grantId, now());
    emit({ type: why, grantId, clientId: g.clientId, ...(detail ? { detail } : {}) });
    if (why !== 'grant.revoked') emit({ type: 'grant.revoked', grantId, clientId: g.clientId, detail: why });
  }

  // ------------------------------------------------------------- routes --

  const app = new Hono();

  const prm = () => ({
    resource,
    authorization_servers: [issuer],
    scopes_supported: scopesSupported(),
    bearer_methods_supported: ['header'],
    resource_name: opts.projectName,
  });
  if (resourcePath === '/' || resourcePath === '') app.get('/.well-known/oauth-protected-resource', (c) => c.json(prm()));
  else app.get(`/.well-known/oauth-protected-resource${resourcePath}`, (c) => c.json(prm()));

  // RFC 8414 §3.1: for an issuer with a path, the path goes AFTER the well-known segment.
  app.get(`/.well-known/oauth-authorization-server${P}`, (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      jwks_uri: `${issuer}/oauth/jwks`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: scopesSupported(),
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }),
  );

  app.get(`${P}/oauth/jwks`, async (c) => {
    await keys.signingKey(); // make sure one exists before anyone asks
    return c.json(keys.jwks(), 200, { 'cache-control': 'public, max-age=300' });
  });

  app.post(`${P}/oauth/register`, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return oauthError(c, 400, 'invalid_client_metadata', 'expected a JSON object');
    try {
      const registered = registry.register(body);
      emit({ type: 'client.registered', clientId: String(registered.client_id) });
      return c.json(registered, 201, { 'cache-control': 'no-store' });
    } catch (err) {
      if (err instanceof ClientError) return oauthError(c, err.code === 'temporarily_unavailable' ? 429 : 400, err.code, err.message);
      throw err;
    }
  });

  app.get(`${P}/oauth/authorize`, async (c) => {
    if (now() - lastSweep > 300_000) {
      lastSweep = now();
      opts.store.sweep(now());
    }
    const q = c.req.query();
    // Until client_id and redirect_uri are validated, never redirect anywhere: show an error page.
    if (!q.client_id) return page(errorPage('Invalid sign-in request', 'client_id is missing.'), 400);
    let client: ResolvedClient;
    try {
      client = await registry.resolve(q.client_id);
    } catch (err) {
      return page(errorPage('Unknown app', err instanceof ClientError ? err.message : 'the app could not be identified'), 400);
    }
    if (!q.redirect_uri || !redirectMatches(client.redirectUris, q.redirect_uri)) {
      return page(errorPage('Invalid sign-in request', 'The app sent a redirect address it did not register.'), 400);
    }
    const back = (error: string, description: string) => redirectTo(q.redirect_uri!, { error, error_description: description, state: q.state, iss: issuer });
    if (q.response_type !== 'code') return back('unsupported_response_type', 'only response_type=code is supported');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return back('invalid_request', 'code_challenge is not a S256 challenge');
    if (!q.resource) return back('invalid_target', `the resource parameter is required (${resource})`);
    if (q.resource.replace(/\/$/, '') !== resource) return back('invalid_target', `this server issues tokens only for ${resource}`);
    const supported = scopesSupported();
    const requested = q.scope ? q.scope.split(' ').filter(Boolean) : supported;
    const unknown = requested.filter((s) => !supported.includes(s));
    if (unknown.length > 0) return back('invalid_scope', `unknown scope(s): ${unknown.join(', ')}`);

    const id = `jar_${randomToken(18)}`;
    const binding = randomToken(24);
    const record: AuthRequestRecord = {
      id,
      clientId: client.clientId,
      redirectUri: q.redirect_uri,
      codeChallenge: q.code_challenge,
      state: q.state ?? null,
      scopes: [...new Set(requested)],
      resource,
      browserHash: sha256(binding),
      data: {},
      expiresAt: now() + REQUEST_TTL_MS,
    };
    const cookie = `${COOKIE}=${binding}; Path=${P}/oauth; HttpOnly; SameSite=Lax; Max-Age=${REQUEST_TTL_MS / 1000}${secure ? '; Secure' : ''}`;

    if (opts.auth.mode === 'oidc' && oidc) {
      let start;
      try {
        start = await oidc.start(upstreamCallback, record.scopes);
      } catch (err) {
        emit({ type: 'signin.failed', clientId: client.clientId, detail: err instanceof Error ? err.message : String(err) });
        return back('temporarily_unavailable', 'the sign-in provider is unavailable');
      }
      // The upstream state carries our request id, so the callback can find the request.
      record.data = { upstreamState: `${id}.${start.state}`, nonce: start.nonce, verifier: start.verifier };
      opts.store.putAuthRequest(record);
      const to = new URL(start.url);
      to.searchParams.set('state', `${id}.${start.state}`);
      return new Response(null, { status: 302, headers: { location: to.href, 'set-cookie': cookie, 'cache-control': 'no-store' } });
    }
    if (link) {
      opts.store.putAuthRequest(record);
      return new Response(null, { status: 302, headers: { location: link.start(id, linkCallback, record.scopes), 'set-cookie': cookie, 'cache-control': 'no-store' } });
    }
    if (opts.auth.mode === 'none') {
      const anon: Identity = { subject: `anon:${randomToken(12)}`, display: 'Guest' };
      record.data = { identity: anon, sealed: box.seal(JSON.stringify({ kind: 'none' } satisfies UpstreamCredential), `req:${id}`) };
    }
    opts.store.putAuthRequest(record);
    const next = opts.auth.mode === 'apikey' ? `/oauth/apikey?request=${id}` : `/oauth/consent?request=${id}`;
    return new Response(null, { status: 302, headers: { location: `${issuer}${next}`, 'set-cookie': cookie, 'cache-control': 'no-store' } });
  });

  app.get(`${P}/oauth/upstream/callback`, async (c) => {
    const state = c.req.query('state') ?? '';
    const loaded = loadRequest(c, state.split('.')[0]);
    if (!loaded.ok) return loaded.res;
    const r = loaded.r;
    if (typeof r.data.upstreamState !== 'string' || !safeEqual(r.data.upstreamState, state)) {
      return page(errorPage('Sign-in failed', 'The sign-in response does not match this sign-in.'), 400);
    }
    if (c.req.query('error')) return failToClient(r, 'access_denied', 'sign-in was cancelled at the identity provider');
    const code = c.req.query('code');
    if (!code || !oidc) return failToClient(r, 'server_error', 'the identity provider returned no code');
    try {
      const { identity, credential } = await oidc.finish(code, upstreamCallback, { nonce: String(r.data.nonce), verifier: String(r.data.verifier) });
      opts.store.updateAuthRequest(r.id, { identity, sealed: box.seal(JSON.stringify(credential), `req:${r.id}`) });
    } catch (err) {
      emit({ type: 'signin.failed', clientId: r.clientId, detail: err instanceof Error ? err.message : String(err) });
      return failToClient(r, 'access_denied', err instanceof UpstreamAuthError ? err.message : 'sign-in failed');
    }
    return new Response(null, { status: 302, headers: { location: `${issuer}/oauth/consent?request=${r.id}`, 'cache-control': 'no-store' } });
  });

  // The customer's app sends the user back here with its signed response. The
  // request id is inside the response token; the browser cookie proves it is
  // the same browser that started, and the signature proves the app answered.
  app.get(`${P}/oauth/link/callback`, (c) => {
    const response = c.req.query('response') ?? '';
    let requestId = '';
    try {
      requestId = String((JSON.parse(Buffer.from(response.split('.')[1] ?? '', 'base64url').toString('utf8')) as { jti?: unknown }).jti ?? '');
    } catch {
      /* verified (and rejected) below */
    }
    const loaded = loadRequest(c, requestId || undefined);
    if (!loaded.ok) return loaded.res;
    const r = loaded.r;
    if (!link) return failToClient(r, 'server_error', 'this project no longer uses account linking');
    if (c.req.query('error')) return failToClient(r, 'access_denied', 'the app did not link the account');
    try {
      const { identity, credential } = link.finish(response, r.id);
      opts.store.updateAuthRequest(r.id, { identity, sealed: box.seal(JSON.stringify(credential), `req:${r.id}`) });
    } catch (err) {
      emit({ type: 'signin.failed', clientId: r.clientId, detail: err instanceof Error ? err.message : String(err) });
      return failToClient(r, 'access_denied', err instanceof UpstreamAuthError ? err.message : 'account linking failed');
    }
    return new Response(null, { status: 302, headers: { location: `${issuer}/oauth/consent?request=${r.id}`, 'cache-control': 'no-store' } });
  });

  app.get(`${P}/oauth/apikey`, (c) => {
    const loaded = loadRequest(c, c.req.query('request'));
    if (!loaded.ok) return loaded.res;
    const r = loaded.r;
    return page(apiKeyPage({ project: opts.projectName, requestId: r.id, base: P }));
  });

  app.post(`${P}/oauth/apikey`, async (c) => {
    if (!sameOrigin(c)) return page(errorPage('Blocked', 'This form must be submitted from the sign-in page.'), 403);
    const form = await c.req.parseBody();
    const loaded = loadRequest(c, typeof form.request === 'string' ? form.request : undefined);
    if (!loaded.ok) return loaded.res;
    const r = loaded.r;
    if (opts.auth.mode !== 'apikey') return page(errorPage('Not available', 'This project does not use API keys.'), 400);
    const key = typeof form.api_key === 'string' ? form.api_key.trim() : '';
    if (key === '' || key.length > 4096 || /[\r\n\0]/.test(key)) {
      return page(apiKeyPage({ project: opts.projectName, requestId: r.id, base: P, error: 'Enter your API key.' }), 400);
    }
    let identity: Identity;
    try {
      identity = await identifyApiKey(opts.auth.apikey, key, opts.manifest(), opts.egress);
    } catch (err) {
      emit({ type: 'signin.failed', clientId: r.clientId, detail: 'api key rejected' });
      return page(apiKeyPage({ project: opts.projectName, requestId: r.id, base: P, error: err instanceof UpstreamAuthError ? err.message : 'That key could not be checked.' }), 400);
    }
    opts.store.updateAuthRequest(r.id, { identity, sealed: box.seal(JSON.stringify({ kind: 'apikey', key } satisfies UpstreamCredential), `req:${r.id}`) });
    return new Response(null, { status: 303, headers: { location: `${issuer}/oauth/consent?request=${r.id}`, 'cache-control': 'no-store' } });
  });

  const consentTools = (scopes: string[]) => opts.manifest().tools.filter((t) => t.requiredScopes.every((s) => scopes.includes(s)));

  app.get(`${P}/oauth/consent`, async (c) => {
    const loaded = loadRequest(c, c.req.query('request'));
    if (!loaded.ok) return loaded.res;
    const r = loaded.r;
    const identity = r.data.identity as Identity | undefined;
    if (!identity) return page(errorPage('Not signed in', 'Sign in first.'), 400);
    const client = await registry.resolve(r.clientId).catch(() => null);
    if (!client) return failToClient(r, 'invalid_client', 'the app is no longer registered');
    return page(
      consentPage({
        project: opts.projectName,
        requestId: r.id,
        base: P,
        user: identity.display,
        client: { name: client.name, verifiedHost: client.verifiedHost, redirectHost: new URL(r.redirectUri).host || new URL(r.redirectUri).protocol },
        tools: consentTools(r.scopes),
        scopes: r.scopes,
      }),
    );
  });

  app.post(`${P}/oauth/consent`, async (c) => {
    if (!sameOrigin(c)) return page(errorPage('Blocked', 'This form must be submitted from the consent page.'), 403);
    const form = await c.req.parseBody();
    const loaded = loadRequest(c, typeof form.request === 'string' ? form.request : undefined);
    if (!loaded.ok) return loaded.res;
    const r = loaded.r;
    const identity = r.data.identity as Identity | undefined;
    if (!identity || typeof r.data.sealed !== 'string') return page(errorPage('Not signed in', 'Sign in first.'), 400);
    if (form.decision !== 'approve') return failToClient(r, 'access_denied', 'the user declined');

    const grant: GrantRecord = {
      id: `grt_${randomToken(18)}`,
      clientId: r.clientId,
      subject: identity.subject,
      display: identity.display,
      scopes: r.scopes,
      resource: r.resource,
      createdAt: now(),
      revokedAt: null,
    };
    opts.store.putGrant(grant);
    // Re-seal the credential to the grant: the request-bound ciphertext cannot be moved elsewhere.
    opts.store.putUpstream(grant.id, box.seal(box.open(r.data.sealed, `req:${r.id}`), `grant:${grant.id}`), now());
    const code = randomToken(32);
    opts.store.putCode({
      codeHash: sha256(code),
      grantId: grant.id,
      clientId: r.clientId,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      resource: r.resource,
      expiresAt: now() + CODE_TTL_MS,
      usedAt: null,
    });
    opts.store.deleteAuthRequest(r.id);
    emit({ type: 'grant.created', grantId: grant.id, clientId: grant.clientId });
    return redirectTo(r.redirectUri, { code, state: r.state, iss: issuer });
  });

  app.post(`${P}/oauth/token`, async (c) => {
    const ct = c.req.header('content-type') ?? '';
    if (!ct.startsWith('application/x-www-form-urlencoded')) return oauthError(c, 400, 'invalid_request', 'use application/x-www-form-urlencoded');
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
    if (!f.client_id) return oauthError(c, 401, 'invalid_client', 'client_id is required');

    if (f.grant_type === 'authorization_code') {
      if (!f.code || !f.code_verifier || !f.redirect_uri) return oauthError(c, 400, 'invalid_request', 'code, code_verifier and redirect_uri are required');
      const hash = sha256(f.code);
      const rec = opts.store.getCode(hash);
      if (!rec) return oauthError(c, 400, 'invalid_grant', 'unknown or expired code');
      // RFC 6749 §4.1.2: a code used twice means it leaked — revoke everything it produced.
      if (rec.usedAt !== null || !opts.store.useCode(hash, now())) {
        revoke(rec.grantId, 'code.replayed');
        return oauthError(c, 400, 'invalid_grant', 'code already used');
      }
      if (rec.expiresAt < now()) return oauthError(c, 400, 'invalid_grant', 'code expired');
      if (rec.clientId !== f.client_id) return oauthError(c, 400, 'invalid_grant', 'code was issued to another client');
      if (rec.redirectUri !== f.redirect_uri) return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      if (!verifyPkce(f.code_verifier, rec.codeChallenge)) return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed');
      if (f.resource && f.resource.replace(/\/$/, '') !== rec.resource) return oauthError(c, 400, 'invalid_target', 'resource does not match the authorization');
      const grant = opts.store.getGrant(rec.grantId);
      if (!grant || grant.revokedAt !== null) return oauthError(c, 400, 'invalid_grant', 'the authorization was revoked');
      return c.json(await issueTokens(grant, grant.scopes), 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
    }

    if (f.grant_type === 'refresh_token') {
      if (!f.refresh_token) return oauthError(c, 400, 'invalid_request', 'refresh_token is required');
      const hash = sha256(f.refresh_token);
      const rec = opts.store.getRefresh(hash);
      if (!rec) return oauthError(c, 400, 'invalid_grant', 'unknown refresh token');
      // OAuth 2.1 §4.3.1: a rotated refresh token coming back means two parties hold it.
      if (rec.rotatedAt !== null) {
        revoke(rec.grantId, 'refresh.replayed');
        return oauthError(c, 400, 'invalid_grant', 'refresh token already used');
      }
      if (rec.expiresAt < now()) return oauthError(c, 400, 'invalid_grant', 'refresh token expired');
      const grant = opts.store.getGrant(rec.grantId);
      if (!grant || grant.revokedAt !== null) return oauthError(c, 400, 'invalid_grant', 'the authorization was revoked');
      if (grant.clientId !== f.client_id) return oauthError(c, 400, 'invalid_grant', 'refresh token was issued to another client');
      if (f.resource && f.resource.replace(/\/$/, '') !== grant.resource) return oauthError(c, 400, 'invalid_target', 'resource does not match the authorization');
      let scopes = grant.scopes;
      if (f.scope) {
        const asked = f.scope.split(' ').filter(Boolean);
        if (!asked.every((s) => grant.scopes.includes(s))) return oauthError(c, 400, 'invalid_scope', 'a refresh can only narrow the granted scopes');
        scopes = asked;
      }
      if (!opts.store.rotateRefresh(hash, now())) {
        revoke(rec.grantId, 'refresh.replayed');
        return oauthError(c, 400, 'invalid_grant', 'refresh token already used');
      }
      return c.json(await issueTokens(grant, scopes), 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
    }

    return oauthError(c, 400, 'unsupported_grant_type', 'supported: authorization_code, refresh_token');
  });

  app.post(`${P}/oauth/revoke`, async (c) => {
    const f = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = typeof f.token === 'string' ? f.token : '';
    // RFC 7009: answer 200 whether or not the token was valid.
    const refresh = token.startsWith('jrt_') ? opts.store.getRefresh(sha256(token)) : null;
    if (refresh) revoke(refresh.grantId);
    else if (token !== '') {
      const info = await verifier.verifyAccessToken(token).catch(() => null);
      const grantId = info?.extra?.grantId;
      if (typeof grantId === 'string') revoke(grantId);
    }
    return c.body(null, 200);
  });

  // ------------------------------------------------- resource server side --

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, createLocalJWKSet(keys.jwks() as never), {
          issuer,
          audience: resource,
          algorithms: ['ES256'],
          typ: 'at+jwt',
          currentDate: new Date(now()),
          clockTolerance: 5,
        }));
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'the access token is invalid or expired');
      }
      const grantId = typeof payload.grant_id === 'string' ? payload.grant_id : '';
      const grant = opts.store.getGrant(grantId);
      if (!grant || grant.revokedAt !== null) throw new OAuthError(OAuthErrorCode.InvalidToken, 'the authorization was revoked');
      return {
        token,
        clientId: String(payload.client_id ?? ''),
        scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
        expiresAt: Number(payload.exp),
        resource: new URL(resource),
        extra: { sub: payload.sub, grantId },
      };
    },
  };

  const protect: AuthServer['protect'] = (mcp) => async (req) => {
    // Explicit control flow, fail closed: verifyBearerToken THROWS on every
    // failure. (Never type-sniff the result: @hono/node-server swaps the
    // global Response class, so an instanceof check silently let a 401
    // through as if it were a signed-in user. Caught by the M3 harness.)
    const [header] = (req.headers.get('authorization') ?? '').split(',');
    let result: AuthInfo;
    try {
      result = await verifyBearerToken(header || undefined, { verifier, resourceMetadataUrl, expectedResource: new URL(resource) });
    } catch (err) {
      return bearerAuthChallengeResponse(err, { resourceMetadataUrl });
    }
    // Step-up (MCP authorization, scope challenge): a call needing scopes the
    // token lacks gets 403 insufficient_scope naming the full set to ask for.
    if (req.method === 'POST') {
      const body = (await req.clone().json().catch(() => null)) as { method?: string; params?: { name?: string } } | null;
      if (body?.method === 'tools/call' && typeof body.params?.name === 'string') {
        const tool = opts.manifest().tools.find((t) => t.name === body.params!.name);
        const missing = tool ? tool.requiredScopes.filter((s) => !result.scopes.includes(s)) : [];
        if (missing.length > 0) {
          const scope = [...new Set([...result.scopes, ...tool!.requiredScopes])].join(' ');
          return new Response(JSON.stringify({ error: 'insufficient_scope', error_description: `${tool!.name} needs ${missing.join(', ')}` }), {
            status: 403,
            headers: {
              'content-type': 'application/json',
              'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadataUrl}", error_description="${tool!.name} needs more permissions"`,
            },
          });
        }
      }
    }
    return mcp(req, result);
  };

  // ------------------------------------------------- upstream credentials --

  const refreshing = new Map<string, Promise<UpstreamCredential>>();

  const credentials: CredentialResolver = async (ctx) => {
    const grantId = ctx.authInfo?.extra?.grantId;
    if (typeof grantId !== 'string') throw new CredentialError('the app is not signed in; reconnect it');
    const sealed = opts.store.getUpstream(grantId);
    if (!sealed) throw new CredentialError(`the ${opts.projectName} sign-in for this app was removed; reconnect the app`);
    let cred = JSON.parse(box.open(sealed, `grant:${grantId}`)) as UpstreamCredential;
    switch (cred.kind) {
      case 'none':
        return {};
      case 'apikey':
        if (opts.auth.mode !== 'apikey') throw new CredentialError('the project changed how users sign in; reconnect the app');
        return apiKeyHeaders(opts.auth.apikey, cred.key);
      case 'link': {
        if (!link) throw new CredentialError('the project changed how users sign in; reconnect the app');
        // Scopes come from the verified token, so the app sees exactly what this grant may do.
        return link.assertionHeaders(cred.sub, ctx.authInfo?.scopes ?? [], grantId);
      }
      case 'oidc': {
        if (cred.expiresAt !== null && cred.expiresAt - now() < 60_000) {
          if (!oidc) throw new CredentialError('the project changed how users sign in; reconnect the app');
          // One refresh per grant at a time: concurrent calls share it (refresh tokens rotate).
          let pending = refreshing.get(grantId);
          if (!pending) {
            const current = cred;
            pending = oidc.refresh(current).finally(() => refreshing.delete(grantId));
            refreshing.set(grantId, pending);
          }
          try {
            cred = await pending;
          } catch {
            throw new CredentialError(`your ${opts.projectName} sign-in expired; reconnect the app to sign in again`);
          }
          opts.store.putUpstream(grantId, box.seal(JSON.stringify(cred), `grant:${grantId}`), now());
        }
        if (cred.kind !== 'oidc') return {};
        return { authorization: `Bearer ${cred.accessToken}` };
      }
    }
  };

  return {
    routes: app,
    verifier,
    credentials,
    protect,
    resourceMetadataUrl,
    listGrants: () => opts.store.listGrants(),
    revokeGrant: (id) => revoke(id),
  };
}
