/**
 * The composition: one origin, one session, the homepage in front, Circuit
 * and Jack behind the hub, Jack's MCP endpoints at the root.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { Executor, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { workflow } from '@graphmind-ai/circuit-sdk';
import { createApi as createCircuit } from 'circuit-api';
import { createJack, SqliteStore as JackStore } from 'jack-api';
import { createPlatform } from '../src/index.js';

const ORIGIN = 'http://127.0.0.1:4800';
const SITE = resolve(import.meta.dirname, '..', '..', 'web');
const dir = mkdtempSync(join(tmpdir(), 'platform-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(site = true) {
  const accounts = createAccounts({ store: new SqliteAccountStore(':memory:'), publicOrigin: ORIGIN });
  const wf = workflow({ name: 'hello' }, async (ctx) => ctx.step('greet', () => ({ hello: 'world' })));
  const store = new SqliteJournalStore(':memory:');
  const executor = new Executor({ store, workflows: [wf] });
  const circuit = createCircuit({ executor, store, workflows: [wf], accounts });
  const hub = site ? '/app' : '';
  const jack = createJack({ store: new JackStore(':memory:'), accounts, publicOrigin: ORIGIN, dataDir: join(dir, randomBytes(4).toString('hex')), secretKey: randomBytes(32), egress: 'any', dashboardPath: `${hub}/jack/` });
  const TRY = resolve(import.meta.dirname, '..', '..', 'viewer', 'dist-try', 'try');
  const app = createPlatform({ accounts, circuit, jack, ...(site ? { site: SITE, tryDist: TRY } : {}) });
  let jar = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, ...(jar ? { cookie: jar } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) jar = set.split(';')[0] ?? '';
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: res.status, text, json, location: res.headers.get('location'), type: res.headers.get('content-type') ?? '' };
  };
  return { app, call, hub, executor, clearJar: () => (jar = '') };
}

describe('the platform, with the homepage in front (local dev)', () => {
  it('serves the homepage at / and routes its account links to the hub', async () => {
    const { call, app } = setup();
    const home = await call('GET', '/');
    expect(home.status).toBe(200);
    expect(home.type).toContain('text/html');
    expect(home.text).toContain('Start free');
    expect(home.text).toContain('data-try="/try/?fixture=1&amp;tour=1&amp;embed=1"'); // the live demo
    expect(home.text).toContain('href="/signup"');
    expect((await call('GET', '/styles.css')).type).toContain('text/css');
    expect((await call('GET', '/graphmind.png')).type).toContain('image/png');
    // The homepage's clips: served, with byte ranges (Safari only plays video that way).
    const clip = await app.request(`${ORIGIN}/media/debugger.webm`, { headers: { range: 'bytes=0-99' } });
    expect(clip.status).toBe(206);
    expect(clip.headers.get('content-type')).toBe('video/webm');
    expect(clip.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);
    expect((await clip.arrayBuffer()).byteLength).toBe(100);
    expect((await call('GET', '/media/debugger.webp')).type).toBe('image/webp');
    // Vendored files and the viewer for /try (the hero's live demo), when built.
    expect((await call('GET', '/vendor/gsap.min.js')).type).toContain('javascript');
    expect((await call('GET', '/vendor/bricolage-grotesque-latin-wght.woff2')).type).toBe('font/woff2');
    expect((await call('GET', '/vendor/../package.json')).status).toBe(404);
    const tryPage = await call('GET', '/try/?fixture=1');
    expect(tryPage.status).toBe(200);
    expect(tryPage.text).toContain('/try/assets/');
    expect((await call('GET', '/try')).location).toBe('/try/');
    expect((await call('GET', '/try/some/deep/route')).type).toContain('text/html'); // SPA fallback
    expect((await call('GET', '/try/assets/../../package.json')).status).toBe(404);
    for (const src of [...home.text.matchAll(/(?:src|poster)="(\/media\/[^"]+)"/g)].map((m) => m[1]!)) {
      expect((await app.request(`${ORIGIN}${src}`, { method: 'HEAD' })).status, src).toBe(200);
    }

    const signup = await call('GET', '/signup');
    expect(signup.status).toBe(302);
    expect(signup.location).toBe('/app/#/signup');
    expect((await call('GET', '/login')).location).toBe('/app/#/signin');
    expect((await call('GET', '/docs/start/install/')).location).toBe('https://graphmind.ai/docs/start/install/');
  });

  it('one sign-up on the hub is a session for Circuit and Jack too', async () => {
    const { call, clearJar } = setup();
    expect((await call('GET', '/app')).status).toBe(308);
    const hub = await call('GET', '/app/');
    expect(hub.status).toBe(200);
    expect(hub.text).toContain('./app.js'); // page-relative assets
    expect((await call('GET', '/app/health')).json).toMatchObject({ service: 'platform', hub: '/app/', accounts: true, signup: true, users: 0 });

    // Not signed in: both dashboards' APIs refuse.
    expect((await call('GET', '/app/circuit/v1/workflows')).status).toBe(401);
    expect((await call('GET', '/app/jack/v1/projects')).status).toBe(401);

    const r = await call('POST', '/app/auth/signup', { email: 'ada@example.com', password: 'a-long-enough-password', name: 'Ada' });
    expect(r.status).toBe(201);

    // The same cookie works everywhere on the origin.
    expect((await call('GET', '/app/auth/me')).json.user.email).toBe('ada@example.com');
    const circuit = await call('GET', '/app/circuit/v1/health');
    expect(circuit.json).toMatchObject({ service: 'circuit', accounts: true, user: { email: 'ada@example.com' } });
    const jack = await call('GET', '/app/jack/v1/health');
    expect(jack.json).toMatchObject({ service: 'jack', accounts: true, user: { email: 'ada@example.com' } });

    // The dashboards themselves are served under the hub with relative assets.
    expect((await call('GET', '/app/circuit')).location).toBe('circuit/'); // relative: resolves to /app/circuit/
    expect((await call('GET', '/app/circuit/')).text).toContain('<title>Circuit · GraphMind</title>');
    // Every surface loads the same shared look and shell, from its own path.
    for (const base of ['/app', '/app/circuit', '/app/jack']) {
      const css = await call('GET', `${base}/gm/graphmind.css`);
      expect(css.status, base).toBe(200);
      expect(css.type).toContain('text/css');
      expect((await call('GET', `${base}/gm/shell.js`)).type).toContain('javascript');
    }
    for (const page of ['/app/', '/app/circuit/', '/app/jack/']) {
      const html = (await call('GET', page)).text;
      expect(html, page).toContain('href="./gm/graphmind.css"');
      expect(html, page).toContain('id="gm-bar"');
    }
    expect((await call('GET', '/app/circuit/app.js')).type).toContain('javascript');
    expect((await call('GET', '/app/jack/')).text).toContain('Jack');
    expect((await call('GET', '/app/jack/style.css')).type).toContain('text/css');

    // Work in both, as one person.
    const run = await call('POST', '/app/circuit/v1/workflows/hello/runs', { input: {} });
    expect(run.status).toBe(202);
    const project = await call('POST', '/app/jack/v1/projects', { slug: 'ada-api', upstream: 'https://api.ada.test' });
    expect(project.status).toBe(201);
    // The MCP URL Jack hands out is at the origin root, and the root really routes there.
    expect(project.json.project.mcpUrl).toBe(`${ORIGIN}/p/ada-api/mcp`);
    const mcp = await call('POST', '/p/ada-api/mcp', {});
    expect(mcp.status).toBe(404); // known project, not deployed yet: Jack answered, not the hub
    expect(mcp.json).toMatchObject({ title: 'Not deployed' });

    // A personal token from the hub works on both APIs without a cookie.
    const minted = await call('POST', '/app/auth/tokens', { name: 'cli' });
    clearJar();
    const bearer = { authorization: `Bearer ${minted.json.token}` };
    expect((await call('GET', '/app/circuit/v1/runs', undefined, bearer)).json.runs).toHaveLength(1);
    expect((await call('GET', '/app/jack/v1/projects', undefined, bearer)).json.projects.map((p: any) => p.slug)).toEqual(['ada-api']);
    expect((await call('GET', '/app/jack/v1/projects')).status).toBe(401);
  });
});

describe('the platform as the hosted app (no homepage)', () => {
  it('serves the hub at / with Circuit and Jack beneath it', async () => {
    const { call } = setup(false);
    expect((await call('GET', '/')).text).toContain('GraphMind');
    expect((await call('GET', '/health')).json).toMatchObject({ service: 'platform', hub: '/' });
    expect((await call('GET', '/circuit')).location).toBe('circuit/');
    expect((await call('GET', '/circuit/health')).json).toMatchObject({ service: 'circuit', accounts: true });
    expect((await call('GET', '/jack/health')).json).toMatchObject({ service: 'jack', accounts: true });
    expect((await call('GET', '/signup')).status).toBe(404); // graphmind.ai owns that redirect in production
  });
});
