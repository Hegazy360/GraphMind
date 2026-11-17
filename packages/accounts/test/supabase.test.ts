import { generateKeyPairSync, sign, createHash, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { testSql } from '@graphmind-ai/db';
import { createSupabaseAccounts } from '../src/index.js';

const SB = 'https://ref.supabase.co';
const ORIGIN = 'https://graphmind.ai';
const ISS = `${SB}/auth/v1`;
const t = await testSql();
const d = t ? describe : describe.skip;

// ------------------------------------------------------- a fake GoTrue --
function keypair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}
function jwt(key: KeyObject, kid: string, claims: Record<string, unknown>) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'ES256', kid, typ: 'JWT' });
  const body = enc(claims);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

class FakeAuth {
  key = keypair('k1');
  other = keypair('evil');
  nowS = () => Math.floor(Date.now() / 1000);
  users = new Map<string, { id: string; password: string; name?: string; confirmed: boolean }>();
  refresh = new Map<string, string>(); // refresh token → user id
  codes = new Map<string, { userId: string; challenge: string }>();
  confirm = true;
  calls: { path: string; headers: Record<string, string>; body: unknown }[] = [];
  ttl = 3600;

  access(userId: string, email: string, exp = this.nowS() + this.ttl, iss = ISS) {
    return jwt(this.key.privateKey, this.key.kid, { sub: userId, email, exp, iss, aud: 'authenticated', role: 'authenticated', user_metadata: { name: this.users.get(email)?.name } });
  }
  session(email: string) {
    const u = this.users.get(email)!;
    const r = `rt_${Math.random().toString(36).slice(2)}`;
    this.refresh.set(r, email);
    return { access_token: this.access(u.id, email), refresh_token: r, token_type: 'bearer', expires_in: this.ttl, user: { id: u.id, email } };
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/auth/v1', '') + url.search;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ path, headers, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/.well-known/jwks.json')) return json(200, { keys: [this.key.jwk] });
    if (path.startsWith('/signup')) {
      if (this.users.has(body.email)) return json(422, { error_code: 'user_already_exists', msg: 'secret internal detail' });
      const id = crypto.randomUUID();
      this.users.set(body.email, { id, password: body.password, name: body.data?.name, confirmed: !this.confirm });
      if (!this.confirm) return json(200, this.session(body.email));
      this.codes.set(`code_${body.email}`, { userId: body.email, challenge: body.code_challenge });
      return json(200, { id, email: body.email, confirmation_sent_at: new Date().toISOString() });
    }
    if (path === '/token?grant_type=password') {
      const u = this.users.get(body.email);
      if (!u || u.password !== body.password) return json(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (!u.confirmed) return json(400, { error_code: 'email_not_confirmed' });
      return json(200, this.session(body.email));
    }
    if (path === '/token?grant_type=refresh_token') {
      const email = this.refresh.get(body.refresh_token);
      if (!email) return json(400, { error_code: 'refresh_token_not_found' });
      this.refresh.delete(body.refresh_token); // rotation
      return json(200, this.session(email));
    }
    if (path === '/token?grant_type=pkce') {
      const c = this.codes.get(body.auth_code);
      const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
      if (!c || c.challenge !== challenge) return json(400, { error_code: 'bad_code_verifier' });
      this.codes.delete(body.auth_code);
      this.users.get(c.userId)!.confirmed = true;
      return json(200, this.session(c.userId));
    }
    if (path.startsWith('/recover')) {
      if (this.users.has(body.email)) this.codes.set(`code_${body.email}`, { userId: body.email, challenge: body.code_challenge });
      return json(200, {});
    }
    if (path === '/user' && init?.method === 'PUT') {
      const tok = headers.authorization?.slice(7) ?? '';
      const email = JSON.parse(Buffer.from(tok.split('.')[1]!, 'base64url').toString()).email;
      this.users.get(email)!.password = body.password;
      return json(200, { id: this.users.get(email)!.id });
    }
    if (path.startsWith('/logout')) return new Response(null, { status: 204 });
    return json(404, {});
  };
}

// ------------------------------------------------------------- harness --
d('createSupabaseAccounts', () => {
  let fake: FakeAuth;
  let app: Hono;
  let jar: Record<string, string>;
  let secretKey: string | undefined;

  const build = () => {
    const accounts = createSupabaseAccounts({
      supabaseUrl: SB,
      publishableKey: 'sb_publishable_test',
      ...(secretKey ? { secretKey } : {}),
      sql: t!.sql,
      schema: t!.schema,
      publicOrigin: ORIGIN,
      hubPath: '/app',
      fetch: fake.fetch,
    });
    app = new Hono();
    app.route('/', accounts.routes);
    app.get('/protected', accounts.requireUser(), (c) => c.json({ email: accounts.principal(c)!.user.email }));
    return accounts;
  };

  const req = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const line of r.headers.getSetCookie()) {
      const [kv] = line.split(';');
      const i = kv!.indexOf('=');
      const k = kv!.slice(0, i);
      const v = kv!.slice(i + 1);
      if (/Max-Age=0/.test(line)) delete jar[k];
      else jar[k] = v;
    }
    return r;
  };

  beforeAll(async () => {
    fake = new FakeAuth();
    await build().migrate();
  });
  afterAll(async () => t?.drop());
  beforeEach(() => {
    fake = new FakeAuth();
    jar = {};
    secretKey = undefined;
    build();
  });

  it('signs up with confirmation: 202, PKCE cookie, callback exchanges the code into a session', async () => {
    const r = await req('POST', '/auth/signup', { email: 'Ada@Example.com', password: 'correct horse battery', name: 'Ada' });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ confirm: true, email: 'ada@example.com' });
    expect(jar['__Host-gm_pkce']).toBeTruthy();
    expect(fake.calls.find((c) => c.path.startsWith('/signup'))!.path).toContain(`redirect_to=${encodeURIComponent(`${ORIGIN}/app/auth/callback`)}`);
    expect((await req('POST', '/auth/login', { email: 'ada@example.com', password: 'correct horse battery' })).status).toBe(403);

    const cb = await req('GET', '/auth/callback?code=code_ada@example.com');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/app/#/');
    expect(jar['__Host-gm_pkce']).toBeUndefined();
    const me = await req('GET', '/auth/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: unknown }).user).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
  });

  it('a callback without the verifier (other browser) asks to sign in, and never sets a session', async () => {
    await req('POST', '/auth/signup', { email: 'bo@example.com', password: 'correct horse battery' });
    jar = {};
    const cb = await req('GET', '/auth/callback?code=code_bo@example.com');
    expect(cb.headers.get('location')).toBe('/app/#/signin?notice=confirmed');
    expect(jar['__Host-gm_session']).toBeUndefined();
  });

  it('signs in and out; the session cookie is HttpOnly, Secure, __Host-', async () => {
    fake.confirm = false;
    const up = await req('POST', '/auth/signup', { email: 'cy@example.com', password: 'correct horse battery' });
    expect(up.status).toBe(201);
    const set = up.headers.getSetCookie().join('\n');
    expect(set).toMatch(/__Host-gm_session=.*HttpOnly.*SameSite=Lax.*Secure/);
    expect((await req('GET', '/protected')).status).toBe(200);
    expect((await req('POST', '/auth/logout')).status).toBe(204);
    expect(fake.calls.some((c) => c.path === '/logout?scope=local')).toBe(true);
    expect((await req('GET', '/protected')).status).toBe(401);
  });

  it('refreshes an expired access token inside requireUser and rotates the cookie', async () => {
    fake.confirm = false;
    await req('POST', '/auth/signup', { email: 'di@example.com', password: 'correct horse battery' });
    const before = jar['__Host-gm_session'];
    fake.ttl = -60; // the next issued tokens are already expired...
    const s = JSON.parse(Buffer.from(decodeURIComponent(before!), 'base64url').toString());
    const u = fake.users.get('di@example.com')!;
    jar['__Host-gm_session'] = encodeURIComponent(Buffer.from(JSON.stringify({ a: fake.access(u.id, 'di@example.com', fake.nowS() - 10), r: s.r })).toString('base64url'));
    fake.ttl = 3600; // ...but refreshing yields a fresh one
    const r = await req('GET', '/protected');
    expect(r.status).toBe(200);
    expect(jar['__Host-gm_session']).not.toBe(before);
    expect(fake.calls.some((c) => c.path === '/token?grant_type=refresh_token')).toBe(true);
    // The rotated refresh token is the one stored: the next refresh works too.
    expect((await req('GET', '/auth/me')).status).toBe(200);
  });

  it('rejects forged, foreign-issuer and garbage session cookies', async () => {
    const forged = jwt(fake.other.privateKey, 'k1', { sub: 'x', email: 'x@x', exp: fake.nowS() + 600, iss: ISS, aud: 'authenticated', role: 'authenticated' });
    const foreign = jwt(fake.key.privateKey, 'k1', { sub: 'x', email: 'x@x', exp: fake.nowS() + 600, iss: 'https://evil.supabase.co/auth/v1', aud: 'authenticated', role: 'authenticated' });
    const anon = jwt(fake.key.privateKey, 'k1', { sub: 'x', exp: fake.nowS() + 600, iss: ISS, aud: 'authenticated', role: 'anon' });
    for (const a of [forged, foreign, anon, 'not.a.jwt']) {
      jar = { '__Host-gm_session': encodeURIComponent(Buffer.from(JSON.stringify({ a, r: 'nope' })).toString('base64url')) };
      expect((await req('GET', '/protected')).status).toBe(401);
    }
    jar = { '__Host-gm_session': '%%%garbage' };
    expect((await req('GET', '/protected')).status).toBe(401);
  });

  it('maps Supabase errors to fixed messages and never echoes their bodies', async () => {
    fake.confirm = false;
    await req('POST', '/auth/signup', { email: 'ed@example.com', password: 'correct horse battery' });
    jar = {};
    const dup = await req('POST', '/auth/signup', { email: 'ed@example.com', password: 'correct horse battery' });
    expect(dup.status).toBe(409);
    expect(await dup.text()).not.toContain('secret internal detail');
    const bad = await req('POST', '/auth/login', { email: 'ed@example.com', password: 'wrong password!!' });
    expect(bad.status).toBe(401);
  });

  it('refuses cross-site sign-in, sign-up and session mutations', async () => {
    const evil = { origin: 'https://evil.example' };
    expect((await req('POST', '/auth/login', { email: 'a@b.co', password: 'x' }, evil)).status).toBe(403);
    expect((await req('POST', '/auth/signup', { email: 'a@b.co', password: 'correct horse battery' }, evil)).status).toBe(403);
    fake.confirm = false;
    await req('POST', '/auth/signup', { email: 'fi@example.com', password: 'correct horse battery' });
    expect((await req('POST', '/auth/tokens', { name: 'x' }, evil)).status).toBe(403);
  });

  it('password reset: recover is uniform, the link signs in, then the password changes', async () => {
    fake.confirm = false;
    await req('POST', '/auth/signup', { email: 'gu@example.com', password: 'correct horse battery' });
    jar = {};
    const known = await req('POST', '/auth/recover', { email: 'gu@example.com' });
    const unknown = await req('POST', '/auth/recover', { email: 'nobody@example.com' });
    expect([known.status, unknown.status]).toEqual([202, 202]);
    expect(fake.calls.find((c) => c.path.startsWith('/recover'))!.path).toContain(encodeURIComponent(`${ORIGIN}/app/auth/callback?next=reset`));
    // The latest recover set the verifier cookie; replay the known address's flow with it.
    jar = {};
    await req('POST', '/auth/recover', { email: 'gu@example.com' });
    const cb = await req('GET', '/auth/callback?code=code_gu@example.com&next=reset');
    expect(cb.headers.get('location')).toBe('/app/#/reset');
    expect((await req('POST', '/auth/password', { password: 'a brand new password' })).status).toBe(204);
    jar = {};
    expect((await req('POST', '/auth/login', { email: 'gu@example.com', password: 'a brand new password' })).status).toBe(200);
  });

  it('personal API tokens: created from a session, accepted as bearer, revocable, scoped to the owner', async () => {
    fake.confirm = false;
    await req('POST', '/auth/signup', { email: 'ha@example.com', password: 'correct horse battery' });
    const created = (await (await req('POST', '/auth/tokens', { name: 'ci' })).json()) as { token: string; id: string };
    expect(created.token).toMatch(/^gmt_/);
    const asBearer = { authorization: `Bearer ${created.token}` };
    const session = jar;
    jar = {};
    expect(await (await req('GET', '/protected', undefined, asBearer)).json()).toEqual({ email: 'ha@example.com' });
    // A token cannot manage tokens.
    expect((await req('GET', '/auth/tokens', undefined, asBearer)).status).toBe(401);
    // Another account cannot revoke it.
    await req('POST', '/auth/signup', { email: 'io@example.com', password: 'correct horse battery' });
    expect((await req('DELETE', `/auth/tokens/${created.id}`)).status).toBe(404);
    jar = session;
    const list = (await (await req('GET', '/auth/tokens')).json()) as { tokens: { id: string }[] };
    expect(list.tokens.map((x: { id: string }) => x.id)).toEqual([created.id]);
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect((await req('DELETE', `/auth/tokens/${created.id}`)).status).toBe(204);
    jar = {};
    expect((await req('GET', '/protected', undefined, asBearer)).status).toBe(401);
  });

  it('forwards the visitor IP only with a secret key, only from the trusted header', async () => {
    fake.confirm = false;
    const ipHeaders = { 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '6.6.6.6', 'sb-forwarded-for': '6.6.6.6' };
    await req('POST', '/auth/signup', { email: 'ju@example.com', password: 'correct horse battery' }, ipHeaders);
    const noSecret = fake.calls.find((c) => c.path.startsWith('/signup'))!;
    expect(noSecret.headers.apikey).toBe('sb_publishable_test');
    expect(noSecret.headers['sb-forwarded-for']).toBeUndefined();

    secretKey = 'sb_secret_test';
    build();
    jar = {};
    await req('POST', '/auth/login', { email: 'ju@example.com', password: 'correct horse battery' }, ipHeaders);
    const withSecret = fake.calls.filter((c) => c.path === '/token?grant_type=password').at(-1)!;
    expect(withSecret.headers.apikey).toBe('sb_secret_test');
    expect(withSecret.headers['sb-forwarded-for']).toBe('203.0.113.7');
    expect(withSecret.headers.authorization).toBeUndefined();
  });

  it('status reports the provider, reset support and a user count', async () => {
    fake.confirm = false;
    await req('POST', '/auth/signup', { email: 'ka@example.com', password: 'correct horse battery' });
    build(); // a fresh instance: the count is read, not cached
    const st = (await (await req('GET', '/auth/status')).json()) as { users: number };
    expect(st).toMatchObject({ accounts: true, signup: true, reset: true, provider: 'supabase' });
    expect(st.users).toBeGreaterThan(0);
  });
});
