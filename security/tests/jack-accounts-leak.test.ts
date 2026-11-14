/**
 * GraphMind accounts (`@graphmind-ai/accounts`, used by the Jack and Circuit
 * dashboards): a password and a personal API token never leave the server
 * in clear once accepted.
 *
 *   forbidden  the password — never in any response or in either database;
 *              the API token — never in a response after the one that minted
 *              it, never in the database (only its hash)
 *   by-design  the token's prefix is listed; the token really works as a
 *              bearer (non-vacuity); the session cookie is HttpOnly
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { createJack, SqliteStore } from 'jack-api';

const nonce = randomBytes(8).toString('hex');
const PASSWORD = `pw_CANARY_${nonce}_${randomBytes(12).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'jack-accounts-audit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('accounts never return or store a password or an API token in clear', () => {
  it('across sign-up, sign-in, every /v1 and /auth surface, and both database files', async () => {
    const ORIGIN = 'http://127.0.0.1:4996';
    const jackDb = join(dir, 'jack.db');
    const accountsDb = join(dir, 'accounts.db');
    const store = new SqliteStore(jackDb);
    const accountStore = new SqliteAccountStore(accountsDb);
    const accounts = createAccounts({ store: accountStore, publicOrigin: ORIGIN });
    const jack = createJack({ store, accounts, publicOrigin: ORIGIN, dataDir: join(dir, 'data'), secretKey: randomBytes(32), egress: 'any', env: {} });

    const surfaces: string[] = [];
    let jar = '';
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await jack.app.request(`${ORIGIN}${path}`, {
        method,
        headers: { origin: ORIGIN, ...(jar ? { cookie: jar } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const set = res.headers.get('set-cookie');
      if (set) jar = set.split(';')[0] ?? '';
      const text = await res.text();
      const record = `${res.status} ${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${text}`;
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { res, text, json, record };
    };
    const keep = (r: { record: string }) => surfaces.push(r.record);

    keep(await call('POST', '/auth/signup', { email: 'canary@example.com', password: PASSWORD, name: 'Canary' }));
    expect(jar).toMatch(/^gm_session=/);
    expect(surfaces[0]).toMatch(/set-cookie: gm_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
    keep(await call('POST', '/auth/logout', {}));
    keep(await call('POST', '/auth/login', { email: 'canary@example.com', password: 'not-the-password-at-all' }));
    keep(await call('POST', '/auth/login', { email: 'canary@example.com', password: PASSWORD }));
    keep(await call('GET', '/auth/me'));
    keep(await call('GET', '/auth/status'));

    // Mint a token: the one response allowed to carry it.
    const minted = await call('POST', '/auth/tokens', { name: 'audit' });
    const TOKEN: string = minted.json.token;
    expect(TOKEN.startsWith('gmt_')).toBe(true);

    keep(await call('GET', '/auth/tokens'));
    keep(await call('GET', '/v1/health'));
    const created = await call('POST', '/v1/projects', { slug: 'canary', upstream: 'https://api.canary.test' });
    keep(created);
    keep(await call('GET', '/v1/projects'));
    keep(await call('GET', `/v1/projects/${created.json.project.id}`));
    for (const file of ['/', '/app.js', '/style.css', '/health']) keep(await call('GET', file));
    // Error paths too.
    keep(await call('POST', '/auth/signup', { email: 'canary@example.com', password: PASSWORD }));
    keep(await call('POST', '/auth/tokens', { name: '' }));
    keep(await call('DELETE', '/auth/tokens/tok_nope'));

    // Non-vacuity: the token really authenticates a cookie-less client.
    jar = '';
    const viaToken = await call('GET', '/v1/projects', undefined, { authorization: `Bearer ${TOKEN}` });
    keep(viaToken);
    expect(viaToken.res.status).toBe(200);
    expect(viaToken.json.projects.map((p: any) => p.slug)).toEqual(['canary']);

    await jack.close();
    store.close();
    accountStore.close();

    const all = surfaces.join('\n---\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(TOKEN);
    expect(all).toContain(TOKEN.slice(0, 10)); // the prefix is listed, by design
    for (const db of [jackDb, accountsDb]) {
      const bytes = readFileSync(db).toString('latin1');
      expect(bytes).not.toContain(PASSWORD);
      expect(bytes).not.toContain(TOKEN);
    }
    // The request bearer echo would be the only way the token reaches a response: make sure headers were captured.
    expect(all).toContain('content-type');
  });
});
