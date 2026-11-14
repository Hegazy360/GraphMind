/**
 * Accounts on the control plane: self-serve sign-up, per-account projects,
 * personal tokens for `jack deploy`, and the operator key that sees everything.
 */
import { describe, expect, it } from 'vitest';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { createApi, SqliteStore } from '../src/index.js';

const ORIGIN = 'http://127.0.0.1:4820';

function setup(opts: { apiKeys?: string[]; allowSignup?: boolean } = {}) {
  const store = new SqliteStore(':memory:');
  const accounts = createAccounts({ store: new SqliteAccountStore(':memory:'), publicOrigin: ORIGIN, ...(opts.allowSignup !== undefined ? { allowSignup: opts.allowSignup } : {}) });
  const app = createApi({ store, accounts, publicOrigin: ORIGIN, ...(opts.apiKeys ? { apiKeys: opts.apiKeys } : {}) });

  /** A browser: keeps its own cookie jar and sends the right Origin. */
  const browser = () => {
    let jar = '';
    return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(`${ORIGIN}${path}`, {
        method,
        headers: { origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(jar ? { cookie: jar } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const set = res.headers.get('set-cookie');
      if (set) jar = set.split(';')[0] ?? '';
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* empty */
      }
      return { status: res.status, json, headers: res.headers };
    };
  };
  /** A CLI: no cookies, a bearer. */
  const cli = (bearer?: string) => async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* empty */
    }
    return { status: res.status, json };
  };
  return { store, app, browser, cli };
}

const signup = async (b: ReturnType<ReturnType<typeof setup>['browser']>, email: string) =>
  b('POST', '/auth/signup', { email, password: 'a-long-enough-password' });

describe('jack with accounts', () => {
  it('needs a sign-in for /v1 and says so in the public health', async () => {
    const { browser, cli } = setup();
    const anon = cli();
    const health = await anon('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ ok: true, service: 'jack', auth: true, accounts: true, signup: true });
    expect(health.json.projects).toBeUndefined();

    const r = await anon('GET', '/v1/projects');
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ title: 'Not signed in' });

    const b = browser();
    expect((await signup(b, 'ada@example.com')).status).toBe(201);
    const mine = await b('GET', '/v1/health');
    expect(mine.status).toBe(200);
    expect(mine.json).toMatchObject({ accounts: true, projects: 0, user: { email: 'ada@example.com' } });
  });

  it('keeps every account’s projects to itself', async () => {
    const { browser } = setup();
    const ada = browser();
    const bob = browser();
    await signup(ada, 'ada@example.com');
    await signup(bob, 'bob@example.com');

    const created = await ada('POST', '/v1/projects', { slug: 'adas-api', upstream: 'https://api.ada.test' });
    expect(created.status).toBe(201);
    expect(created.json.project.ownerId).toBeUndefined(); // ownership is not on the wire
    const id = created.json.project.id as string;

    expect((await ada('GET', '/v1/projects')).json.projects).toHaveLength(1);
    expect((await bob('GET', '/v1/projects')).json.projects).toHaveLength(0);

    // Bob cannot see, change, deploy to or delete Ada's project: it does not exist for him.
    expect((await bob('GET', `/v1/projects/${id}`)).status).toBe(404);
    expect((await bob('GET', `/v1/projects/${id}/draft`)).status).toBe(404);
    expect((await bob('POST', `/v1/projects/${id}/deploy`, {})).status).toBe(404);
    expect((await bob('DELETE', `/v1/projects/${id}`)).status).toBe(404);
    expect((await ada('GET', `/v1/projects/${id}`)).status).toBe(200);

    // Slugs are global (they are hostnames), so Bob cannot take Ada's.
    expect((await bob('POST', '/v1/projects', { slug: 'adas-api', upstream: 'https://api.bob.test' })).status).toBe(409);
  });

  it('records who deployed, by account email', async () => {
    const { browser, store } = setup();
    const ada = browser();
    await signup(ada, 'ada@example.com');
    const { json } = await ada('POST', '/v1/projects', { slug: 'proj-p', upstream: 'https://api.p.test' });
    const manifest = {
      version: 1,
      name: 'P',
      upstream: 'https://api.p.test',
      tools: [],
      toolsets: [],
      scopes: [],
    };
    const dep = await ada('POST', `/v1/projects/${json.project.id}/deployments`, { manifest });
    expect(dep.status).toBe(201);
    expect(store.getDeployment(json.project.id, 1)?.createdBy).toBe('ada@example.com');
  });

  it('lets a CLI act as the account with a personal token, never with a cookie-less call', async () => {
    const { browser, cli } = setup();
    const ada = browser();
    await signup(ada, 'ada@example.com');
    await ada('POST', '/v1/projects', { slug: 'proj-p', upstream: 'https://api.p.test' });
    const minted = await ada('POST', '/auth/tokens', { name: 'laptop' });
    expect(minted.status).toBe(201);

    const deploy = cli(minted.json.token);
    const list = await deploy('GET', '/v1/projects');
    expect(list.status).toBe(200);
    expect(list.json.projects.map((p: any) => p.slug)).toEqual(['proj-p']);
    // a token-authenticated write needs no Origin header (there is no browser)
    expect((await deploy('POST', '/v1/projects', { slug: 'proj-q', upstream: 'https://api.q.test' })).status).toBe(201);

    expect((await cli('gmt_not_a_real_token')('GET', '/v1/projects')).status).toBe(401);
    expect((await cli()('GET', '/v1/projects')).status).toBe(401);
  });

  it('refuses a cross-site write even with a valid session', async () => {
    const { browser } = setup();
    const ada = browser();
    await signup(ada, 'ada@example.com');
    const r = await ada('POST', '/v1/projects', { slug: 'proj-p', upstream: 'https://api.p.test' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect((await ada('GET', '/v1/projects', undefined, { origin: 'https://evil.example' })).status).toBe(200);
  });

  it('an operator key still works beside accounts and sees every project', async () => {
    const { browser, cli } = setup({ apiKeys: ['op-secret'] });
    const ada = browser();
    const bob = browser();
    await signup(ada, 'ada@example.com');
    await signup(bob, 'bob@example.com');
    await ada('POST', '/v1/projects', { slug: 'proj-a', upstream: 'https://a.test' });
    await bob('POST', '/v1/projects', { slug: 'proj-b', upstream: 'https://b.test' });
    const op = cli('op-secret');
    expect((await op('GET', '/v1/projects')).json.projects.map((p: any) => p.slug)).toEqual(['proj-a', 'proj-b']);
    expect((await cli('wrong')('GET', '/v1/projects')).status).toBe(401);
  });

  it('can close sign-up', async () => {
    const { browser, cli } = setup({ allowSignup: false });
    expect((await cli()('GET', '/health')).json.signup).toBe(false);
    expect((await signup(browser(), 'x@y.co')).status).toBe(403);
  });

  it('projects created before accounts existed stay visible to the operator only', async () => {
    const { store, browser, cli } = setup({ apiKeys: ['op'] });
    store.createProject({ slug: 'legacy', name: 'Legacy', upstream: 'https://legacy.test', auth: { mode: 'none', requireSignIn: false } });
    const ada = browser();
    await signup(ada, 'ada@example.com');
    expect((await ada('GET', '/v1/projects')).json.projects).toHaveLength(0);
    expect((await cli('op')('GET', '/v1/projects')).json.projects.map((p: any) => p.slug)).toEqual(['legacy']);
  });
});
