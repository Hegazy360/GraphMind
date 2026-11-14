/**
 * GraphMind Jack, authorization server (M3): a user's upstream credential is
 * handed to Jack once — pasted on Jack's own sign-in page — and must never
 * come back out: not in a redirect, a token response, the consent page, an
 * MCP result, an event, or the database file.
 *
 *   forbidden  the user's API key for the customer's API
 *   forbidden  Jack's refresh token, in the database (only its hash may be stored)
 *   by-design  the user's display name and the tool result the model asked
 *              for — they MUST be found (non-vacuity)
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

const nonce = randomBytes(8).toString('hex');
const FORBIDDEN_KEY = `uk_CANARY_${nonce}_${randomBytes(16).toString('hex')}`;
const BY_DESIGN_NAME = `Canary User ${nonce}`;
const BY_DESIGN_DATA = `note-${nonce}`;
const JACK = 'https://jack.test';
const REDIRECT = 'http://127.0.0.1:41999/cb';

let upstream: HttpServer;
let origin = '';
const dir = mkdtempSync(join(tmpdir(), 'jack-auth-audit-'));

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${FORBIDDEN_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"title":"Unauthorized"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/me' ? { id: `u-${nonce}`, name: BY_DESIGN_NAME } : { note: BY_DESIGN_DATA }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('jack authorization server never returns or stores the user\'s upstream credential', () => {
  it('across a full sign-in, token refresh, tool calls, revocation and the database file', async () => {
    const manifest = parseManifest({
      version: 1,
      name: 'Canary',
      upstream: origin,
      tools: [
        { name: 'whoami', description: 'Return the signed-in user for the audit.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, http: { method: 'GET', path: '/me' } },
        { name: 'read_note', description: 'Read a note for the audit test.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, http: { method: 'GET', path: '/note' } },
      ],
    });
    const dbPath = join(dir, 'auth.db');
    const store = new SqliteAuthStore(dbPath);
    const events: AuthEvent[] = [];
    const auth = createAuthServer({
      issuer: JACK,
      resource: `${JACK}/mcp`,
      projectName: 'Canary',
      manifest: () => manifest,
      auth: { mode: 'apikey', apikey: { header: 'authorization', prefix: 'Bearer ', whoamiTool: 'whoami' } },
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
      const res = await app.fetch(new Request(url, init));
      const body = await res.clone().text();
      surfaces.push(`${res.status} ${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${body}`);
      return res;
    };

    // 1. Register (DCR) and sign in through the pages, as a browser would.
    const client = (await (await net(`${JACK}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Audit' }) })).json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const authz = new URL(`${JACK}/oauth/authorize`);
    authz.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: sha256(verifier), code_challenge_method: 'S256', resource: `${JACK}/mcp`, state: 's' }).toString();
    // A wrong key first (the error page is a surface too), then the right one.
    let attempt = 0;
    const done = await browse(authz.href, (u, i) => net(u, i), {
      stopAt: (u) => u.startsWith(REDIRECT),
      forms: {
        'jack-apikey': () => ({ api_key: attempt++ === 0 ? `${FORBIDDEN_KEY}x` : FORBIDDEN_KEY }),
        'jack-consent': () => ({ decision: 'approve' }),
      },
    });
    const code = new URL(done.url!).searchParams.get('code')!;

    // 2. Tokens: exchange, use, refresh, use again.
    const tokenReq = (form: Record<string, string>) =>
      net(`${JACK}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    const t1 = (await (await tokenReq({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id })).json()) as { access_token: string; refresh_token: string };
    const callTool = (token: string, name: string) =>
      net(`${JACK}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'audit', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
      });
    await callTool(t1.access_token, 'read_note');
    const t2 = (await (await tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id })).json()) as { access_token: string; refresh_token: string };
    await callTool(t2.access_token, 'whoami');
    // 3. Failure paths: replayed refresh (revokes), then a call with the dead token.
    await tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
    await callTool(t2.access_token, 'read_note');
    store.close();

    const db = readFileSync(dbPath).toString('latin1') + (() => { try { return readFileSync(`${dbPath}-wal`).toString('latin1'); } catch { return ''; } })();
    const all = [...surfaces, ...events.map((e) => JSON.stringify(e))].join('\n---\n');

    expect(all).not.toContain(FORBIDDEN_KEY);
    expect(db).not.toContain(FORBIDDEN_KEY);
    expect(db).not.toContain(t2.refresh_token);
    // Non-vacuity: the sign-in really validated the key against the API, and the data really flowed.
    expect(all).toContain(BY_DESIGN_NAME); // on the consent page
    expect(all).toContain(BY_DESIGN_DATA); // in a tool result
    expect(all).toContain('the API did not accept that key'); // the wrong-key path ran
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['client.registered', 'grant.created', 'refresh.replayed', 'grant.revoked']));
    expect(db).toContain(BY_DESIGN_NAME);
  });
});
