/**
 * GraphMind Jack, dashboard / control plane (M4): an OIDC client secret
 * entered on the Sign-in page is write-only.
 *
 *   forbidden  the client secret — never in any /v1 response (project,
 *              draft, list, history, export), the dashboard files, or the
 *              database file
 *   by-design  the secret's NAME is listed, and Jack really uses the value:
 *              the identity provider's token endpoint receives it (non-vacuity)
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJack, SqliteStore } from 'jack-api';
import { browse } from '@graphmind-ai/jack-auth/testing';

const nonce = randomBytes(8).toString('hex');
const FORBIDDEN_SECRET = `cs_CANARY_${nonce}_${randomBytes(16).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'jack-dash-audit-'));
let idp: Server;
let idpUrl = '';
const tokenEndpointSaw: string[] = [];

const spec = (origin: string) =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Canary', version: '1' },
    servers: [{ url: origin }],
    paths: { '/me': { get: { operationId: 'getMe', summary: 'Return the signed-in user for the audit.', responses: {} } } },
  });

beforeAll(async () => {
  // A minimal identity provider: discovery + a token endpoint that records the client auth it receives.
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ issuer: idpUrl, authorization_endpoint: `${idpUrl}/authorize`, token_endpoint: `${idpUrl}/token`, jwks_uri: `${idpUrl}/jwks` }));
    }
    if (url.pathname === '/authorize') {
      res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=c&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}` });
      return res.end();
    }
    if (url.pathname === '/token') {
      tokenEndpointSaw.push(Buffer.from((req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString());
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end('{"error":"invalid_grant"}');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => idp.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('jack dashboard never returns or stores a client secret in clear', () => {
  it('across every /v1 surface, the export, the dashboard and the database file', async () => {
    const ORIGIN = 'http://127.0.0.1:4997';
    const dbPath = join(dir, 'jack.db');
    const store = new SqliteStore(dbPath);
    const jack = createJack({ store, publicOrigin: ORIGIN, dataDir: join(dir, 'data'), secretKey: randomBytes(32), egress: 'any', env: {} });
    const surfaces: string[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await jack.app.request(`${ORIGIN}${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      surfaces.push(`${res.status} ${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${text}`);
      return text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    };

    const created = await call('POST', '/v1/projects', { slug: 'canary', source: { text: spec(idpUrl) } });
    const id = created.project.id as string;
    await call('PUT', `/v1/projects/${id}/secrets/oidc_client_secret`, { value: FORBIDDEN_SECRET });
    await call('PATCH', `/v1/projects/${id}/draft`, { auth: { mode: 'oidc', issuer: idpUrl, clientId: 'jack', clientSecretRef: 'secret:oidc_client_secret', scopes: ['openid'] } });
    await call('POST', `/v1/projects/${id}/deploy`, {});
    for (const path of ['', '/draft', '/deployments', '/deployments/1', '/jack.yaml', '/grants', '/calls']) await call('GET', `/v1/projects/${id}${path}`);
    await call('GET', '/v1/projects');
    for (const file of ['/', '/app.js', '/style.css']) await call('GET', file);
    // Error paths: a bad secret name, a bad value, an unknown secret delete.
    await call('PUT', `/v1/projects/${id}/secrets/bad-name!`, { value: FORBIDDEN_SECRET });
    await call('PUT', `/v1/projects/${id}/secrets/x`, { value: '' });

    // Non-vacuity: a sign-in makes Jack present the secret to the IdP's token endpoint.
    const start = await call('POST', `/v1/projects/${id}/test-signin`);
    await browse(start.url, async (u, i) => (u.startsWith(ORIGIN) ? jack.app.fetch(new Request(u, i)) : fetch(u, i)), { stopAt: (u) => new URL(u).pathname === '/', forms: {}, maxSteps: 10 }).catch(() => null);
    await jack.close();
    store.close();

    const all = surfaces.join('\n---\n');
    expect(all).not.toContain(FORBIDDEN_SECRET);
    expect(readFileSync(dbPath).toString('latin1')).not.toContain(FORBIDDEN_SECRET);
    expect(all).toContain('oidc_client_secret'); // the name is listed
    expect(tokenEndpointSaw).toContain(`jack:${encodeURIComponent(FORBIDDEN_SECRET)}`); // and the value is really used
  });
});
