/**
 * The JackStore contract against both backends — SQLite always, Postgres
 * when PG_TEST_URL is set (a throwaway schema per run) — and one request-
 * level pass through createJack on Postgres only: PgJackStore for the
 * control plane, PgAuthStore handles from `authStoreFor`, no dataDir.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ident, testSql } from '@graphmind-ai/db';
import { PgAuthStore } from '@graphmind-ai/jack-auth';
import type { Manifest } from '@graphmind-ai/jack-schema';
import { createJack, PgJackStore, SlugTakenError, SqliteStore, type JackStore } from '../src/index.js';

const pg = await testSql();
const spec = readFileSync(fileURLToPath(new URL('../../../examples/jack-tasks/openapi.json', import.meta.url)), 'utf8');

beforeAll(async () => {
  if (!pg) return;
  expect(await new PgJackStore(pg.sql, { schema: pg.schema }).migrate()).toEqual(['jack-001-init']);
  expect(await PgAuthStore.migrate(pg.sql, pg.schema)).toEqual(['jack-auth-001-init']);
});
afterAll(async () => pg?.drop());

const manifest = (upstream: string, tools: string[] = []): Manifest => ({
  version: 1,
  name: 'T',
  upstream,
  tools: tools.map((name) => ({
    name,
    description: 'A tool.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    requiredScopes: [],
    confirm: false,
    http: { method: 'GET', path: '/x', params: [], body: 'json', headers: {}, timeoutMs: 30_000 },
    response: { maxBytes: 50_000 },
  })),
  toolsets: [],
  scopes: [],
});

const backends: [string, (() => Promise<JackStore>) | null][] = [
  ['sqlite', async () => new SqliteStore(':memory:')],
  [
    'pg',
    pg
      ? async () => {
          // Tables are shared across a run, so every case uses unique slugs.
          return new PgJackStore(pg.sql, { schema: pg.schema });
        }
      : null,
  ],
];

let n = 0;
const slug = (base: string) => `${base}-${process.pid}-${++n}`;

for (const [name, make] of backends) {
  (make ? describe : describe.skip)(`JackStore contract (${name})`, () => {
    it('projects: create, unique slug, get by id/slug, list by owner in creation order, update, delete', async () => {
      const s = await make!();
      const a = await s.createProject({ slug: slug('a'), name: 'A', upstream: 'https://a.test', auth: { mode: 'none', requireSignIn: false }, ownerId: 'u1' });
      await expect(s.createProject({ slug: a.slug, name: 'dup', upstream: 'https://a.test', auth: { mode: 'none', requireSignIn: false } })).rejects.toBeInstanceOf(SlugTakenError);
      const b = await s.createProject({ slug: slug('b'), name: 'B', upstream: 'https://b.test', auth: { mode: 'apikey', header: 'authorization', prefix: 'Bearer ', requireSignIn: false } as never });
      expect(a).toMatchObject({ ownerId: 'u1', activeVersion: null, auth: { mode: 'none' } });
      expect(await s.getProject(a.id)).toEqual(a);
      expect(await s.getProjectBySlug(b.slug)).toEqual(b);
      expect(await s.getProject('nope')).toBeNull();
      expect((await s.listProjects('u1')).map((p) => p.id)).toEqual([a.id]);
      const all = (await s.listProjects()).map((p) => p.id);
      expect(all.indexOf(a.id)).toBeLessThan(all.indexOf(b.id));
      const u = await s.updateProject(a.id, { name: 'A2' });
      expect(u).toMatchObject({ name: 'A2', ownerId: 'u1', upstream: 'https://a.test' });
      expect((await s.getProject(a.id))?.name).toBe('A2');
      await expect(s.updateProject('nope', { name: 'x' })).rejects.toThrow();
      expect(await s.deleteProject(b.id)).toBe(true);
      expect(await s.deleteProject(b.id)).toBe(false);
    });

    it('sources, drafts and secrets upsert; secrets list sorted; deleting a project cascades', async () => {
      const s = await make!();
      const p = await s.createProject({ slug: slug('c'), name: 'C', upstream: 'https://c.test', auth: { mode: 'none', requireSignIn: false } });
      expect(await s.getSource(p.id)).toBeNull();
      await s.putSource(p.id, { text: '{}', url: null });
      await s.putSource(p.id, { text: '{"a":1}', url: 'https://c.test/openapi.json' });
      expect(await s.getSource(p.id)).toMatchObject({ text: '{"a":1}', url: 'https://c.test/openapi.json' });
      const config = { source: 'x', tools: { b_op: { enabled: true }, a_op: { enabled: false } }, toolsets: {} } as never;
      await s.putDraft(p.id, config);
      expect((await s.getDraft(p.id))?.config).toMatchObject({ source: 'x', tools: { b_op: { enabled: true }, a_op: { enabled: false } } });
      await s.putSecret(p.id, 'b', 'sealed-b');
      await s.putSecret(p.id, 'B', 'sealed-B');
      await s.putSecret(p.id, 'a', 'sealed-a1');
      await s.putSecret(p.id, 'a', 'sealed-a2');
      expect(await s.getSecret(p.id, 'a')).toBe('sealed-a2');
      expect((await s.listSecrets(p.id)).map((x) => x.name)).toEqual(['B', 'a', 'b']);
      expect(await s.deleteSecret(p.id, 'b')).toBe(true);
      expect(await s.deleteSecret(p.id, 'b')).toBe(false);
      await s.deleteProject(p.id);
      expect(await s.getSource(p.id)).toBeNull();
      expect(await s.getDraft(p.id)).toBeNull();
      expect(await s.getSecret(p.id, 'a')).toBeNull();
    });

    it('deployments: versions 1, 2, … (also when created concurrently), newest first; activeDeployment follows activeVersion', async () => {
      const s = await make!();
      const p = await s.createProject({ slug: slug('d'), name: 'D', upstream: 'https://d.test', auth: { mode: 'none', requireSignIn: false } });
      await expect(s.createDeployment({ projectId: 'nope', manifest: manifest('https://d.test'), manifestHash: 'h', createdBy: 'me' })).rejects.toThrow();
      const d1 = await s.createDeployment({ projectId: p.id, manifest: manifest('https://d.test', ['t1']), manifestHash: 'h1', createdBy: 'me', message: 'first' });
      expect(d1).toMatchObject({ version: 1, manifestHash: 'h1', createdBy: 'me', config: null, message: 'first' });
      const more = await Promise.all([1, 2, 3].map((i) => s.createDeployment({ projectId: p.id, manifest: manifest('https://d.test'), manifestHash: `h${i + 1}`, createdBy: 'me' })));
      expect(more.map((d) => d.version).sort()).toEqual([2, 3, 4]);
      expect((await s.listDeployments(p.id)).map((d) => d.version)).toEqual([4, 3, 2, 1]);
      expect(await s.activeDeployment(p.id)).toBeNull();
      await s.updateProject(p.id, { activeVersion: 1 });
      expect((await s.activeDeployment(p.id))?.manifest.tools.map((t) => t.name)).toEqual(['t1']);
      expect(await s.getDeployment(p.id, 9)).toBeNull();
    });

    it('calls: newest first, paged by id, limit clamped', async () => {
      const s = await make!();
      const p = await s.createProject({ slug: slug('e'), name: 'E', upstream: 'https://e.test', auth: { mode: 'none', requireSignIn: false } });
      for (let i = 0; i < 5; i++) {
        await s.insertCall({ projectId: p.id, version: 1, tool: `t${i}`, status: 'ok', upstreamStatus: 200, ms: 3, requestBytes: 1, responseBytes: 2, subject: null, clientId: null, at: i });
      }
      const all = await s.listCalls(p.id);
      expect(all.map((c) => c.tool)).toEqual(['t4', 't3', 't2', 't1', 't0']);
      expect(all[0]).toMatchObject({ projectId: p.id, version: 1, upstreamStatus: 200, ms: 3, subject: null });
      const page = await s.listCalls(p.id, { limit: 2, before: all[1]!.id });
      expect(page.map((c) => c.tool)).toEqual(['t2', 't1']);
      expect(await s.listCalls(p.id, { limit: 0 })).toHaveLength(1);
    });
  });
}

(pg ? describe : describe.skip)('createJack on Postgres (PG_TEST_URL)', () => {
  it('create, deploy and tools/list through /p/<slug>/mcp; sign-in rows are per project; delete purges them', async () => {
    const { sql, schema } = pg!;
    const store = new PgJackStore(sql, { schema });
    const scoped: string[] = [];
    const jack = createJack({
      store,
      publicOrigin: 'http://127.0.0.1:4998',
      // No dataDir: with a factory nothing may touch the filesystem.
      authStoreFor: (projectId) => {
        scoped.push(projectId);
        return PgAuthStore.forProject(sql, projectId, { schema });
      },
      secretKey: randomBytes(32),
      egress: 'any',
      dashboard: false,
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await jack.app.request(`http://127.0.0.1:4998${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };
    try {
      const open = slug('open');
      const created = await call('POST', '/v1/projects', { slug: open, source: { text: spec }, upstream: 'https://acme.test' });
      expect(created.status).toBe(201);
      const id = created.json.project.id as string;
      expect((await call('POST', `/v1/projects/${id}/deploy`, { message: 'v1' })).status).toBe(201);

      const client = new Client({ name: 'pg-test', version: '0.0.1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:4998/p/${open}/mcp`), { fetch: async (u, init) => jack.app.fetch(new Request(u, init)) }));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('list_tasks');
      await client.close();

      // A sign-in project: its auth server's rows land in the shared tables under its own project id.
      const signin = slug('signin');
      const sid = (await call('POST', '/v1/projects', { slug: signin, source: { text: spec }, upstream: 'https://acme.test' })).json.project.id as string;
      await call('PATCH', `/v1/projects/${sid}/draft`, { auth: { mode: 'apikey' } });
      expect((await call('POST', `/v1/projects/${sid}/deploy`, {})).status).toBe(201);
      expect((await jack.app.request(`http://127.0.0.1:4998/p/${signin}/mcp`, { method: 'POST' })).status).toBe(401);
      const reg = await jack.app.request(`http://127.0.0.1:4998/p/${signin}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'] }),
      });
      expect(reg.status).toBe(201);
      const clients = await sql.query<{ project_id: string }>(`SELECT project_id FROM ${ident(schema)}.jack_auth_clients WHERE project_id = ANY($1)`, [[id, sid]]);
      expect(clients.map((r) => r.project_id)).toEqual([sid]);
      expect(scoped).toContain(sid);
      expect((await call('GET', `/v1/projects/${sid}/grants`)).json.grants).toEqual([]);

      // Concurrent first requests share one bundle build (and the calls still all succeed).
      const statuses = await Promise.all(
        Array.from({ length: 4 }, () => Promise.resolve(jack.app.request(`http://127.0.0.1:4998/.well-known/oauth-authorization-server/p/${signin}`)).then((r) => r.status)),
      );
      expect(statuses).toEqual([200, 200, 200, 200]);

      expect((await jack.app.request(`http://127.0.0.1:4998/p/${signin}/oauth/jwks`)).status).toBe(200);
      expect(await sql.query(`SELECT 1 FROM ${ident(schema)}.jack_auth_signing_keys WHERE project_id = $1`, [sid])).toHaveLength(1);
      expect((await call('DELETE', `/v1/projects/${sid}`)).status).toBe(204);
      expect(await sql.query(`SELECT 1 FROM ${ident(schema)}.jack_auth_clients WHERE project_id = $1`, [sid])).toEqual([]);
      expect(await sql.query(`SELECT 1 FROM ${ident(schema)}.jack_auth_signing_keys WHERE project_id = $1`, [sid])).toEqual([]);
      expect(await store.getProject(sid)).toBeNull();
      expect(await store.getProject(id)).not.toBeNull();
    } finally {
      await jack.close();
    }
  });
});
