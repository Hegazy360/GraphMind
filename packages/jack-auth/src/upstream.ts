/**
 * How a project's users prove who they are to the CUSTOMER's API
 * (plan §3.4 (b)). Jack is a separate client of the customer's identity
 * provider; whatever it obtains stays sealed in Jack and is attached to
 * upstream calls server-side. The MCP client never sees any of it.
 *
 *   oidc    Jack runs an authorization-code + PKCE flow against the
 *           customer's OIDC provider, verifies the id_token, and keeps the
 *           user's access/refresh tokens (refreshing them as needed).
 *   apikey  The user pastes their key into Jack's own page (never into the
 *           AI client); an optional "whoami" call validates it first.
 */
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AuthConfig, JsonValue, Manifest } from '@graphmind-ai/jack-schema';
import { buildRequest, sendUpstream, type EgressPolicy } from '@graphmind-ai/jack-runtime';
import { randomToken, sha256 } from './crypto.js';
import { signHs256, verifyHs256, JwtError } from '@graphmind-ai/jack-verify';

export type Fetcher = (url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

/** What Jack keeps for a grant, sealed. */
export type UpstreamCredential =
  | { kind: 'oidc'; accessToken: string; refreshToken?: string; expiresAt: number | null; scope?: string }
  | { kind: 'apikey'; key: string }
  /** link mode: the customer's own user id; every call carries a fresh signed assertion naming it. */
  | { kind: 'link'; sub: string }
  | { kind: 'none' };

export interface Identity {
  subject: string;
  display: string;
}

export class UpstreamAuthError extends Error {
  override name = 'UpstreamAuthError';
}

// ------------------------------------------------------------------ OIDC --

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export class OidcProvider {
  private discovery: Promise<Discovery> | null = null;

  constructor(
    private readonly settings: OidcSettings,
    private readonly fetcher: Fetcher,
    private readonly now: () => number,
  ) {}

  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const url = `${this.settings.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await this.fetcher(url);
      if (!res.ok) throw new UpstreamAuthError(`identity provider discovery failed (HTTP ${res.status} from ${url})`);
      const d = (await res.json()) as Partial<Discovery>;
      // OIDC Discovery §4.3: the document's issuer must be exactly the one we were configured with.
      if (d.issuer !== this.settings.issuer) throw new UpstreamAuthError(`identity provider issuer mismatch: expected ${this.settings.issuer}, got ${d.issuer}`);
      for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
        if (typeof d[k] !== 'string') throw new UpstreamAuthError(`identity provider discovery has no ${k}`);
      }
      return d as Discovery;
    })();
    this.discovery.catch(() => (this.discovery = null));
    return this.discovery;
  }

  /** Start: returns the URL to send the browser to, and the secrets to remember for the callback. */
  async start(callbackUrl: string, extraScopes: string[]): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
    const d = await this.discover();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.settings.clientId,
      redirect_uri: callbackUrl,
      scope: [...new Set([...this.settings.scopes, ...extraScopes])].join(' '),
      state,
      nonce,
      code_challenge: sha256(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.href, state, nonce, verifier };
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    const d = await this.discover();
    const basic = Buffer.from(`${encodeURIComponent(this.settings.clientId)}:${encodeURIComponent(this.settings.clientSecret)}`).toString('base64');
    const res = await this.fetcher(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
      body: new URLSearchParams(params).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // The IdP's error code only — never echo a body that could contain request material.
      throw new UpstreamAuthError(`identity provider token request failed (${typeof body.error === 'string' ? body.error : `HTTP ${res.status}`})`);
    }
    return body;
  }

  private credentialFrom(body: Record<string, unknown>, previousRefresh?: string): UpstreamCredential {
    if (typeof body.access_token !== 'string') throw new UpstreamAuthError('identity provider returned no access_token');
    const expiresIn = Number(body.expires_in);
    return {
      kind: 'oidc',
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : previousRefresh ? { refreshToken: previousRefresh } : {}),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? this.now() + expiresIn * 1000 : null,
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    };
  }

  /** Callback: exchange the code, verify the id_token, return who the user is and their credential. */
  async finish(code: string, callbackUrl: string, expected: { nonce: string; verifier: string }): Promise<{ identity: Identity; credential: UpstreamCredential }> {
    const d = await this.discover();
    const body = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl, code_verifier: expected.verifier });
    if (typeof body.id_token !== 'string') throw new UpstreamAuthError('identity provider returned no id_token (is the openid scope configured?)');
    const jwksRes = await this.fetcher(d.jwks_uri);
    if (!jwksRes.ok) throw new UpstreamAuthError('could not load the identity provider keys');
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(body.id_token, createLocalJWKSet((await jwksRes.json()) as never), {
        issuer: this.settings.issuer,
        audience: this.settings.clientId,
        currentDate: new Date(this.now()),
        clockTolerance: 60,
      }));
    } catch (err) {
      throw new UpstreamAuthError(`id_token rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (claims.nonce !== expected.nonce) throw new UpstreamAuthError('id_token nonce does not match this sign-in');
    if (typeof claims.sub !== 'string' || claims.sub === '') throw new UpstreamAuthError('id_token has no subject');
    const display = [claims.name, claims.email, claims.preferred_username].find((v): v is string => typeof v === 'string' && v !== '') ?? claims.sub;
    return { identity: { subject: `${this.settings.issuer}|${claims.sub}`, display }, credential: this.credentialFrom(body) };
  }

  async refresh(cred: Extract<UpstreamCredential, { kind: 'oidc' }>): Promise<UpstreamCredential> {
    if (!cred.refreshToken) throw new UpstreamAuthError('the sign-in expired and cannot be renewed');
    const body = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: cred.refreshToken });
    return this.credentialFrom(body, cred.refreshToken);
  }
}

// ----------------------------------------------------------------- API key --

export interface ApiKeySettings {
  header: string;
  prefix: string;
  /** Tool used to validate the key and learn who it belongs to. */
  whoamiTool?: string;
}

export function apiKeyHeaders(s: ApiKeySettings, key: string): Record<string, string> {
  return { [s.header.toLowerCase()]: `${s.prefix}${key}` };
}

/**
 * Validate a pasted key by calling the project's own whoami tool with it.
 * Subject: the response's `id`/`sub`/`email`, else a hash of the key (so
 * the same key maps to the same grant owner without storing it in clear).
 */
export async function identifyApiKey(
  s: ApiKeySettings,
  key: string,
  manifest: Manifest,
  egress: EgressPolicy,
): Promise<Identity> {
  const fallback: Identity = { subject: `key:${sha256(key).slice(0, 22)}`, display: `API key ending ${key.slice(-4)}` };
  if (!s.whoamiTool) return fallback;
  const tool = manifest.tools.find((t) => t.name === s.whoamiTool);
  if (!tool) throw new UpstreamAuthError(`auth.whoamiTool '${s.whoamiTool}' is not an enabled tool`);
  const req = buildRequest(tool, {}, manifest.upstream);
  req.headers = { ...req.headers, ...apiKeyHeaders(s, key) };
  let res;
  try {
    res = await sendUpstream(req, { allowedOrigin: manifest.upstream, policy: egress, timeoutMs: 10_000, maxResponseBytes: 64 * 1024 });
  } catch (err) {
    throw new UpstreamAuthError(`could not reach the API to check the key (${err instanceof Error ? err.message : String(err)})`);
  }
  if (res.status === 401 || res.status === 403) throw new UpstreamAuthError('the API did not accept that key');
  if (res.status < 200 || res.status >= 300) throw new UpstreamAuthError(`the API answered HTTP ${res.status} when checking the key`);
  let body: Record<string, JsonValue> = {};
  try {
    body = JSON.parse(res.body.toString('utf8')) as Record<string, JsonValue>;
  } catch {
    return fallback;
  }
  const id = [body.id, body.sub, body.email].find((v): v is string => typeof v === 'string' && v !== '');
  const display = [body.name, body.email, body.username, body.id].find((v): v is string => typeof v === 'string' && v !== '');
  return { subject: id ? `user:${id}` : fallback.subject, display: display ?? fallback.display };
}

// ------------------------------------------------------------------ link --

export interface LinkSettings {
  linkUrl: string;
  /** Shared with the customer's app as JACK_LINK_SECRET. */
  secret: string;
}

export const LINK_TYP = { request: 'jack-link-request', response: 'jack-link-response', assertion: 'jack-link-assertion' } as const;
const LINK_REQUEST_TTL_S = 300;
const ASSERTION_TTL_S = 60;

/**
 * Account linking (plan §3.4 `link`): for apps with a session login and no
 * OAuth server. Jack sends the user to the app's link route with a signed
 * request; the app, where the user is already logged in, answers with a
 * signed response naming the user; from then on every upstream call carries
 * a 60-second signed assertion. All HS256 with one shared secret; the
 * customer verifies with `@graphmind-ai/jack-verify` (or its Python/Ruby ports).
 */
export class LinkProvider {
  readonly audience: string;

  constructor(
    private readonly settings: LinkSettings,
    private readonly issuer: string,
    upstreamOrigin: string,
    private readonly now: () => number,
  ) {
    if (settings.secret.length < 32) throw new UpstreamAuthError('the link secret must be at least 32 characters');
    this.audience = new URL(upstreamOrigin).origin;
    if (new URL(settings.linkUrl).origin !== this.audience) {
      throw new UpstreamAuthError(`auth.linkUrl (${settings.linkUrl}) must be on the upstream origin (${this.audience})`);
    }
  }

  /** The URL to send the user's browser to. */
  start(requestId: string, returnUrl: string, scopes: string[]): string {
    const iat = Math.floor(this.now() / 1000);
    const token = signHs256(
      { typ: LINK_TYP.request, iss: this.issuer, aud: this.audience, jti: requestId, return: returnUrl, scope: scopes.join(' '), iat, exp: iat + LINK_REQUEST_TTL_S },
      this.settings.secret,
    );
    const u = new URL(this.settings.linkUrl);
    u.searchParams.set('request', token);
    return u.href;
  }

  /** Verify the app's response for THIS request; returns who the user is. */
  finish(responseToken: string, requestId: string): { identity: Identity; credential: UpstreamCredential } {
    let p: Record<string, unknown>;
    try {
      p = verifyHs256(responseToken, this.settings.secret, { typ: LINK_TYP.response, issuer: this.audience, audience: this.issuer, now: this.now() });
    } catch (err) {
      throw new UpstreamAuthError(`the app's link response was rejected (${err instanceof JwtError ? err.message : 'invalid'})`);
    }
    if (p.jti !== requestId) throw new UpstreamAuthError('the link response belongs to a different sign-in');
    const sub = typeof p.sub === 'string' && p.sub !== '' ? p.sub : null;
    if (!sub) throw new UpstreamAuthError('the link response names no user');
    const display = [p.name, p.email].find((v): v is string => typeof v === 'string' && v !== '') ?? sub;
    return { identity: { subject: `link:${sub}`, display }, credential: { kind: 'link', sub } };
  }

  /** The per-call header: fresh, 60 s, single-use on the receiving side. */
  assertionHeaders(sub: string, scopes: readonly string[], grantId: string): Record<string, string> {
    const iat = Math.floor(this.now() / 1000);
    const token = signHs256(
      { typ: LINK_TYP.assertion, iss: this.issuer, aud: this.audience, sub, grant_id: grantId, scope: scopes.join(' '), jti: randomToken(12), iat, exp: iat + ASSERTION_TTL_S },
      this.settings.secret,
    );
    return { 'jack-assertion': token };
  }
}

/** The `auth` block of a project, with secrets resolved. */
export type ResolvedAuth =
  | { mode: 'oidc'; oidc: OidcSettings }
  | { mode: 'apikey'; apikey: ApiKeySettings }
  | { mode: 'link'; link: LinkSettings }
  | { mode: 'none' };

/** Turn jack.yaml/project auth into runtime settings; `secret` resolves `clientSecretRef`. */
export function resolveAuth(auth: AuthConfig, secret: (ref: string) => string | undefined): ResolvedAuth {
  switch (auth.mode) {
    case 'oidc': {
      const clientSecret = secret(auth.clientSecretRef);
      if (clientSecret === undefined || clientSecret === '') {
        throw new UpstreamAuthError(`auth.clientSecretRef '${auth.clientSecretRef}' did not resolve to a secret`);
      }
      return { mode: 'oidc', oidc: { issuer: auth.issuer, clientId: auth.clientId, clientSecret, scopes: auth.scopes } };
    }
    case 'apikey':
      return { mode: 'apikey', apikey: { header: auth.header, prefix: auth.prefix, ...(auth.whoamiTool ? { whoamiTool: auth.whoamiTool } : {}) } };
    case 'none':
      return { mode: 'none' };
    case 'link': {
      const s = secret(auth.secretRef);
      if (s === undefined || s === '') throw new UpstreamAuthError(`auth.secretRef '${auth.secretRef}' did not resolve to a secret`);
      return { mode: 'link', link: { linkUrl: auth.linkUrl, secret: s } };
    }
  }
}
