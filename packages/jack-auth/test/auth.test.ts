/**
 * M3: Jack's authorization server, driven by the official MCP SDK client
 * (2.4) through a scripted browser — the same flow Claude, ChatGPT or
 * Cursor run — plus every rejection path the design promises.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createAuthServer, SqliteAuthStore, sha256, validRedirectUri, redirectMatches } from '../src/index.js';
import { createStack, API, CIMD_URL, JACK, LINK_SECRET, manifest, REDIRECT, signedInClient, TestOAuthProvider, type Stack } from './harness.js';
import { createJackVerifier, signHs256, TYP } from '@graphmind-ai/jack-verify';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n');

/** Start an authorization request by hand (for the rejection tests). */
function authorizeUrl(params: Record<string, string | undefined>) {
  const u = new URL(`${JACK}/oauth/authorize`);
  const base: Record<string, string> = {
    response_type: 'code',
    client_id: CIMD_URL,
    redirect_uri: REDIRECT,
    code_challenge: sha256('v'.repeat(43)),
    code_challenge_method: 'S256',
    resource: `${JACK}/mcp`,
    state: 'st-1',
  };
  for (const [k, v] of Object.entries({ ...base, ...params })) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

/** Run a whole sign-in by hand and return the code (no SDK), for token-endpoint tests. */
async function codeFor(s: Stack, verifier = 'v'.repeat(43)) {
  const res = await s.browser(authorizeUrl({ code_challenge: sha256(verifier) }));
  const u = new URL(res.url!);
  return { code: u.searchParams.get('code')!, url: u, verifier };
}

const token = (s: Stack, form: Record<string, string>) =>
  s.net(`${JACK}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });

const exchange = (s: Stack, c: { code: string; verifier: string }, over: Record<string, string> = {}) =>
  token(s, { grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, redirect_uri: REDIRECT, client_id: CIMD_URL, resource: `${JACK}/mcp`, ...over });

const mcpPost = (s: Stack, accessToken: string | null, body: unknown) =>
  s.net(`${JACK}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': (body as { method: string }).method,
      'mcp-name': (body as { params: { name: string } }).params.name,
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });

const toolsCall = (name: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name,
    arguments: name === 'add_note' ? { text: 'hi' } : {},
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  },
});

describe('discovery', () => {
  it('protected resource metadata, server metadata, and the 401 that points to them', async () => {
    const s = await createStack('apikey');
    const prm = await json(await s.net(`${JACK}/.well-known/oauth-protected-resource/mcp`));
    expect(prm).toEqual({
      resource: `${JACK}/mcp`,
      authorization_servers: [JACK],
      scopes_supported: ['notes:read', 'notes:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Notes',
    });
    const as = await json(await s.net(`${JACK}/.well-known/oauth-authorization-server`));
    expect(as).toMatchObject({
      issuer: JACK,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    const unauth = await mcpPost(s, null, toolsCall('whoami'));
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain(`resource_metadata="${JACK}/.well-known/oauth-protected-resource/mcp"`);
    expect((await json(await s.net(`${JACK}/oauth/jwks`))).keys[0]).toMatchObject({ kty: 'EC', alg: 'ES256', use: 'sig' });
  });
});

describe('sign-in, end to end with the SDK client', () => {
  it('apikey mode over DCR: the key goes to Jack, never to the client', async () => {
    const s = await createStack('apikey');
    const { client, provider, browse } = await signedInClient(s, new TestOAuthProvider());
    // The browser saw Jack's own API-key page, then consent — flagged as an unverified app (DCR).
    expect(browse!.visited.some((u) => u.includes('/oauth/apikey'))).toBe(true);
    const r = await client.callTool({ name: 'whoami', arguments: {} });
    expect(JSON.parse(text(r))).toEqual({ id: 'alice', name: 'Alice Martin' });
    expect(s.api.authorizations).toContain('Bearer key-alice');
    expect(JSON.stringify(provider.savedTokens)).not.toContain('key-alice');
    expect(s.calls.at(-1)).toMatchObject({ tool: 'whoami', status: 'ok', clientId: expect.stringMatching(/^jdc_/) });
    expect(s.events.map((e) => e.type)).toEqual(['client.registered', 'grant.created']);
  });

  it('oidc mode over CIMD: federated login, verified app, the IdP token stays in Jack', async () => {
    const s = await createStack('oidc');
    let consentHtml = '';
    const { client, provider } = await signedInClient(s, new TestOAuthProvider({ cimd: true }), {
      'idp-login': () => ({ username: 'alice' }),
      'jack-consent': ({ html }) => {
        consentHtml = html;
        return { decision: 'approve' };
      },
    });
    expect(consentHtml).toContain('Verified app from <strong>app.example</strong>');
    expect(consentHtml).toContain('Signed in as <span class="who">Alice Martin</span>');
    expect(consentHtml).toMatch(/Read<\/span>[\s\S]*Who am I/);
    const r = await client.callTool({ name: 'add_note', arguments: { text: 'buy milk' } });
    expect(JSON.parse(text(r))).toMatchObject({ ok: true, by: 'alice', text: 'buy milk' });
    expect(s.api.authorizations).toContain('Bearer idp-at-alice');
    expect(JSON.stringify(provider.savedTokens)).not.toContain('idp-at-alice');
    expect(s.store.listGrants()[0]).toMatchObject({ clientId: CIMD_URL, subject: 'https://idp.test|alice', display: 'Alice Martin' });
  });

  it('renews the upstream token with the IdP before it expires (once, shared by concurrent calls)', async () => {
    const s = await createStack('oidc');
    s.idp.expiresIn = 30; // inside the 60 s renewal window from the start
    const { client } = await signedInClient(s, new TestOAuthProvider({ cimd: true }));
    await Promise.all([1, 2, 3].map(() => client.callTool({ name: 'whoami', arguments: {} })));
    expect(s.idp.refreshes).toBe(1);
    expect(s.api.authorizations.filter((a) => a === 'Bearer idp-at-alice-r1')).toHaveLength(3);
  });

  it('a cancelled consent sends access_denied back and creates nothing', async () => {
    const s = await createStack('apikey');
    const res = await s.browser(authorizeUrl({}), {
      'jack-apikey': () => ({ api_key: 'key-alice' }),
      'jack-consent': () => ({ decision: 'deny' }),
    });
    expect(new URL(res.url!).searchParams.get('error')).toBe('access_denied');
    expect(new URL(res.url!).searchParams.get('state')).toBe('st-1');
    expect(s.store.listGrants()).toEqual([]);
  });

  it('a wrong API key is refused on Jack\'s page, before any grant exists', async () => {
    const s = await createStack('apikey');
    const res = await s.browser(authorizeUrl({}), { 'jack-apikey': ({ html }) => (html.includes('did not accept') ? null : { api_key: 'key-wrong' }) });
    expect(res.stuck?.status).toBe(400);
    expect(res.stuck?.html).toContain('the API did not accept that key');
    expect(s.store.listGrants()).toEqual([]);
  });
});

describe('an issuer with a path (many projects on one origin, as jack serve hosts them)', () => {
  it('RFC 8414 / 9728 path-inserted discovery, path-scoped cookie and forms; the SDK client signs in', async () => {
    const s = await createStack('apikey', {}, '/p/notes');
    const as = await json(await s.net(`${JACK}/.well-known/oauth-authorization-server/p/notes`));
    expect(as).toMatchObject({ issuer: `${JACK}/p/notes`, authorization_endpoint: `${JACK}/p/notes/oauth/authorize`, token_endpoint: `${JACK}/p/notes/oauth/token` });
    expect(await json(await s.net(`${JACK}/.well-known/oauth-protected-resource/p/notes/mcp`))).toMatchObject({
      resource: `${JACK}/p/notes/mcp`,
      authorization_servers: [`${JACK}/p/notes`],
    });
    // The root documents belong to nobody: another project on this origin must not be advertised.
    expect((await s.net(`${JACK}/.well-known/oauth-authorization-server`)).status).toBe(404);

    const { client, browse } = await signedInClient(s, new TestOAuthProvider({ cimd: true }));
    expect(browse!.visited.some((u) => u.startsWith(`${JACK}/p/notes/oauth/apikey`))).toBe(true);
    expect(JSON.parse(text(await client.callTool({ name: 'whoami', arguments: {} })))).toMatchObject({ id: 'alice' });
    const t = s.store.listGrants()[0]!;
    expect(t.resource).toBe(`${JACK}/p/notes/mcp`);
  });

  it('the sign-in cookie is scoped to the project path, so a neighbour project on the same origin never receives it', async () => {
    const s = await createStack('apikey', {}, '/p/notes');
    const r = await s.net(
      `${JACK}/p/notes/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CIMD_URL, redirect_uri: REDIRECT, code_challenge: sha256('v'.repeat(43)), code_challenge_method: 'S256', resource: `${JACK}/p/notes/mcp` })}`,
      { redirect: 'manual' },
    );
    expect(r.headers.get('set-cookie')).toMatch(/Path=\/p\/notes\/oauth;/);
    expect(r.headers.get('location')).toMatch(new RegExp(`^${JACK}/p/notes/oauth/apikey\\?request=`));
  });
});

describe('the authorize endpoint refuses bad requests', () => {
  it('unknown client or unregistered redirect: an error page, never a redirect', async () => {
    const s = await createStack('apikey');
    for (const params of [{ client_id: 'jdc_nope' }, { redirect_uri: 'https://evil.example/cb' }, { client_id: undefined }]) {
      const r = await s.net(authorizeUrl(params as Record<string, string>), { redirect: 'manual' });
      expect(r.status).toBe(400);
      expect(r.headers.get('location')).toBeNull();
      expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
  });

  it('PKCE, resource and scope errors go back to the client with state and iss', async () => {
    const s = await createStack('apikey');
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ resource: undefined }, 'invalid_target'],
      [{ resource: 'https://other.test/mcp' }, 'invalid_target'],
      [{ scope: 'notes:read admin' }, 'invalid_scope'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ];
    for (const [params, error] of cases) {
      const r = await s.net(authorizeUrl(params), { redirect: 'manual' });
      const loc = new URL(r.headers.get('location')!);
      expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
      expect(loc.searchParams.get('error'), JSON.stringify(params)).toBe(error);
      expect(loc.searchParams.get('state')).toBe('st-1');
      expect(loc.searchParams.get('iss')).toBe(JACK);
    }
  });

  it('loopback redirects may change port; everything else must match exactly', () => {
    expect(redirectMatches([REDIRECT], 'http://127.0.0.1:50999/callback')).toBe(true);
    expect(redirectMatches([REDIRECT], 'http://127.0.0.1:50999/other')).toBe(false);
    expect(redirectMatches(['https://app.example/cb'], 'https://app.example/cb?x=1')).toBe(false);
    for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:7777/cb', 'cursor://anysphere.cursor-mcp/oauth/callback', 'com.example.app:/cb']) {
      expect(validRedirectUri(ok), ok).toBe(true);
    }
    for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'data:text/html,x', 'https://a.test/cb#frag', 'myapp://cb']) {
      expect(validRedirectUri(bad), bad).toBe(false);
    }
  });
});

describe('the token endpoint', () => {
  it('PKCE, client, redirect and resource must all match the authorization', async () => {
    const s = await createStack('apikey');
    for (const over of [
      { code_verifier: 'w'.repeat(43) },
      { client_id: 'jdc_other' },
      { redirect_uri: 'http://127.0.0.1:1/callback' },
      { resource: 'https://other.test/mcp' },
    ]) {
      const c = await codeFor(s);
      const r = await exchange(s, c, over);
      expect(r.status, JSON.stringify(over)).toBeGreaterThanOrEqual(400);
      expect((await json(r)).error).toMatch(/invalid_grant|invalid_target/);
    }
    const c = await codeFor(s);
    const ok = await exchange(s, c);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await json(ok)).toMatchObject({ token_type: 'Bearer', expires_in: 900, refresh_token: expect.stringMatching(/^jrt_/) });
  });

  it('a code used twice revokes everything it produced', async () => {
    const s = await createStack('apikey');
    const c = await codeFor(s);
    const first = (await json(await exchange(s, c))) as { access_token: string };
    expect((await mcpPost(s, first.access_token, toolsCall('whoami'))).status).toBe(200);
    const again = await exchange(s, c);
    expect((await json(again)).error).toBe('invalid_grant');
    expect((await mcpPost(s, first.access_token, toolsCall('whoami'))).status).toBe(401);
    expect(s.events.map((e) => e.type)).toContain('code.replayed');
  });

  it('codes expire after 60 seconds', async () => {
    const s = await createStack('apikey');
    const c = await codeFor(s);
    s.clock.now += 61_000;
    expect((await json(await exchange(s, c))).error).toBe('invalid_grant');
  });

  it('refresh tokens rotate; replaying an old one revokes the grant', async () => {
    const s = await createStack('apikey');
    const t1 = (await json(await exchange(s, await codeFor(s)))) as { access_token: string; refresh_token: string };
    const refresh = (rt: string, over: Record<string, string> = {}) =>
      token(s, { grant_type: 'refresh_token', refresh_token: rt, client_id: CIMD_URL, ...over });
    const t2 = (await json(await refresh(t1.refresh_token))) as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await mcpPost(s, t2.access_token, toolsCall('whoami'))).status).toBe(200);
    // Narrowing is allowed, widening is not.
    expect((await json(await refresh(t2.refresh_token, { scope: 'notes:read admin' }))).error).toBe('invalid_scope');
    // The thief replays the first refresh token: the whole grant dies, for both parties.
    expect((await json(await refresh(t1.refresh_token))).error).toBe('invalid_grant');
    expect((await mcpPost(s, t2.access_token, toolsCall('whoami'))).status).toBe(401);
    expect((await json(await refresh(t2.refresh_token))).error).toBe('invalid_grant');
    expect(s.events.map((e) => e.type)).toContain('refresh.replayed');
  });

  it('revocation (RFC 7009 and from the server) takes effect on the next call', async () => {
    const s = await createStack('apikey');
    const t = (await json(await exchange(s, await codeFor(s)))) as { access_token: string; refresh_token: string };
    await s.net(`${JACK}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${t.refresh_token}` });
    expect((await mcpPost(s, t.access_token, toolsCall('whoami'))).status).toBe(401);

    const t2 = (await json(await exchange(s, await codeFor(s)))) as { access_token: string };
    s.auth.revokeGrant(s.store.listGrants().at(-1)!.id);
    expect((await mcpPost(s, t2.access_token, toolsCall('whoami'))).status).toBe(401);
  });
});

describe('access tokens', () => {
  it('are bound to this resource: a token for project A is refused by project B', async () => {
    const s = await createStack('apikey');
    const t = (await json(await exchange(s, await codeFor(s)))) as { access_token: string };
    // Project B shares nothing but would accept a JWT if audience were not checked.
    const b = createAuthServer({
      issuer: JACK,
      resource: 'https://jack.test/other-mcp',
      projectName: 'B',
      manifest,
      auth: { mode: 'none' },
      store: s.store, // even sharing the store and keys
      secretKey: randomBytes(32),
      egress: 'any',
    });
    await expect(b.verifier.verifyAccessToken(t.access_token)).rejects.toThrow();
    await expect(s.auth.verifier.verifyAccessToken(`${t.access_token.slice(0, -4)}AAAA`)).rejects.toThrow();
  });

  it('expire after 15 minutes', async () => {
    const s = await createStack('apikey');
    const t = (await json(await exchange(s, await codeFor(s)))) as { access_token: string };
    s.clock.now += 16 * 60_000;
    await expect(s.auth.verifier.verifyAccessToken(t.access_token)).rejects.toThrow(/invalid or expired/);
  });

  it('step-up: a call needing more scopes gets 403 insufficient_scope naming what to ask for', async () => {
    const s = await createStack('apikey');
    const v = 'v'.repeat(43);
    const res = await s.browser(authorizeUrl({ scope: 'notes:read', code_challenge: sha256(v) }));
    const t = (await json(await exchange(s, { code: new URL(res.url!).searchParams.get('code')!, verifier: v }))) as { access_token: string; scope: string };
    expect(t.scope).toBe('notes:read');
    expect((await mcpPost(s, t.access_token, toolsCall('whoami'))).status).toBe(200);
    const denied = await mcpPost(s, t.access_token, toolsCall('add_note'));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('www-authenticate')).toMatch(/error="insufficient_scope", scope="notes:read notes:write", resource_metadata="/);
    expect(s.api.authorizations.length).toBe(2); // whoami at sign-in + whoami call; add_note never reached the API
  });
});

describe('the browser side', () => {
  it('a sign-in cannot be finished from another browser, and cross-site form posts are refused', async () => {
    const s = await createStack('apikey');
    const start = await s.net(authorizeUrl({}), { redirect: 'manual' });
    const next = new URL(start.headers.get('location')!);
    const id = next.searchParams.get('request')!;
    // A different browser (no cookie) opening the link:
    expect((await s.net(next.href)).status).toBe(403);
    // A cross-site page posting the form with the victim's cookie:
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const evil = await s.net(`${JACK}/oauth/apikey`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: `request=${id}&api_key=key-alice`,
    });
    expect(evil.status).toBe(403);
  });

  it('the IdP callback must carry this sign-in\'s state, and the id_token its nonce', async () => {
    const s = await createStack('oidc');
    const start = await s.net(authorizeUrl({}), { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const tampered = await s.net(`${JACK}/oauth/upstream/callback?code=x&state=${state.split('.')[0]}.forged`, { headers: { cookie } });
    expect(tampered.status).toBe(400);

    s.idp.forgeNonce = true;
    const res = await s.browser(authorizeUrl({}));
    expect(new URL(res.url!).searchParams.get('error')).toBe('access_denied');
    expect(new URL(res.url!).searchParams.get('error_description')).toMatch(/nonce/);
    expect(s.store.listGrants()).toEqual([]);
  });
});

describe('account linking (link mode)', () => {
  it('end to end with the SDK client: the app\'s own login, a signed response, then assertions on every call', async () => {
    const s = await createStack('link');
    let consent = '';
    const { client, browse } = await signedInClient(s, new TestOAuthProvider({ cimd: true }), {
      'customer-login': () => ({ username: 'alice' }),
      'jack-consent': ({ html }) => ((consent = html), { decision: 'approve' }),
    });
    // The user went: Jack → the app's link route → the app's login → back to the link route → Jack's consent.
    expect(browse!.visited.filter((u) => u.startsWith(API)).map((u) => new URL(u).pathname)).toEqual(['/jack/link', '/login', '/login', '/jack/link']);
    expect(consent).toContain('Signed in as <span class="who">Alice Martin</span>');
    const r = await client.callTool({ name: 'add_note', arguments: { text: 'linked' } });
    expect(JSON.parse(text(r))).toMatchObject({ ok: true, by: 'alice', text: 'linked' });
    // No upstream token exists: the API saw one fresh assertion per call and no Authorization header.
    expect(s.api.assertions).toHaveLength(1);
    expect(s.api.authorizations.at(-1)).toBe('');
    expect(s.api.lastScopes).toEqual(['notes:read', 'notes:write']);
    await client.callTool({ name: 'whoami', arguments: {} });
    expect(s.api.assertions).toHaveLength(2);
    expect(s.api.assertions[0]).not.toBe(s.api.assertions[1]);
    expect(s.store.listGrants()[0]).toMatchObject({ subject: 'link:alice', display: 'Alice Martin' });
    // What Jack stored for the grant is just the app's user id, sealed — there is nothing else to steal.
    const verifier = createJackVerifier({ secret: LINK_SECRET, issuer: JACK, audience: API });
    expect(() => verifier.verifyAssertion(s.api.assertions[1]!)).not.toThrow();
    expect(() => verifier.verifyAssertion(s.api.assertions[1]!)).toThrow(/replayed/);
  });

  it('a scope-narrowed grant produces narrowed assertions', async () => {
    const s = await createStack('link');
    const v = 'v'.repeat(43);
    const res = await s.browser(authorizeUrl({ scope: 'notes:read', code_challenge: sha256(v) }));
    const tok = (await json(await exchange(s, { code: new URL(res.url!).searchParams.get('code')!, verifier: v }))) as { access_token: string };
    expect((await mcpPost(s, tok.access_token, toolsCall('whoami'))).status).toBe(200);
    expect(s.api.lastScopes).toEqual(['notes:read']);
  });

  it('forged, foreign or mismatched link responses are refused and no grant is created', async () => {
    const s = await createStack('link');
    const start = await s.net(authorizeUrl({}), { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const requestToken = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const verifier = createJackVerifier({ secret: LINK_SECRET, issuer: JACK, audience: API });
    const { requestId } = verifier.verifyLinkRequest(requestToken);
    const now = Math.floor(Date.now() / 1000);
    const response = (over: Record<string, unknown>, secret = LINK_SECRET) =>
      signHs256({ typ: TYP.response, iss: API, aud: JACK, jti: requestId, sub: 'mallory', iat: now, exp: now + 300, ...over }, secret);
    const cb = (tok: string, c = cookie) => s.net(`${JACK}/oauth/link/callback?response=${encodeURIComponent(tok)}`, { headers: { cookie: c }, redirect: 'manual' });
    const expectDenied = async (tok: string, why: RegExp) => {
      const r = await cb(tok);
      const loc = r.headers.get('location');
      expect(loc, tok.slice(0, 20)).not.toBeNull();
      const q = new URL(loc!).searchParams;
      expect(q.get('error')).toBe('access_denied');
      expect(q.get('error_description')).toMatch(why);
    };
    await expectDenied(response({}, 'wrong-secret-wrong-secret-wrong-secret-00'), /rejected/);
    // Each attempt consumed the auth request (failToClient deletes it): start fresh for the next ones.
    const fresh = async () => {
      const st = await s.net(authorizeUrl({}), { redirect: 'manual' });
      const ck = st.headers.get('set-cookie')!.split(';')[0]!;
      const id = verifier.verifyLinkRequest(new URL(st.headers.get('location')!).searchParams.get('request')!).requestId;
      return { ck, id };
    };
    let f = await fresh();
    let r = await cb(response({ jti: f.id, typ: TYP.request }), f.ck);
    expect(new URL(r.headers.get('location')!).searchParams.get('error_description')).toMatch(/wrong token type/);
    f = await fresh();
    r = await cb(response({ jti: f.id, exp: now - 500 }), f.ck);
    expect(new URL(r.headers.get('location')!).searchParams.get('error_description')).toMatch(/expired/);
    // A valid response for another sign-in, replayed into this one: the cookie binding stops it (different browser).
    f = await fresh();
    r = await cb(response({ jti: f.id }), cookie);
    expect(r.status).toBe(403);
    // No user named: refused.
    f = await fresh();
    r = await cb(response({ jti: f.id, sub: '' }), f.ck);
    expect(new URL(r.headers.get('location')!).searchParams.get('error_description')).toMatch(/names no user/);
    expect(s.store.listGrants()).toEqual([]);
  });

  it('the link route must live on the upstream origin, and the secret must be strong', async () => {
    await expect(createStack('link', { auth: { mode: 'link', link: { linkUrl: 'https://elsewhere.test/jack/link', secret: LINK_SECRET } } })).rejects.toThrow(/must be on the upstream origin/);
    await expect(createStack('link', { auth: { mode: 'link', link: { linkUrl: `${API}/jack/link`, secret: 'short' } } })).rejects.toThrow(/32 characters/);
  });
});

describe('client registration', () => {
  it('CIMD documents must name themselves; the default fetcher refuses http and private hosts', async () => {
    const bad = await createStack('apikey', {
      fetchClientMetadata: async () => Response.json({ client_id: 'https://someone-else.example/c.json', redirect_uris: [REDIRECT] }),
    });
    expect((await bad.net(authorizeUrl({}))).status).toBe(400);

    const strict = await createStack('apikey', { fetchClientMetadata: undefined });
    for (const id of ['https://127.0.0.1/client.json', 'https://169.254.169.254/latest/meta-data/x']) {
      const r = await strict.net(authorizeUrl({ client_id: id }));
      expect(r.status).toBe(400);
      expect(await r.text()).toMatch(/not a public address|could not fetch/);
    }
  });

  it('DCR: public clients only, safe redirect URIs only, rate limited', async () => {
    const s = await createStack('apikey', { dcrLimitPerHour: 2 });
    const reg = (body: unknown) => s.net(`${JACK}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await reg({ redirect_uris: ['javascript:alert(1)'] })).status).toBe(400);
    expect((await reg({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400);
    expect((await reg({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] })).status).toBe(400);
    const ok = await reg({ redirect_uris: [REDIRECT], client_name: 'Cursor' });
    expect(ok.status).toBe(201);
    expect(await json(ok)).toMatchObject({ client_id: expect.stringMatching(/^jdc_/), token_endpoint_auth_method: 'none' });
    expect((await reg({ redirect_uris: [REDIRECT] })).status).toBe(201);
    expect((await reg({ redirect_uris: [REDIRECT] })).status).toBe(429);
  });
});

describe('at rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jack-auth-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the database never holds an API key, upstream token, refresh token or code in clear', async () => {
    const path = join(dir, 'auth.db');
    const store = new SqliteAuthStore(path);
    const s = await createStack('oidc', { store });
    const t = (await json(await exchange(s, await codeFor(s)))) as { refresh_token: string };
    const s2 = await createStack('apikey', { store });
    await exchange(s2, await codeFor(s2));
    store.close();
    const bytes = readFileSync(path).toString('latin1') + (() => {
      try {
        return readFileSync(`${path}-wal`).toString('latin1');
      } catch {
        return '';
      }
    })();
    for (const secret of ['idp-at-alice', 'rt:alice:0', 'key-alice', t.refresh_token]) expect(bytes, secret).not.toContain(secret);
    // Non-vacuity: the grant really is in this file.
    expect(bytes).toContain('https://idp.test|alice');
  });
});
