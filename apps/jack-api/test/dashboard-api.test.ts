/**
 * M4: the control plane behind the dashboard and `jack deploy`, and the
 * multi-project data plane — against the real Acme Tasks example API.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseConfigText, compile } from '@graphmind-ai/jack-openapi';
import { browse } from '@graphmind-ai/jack-auth/testing';
import { createTasksApp } from '../../../examples/jack-tasks/src/app.js';
import { createJack, SqliteStore, type Jack } from '../src/index.js';

const spec = readFileSync(fileURLToPath(new URL('../../../examples/jack-tasks/openapi.json', import.meta.url)), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'jack-m4-'));
const ORIGIN = 'http://127.0.0.1:4999'; // the public origin Jack believes it has; requests go in-process
let acme: ServerType;
let acmeUrl = '';

beforeAll(async () => {
  const holder: { f?: (r: Request) => Response | Promise<Response> } = {};
  await new Promise<void>((r) => {
    acme = serve({ fetch: (req) => holder.f!(req), port: 0, hostname: '127.0.0.1' }, () => r());
  });
  acmeUrl = `http://127.0.0.1:${(acme.address() as AddressInfo).port}`;
  holder.f = (await createTasksApp({ origin: acmeUrl })).app.fetch;
});
afterAll(async () => {
  await new Promise<void>((r) => acme.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function setup(name: string, extra: Partial<Parameters<typeof createJack>[0]> = {}) {
  const dbPath = join(dir, `${name}.db`);
  const store = new SqliteStore(dbPath);
  const jack: Jack = createJack({ store, publicOrigin: ORIGIN, dataDir: join(dir, name), secretKey: randomBytes(32), egress: 'any', ...extra });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await jack.app.request(`${ORIGIN}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* yaml, html */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const fetchJack = async (url: string | URL, init?: RequestInit): Promise<Response> => jack.app.fetch(new Request(url, init));
  return { store, jack, call, fetchJack, dbPath };
}

async function importAcme(t: ReturnType<typeof setup>, slug = 'acme') {
  const r = await t.call('POST', '/v1/projects', { slug, source: { text: spec }, upstream: acmeUrl });
  expect(r.status).toBe(201);
  return r.json.project.id as string;
}

describe('import', () => {
  it('previews a spec without creating anything, then creates a project from it', async () => {
    const t = setup('import');
    const p = await t.call('POST', '/v1/import/preview', { source: { text: spec }, upstream: acmeUrl });
    expect(p.json.preview).toMatchObject({ title: 'Acme Tasks API', dialect: 'openapi-3.1', operations: 13, enabled: 6, writes: 6 });
    expect((await t.call('GET', '/v1/projects')).json.projects).toEqual([]);

    const id = await importAcme(t);
    const d = (await t.call('GET', `/v1/projects/${id}/draft`)).json.draft;
    expect(d.enabled).toBe(6); // reads only: nothing that writes is on until someone turns it on
    expect(d.tools.find((x: any) => x.key === 'delete_task')).toMatchObject({ enabled: false, kind: 'destructive', requiredScopes: ['tasks:write'] });
    // Disabled tools still carry their effective definition, so they can be edited before enabling.
    expect(d.tools.find((x: any) => x.key === 'create_task').description).toMatch(/Create a task/);
    expect(d.live).toMatchObject({ version: null, changes: 6 });

    expect((await t.call('POST', '/v1/import/preview', { source: { text: '{"hello":1}' } })).status).toBe(400);
    expect((await t.call('POST', '/v1/projects', { slug: 'acme', source: { text: spec }, upstream: acmeUrl })).status).toBe(409);
  });
});

describe('editing the draft', () => {
  it('toggle, rename, describe, require approval; invalid edits are refused and nothing is saved', async () => {
    const t = setup('edit');
    const id = await importAcme(t);
    const patch = (key: string, body: unknown) => t.call('PATCH', `/v1/projects/${id}/draft/tools/${key}`, body);

    let d = (await patch('delete_task', { enabled: true, confirm: true, name: 'remove_task', description: 'Delete one task by id (tsk_…). The user approves first.' })).json.draft;
    const del = d.tools.find((x: any) => x.key === 'delete_task');
    expect(del).toMatchObject({ name: 'remove_task', enabled: true, confirm: true, descriptionIsCustom: true });
    expect(d.enabled).toBe(7);

    // Back to the spec's text with null.
    d = (await patch('delete_task', { description: null })).json.draft;
    expect(d.tools.find((x: any) => x.key === 'delete_task')).toMatchObject({ descriptionIsCustom: false, description: expect.stringMatching(/Deletes the task/) });

    // A rename that collides with another enabled tool cannot compile: refused, draft unchanged.
    const bad = await patch('list_tasks', { name: 'remove_task' });
    expect(bad.status).toBe(400);
    expect(bad.json.detail).toMatch(/two enabled tools are named 'remove_task'/);
    expect((await t.call('GET', `/v1/projects/${id}/draft`)).json.draft.tools.find((x: any) => x.key === 'list_tasks').name).toBe('list_tasks');

    expect((await patch('list_tasks', { name: 'Not Snake' })).status).toBe(400);
    expect((await patch('no_such_op', { enabled: true })).status).toBe(400);
    expect((await t.call('PATCH', `/v1/projects/${id}/draft`, { evil: 1 })).status).toBe(400);
  });

  it('exports a jack.yaml that compiles to exactly the draft', async () => {
    const t = setup('export');
    const id = await importAcme(t);
    await t.call('PATCH', `/v1/projects/${id}/draft/tools/create_task`, { enabled: true, description: 'Create a task in a project (ids look like prj_0001).' });
    await t.call('PATCH', `/v1/projects/${id}/draft`, { auth: { mode: 'apikey', whoamiTool: 'get_me' } });
    const y = await t.call('GET', `/v1/projects/${id}/jack.yaml`);
    expect(y.headers.get('content-type')).toContain('yaml');
    expect(y.text).toMatch(/^# jack\.yaml for Acme Tasks API — exported from the Jack dashboard/);
    const config = parseConfigText(y.text, 'exported');
    const draft = (await t.call('GET', `/v1/projects/${id}/draft`)).json.draft;
    const again = compile(JSON.parse(spec), config);
    expect(again.manifest.tools.map((x) => x.name).sort()).toEqual(draft.tools.filter((x: any) => x.enabled).map((x: any) => x.name).sort());
    expect(config.auth).toMatchObject({ mode: 'apikey', whoamiTool: 'get_me' });
  });
});

describe('deploy, history, rollback', () => {
  it('the data plane serves exactly the live version; rollback is live on the next request', async () => {
    const t = setup('deploy');
    const id = await importAcme(t);
    const mcp = `${ORIGIN}/p/acme/mcp`;
    const tools = async () => {
      const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcp), { fetch: t.fetchJack }));
      const { tools: list } = await client.listTools();
      await client.close();
      return list.map((x) => x.name).sort();
    };
    // Not deployed: a 404 that says so.
    const before = await t.fetchJack(mcp, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(before.status).toBe(404);
    expect(await before.text()).toMatch(/not been deployed/);

    const v1 = await t.call('POST', `/v1/projects/${id}/deploy`, { message: 'reads only' });
    expect(v1.json).toMatchObject({ deployment: { version: 1 }, diff: { added: expect.arrayContaining(['get_me']) } });
    expect(await tools()).toHaveLength(6);

    await t.call('PATCH', `/v1/projects/${id}/draft/tools/create_task`, { enabled: true });
    const pending = (await t.call('GET', `/v1/projects/${id}/draft`)).json.draft.live;
    expect(pending).toMatchObject({ version: 1, changes: 1, diff: { added: ['create_task'] } });
    expect(await tools()).toHaveLength(6); // the draft is not live

    await t.call('POST', `/v1/projects/${id}/deploy`, {});
    expect(await tools()).toContain('create_task');

    const hist = (await t.call('GET', `/v1/projects/${id}/deployments`)).json;
    expect(hist.activeVersion).toBe(2);
    expect(hist.deployments.map((d: any) => [d.version, d.diff.added])).toEqual([
      [2, ['create_task']],
      [1, expect.arrayContaining(['get_me', 'list_tasks'])],
    ]);
    expect(hist.deployments[1].message).toBe('reads only');

    await t.call('POST', `/v1/projects/${id}/promote`, { version: 1 });
    expect(await tools()).not.toContain('create_task');
  });

  it('a link draft needs its shared secret; with it, the data plane sends users to the app\'s link route', async () => {
    const t = setup('link-secret');
    const id = await importAcme(t);
    await t.call('PATCH', `/v1/projects/${id}/draft`, { auth: { mode: 'link', linkUrl: `${acmeUrl}/jack/link`, secretRef: 'secret:link_secret' } });
    const r = await t.call('POST', `/v1/projects/${id}/deploy`, {});
    expect(r.status).toBe(400);
    expect(r.json.detail).toMatch(/shared secret/);
    expect((await t.call('PUT', `/v1/projects/${id}/secrets/link_secret`, { value: 'a-link-secret-with-at-least-32-characters-xx' })).status).toBe(204);
    expect((await t.call('POST', `/v1/projects/${id}/deploy`, {})).status).toBe(201);
    // Starting a sign-in now redirects the browser to Acme's link route with a signed request.
    const start = await t.call('POST', `/v1/projects/${id}/test-signin`);
    const first = await t.fetchJack(start.json.url, { redirect: 'manual' });
    expect(first.status).toBe(302);
    const to = new URL(first.headers.get('location')!);
    expect(`${to.origin}${to.pathname}`).toBe(`${acmeUrl}/jack/link`);
    expect(to.searchParams.get('request')).toMatch(/^eyJ/);
  });

  it('an oidc draft cannot deploy without its client secret', async () => {
    const t = setup('oidc-secret');
    const id = await importAcme(t);
    await t.call('PATCH', `/v1/projects/${id}/draft`, { auth: { mode: 'oidc', issuer: acmeUrl, clientId: 'jack-preview', clientSecretRef: 'secret:oidc_client_secret', scopes: ['openid'] } });
    const r = await t.call('POST', `/v1/projects/${id}/deploy`, {});
    expect(r.status).toBe(400);
    expect(r.json.detail).toMatch(/client secret/);
  });
});

describe('secrets', () => {
  it('are write-only over the API and sealed in the database', async () => {
    const t = setup('secrets');
    const id = await importAcme(t);
    const secret = `oidc-SECRET-${randomBytes(8).toString('hex')}`;
    expect((await t.call('PUT', `/v1/projects/${id}/secrets/oidc_client_secret`, { value: secret })).status).toBe(204);
    const all = [await t.call('GET', `/v1/projects/${id}`), await t.call('GET', `/v1/projects/${id}/draft`), await t.call('GET', '/v1/projects'), await t.call('GET', `/v1/projects/${id}/jack.yaml`)];
    for (const r of all) expect(r.text).not.toContain(secret);
    expect(all[0]!.json.secrets).toEqual([{ name: 'oidc_client_secret', updatedAt: expect.any(Number) }]);
    t.store.close();
    expect(readFileSync(t.dbPath).toString('latin1')).not.toContain(secret);
  });
});

describe('sign-in through a hosted project, users and activity', () => {
  it('an AI client signs in at /p/<slug>; the dashboard lists the user, revokes them, and logs the calls', async () => {
    const t = setup('users');
    const id = await importAcme(t);
    await t.call('PATCH', `/v1/projects/${id}/draft`, { auth: { mode: 'apikey', whoamiTool: 'get_me' } });
    await t.call('POST', `/v1/projects/${id}/deploy`, {});

    // Test sign-in, the dashboard's own OAuth client: real authorize → key page → consent → callback.
    const start = await t.call('POST', `/v1/projects/${id}/test-signin`);
    const done = await browse(start.json.url, (u, i) => t.fetchJack(u, i), {
      stopAt: (u) => new URL(u).pathname === '/' , // the callback redirects back into the dashboard
      forms: { 'jack-apikey': () => ({ api_key: 'tk_demo_alice' }), 'jack-consent': () => ({ decision: 'approve' }) },
    });
    expect(done.url).toMatch(new RegExp(`/#/p/${id}/try\\?signin=ok$`));
    expect((await t.call('GET', `/v1/projects/${id}`)).json.testSession).toEqual({ signedIn: true, as: 'Alice Martin' });

    // Try it: a real call through /p/acme/mcp as Alice.
    const tried = await t.call('POST', `/v1/projects/${id}/try`, { tool: 'get_me', args: {} });
    expect(tried.json.result).toMatchObject({ isError: false, as: 'Alice Martin', approval: 'not-needed' });
    expect(JSON.parse(tried.json.result.content[0].text)).toMatchObject({ id: 'usr_alice' });
    const badArgs = await t.call('POST', `/v1/projects/${id}/try`, { tool: 'list_tasks', args: { status: 'finished' } });
    expect(badArgs.json.result.isError).toBe(true);

    const grants = (await t.call('GET', `/v1/projects/${id}/grants`)).json.grants;
    expect(grants).toEqual([expect.objectContaining({ user: 'Alice Martin', app: 'registered app (unverified)', revokedAt: null })]);
    const calls = (await t.call('GET', `/v1/projects/${id}/calls`)).json.calls;
    expect(calls.map((c: any) => [c.tool, c.status])).toEqual([
      ['list_tasks', 'invalid_arguments'],
      ['get_me', 'ok'],
    ]);
    expect(calls[1]).toMatchObject({ version: 1, upstreamStatus: 200, subject: 'user:usr_alice' });

    // Disconnect from the dashboard: the very next call is refused.
    expect((await t.call('DELETE', `/v1/projects/${id}/grants/${grants[0].id}`)).status).toBe(204);
    expect((await t.call('POST', `/v1/projects/${id}/try`, { tool: 'get_me', args: {} })).json.detail).toMatch(/sign in/);
    expect((await t.call('GET', `/v1/projects/${id}/grants`)).json.grants[0].revokedAt).toEqual(expect.any(Number));
  });

  it('projects on one origin are isolated: separate issuers, and a token for one is refused by the other', async () => {
    const t = setup('isolation');
    const ids: Record<string, string> = {};
    for (const slug of ['alpha', 'beta']) {
      ids[slug] = await importAcme(t, slug);
      await t.call('PATCH', `/v1/projects/${ids[slug]}/draft`, { auth: { mode: 'apikey' } });
      await t.call('POST', `/v1/projects/${ids[slug]}/deploy`, {});
    }
    const meta = async (slug: string) => ((await t.fetchJack(`${ORIGIN}/.well-known/oauth-authorization-server/p/${slug}`)).json() as Promise<{ issuer: string }>);
    expect((await meta('alpha')).issuer).toBe(`${ORIGIN}/p/alpha`);
    expect((await meta('beta')).issuer).toBe(`${ORIGIN}/p/beta`);

    // A real access token for alpha, obtained as any OAuth client would.
    const redirect = 'http://127.0.0.1:9/cb';
    const reg = (await (await t.fetchJack(`${ORIGIN}/p/alpha/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const { createHash } = await import('node:crypto');
    const authz = `${ORIGIN}/p/alpha/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${ORIGIN}/p/alpha/mcp` })}`;
    const done = await browse(authz, (u, i) => t.fetchJack(u, i), {
      stopAt: (u) => u.startsWith(redirect),
      forms: { 'jack-apikey': () => ({ api_key: 'tk_demo_alice' }), 'jack-consent': () => ({ decision: 'approve' }) },
    });
    const tok = (await (
      await t.fetchJack(`${ORIGIN}/p/alpha/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL(done.url!).searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirect, client_id: reg.client_id }).toString(),
      })
    ).json()) as { access_token: string };

    const post = (slug: string) =>
      t.fetchJack(`${ORIGIN}/p/${slug}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'x', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
      });
    expect((await post('alpha')).status).toBe(200);
    const refused = await post('beta');
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/p/beta/mcp`);
    // Separate sign-in databases: beta has never seen Alice.
    expect((await t.call('GET', `/v1/projects/${ids.beta}/grants`)).json.grants).toEqual([]);
  });
});
