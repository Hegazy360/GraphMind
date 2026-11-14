/**
 * GraphMind Jack, control plane (M0): does a credential ever reach an
 * artifact? Plan §3.6 says the canary audit is a day-one CI job, so this
 * file exists from the scaffold and grows with every milestone (M3 adds
 * upstream tokens and IdP client secrets, M4 the call log and dashboard).
 *
 * Planted today:
 *   forbidden  the control-plane bearer key — it authenticates every /v1
 *              call and must never appear in a response body, a problem
 *              detail, the dashboard page, or the SQLite file.
 *   by-design  the project slug and upstream host — the control plane's job
 *              is to store and return them, so they MUST be found (this is
 *              the non-vacuity guard: a grep that finds nothing proves nothing).
 *
 * Imports jack-api through its published entry point (dist/), as every
 * audit here does: the question is what the shipped artifact does.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApi, SqliteStore } from 'jack-api';

const nonce = randomBytes(8).toString('hex');
const FORBIDDEN_KEY = `jk_dev_CANARY_${nonce}_${randomBytes(16).toString('hex')}`;
const BY_DESIGN_SLUG = `canary-${nonce}`;
const BY_DESIGN_HOST = `api-${nonce}.example.test`;

const dir = mkdtempSync(join(tmpdir(), 'jack-audit-'));
const dbPath = join(dir, 'jack.db');
const store = new SqliteStore(dbPath);
const app = createApi({ store, apiKeys: [FORBIDDEN_KEY] });
afterAll(() => {
  try {
    store.close();
  } catch {
    // the SQLite-file test already closed it to read the file
  }
  rmSync(dir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${FORBIDDEN_KEY}`, 'content-type': 'application/json' };

describe('jack control plane never records or echoes its bearer key', () => {
  it('every response surface: ok paths, every error path, the dashboard', async () => {
    const surfaces: string[] = [];
    const grab = async (res: Response) => {
      surfaces.push([...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'));
      surfaces.push(await res.text());
    };

    await grab(await app.request('/'));
    await grab(await app.request('/v1/health', { headers: auth }));
    await grab(
      await app.request('/v1/projects', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ slug: BY_DESIGN_SLUG, upstream: `https://${BY_DESIGN_HOST}` }),
      }),
    );
    await grab(await app.request('/v1/projects', { headers: auth }));
    // Error paths: a 401 must not hint at the accepted key, a 400 must not
    // reflect headers, a malformed body must not dump the request.
    await grab(await app.request('/v1/health'));
    await grab(await app.request('/v1/health', { headers: { authorization: `Bearer ${FORBIDDEN_KEY}x` } }));
    await grab(await app.request('/v1/projects', { method: 'POST', headers: auth, body: '{not json' }));
    await grab(await app.request('/v1/projects', { method: 'POST', headers: auth, body: JSON.stringify({ slug: 'x' }) }));
    await grab(await app.request('/v1/projects/nope', { headers: auth }));
    await grab(await app.request('/v1/projects/nope/deployments', { method: 'POST', headers: auth, body: '{}' }));

    const all = surfaces.join('\n---\n');
    expect(all).not.toContain(FORBIDDEN_KEY);
    // Non-vacuity: the by-design data IS there, so the grep is looking at real output.
    expect(all).toContain(BY_DESIGN_SLUG);
    expect(all).toContain(BY_DESIGN_HOST);
  });

  it('the SQLite file holds the project but not the key', () => {
    // WAL mode: closing the last connection checkpoints the log into the main file.
    store.close();
    const bytes = readFileSync(dbPath).toString('latin1');
    expect(bytes).toContain(BY_DESIGN_SLUG);
    expect(bytes).not.toContain(FORBIDDEN_KEY);
  });
});
