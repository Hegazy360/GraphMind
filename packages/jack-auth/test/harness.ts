/**
 * An in-memory internet for auth tests. Every party is a real HTTP app;
 * `net()` routes a fetch to the one that owns the origin:
 *
 *   https://jack.test       Jack: authorization server + protected /mcp
 *   https://idp.test        a minimal OIDC provider (the customer's login)
 *   https://api.test        the customer's API (checks the upstream credential)
 *   https://app.example     an MCP client's CIMD document
 */
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { Client, StreamableHTTPClientTransport, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { parseManifest, type Manifest } from '@graphmind-ai/jack-schema';
import { createToolHttpHandler, type CallRecord } from '@graphmind-ai/jack-runtime';
import { createJackVerifier } from '@graphmind-ai/jack-verify';
import { createAuthServer, SqliteAuthStore, type AuthEvent, type AuthServerOptions, type ResolvedAuth } from '../src/index.js';
import { browse, type BrowseOptions } from '../src/testing.js';

export const JACK = 'https://jack.test';
export const IDP = 'https://idp.test';
export const API = 'https://api.test';
export const CIMD_URL = 'https://app.example/oauth/client.json';
export const REDIRECT = 'http://127.0.0.1:33418/callback';
export const LINK_SECRET = 'test-link-secret-0123456789abcdef0123456789abcdef';

export function manifest(): Manifest {
  return parseManifest({
    version: 1,
    name: 'Notes',
    upstream: API,
    scopes: ['notes:read', 'notes:write'],
    tools: [
      {
        name: 'whoami',
        description: 'Return the signed-in user, as the API sees them.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, title: 'Who am I' },
        requiredScopes: ['notes:read'],
        http: { method: 'GET', path: '/me' },
      },
      {
        name: 'add_note',
        description: 'Add a note for the signed-in user.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        annotations: { readOnlyHint: false, title: 'Add note' },
        requiredScopes: ['notes:write'],
        http: { method: 'POST', path: '/notes', params: [{ arg: 'text', in: 'body' }] },
      },
    ],
  });
}

// ------------------------------------------------------------- the IdP --

export interface IdpControls {
  refreshes: number;
  /** Next id_token carries a nonce of an attacker's choosing. */
  forgeNonce: boolean;
  expiresIn: number;
}

async function createIdp(controls: IdpControls) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'idp-1', alg: 'ES256', use: 'sig' };
  const codes = new Map<string, { sub: string; nonce: string; challenge: string; redirect: string }>();
  const app = new Hono();
  app.get('/.well-known/openid-configuration', (c) =>
    c.json({ issuer: IDP, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, jwks_uri: `${IDP}/jwks` }),
  );
  app.get('/jwks', (c) => c.json({ keys: [jwk] }));
  app.get('/authorize', (c) => {
    const q = c.req.query();
    return c.html(
      `<form id="idp-login" method="post" action="/authorize">${Object.entries(q)
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`)
        .join('')}<input name="username"></form>`,
    );
  });
  app.post('/authorize', async (c) => {
    const f = (await c.req.parseBody()) as Record<string, string>;
    const code = randomBytes(8).toString('hex');
    codes.set(code, { sub: f.username ?? '', nonce: f.nonce ?? '', challenge: f.code_challenge ?? '', redirect: f.redirect_uri ?? '' });
    return c.redirect(`${f.redirect_uri}?code=${code}&state=${encodeURIComponent(f.state ?? '')}`, 302);
  });
  const sign = (sub: string, aud: string, extra: Record<string, unknown> = {}) =>
    new SignJWT(extra).setProtectedHeader({ alg: 'ES256', kid: 'idp-1' }).setIssuer(IDP).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(privateKey as CryptoKey);
  app.post('/token', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    if (auth !== `Basic ${Buffer.from('jack-client:jack-secret').toString('base64')}`) return c.json({ error: 'invalid_client' }, 401);
    const f = (await c.req.parseBody()) as Record<string, string>;
    if (f.grant_type === 'refresh_token') {
      controls.refreshes++;
      const sub = (f.refresh_token ?? '').split(':')[1] ?? '';
      return c.json({ access_token: `idp-at-${sub}-r${controls.refreshes}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt:${sub}:${controls.refreshes}` });
    }
    const rec = codes.get(f.code ?? '');
    if (!rec || rec.redirect !== f.redirect_uri) return c.json({ error: 'invalid_grant' }, 400);
    codes.delete(f.code ?? '');
    const { createHash } = await import('node:crypto');
    if (createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== rec.challenge) return c.json({ error: 'invalid_grant' }, 400);
    const nonce = controls.forgeNonce ? 'attacker-nonce' : rec.nonce;
    return c.json({
      access_token: `idp-at-${rec.sub}`,
      token_type: 'Bearer',
      expires_in: controls.expiresIn,
      refresh_token: `rt:${rec.sub}:0`,
      id_token: await sign(rec.sub, 'jack-client', { nonce, name: rec.sub === 'alice' ? 'Alice Martin' : rec.sub, email: `${rec.sub}@idp.test` }),
    });
  });
  return app;
}

// ------------------------------------------------------------- the API --

export interface ApiLog {
  authorizations: string[];
  /** Every Jack-Assertion header the API received (link mode). */
  assertions: string[];
  /** Scopes carried by the last verified assertion. */
  lastScopes: string[];
}

/**
 * The customer's API. In link mode it is a session-login app that added the
 * two things Jack asks for: a /jack/link route and the assertion middleware,
 * both from @graphmind-ai/jack-verify — exactly what a real customer writes.
 */
function createApi(log: ApiLog, link: { issuer: string } | null) {
  const app = new Hono();
  const jack = link ? createJackVerifier({ secret: LINK_SECRET, issuer: link.issuer, audience: API }) : null;
  // "Session": a cookie set by the login form. Jack never sees it.
  const sessionUser = (c: { req: { header(n: string): string | undefined } }) => /acme_session=(\w+)/.exec(c.req.header('cookie') ?? '')?.[1] ?? null;

  app.get('/login', (c) => c.html(`<form id="customer-login" method="post" action="/login"><input type="hidden" name="next" value="${c.req.query('next') ?? '/'}"><input name="username"></form>`));
  app.post('/login', async (c) => {
    const f = (await c.req.parseBody()) as Record<string, string>;
    return new Response(null, { status: 302, headers: { location: f.next ?? '/', 'set-cookie': `acme_session=${f.username}; Path=/` } });
  });
  app.get('/jack/link', (c) => {
    if (!jack) return c.text('not a link-mode app', 404);
    const token = c.req.query('request') ?? '';
    try {
      jack.verifyLinkRequest(token);
    } catch (err) {
      return c.text(`bad link request: ${(err as Error).message}`, 400);
    }
    const user = sessionUser(c);
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(c.req.path + '?' + new URL(c.req.url).searchParams.toString())}`, 302);
    return c.redirect(jack.linkResponseUrl(token, { userId: user, name: user === 'alice' ? 'Alice Martin' : user }), 302);
  });

  const who = (auth: string): string | null => {
    const token = auth.replace(/^Bearer /, '');
    if (token.startsWith('idp-at-')) return token.split('-')[2] ?? null;
    if (token === 'key-alice') return 'alice';
    if (token === 'key-bob') return 'bob';
    return null;
  };
  if (jack) app.use('*', jack.hono() as never);
  app.use('*', async (c, next) => {
    log.authorizations.push(c.req.header('authorization') ?? '');
    const assertion = c.req.header('jack-assertion');
    if (assertion) log.assertions.push(assertion);
    const linked = (c as unknown as { get(k: string): { userId: string; scopes: string[] } | undefined }).get('jackUser');
    if (linked) {
      log.lastScopes = linked.scopes;
      (c as unknown as { set(k: string, v: unknown): void }).set('user', linked.userId);
    } else {
      const u = who(c.req.header('authorization') ?? '');
      if (!u) return c.json({ title: 'Unauthorized' }, 401);
      (c as unknown as { set(k: string, v: unknown): void }).set('user', u);
    }
    await next();
  });
  const current = (c: unknown) => (c as { get(k: string): string }).get('user');
  app.get('/me', (c) => {
    const id = current(c);
    return c.json({ id, name: id === 'alice' ? 'Alice Martin' : 'Bob' });
  });
  app.post('/notes', async (c) => c.json({ ok: true, by: current(c), ...(await c.req.json()) }, 201));
  return app;
}

// ----------------------------------------------------------- the stack --

export interface Stack {
  /** The MCP endpoint of this stack. */
  mcpUrl: string;
  net: (url: string | URL, init?: RequestInit) => Promise<Response>;
  auth: ReturnType<typeof createAuthServer>;
  store: SqliteAuthStore;
  idp: IdpControls;
  api: ApiLog;
  calls: CallRecord[];
  events: AuthEvent[];
  clock: { now: number };
  /** Run the browser part of a sign-in from an authorization URL. */
  browser: (authorizationUrl: string, forms?: BrowseOptions['forms']) => ReturnType<typeof browse>;
}

/** Overrides for the auth server; `fetchClientMetadata: undefined` restores the real (strict) CIMD fetcher. */
export type StackOverrides = { [K in keyof AuthServerOptions]?: AuthServerOptions[K] | undefined };

/** `prefix` hosts the project under a path on the shared origin (e.g. '/p/notes'), as `jack serve` does. */
export async function createStack(mode: 'oidc' | 'apikey' | 'link' | 'none', overrides: StackOverrides = {}, prefix = ''): Promise<Stack> {
  const idp: IdpControls = { refreshes: 0, forgeNonce: false, expiresIn: 3600 };
  const api: ApiLog = { authorizations: [], assertions: [], lastScopes: [] };
  const calls: CallRecord[] = [];
  const events: AuthEvent[] = [];
  const clock = { now: Date.now() };
  const store = new SqliteAuthStore(':memory:');
  const idpApp = await createIdp(idp);
  const apiApp = createApi(api, mode === 'link' ? { issuer: `${JACK}${prefix}` } : null);
  const m = manifest();

  const resolved: ResolvedAuth =
    mode === 'oidc'
      ? { mode: 'oidc', oidc: { issuer: IDP, clientId: 'jack-client', clientSecret: 'jack-secret', scopes: ['openid', 'email'] } }
      : mode === 'apikey'
        ? { mode: 'apikey', apikey: { header: 'authorization', prefix: 'Bearer ', whoamiTool: 'whoami' } }
        : mode === 'link'
          ? { mode: 'link', link: { linkUrl: `${API}/jack/link`, secret: LINK_SECRET } }
          : { mode: 'none' };

  // eslint-disable-next-line prefer-const
  let net: Stack['net'];
  const auth = createAuthServer({
    issuer: `${JACK}${prefix}`,
    resource: `${JACK}${prefix}/mcp`,
    projectName: 'Notes',
    manifest: () => m,
    auth: resolved,
    store,
    secretKey: randomBytes(32),
    egress: 'any',
    now: () => clock.now,
    fetcher: (url, init) => net(url, init as RequestInit),
    fetchClientMetadata: async (url) => net(url),
    onEvent: (e) => events.push(e),
    ...(overrides as Partial<AuthServerOptions>),
  });
  const mcp = createToolHttpHandler({ manifest: m, egress: 'any', listAll: true, credentials: auth.credentials, onCall: (r) => calls.push(r) });
  const jack = new Hono();
  jack.route('/', auth.routes);
  jack.all(`${prefix}/mcp`, (c) => auth.protect((req, authInfo) => mcp.fetch(req, { authInfo }))(c.req.raw));

  // The runtime reaches the API over real sockets; route https://api.test there via a local server.
  const { serve } = await import('@hono/node-server');
  const server = await new Promise<{ port: number; close: () => void }>((resolve) => {
    const s = serve({ fetch: apiApp.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ port: info.port, close: () => s.close() }));
  });
  // Rewrite the manifest upstream to the socket the API listens on (the runtime uses node:http).
  (m as { upstream: string }).upstream = `http://127.0.0.1:${server.port}`;

  const cimd = {
    client_id: CIMD_URL,
    client_name: 'Example Agent',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  net = async (url, init) => {
    const u = new URL(url);
    const req = new Request(u, init);
    if (u.origin === JACK) return jack.fetch(req);
    if (u.origin === IDP) return idpApp.fetch(req);
    if (u.origin === API) return apiApp.fetch(req);
    if (u.href === CIMD_URL) return Response.json(cimd);
    return new Response('no such host', { status: 502 });
  };

  const browser: Stack['browser'] = (authorizationUrl, forms) =>
    browse(authorizationUrl, (url, init) => net(url, init), {
      stopAt: (url) => url.startsWith('http://127.0.0.1:'),
      forms: forms ?? {
        'idp-login': () => ({ username: 'alice' }),
        'jack-apikey': () => ({ api_key: 'key-alice' }),
        'customer-login': () => ({ username: 'alice' }),
        'jack-consent': () => ({ decision: 'approve' }),
      },
    });

  return { mcpUrl: `${JACK}${prefix}/mcp`, net, auth, store, idp, api, calls, events, clock, browser };
}

// ------------------------------------------------- an MCP client w/ OAuth --

export class TestOAuthProvider implements OAuthClientProvider {
  private saved?: Record<string, unknown>;
  private client?: Record<string, unknown>;
  private verifier = '';
  lastAuthorizationUrl: URL | null = null;

  clientMetadataUrl?: string;

  constructor(private readonly opts: { cimd?: boolean; scope?: string } = {}) {
    if (opts.cimd) this.clientMetadataUrl = CIMD_URL;
  }

  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return {
      client_name: 'Test Agent (DCR)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }
  clientInformation() {
    return this.client as never;
  }
  saveClientInformation(info: unknown) {
    this.client = info as Record<string, unknown>;
  }
  tokens() {
    return this.saved as never;
  }
  saveTokens(t: unknown) {
    this.saved = t as Record<string, unknown>;
  }
  redirectToAuthorization(url: URL) {
    this.lastAuthorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  get savedTokens() {
    return this.saved as { access_token: string; refresh_token: string; scope?: string } | undefined;
  }
}

/** Connect an SDK client, running the whole sign-in through the scripted browser when asked to. */
export async function signedInClient(stack: Stack, provider = new TestOAuthProvider(), forms?: BrowseOptions['forms']) {
  const make = () =>
    new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: provider, fetch: (u, i) => stack.net(u as string, i) });
  const client = () =>
    new Client({ name: 'auth-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  let transport = make();
  let c = client();
  try {
    await c.connect(transport);
    return { client: c, provider };
  } catch (err) {
    if (!provider.lastAuthorizationUrl) throw err;
  }
  const result = await stack.browser(provider.lastAuthorizationUrl.href, forms);
  if (!result.url) throw new Error(`sign-in did not finish: ${result.stuck?.status} at ${result.stuck?.url}\n${result.stuck?.html.slice(0, 400)}`);
  const params = new URL(result.url).searchParams;
  if (params.get('error')) throw new Error(`sign-in failed: ${params.get('error')}: ${params.get('error_description')}`);
  await transport.finishAuth(params);
  transport = make();
  c = client();
  await c.connect(transport);
  return { client: c, provider, browse: result };
}
