/**
 * M0: the control plane over SQLite — projects, deployments with diff,
 * promote, auth, problem+json errors.
 */
import { describe, expect, it } from 'vitest';
import type { Manifest } from '@graphmind-ai/jack-schema';
import { createApi, mcpUrlFor, SqliteStore } from '../src/index.js';

const petstore = (extra: Partial<Manifest> = {}): Manifest => ({
  version: 1,
  name: 'Petstore',
  upstream: 'https://api.petstore.test',
  tools: [
    {
      name: 'get_pet',
      description: 'Fetch one pet by id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      annotations: { readOnlyHint: true },
      requiredScopes: [],
      confirm: false,
      http: { method: 'GET', path: '/pets/{id}', params: [{ arg: 'id', in: 'path' }], body: 'json', headers: {}, timeoutMs: 30_000 },
      response: { maxBytes: 50_000 },
    },
  ],
  toolsets: [],
  scopes: [],
  ...extra,
});

function setup(apiKeys?: string[]) {
  const store = new SqliteStore(':memory:');
  const app = createApi({ store, ...(apiKeys ? { apiKeys } : {}) });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const type = res.headers.get('content-type');
    const isJson = type !== null && /json/.test(type);
    return { status: res.status, json: isJson && text ? (JSON.parse(text) as Record<string, unknown>) : null, type };
  };
  return { store, app, call };
}

describe('jack control plane', () => {
  it('reports health with the one protocol revision we speak', async () => {
    const { call } = setup();
    const r = await call('GET', '/v1/health');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, service: 'jack', protocol: '2026-07-28', auth: false, projects: 0 });
  });

  it('creates projects, defaults auth to none, and derives the MCP url', async () => {
    const { call } = setup();
    const r = await call('POST', '/v1/projects', { slug: 'petstore', upstream: 'https://api.petstore.test/v2/' });
    expect(r.status).toBe(201);
    const project = r.json!.project as Record<string, unknown>;
    expect(project).toMatchObject({
      slug: 'petstore',
      name: 'petstore',
      upstream: 'https://api.petstore.test', // origin only
      auth: { mode: 'none', requireSignIn: false },
      activeVersion: null,
      mcpUrl: 'http://127.0.0.1:4820/p/petstore/mcp',
    });
    const dup = await call('POST', '/v1/projects', { slug: 'petstore', upstream: 'https://other.test' });
    expect(dup.status).toBe(409);
    expect(dup.type).toContain('application/problem+json');

    const bad = await call('POST', '/v1/projects', { slug: 'Bad Slug', upstream: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ title: 'Invalid request body' });

    const list = await call('GET', '/v1/projects');
    expect((list.json!.projects as unknown[]).length).toBe(1);
  });

  it('hosted projects get their own host', () => {
    expect(mcpUrlFor('https://mcp.graphmind.ai', { slug: 'acme' })).toBe('https://acme.mcp.graphmind.ai/mcp');
  });

  it('deployments: validated, versioned, diffed; promote swaps the active pointer', async () => {
    const { call } = setup();
    const { json } = await call('POST', '/v1/projects', { slug: 'petstore', upstream: 'https://api.petstore.test' });
    const id = (json!.project as { id: string }).id;

    const d1 = await call('POST', `/v1/projects/${id}/deployments`, { manifest: petstore() });
    expect(d1.status).toBe(201);
    expect(d1.json!.deployment).toMatchObject({ version: 1, createdBy: 'api' });
    expect(d1.json!.diff).toEqual({ added: ['get_pet'], removed: [], changed: [], rewired: [] });

    // Not promoted yet: nothing is active, the second deploy still diffs against nothing.
    const before = await call('GET', `/v1/projects/${id}`);
    expect(before.json!.active).toBeNull();

    const promote = await call('POST', `/v1/projects/${id}/promote`, { version: 1 });
    expect(promote.status).toBe(200);
    expect((promote.json!.project as { activeVersion: number }).activeVersion).toBe(1);

    const m2 = petstore();
    m2.tools[0]!.description = 'Fetch one pet by its id.';
    const d2 = await call('POST', `/v1/projects/${id}/deployments`, { manifest: m2 }, { 'x-jack-actor': 'bridge' });
    expect(d2.json!.deployment).toMatchObject({ version: 2, createdBy: 'bridge' });
    expect(d2.json!.diff).toMatchObject({ changed: ['get_pet'] });

    const list = await call('GET', `/v1/projects/${id}/deployments`);
    expect(list.json).toMatchObject({ activeVersion: 1 });
    expect((list.json!.deployments as Array<{ version: number; tools: number }>).map((d) => d.version)).toEqual([2, 1]);

    const one = await call('GET', `/v1/projects/${id}/deployments/2`);
    expect((one.json!.deployment as { manifest: Manifest }).manifest.tools[0]!.description).toBe('Fetch one pet by its id.');

    const missing = await call('POST', `/v1/projects/${id}/promote`, { version: 9 });
    expect(missing.status).toBe(404);
  });

  it('rejects manifests that point at a different host than the project', async () => {
    const { call } = setup();
    const { json } = await call('POST', '/v1/projects', { slug: 'petstore', upstream: 'https://api.petstore.test' });
    const id = (json!.project as { id: string }).id;
    const r = await call('POST', `/v1/projects/${id}/deployments`, { manifest: petstore({ upstream: 'https://evil.test' }) });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ title: 'Upstream mismatch' });

    const broken = petstore();
    broken.tools[0]!.http.params = [];
    const r2 = await call('POST', `/v1/projects/${id}/deployments`, { manifest: broken });
    expect(r2.status).toBe(400);
    expect(r2.json).toMatchObject({ title: 'Invalid manifest' });
  });

  it('bearer keys gate /v1 but not the dashboard page', async () => {
    const { call } = setup(['jk_test_secret']);
    expect((await call('GET', '/v1/health')).status).toBe(401);
    expect((await call('GET', '/v1/health', undefined, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call('GET', '/v1/health', undefined, { authorization: 'Bearer jk_test_secret' })).status).toBe(200);
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
  });

  it('deleting a project cascades to its deployments', async () => {
    const { call, store } = setup();
    const { json } = await call('POST', '/v1/projects', { slug: 'petstore', upstream: 'https://api.petstore.test' });
    const id = (json!.project as { id: string }).id;
    await call('POST', `/v1/projects/${id}/deployments`, { manifest: petstore() });
    expect((await call('DELETE', `/v1/projects/${id}`)).status).toBe(204);
    expect(store.listDeployments(id)).toEqual([]);
    expect((await call('GET', `/v1/projects/${id}`)).status).toBe(404);
  });
});
