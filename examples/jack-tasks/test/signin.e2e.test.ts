/**
 * M3 end to end, everything on real sockets:
 *
 *   jack CLI (OAuth client, loopback redirect)
 *     → jack preview in sign-in mode (Jack's authorization server + /mcp)
 *       → Acme Tasks' own login (oidc mode)  or  Jack's API-key page (apikey mode)
 *         → Acme Tasks API, called with THAT user's credential
 *
 * A scripted browser plays the user. It uses the same form ids a person
 * sees: Acme's `acme-login`, Jack's `jack-apikey` and `jack-consent`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browse } from '@graphmind-ai/jack-auth/testing';
import { callCommand, logoutCommand, portIsFree, startPreview, type Io, type PreviewHandle } from '@graphmind-ai/jack-cli';
import { createTasksApp } from '../src/app.js';
import type { OidcClient } from '../src/idp.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'jack-signin-e2e-'));
const oidcClients: Record<string, OidcClient> = {
  'jack-preview': { name: 'Acme for AI (via Jack)', secret: 'test-oidc-secret', redirectUris: ['http://127.0.0.1/oauth/upstream/callback'] },
};
let api: ServerType;
let origin = '';
const previews: PreviewHandle[] = [];

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}


beforeAll(async () => {
  // Bind first, then build the app with its real origin (the OIDC issuer must match exactly).
  const holder: { fetch?: (r: Request) => Response | Promise<Response> } = {};
  await new Promise<void>((r) => {
    api = serve({ fetch: (req) => holder.fetch!(req), port: 0, hostname: '127.0.0.1' }, () => r());
  });
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  // Short-lived Acme tokens, so Jack has to renew them during the test.
  const { app } = await createTasksApp({ origin, oidcClients, accessTokenTtlSeconds: 30 });
  holder.fetch = app.fetch;
});

afterAll(async () => {
  await Promise.all(previews.map((p) => p.close()));
  await new Promise<void>((r) => api.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function preview(config: 'jack.yaml' | 'jack.oidc.yaml', stateDir: string) {
  const io = capture();
  const handle = await startPreview(
    // The committed config files, unchanged: URLs come from the environment.
    { config: here(`../${config}`), port: 0, watch: false, stateDir: join(dir, stateDir), env: { ACME_OIDC_CLIENT_SECRET: 'test-oidc-secret', ACME_TASKS_URL: origin } },
    io,
  );
  previews.push(handle);
  return { handle, io };
}

/** A user at a browser: fills Acme's login, Jack's key page and the consent screen. */
function user(name: 'alice' | 'bob', opts: { consent?: 'approve' | 'deny'; password?: string } = {}) {
  const seen: { consent?: string; pages: string[] } = { pages: [] };
  const openUrl = async (url: string) => {
    const r = await browse(url, (u, init) => fetch(u, init), {
      stopAt: () => false, // let the browser hit the CLI's loopback callback for real
      forms: {
        // A person stops after being told the password is wrong.
        'acme-login': ({ html }) => (html.includes('Wrong username or password') ? null : { username: name, password: opts.password ?? `${name}-password` }),
        'jack-apikey': () => ({ api_key: `tk_demo_${name}` }),
        // Acme's SESSION login (link mode): a plain cookie, no OAuth anywhere.
        'acme-session-login': ({ html }) => (html.includes('Wrong username or password') ? null : { username: name, password: opts.password ?? `${name}-password` }),
        'jack-consent': ({ html }) => {
          seen.consent = html;
          return { decision: opts.consent ?? 'approve' };
        },
      },
    });
    seen.pages = r.visited;
  };
  return { openUrl, seen };
}

async function call(url: string, tool: string, args: Record<string, unknown>, who: ReturnType<typeof user>, credentialsPath: string) {
  const io = capture();
  const code = await callCommand(tool, JSON.stringify(args), { url, confirm: 'yes', openUrl: who.openUrl, credentialsPath }, io);
  const text = io.lines.join('\n');
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { code, text, json, log: io.errors.join('\n') };
}

describe('jack preview, sign-in mode', () => {
  it('apikey: each user pastes their own key on Jack\'s page; the CLI only ever holds a Jack token', async () => {
    const { handle, io } = await preview('jack.yaml', 'state-apikey');
    expect(handle.mode).toBe('sign-in');
    expect(io.lines.join('\n')).toMatch(/sign-in: each user pastes their own API key/);

    const aliceCreds = join(dir, 'alice-cli.json');
    const alice = user('alice');
    const me = await call(handle.url!, 'get_me', {}, alice, aliceCreds);
    expect(me.code).toBe(0);
    expect(me.json).toMatchObject({ id: 'usr_alice' });
    expect(me.log).toMatch(/Sign in to continue/);
    expect(alice.seen.pages.some((p) => p.includes('/oauth/apikey'))).toBe(true);
    expect(alice.seen.consent).toContain('not verified'); // the CLI registers dynamically
    expect(alice.seen.consent).toContain('Signed in as <span class="who">Alice Martin</span>');

    // The cached sign-in is reused: no browser the second time.
    const again = user('alice');
    expect((await call(handle.url!, 'list_projects', {}, again, aliceCreds)).code).toBe(0);
    expect(again.seen.pages).toEqual([]);

    // A second person on the same server is a different grant, with their own data.
    const bob = await call(handle.url!, 'get_me', {}, user('bob'), join(dir, 'bob-cli.json'));
    expect(bob.json).toMatchObject({ id: 'usr_bob' });
    expect(handle.auth!.listGrants().map((g) => g.display).sort()).toEqual(['Alice Martin', 'Bob Okafor']);

    // The key is in neither CLI's credential file.
    for (const f of ['alice-cli.json', 'bob-cli.json']) expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/tk_demo_/);
    expect(io.lines.join('\n')).toMatch(/\+ signed in: Alice Martin/);
  });

  it('oidc: users log in with Acme\'s own login; Jack renews Acme\'s short-lived token itself', async () => {
    const { handle, io } = await preview('jack.oidc.yaml', 'state-oidc');
    expect(io.lines.join('\n')).toMatch(/sign-in: oidc via http:\/\/127\.0\.0\.1:\d+ \(client jack-preview\)/);

    const creds = join(dir, 'alice-oidc.json');
    const alice = user('alice');
    const created = await call(handle.url!, 'create_task', { projectId: 'prj_0001', title: 'Signed in via OIDC' }, alice, creds);
    expect(created.code).toBe(0);
    expect(created.json).toMatchObject({ title: 'Signed in via OIDC' });
    expect(alice.seen.pages.some((p) => p.startsWith(`${origin}/oauth/authorize`))).toBe(true); // Acme's login page
    expect(alice.seen.consent).toMatch(/Change data[\s\S]*Create a task/);

    // Acme issued a 30 s token; Jack renews it before use (inside its 60 s window) — the call still works.
    const list = await call(handle.url!, 'list_tasks', { q: 'via OIDC' }, user('alice'), creds);
    expect(list.json.items).toHaveLength(1);
    expect(readFileSync(creds, 'utf8')).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+.*acme-tasks-api/); // no Acme token in the client's file
  });

  it('a wrong Acme password stops at Acme\'s login; a declined consent creates no grant', async () => {
    const { handle } = await preview('jack.oidc.yaml', 'state-oidc-neg');
    const before = handle.auth!.listGrants().length;
    // Wrong password: the browser stays on Acme's login (401) and the CLI gives up waiting.
    const wrong = user('alice', { password: 'nope' });
    const io = capture();
    await expect(
      callCommand('get_me', '{}', { url: handle.url!, openUrl: wrong.openUrl, credentialsPath: join(dir, 'wrong.json'), signInTimeoutMs: 1_500 }, io),
    ).rejects.toThrow(/timed out waiting for the browser sign-in/);
    expect(wrong.seen.pages.at(-1)).toMatch(new RegExp(`^${origin}/oauth/authorize`));

    const declined = await call(handle.url!, 'get_me', {}, user('alice', { consent: 'deny' }), join(dir, 'declined.json')).catch((e: Error) => ({ code: 1, text: e.message }));
    expect(declined.code).toBe(1);
    expect(handle.auth!.listGrants().length).toBe(before);
  });

  it('link: Acme has only a session login; one route + one middleware make per-user sign-in work', async () => {
    // Link mode needs Acme to know Jack's issuer up front, so pick the preview port first.
    let port = 21_900 + Math.floor(Math.random() * 90);
    while (!(await portIsFree(port))) port++;
    const previewOrigin = `http://127.0.0.1:${port}`;
    const linkSecret = 'e2e-link-secret-0123456789abcdef0123456789abcdef';
    const holder: { fetch?: (r: Request) => Response | Promise<Response> } = {};
    const linkApi = await new Promise<ServerType>((r) => {
      const s = serve({ fetch: (req) => holder.fetch!(req), port: 0, hostname: '127.0.0.1' }, () => r(s));
    });
    const linkOrigin = `http://127.0.0.1:${(linkApi.address() as AddressInfo).port}`;
    const received: string[] = [];
    const { app } = await createTasksApp({ origin: linkOrigin, env: { JACK_LINK_SECRET: linkSecret, JACK_LINK_ISSUER: previewOrigin, JACK_LINK_AUDIENCE: linkOrigin } });
    holder.fetch = (req) => {
      const a = req.headers.get('jack-assertion');
      if (a) received.push(a);
      return app.fetch(req);
    };
    try {
      const io = capture();
      const handle = await startPreview(
        { config: here('../jack.link.yaml'), port, watch: false, stateDir: join(dir, 'state-link'), env: { ACME_TASKS_URL: linkOrigin, JACK_LINK_SECRET: linkSecret } },
        io,
      );
      previews.push(handle);
      expect(io.lines.join('\n')).toMatch(/sign-in: account linking via .*\/jack\/link/);

      const creds = join(dir, 'alice-link.json');
      const alice = user('alice');
      const me = await call(handle.url!, 'get_me', {}, alice, creds);
      expect(me.code).toBe(0);
      expect(me.json).toMatchObject({ id: 'usr_alice' });
      const paths = alice.seen.pages.filter((p) => p.startsWith(linkOrigin)).map((p) => new URL(p).pathname);
      expect(paths).toEqual(['/jack/link', '/session/login', '/session/login', '/jack/link']); // link → login → back → linked
      expect(alice.seen.consent).toContain('Signed in as <span class="who">Alice Martin</span>');
      // The API saw an assertion, not a key or a token; a write carries the granted scope and a fresh assertion.
      expect(received).toHaveLength(1);
      const created = await call(handle.url!, 'create_task', { projectId: 'prj_0001', title: 'Linked!' }, user('alice'), creds);
      expect(created.json).toMatchObject({ title: 'Linked!' });
      expect(received).toHaveLength(2);
      expect(received[1]).not.toBe(received[0]);
      expect(readFileSync(creds, 'utf8')).not.toContain(linkSecret);
      // A replayed assertion is refused by Acme's middleware.
      const replay = await fetch(`${linkOrigin}/me`, { headers: { 'jack-assertion': received[1]! } });
      expect(replay.status).toBe(401);
      expect(await replay.text()).toMatch(/replayed/);
    } finally {
      await new Promise<void>((r) => linkApi.close(() => r()));
    }
  });

  it('jack logout revokes the grant at the server, not just locally', async () => {
    const { handle } = await preview('jack.yaml', 'state-logout');
    const creds = join(dir, 'logout.json');
    expect((await call(handle.url!, 'get_me', {}, user('alice'), creds)).code).toBe(0);
    const out = capture();
    expect(await logoutCommand({ url: handle.url!, credentialsPath: creds }, out)).toBe(0);
    expect(out.lines[0]).toMatch(/signed out/);
    expect(handle.auth!.listGrants().every((g) => g.revokedAt !== null)).toBe(true);
  });
});
