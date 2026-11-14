/**
 * GraphMind Jack, account linking (M5): the shared link secret must never
 * leave Jack, and the per-call assertion must reach only the customer's API.
 *
 *   forbidden  the shared secret — not in any OAuth response, page, MCP
 *              result, event, or the database file
 *   forbidden  an assertion token — never in anything returned to the MCP
 *              client (it is the credential for the upstream)
 *   by-design  the assertion reaches the upstream, and the user's name is on
 *              the consent page (non-vacuity)
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManifest } from '@graphmind-ai/jack-schema';
import { createToolHttpHandler } from '@graphmind-ai/jack-runtime';
import { createAuthServer, sha256, SqliteAuthStore, type AuthEvent } from '@graphmind-ai/jack-auth';
import { browse } from '@graphmind-ai/jack-auth/testing';
import { createJackVerifier } from '@graphmind-ai/jack-verify';

const nonce = randomBytes(8).toString('hex');
const FORBIDDEN_SECRET = `lk_CANARY_${nonce}_${randomBytes(16).toString('hex')}`;
const BY_DESIGN_NAME = `Linked User ${nonce}`;
const JACK = 'https://jack.test';
const REDIRECT = 'http://127.0.0.1:41998/cb';
const dir = mkdtempSync(join(tmpdir(), 'jack-link-audit-'));
let upstream: HttpServer;
let origin = '';
const assertionsUpstream: string[] = [];

beforeAll(async () => {
  // The customer's API: a session-login app with Jack's two additions, verifying with the real library.
  upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const jack = createJackVerifier({ secret: FORBIDDEN_SECRET, issuer: JACK, audience: origin });
    if (url.pathname === '/jack/link') {
      const token = url.searchParams.get('request') ?? '';
      res.writeHead(302, { location: jack.linkResponseUrl(token, { userId: `u-${nonce}`, name: BY_DESIGN_NAME }) });
      return res.end();
    }
    const a = req.headers['jack-assertion'];
    if (typeof a === 'string') {
      assertionsUpstream.push(a);
      try {
        jack.verifyAssertion(a);
      } catch (err) {
        res.writeHead(401);
        return res.end(String(err));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ note: `hello-${nonce}` }));
    }
    res.writeHead(401);
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('jack link mode never leaks the shared secret or an assertion to the MCP client', () => {
  it('across sign-in, tool calls, revocation and the database file', async () => {
    const manifest = parseManifest({
      version: 1,
      name: 'Canary',
      upstream: origin,
      tools: [{ name: 'read_note', description: 'Read a note for the audit test.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, http: { method: 'GET', path: '/note' } }],
    });
    const dbPath = join(dir, 'auth.db');
    const store = new SqliteAuthStore(dbPath);
    const events: AuthEvent[] = [];
    const auth = createAuthServer({
      issuer: JACK,
      resource: `${JACK}/mcp`,
      projectName: 'Canary',
      manifest: () => manifest,
      auth: { mode: 'link', link: { linkUrl: `${origin}/jack/link`, secret: FORBIDDEN_SECRET } },
      store,
      secretKey: randomBytes(32),
      egress: 'any',
      onEvent: (e) => events.push(e),
    });
    const mcp = createToolHttpHandler({ manifest, egress: 'any', listAll: true, credentials: auth.credentials });
    const app = new Hono();
    app.route('/', auth.routes);
    app.all('/mcp', (c) => auth.protect((req, authInfo) => mcp.fetch(req, { authInfo }))(c.req.raw));

    const surfaces: string[] = [];
    const net = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.origin !== JACK) return fetch(url, init); // the customer's app, over a real socket
      const res = await app.fetch(new Request(url, init));
      surfaces.push(`${res.status} ${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.clone().text()}`);
      return res;
    };

    const client = (await (await net(`${JACK}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const authz = new URL(`${JACK}/oauth/authorize`);
    authz.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: sha256(verifier), code_challenge_method: 'S256', resource: `${JACK}/mcp`, state: 's' }).toString();
    const done = await browse(authz.href, (u, i) => net(u, i), { stopAt: (u) => u.startsWith(REDIRECT), forms: { 'jack-consent': () => ({ decision: 'approve' }) } });
    const code = new URL(done.url!).searchParams.get('code')!;
    const tokens = (await (await net(`${JACK}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id }).toString() })).json()) as { access_token: string; refresh_token: string };
    const call = () =>
      net(`${JACK}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.access_token}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'read_note' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_note', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'audit', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
      });
    await call();
    await call();
    auth.revokeGrant(store.listGrants()[0]!.id);
    await call(); // 401 path
    store.close();

    const all = [...surfaces, ...events.map((e) => JSON.stringify(e))].join('\n---\n');
    const db = readFileSync(dbPath).toString('latin1') + (() => { try { return readFileSync(`${dbPath}-wal`).toString('latin1'); } catch { return ''; } })();
    expect(all).not.toContain(FORBIDDEN_SECRET);
    expect(db).not.toContain(FORBIDDEN_SECRET);
    for (const a of assertionsUpstream) expect(all).not.toContain(a);
    // Non-vacuity.
    expect(assertionsUpstream).toHaveLength(2);
    expect(all).toContain(BY_DESIGN_NAME);
    expect(all).toContain(`hello-${nonce}`);
    expect(db).toContain(`link:u-${nonce}`);
  });
});
