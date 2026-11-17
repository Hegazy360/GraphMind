/**
 * The AuthStore contract, run against both backends: SQLite (always) and
 * Postgres (when PG_TEST_URL is set; each run gets a throwaway schema).
 * The Postgres leg adds what only it has to prove: tenants share tables, so
 * a row of project A must never resolve through project B's handle.
 *
 * The concurrency cases go through the real token endpoint, so they check
 * the whole path (server read → atomic store update → replay handling), not
 * just the SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSql, type Sql } from '@graphmind-ai/db';
import { PgAuthStore, SqliteAuthStore, sha256, type AuthStore, type GrantRecord } from '../src/index.js';
import { CIMD_URL, createStack, JACK, REDIRECT, type Stack } from './harness.js';

const pg = await testSql();

interface Backend {
  /** A fresh, empty store for project `projectId`. */
  make(projectId?: string): Promise<AuthStore>;
}

const backends: [string, Backend | null][] = [
  ['sqlite', { make: async () => new SqliteAuthStore(':memory:') }],
  [
    'pg',
    pg
      ? {
          make: async (projectId = `prj_${Math.random().toString(36).slice(2, 10)}`) => PgAuthStore.forProject(pg.sql, projectId, { schema: pg.schema }),
        }
      : null,
  ],
];

beforeAll(async () => {
  if (pg) {
    expect(await PgAuthStore.migrate(pg.sql, pg.schema)).toEqual(['jack-auth-001-init']);
    expect(await PgAuthStore.migrate(pg.sql, pg.schema)).toEqual([]);
  }
});
afterAll(async () => pg?.drop());

const grant = (id: string, createdAt: number, over: Partial<GrantRecord> = {}): GrantRecord => ({
  id,
  clientId: 'c1',
  subject: 'alice',
  display: 'Alice',
  scopes: ['read', 'write'],
  resource: 'https://jack.test/mcp',
  createdAt,
  revokedAt: null,
  ...over,
});

// Helpers for driving the real token endpoint (as in auth.test.ts).
async function codeFor(s: Stack, verifier = 'v'.repeat(43)) {
  const u = new URL(`${JACK}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: CIMD_URL,
    redirect_uri: REDIRECT,
    code_challenge: sha256(verifier),
    code_challenge_method: 'S256',
    resource: `${JACK}/mcp`,
    state: 'st',
  }))
    u.searchParams.set(k, v);
  const res = await s.browser(u.href);
  return { code: new URL(res.url!).searchParams.get('code')!, verifier };
}
const token = (s: Stack, form: Record<string, string>) =>
  s.net(`${JACK}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
const exchange = (s: Stack, c: { code: string; verifier: string }) =>
  token(s, { grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, redirect_uri: REDIRECT, client_id: CIMD_URL, resource: `${JACK}/mcp` });

for (const [name, backend] of backends) {
  const d = backend ? describe : describe.skip;
  d(`AuthStore contract (${name})`, () => {
    const make = (id?: string) => backend!.make(id);

    it('clients: put/get/touch, and counts registrations in a window', async () => {
      const s = await make();
      expect(await s.getClient('jdc_x')).toBeNull();
      await s.putClient({ clientId: 'jdc_x', kind: 'dcr', metadata: { client_name: 'X', redirect_uris: ['https://a/cb'] }, createdAt: 100, lastUsedAt: 100 });
      await s.putClient({ clientId: 'jdc_y', kind: 'dcr', metadata: {}, createdAt: 200, lastUsedAt: 200 });
      await s.touchClient('jdc_x', 150);
      expect(await s.getClient('jdc_x')).toEqual({ clientId: 'jdc_x', kind: 'dcr', metadata: { client_name: 'X', redirect_uris: ['https://a/cb'] }, createdAt: 100, lastUsedAt: 150 });
      expect(await s.countClientsSince(100)).toBe(2);
      expect(await s.countClientsSince(101)).toBe(1);
      await expect(s.putClient({ clientId: 'jdc_x', kind: 'dcr', metadata: {}, createdAt: 1, lastUsedAt: 1 })).rejects.toThrow();
    });

    it('auth requests: round-trip JSON fields, update data, delete', async () => {
      const s = await make();
      const r = { id: 'jar_1', clientId: 'c', redirectUri: 'https://a/cb', codeChallenge: 'cc', state: null, scopes: ['a', 'b'], resource: 'r', browserHash: 'bh', data: {}, expiresAt: 1000 };
      await s.putAuthRequest(r);
      expect(await s.getAuthRequest('jar_1')).toEqual(r);
      await s.updateAuthRequest('jar_1', { identity: { subject: 's', display: 'd' }, sealed: 'x' });
      expect((await s.getAuthRequest('jar_1'))?.data).toEqual({ identity: { subject: 's', display: 'd' }, sealed: 'x' });
      await s.deleteAuthRequest('jar_1');
      expect(await s.getAuthRequest('jar_1')).toBeNull();
    });

    it('codes are single use, also under concurrency', async () => {
      const s = await make();
      const c = { codeHash: 'h1', grantId: 'g', clientId: 'c', redirectUri: 'u', codeChallenge: 'cc', resource: 'r', expiresAt: 1000, usedAt: null };
      await s.putCode(c);
      expect(await s.getCode('h1')).toEqual(c);
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => s.useCode('h1', 10 + i)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await s.getCode('h1'))?.usedAt).not.toBeNull();
      expect(await s.useCode('h1', 99)).toBe(false);
      expect(await s.useCode('nope', 99)).toBe(false);
    });

    it('grants: listed oldest first (ties in insertion order); revoking keeps the first time and drops the upstream credential', async () => {
      const s = await make();
      await s.putGrant(grant('g2', 5));
      await s.putGrant(grant('g1', 5));
      await s.putGrant(grant('g0', 1));
      expect((await s.listGrants()).map((g) => g.id)).toEqual(['g0', 'g2', 'g1']);
      await s.putUpstream('g1', 'sealed-1', 1);
      await s.putUpstream('g1', 'sealed-2', 2);
      expect(await s.getUpstream('g1')).toBe('sealed-2');
      await s.revokeGrant('g1', 50);
      await s.revokeGrant('g1', 60);
      expect((await s.getGrant('g1'))?.revokedAt).toBe(50);
      expect(await s.getUpstream('g1')).toBeNull();
      expect(await s.getGrant('missing')).toBeNull();
    });

    it('refresh tokens rotate once, also under concurrency', async () => {
      const s = await make();
      await s.putRefresh({ tokenHash: 'rt', grantId: 'g', expiresAt: 1000, rotatedAt: null });
      expect(await s.getRefresh('rt')).toEqual({ tokenHash: 'rt', grantId: 'g', expiresAt: 1000, rotatedAt: null });
      const results = await Promise.all(Array.from({ length: 8 }, () => s.rotateRefresh('rt', 7)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await s.getRefresh('rt'))?.rotatedAt).toBe(7);
    });

    it('signing keys: newest first', async () => {
      const s = await make();
      await s.putSigningKey({ kid: 'k1', publicJwk: { kty: 'EC', kid: 'k1' }, sealedPrivateJwk: 'p1', createdAt: 1 });
      await s.putSigningKey({ kid: 'k2', publicJwk: { kty: 'EC', kid: 'k2' }, sealedPrivateJwk: 'p2', createdAt: 2 });
      expect((await s.listSigningKeys()).map((k) => [k.kid, k.publicJwk.kid])).toEqual([
        ['k2', 'k2'],
        ['k1', 'k1'],
      ]);
    });

    it('sweep removes expired requests and refresh tokens, and codes an hour past expiry', async () => {
      const s = await make();
      const now = 10_000_000;
      await s.putAuthRequest({ id: 'old', clientId: 'c', redirectUri: 'u', codeChallenge: 'c', state: 's', scopes: [], resource: 'r', browserHash: 'b', data: {}, expiresAt: now - 1 });
      await s.putAuthRequest({ id: 'new', clientId: 'c', redirectUri: 'u', codeChallenge: 'c', state: 's', scopes: [], resource: 'r', browserHash: 'b', data: {}, expiresAt: now + 1 });
      const code = { grantId: 'g', clientId: 'c', redirectUri: 'u', codeChallenge: 'c', resource: 'r', usedAt: null };
      await s.putCode({ ...code, codeHash: 'recent', expiresAt: now - 1 });
      await s.putCode({ ...code, codeHash: 'ancient', expiresAt: now - 3_600_001 });
      await s.putRefresh({ tokenHash: 'old', grantId: 'g', expiresAt: now - 1, rotatedAt: null });
      await s.sweep(now);
      expect(await s.getAuthRequest('old')).toBeNull();
      expect(await s.getAuthRequest('new')).not.toBeNull();
      expect(await s.getCode('recent')).not.toBeNull();
      expect(await s.getCode('ancient')).toBeNull();
      expect(await s.getRefresh('old')).toBeNull();
    });

    it('purge empties the store', async () => {
      const s = await make();
      await s.putGrant(grant('g', 1));
      await s.putClient({ clientId: 'c', kind: 'dcr', metadata: {}, createdAt: 1, lastUsedAt: 1 });
      await s.purge();
      expect(await s.listGrants()).toEqual([]);
      expect(await s.getClient('c')).toBeNull();
    });

    it('token endpoint: of concurrent uses of one refresh token exactly one wins, and the reuse revokes the grant', async () => {
      const s = await createStack('apikey', { store: await make() });
      const t = (await (await exchange(s, await codeFor(s))).json()) as { refresh_token: string };
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => token(s, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CIMD_URL })),
      );
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 400)).toHaveLength(4);
      const [g] = await s.store.listGrants();
      expect(g?.revokedAt).not.toBeNull();
      expect(s.events.map((e) => e.type)).toContain('refresh.replayed');
    });

    it('token endpoint: a code redeemed concurrently yields tokens once, and the replay revokes the grant', async () => {
      const s = await createStack('apikey', { store: await make() });
      const c = await codeFor(s);
      const responses = await Promise.all(Array.from({ length: 5 }, () => exchange(s, c)));
      // At most one: the replay may revoke the grant before the winner's own revocation check, which is also correct.
      expect(responses.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      expect(responses.filter((r) => r.status === 400).length).toBeGreaterThanOrEqual(4);
      const [g] = await s.store.listGrants();
      expect(g?.revokedAt).not.toBeNull();
      expect(s.events.map((e) => e.type)).toContain('code.replayed');
    });
  });
}

(pg ? describe : describe.skip)('PgAuthStore tenancy (PG_TEST_URL)', () => {
  let sql: Sql;
  beforeAll(() => {
    sql = pg!.sql;
  });
  const scoped = (id: string) => PgAuthStore.forProject(sql, id, { schema: pg!.schema });

  it('rows of project A never resolve through project B, and the same ids coexist', async () => {
    const a = scoped('prj_iso_a');
    const b = scoped('prj_iso_b');
    await a.putClient({ clientId: 'jdc_same', kind: 'dcr', metadata: { owner: 'a' }, createdAt: 1, lastUsedAt: 1 });
    await a.putGrant(grant('grt_same', 1));
    await a.putUpstream('grt_same', 'sealed-a', 1);
    await a.putCode({ codeHash: 'code_a', grantId: 'grt_same', clientId: 'jdc_same', redirectUri: 'u', codeChallenge: 'c', resource: 'r', expiresAt: 9e12, usedAt: null });
    await a.putRefresh({ tokenHash: 'rt_a', grantId: 'grt_same', expiresAt: 9e12, rotatedAt: null });
    await a.putAuthRequest({ id: 'jar_a', clientId: 'c', redirectUri: 'u', codeChallenge: 'c', state: null, scopes: [], resource: 'r', browserHash: 'b', data: {}, expiresAt: 9e12 });
    await a.putSigningKey({ kid: 'kid_a', publicJwk: {}, sealedPrivateJwk: 'p', createdAt: 1 });

    expect(await b.getClient('jdc_same')).toBeNull();
    expect(await b.countClientsSince(0)).toBe(0);
    expect(await b.getGrant('grt_same')).toBeNull();
    expect(await b.listGrants()).toEqual([]);
    expect(await b.getUpstream('grt_same')).toBeNull();
    expect(await b.getCode('code_a')).toBeNull();
    expect(await b.useCode('code_a', 5)).toBe(false);
    expect(await b.getRefresh('rt_a')).toBeNull();
    expect(await b.rotateRefresh('rt_a', 5)).toBe(false);
    expect(await b.getAuthRequest('jar_a')).toBeNull();
    expect(await b.listSigningKeys()).toEqual([]);

    // B's writes with A's ids land in B only.
    await b.putClient({ clientId: 'jdc_same', kind: 'dcr', metadata: { owner: 'b' }, createdAt: 2, lastUsedAt: 2 });
    await b.putGrant(grant('grt_same', 2));
    await b.revokeGrant('grt_same', 9);
    expect((await a.getClient('jdc_same'))?.metadata).toEqual({ owner: 'a' });
    expect((await a.getGrant('grt_same'))?.revokedAt).toBeNull();
    expect(await a.getUpstream('grt_same')).toBe('sealed-a');
    expect((await a.getCode('code_a'))?.usedAt).toBeNull();
    expect((await a.getRefresh('rt_a'))?.rotatedAt).toBeNull();

    // Deleting B (project deletion) leaves A untouched; sweeping B never touches A.
    await b.sweep(Number.MAX_SAFE_INTEGER);
    await b.purge();
    expect(await b.getClient('jdc_same')).toBeNull();
    expect(await a.getClient('jdc_same')).not.toBeNull();
    expect(await a.getAuthRequest('jar_a')).not.toBeNull();
    expect(await a.listSigningKeys()).toHaveLength(1);
  });

  it('a token issued by project A is not refreshable through project B on the same tables', async () => {
    const a = await createStack('apikey', { store: scoped('prj_tok_a') });
    const t = (await (await exchange(a, await codeFor(a))).json()) as { refresh_token: string };
    const b = await createStack('apikey', { store: scoped('prj_tok_b') });
    const res = await token(b, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CIMD_URL });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    // …and A's grant is unharmed (B's miss is not a replay of A's token).
    expect((await a.store.listGrants())[0]?.revokedAt).toBeNull();
  });

  it('every table has row level security enabled', async () => {
    const rows = await sql.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE 'jack_auth_%'`,
      [pg!.schema],
    );
    expect(rows.length).toBe(7);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
