import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createAccounts, hashPassword, SqliteAccountStore, verifyPassword } from '../src/index.js';

const ORIGIN = 'http://127.0.0.1:4999';

function setup(extra: Partial<Parameters<typeof createAccounts>[0]> = {}) {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const store = new SqliteAccountStore(':memory:', now);
  const accounts = createAccounts({ store, publicOrigin: ORIGIN, now, ...extra });
  const app = new Hono();
  app.route('/', accounts.routes);
  app.use('/v1/*', accounts.requireUser());
  app.get('/v1/whoami', (c) => c.json({ principal: accounts.principal(c) }));
  app.post('/v1/mutate', (c) => c.json({ ok: true, by: accounts.principal(c)?.user.email }));

  let jar = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar ? { cookie: jar } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) jar = set.split(';')[0] ?? '';
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* no body */
    }
    return { status: res.status, json, headers: res.headers };
  };
  return { store, accounts, app, call, tick: (ms: number) => (clock += ms), cookie: () => jar, clearJar: () => (jar = '') };
}

const sameSite = { origin: ORIGIN };

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('accounts', () => {
  it('signs up, is signed in, and the cookie is HttpOnly + Lax', async () => {
    const { call, headers } = Object.assign(setup(), { headers: null });
    const r = await call('POST', '/auth/signup', { email: 'Ada@Example.com', password: 'a-long-password', name: 'Ada' }, sameSite);
    expect(r.status).toBe(201);
    expect(r.json.user).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
    expect(r.json.user.passwordHash).toBeUndefined();
    const cookie = r.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^gm_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    void headers;

    const me = await call('GET', '/auth/me');
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ user: { email: 'ada@example.com' }, via: 'session' });

    const who = await call('GET', '/v1/whoami');
    expect(who.status).toBe(200);
    expect(who.json.principal.user.email).toBe('ada@example.com');
  });

  it('uses a __Host- Secure cookie on https origins', async () => {
    const { call, accounts } = setup({ publicOrigin: 'https://app.graphmind.ai' });
    expect(accounts.cookieName).toBe('__Host-gm_session');
    const r = await call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, { origin: 'https://app.graphmind.ai' });
    expect(r.status).toBe(201);
    expect(r.headers.get('set-cookie')).toContain('__Host-gm_session=');
    expect(r.headers.get('set-cookie')).toContain('; Secure');
  });

  it('refuses a duplicate email, a short password and a bad email', async () => {
    const { call } = setup();
    expect((await call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, sameSite)).status).toBe(201);
    const dup = await call('POST', '/auth/signup', { email: 'A@B.CO', password: 'another-long-one' }, sameSite);
    expect(dup.status).toBe(409);
    expect(dup.headers.get('content-type')).toContain('application/problem+json');
    expect((await call('POST', '/auth/signup', { email: 'c@d.co', password: 'short' }, sameSite)).status).toBe(400);
    expect((await call('POST', '/auth/signup', { email: 'not-an-email', password: 'a-long-password' }, sameSite)).status).toBe(400);
  });

  it('logs in and out; a wrong password is a 401 that does not say which part was wrong', async () => {
    const { call, clearJar } = setup();
    await call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, sameSite);
    await call('POST', '/auth/logout', undefined, sameSite);
    expect((await call('GET', '/auth/me')).status).toBe(401);
    clearJar();

    const bad = await call('POST', '/auth/login', { email: 'a@b.co', password: 'nope-nope-nope' }, sameSite);
    expect(bad.status).toBe(401);
    expect(bad.json.detail).toBe('wrong email or password');
    const unknown = await call('POST', '/auth/login', { email: 'zz@b.co', password: 'nope-nope-nope' }, sameSite);
    expect(unknown.status).toBe(401);
    expect(unknown.json.detail).toBe('wrong email or password');

    const ok = await call('POST', '/auth/login', { email: 'a@b.co', password: 'a-long-password' }, sameSite);
    expect(ok.status).toBe(200);
    expect((await call('GET', '/auth/me')).status).toBe(200);
  });

  it('rate-limits failed sign-ins per address and email', async () => {
    const { call, tick } = setup({ loginRateLimit: { max: 3, windowMs: 60_000 } });
    await call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, sameSite);
    for (let i = 0; i < 3; i++) expect((await call('POST', '/auth/login', { email: 'a@b.co', password: 'wrong-wrong-wrong' }, sameSite)).status).toBe(401);
    const blocked = await call('POST', '/auth/login', { email: 'a@b.co', password: 'a-long-password' }, sameSite);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    // another address is not affected
    expect((await call('POST', '/auth/login', { email: 'a@b.co', password: 'a-long-password' }, { ...sameSite, 'x-forwarded-for': '10.0.0.9' })).status).toBe(200);
    tick(61_000);
    expect((await call('POST', '/auth/login', { email: 'a@b.co', password: 'a-long-password' }, sameSite)).status).toBe(200);
  });

  it('expires sessions', async () => {
    const { call, tick } = setup({ sessionTtlMs: 1_000 });
    await call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, sameSite);
    expect((await call('GET', '/auth/me')).status).toBe(200);
    tick(1_001);
    expect((await call('GET', '/auth/me')).status).toBe(401);
    expect((await call('GET', '/v1/whoami')).status).toBe(401);
  });

  it('refuses cross-site mutations from a session, and allows same-origin ones', async () => {
    const { call } = setup();
    await call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, sameSite);
    expect((await call('POST', '/v1/mutate', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/v1/mutate', {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call('POST', '/v1/mutate', {})).status).toBe(403); // no provenance at all
    expect((await call('POST', '/v1/mutate', {}, sameSite)).status).toBe(200);
    expect((await call('POST', '/v1/mutate', {}, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await call('GET', '/v1/whoami', undefined, { origin: 'https://evil.example' })).status).toBe(200); // reads are fine: cookie is Lax anyway
    // the sign-up and login forms themselves are same-origin only
    expect((await call('POST', '/auth/login', { email: 'a@b.co', password: 'a-long-password' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('closes sign-up when told to', async () => {
    const { call, accounts } = setup({ allowSignup: false });
    expect(accounts.status()).toEqual({ accounts: true, signup: false, users: 0 });
    expect((await call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, sameSite)).status).toBe(403);
    expect((await call('GET', '/auth/status')).json).toEqual({ accounts: true, signup: false, users: 0 });
  });

  it('mints personal API tokens that work as bearers and are stored hashed', async () => {
    const { call, store, clearJar } = setup();
    await call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, sameSite);
    const minted = await call('POST', '/auth/tokens', { name: 'laptop' }, sameSite);
    expect(minted.status).toBe(201);
    const token: string = minted.json.token;
    expect(token.startsWith('gmt_')).toBe(true);
    expect(minted.json.prefix).toBe(token.slice(0, 10));

    const list = await call('GET', '/auth/tokens');
    expect(list.json.tokens).toHaveLength(1);
    expect(list.json.tokens[0]).toMatchObject({ name: 'laptop', prefix: token.slice(0, 10) });
    expect(JSON.stringify(list.json)).not.toContain(token);
    expect(store.getTokenByHash(token)).toBeNull(); // only the hash is stored

    clearJar();
    const who = await call('GET', '/v1/whoami', undefined, { authorization: `Bearer ${token}` });
    expect(who.status).toBe(200);
    expect(who.json.principal).toMatchObject({ via: 'token', user: { email: 'a@b.co' } });
    // tokens are exempt from the origin check (no browser, no ambient cookie)
    expect((await call('POST', '/v1/mutate', {}, { authorization: `Bearer ${token}` })).status).toBe(200);
    // but cannot manage tokens
    expect((await call('GET', '/auth/tokens', undefined, { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await call('GET', '/v1/whoami', undefined, { authorization: 'Bearer gmt_unknown' })).status).toBe(401);
    expect((await call('GET', '/v1/whoami', undefined, { authorization: 'Bearer something-else' })).status).toBe(401);
  });

  it('revoked tokens stop working at once', async () => {
    const { call, clearJar } = setup();
    await call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, sameSite);
    const { json } = await call('POST', '/auth/tokens', { name: 'ci' }, sameSite);
    expect((await call('DELETE', `/auth/tokens/${json.id}`, undefined, sameSite)).status).toBe(204);
    expect((await call('GET', '/auth/tokens')).json.tokens).toHaveLength(0);
    clearJar();
    expect((await call('GET', '/v1/whoami', undefined, { authorization: `Bearer ${json.token}` })).status).toBe(401);
  });

  it('isolates users: one user cannot revoke another user’s token', async () => {
    const a = setup();
    await a.call('POST', '/auth/signup', { email: 'a@b.co', password: 'a-long-password' }, sameSite);
    const { json } = await a.call('POST', '/auth/tokens', { name: 'a' }, sameSite);
    a.clearJar();
    await a.call('POST', '/auth/signup', { email: 'b@b.co', password: 'a-long-password' }, sameSite);
    expect((await a.call('DELETE', `/auth/tokens/${json.id}`, undefined, sameSite)).status).toBe(404);
  });
});
