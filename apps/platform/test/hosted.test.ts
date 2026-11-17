import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '@graphmind-ai/db';
import { ConfigError, createHostedPlatform, migrateAll, publicOriginFrom, type Hosted } from '../src/hosted.js';
import { redact } from '../src/redact.js';

const ORIGIN = 'https://graphmind.test';
const CRON = 'c'.repeat(64);
const KEY = Buffer.alloc(32, 7).toString('base64');

/** Collect waitUntil work so a test can await everything the platform deferred. */
function deferred() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => {})),
    settle: async () => {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

async function waitForRun(h: Hosted, cookie: string, id: string, until: (status: string) => boolean, flush: () => Promise<void>) {
  for (let i = 0; i < 50; i++) {
    await flush();
    const r = await h.app.request(`${ORIGIN}/app/circuit/v1/runs/${id}`, { headers: { cookie } });
    const body = (await r.json()) as { run: { status: string } };
    if (until(body.run.status)) return body.run.status;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('run did not settle');
}

describe('configuration', () => {
  it('derives the public origin: explicit, then the Vercel deployment URL', () => {
    expect(publicOriginFrom({ PUBLIC_ORIGIN: 'https://graphmind.ai/' })).toBe('https://graphmind.ai');
    expect(publicOriginFrom({ VERCEL_URL: 'graphmind-abc.vercel.app' })).toBe('https://graphmind-abc.vercel.app');
  });

  it('fails the hosted boot naming the missing variable, never a value', async () => {
    const base = { POSTGRES_URL: 'postgres://u:supersecret@127.0.0.1:1/db', PUBLIC_ORIGIN: ORIGIN };
    await expect(createHostedPlatform({ env: base })).rejects.toThrow(new ConfigError('missing environment variable SUPABASE_URL'));
    const withAuth = { ...base, SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' };
    await expect(createHostedPlatform({ env: withAuth })).rejects.toThrow('CRON_SECRET');
    await expect(createHostedPlatform({ env: { ...withAuth, CRON_SECRET: CRON } })).rejects.toThrow('JACK_SECRET_KEY');
    const err = await createHostedPlatform({ env: { ...withAuth, CRON_SECRET: CRON, JACK_SECRET_KEY: 'c2hvcnQ=' } }).catch((e: Error) => e);
    expect(String(err)).toContain('32 bytes');
    expect(String(err)).not.toContain('supersecret');
  });

  it('redacts connection strings and keys from log lines', () => {
    const line = redact('connect ECONNREFUSED postgres://graphmind_app.ref:hunter2@pooler:6543/postgres with sb_secret_abc123 and Bearer xyz.abc');
    expect(line).not.toMatch(/hunter2|abc123|xyz\.abc/);
  });
});

describe('preview mode (no POSTGRES_URL)', () => {
  const d = deferred();
  let h: Hosted;
  afterAll(async () => h?.close());

  it('boots on SQLite with in-house accounts, serves the hub at /app, and drains Circuit work after the response', async () => {
    h = await createHostedPlatform({ env: { VERCEL_URL: 'graphmind.test' }, waitUntil: d.waitUntil });
    expect(h.mode).toBe('preview');
    const health = await (await h.app.request(`${ORIGIN}/app/health`)).json();
    expect(health).toMatchObject({ ok: true, service: 'platform', hub: '/app/', accounts: true });
    expect((await h.app.request(`${ORIGIN}/app/`)).status).toBe(200);

    const up = await h.app.request(`${ORIGIN}/app/auth/signup`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `pre-${Date.now()}@example.com`, password: 'correct horse battery' }),
    });
    expect(up.status).toBe(201);
    const cookie = up.headers.get('set-cookie')!.split(';')[0]!;

    const start = await h.app.request(`${ORIGIN}/app/circuit/v1/workflows/triage-invoice/runs`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { invoiceId: 'INV-1' } }),
    });
    expect(start.status).toBeLessThan(300);
    const run = { id: ((await start.json()) as { runId: string }).runId };
    const status = await waitForRun(h, cookie, run.id, (s) => s !== 'queued' && s !== 'running', d.settle);
    expect(['completed', 'paused', 'suspended', 'failed']).toContain(status);
  });

  it('refuses the internal tick when no CRON_SECRET is configured', async () => {
    const r = await h.app.request(`${ORIGIN}/api/internal/tick`, { method: 'POST', headers: { authorization: 'Bearer ' } });
    expect(r.status).toBe(401);
  });
});

// ------------------------------------------------- postgres + supabase --
const PG = process.env.PG_TEST_URL;
const dpg = PG ? describe : describe.skip;

dpg('production mode (Postgres + Supabase Auth)', () => {
  const SB = 'https://ref.supabase.co';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256' };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const access = (sub: string, email: string) => {
    const head = enc({ alg: 'ES256', kid: 'k1' });
    const body = enc({ sub, email, exp: Math.floor(Date.now() / 1000) + 3600, iss: `${SB}/auth/v1`, aud: 'authenticated', role: 'authenticated' });
    return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const kicks: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/auth/v1/token?grant_type=password')) {
      return Response.json({ access_token: access('11111111-1111-4111-8111-111111111111', 'pg@example.com'), refresh_token: 'rt1' });
    }
    if (url.endsWith('/api/internal/tick')) {
      kicks.push(String((init?.headers as Record<string, string>)?.authorization));
      return new Response(null, { status: 202 });
    }
    return new Response('{}', { status: 404 });
  };
  const env = {
    POSTGRES_URL: PG!,
    SUPABASE_URL: SB,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    CRON_SECRET: CRON,
    JACK_SECRET_KEY: KEY,
    PUBLIC_ORIGIN: ORIGIN,
  };
  const d = deferred();
  let h: Hosted;
  // Created lazily: a skipped describe still evaluates its body, and there is no URL to parse then.
  let admin: Sql;
  beforeAll(() => {
    admin = createSql(PG!);
  });

  afterAll(async () => {
    await h?.close();
    await admin.query('DROP SCHEMA IF EXISTS graphmind CASCADE');
    await admin.end();
  });

  it('migrates every store into one schema, idempotently', async () => {
    await admin.query('DROP SCHEMA IF EXISTS graphmind CASCADE');
    await admin.query('CREATE SCHEMA graphmind');
    const first = await migrateAll(PG!);
    expect(first).toEqual(expect.arrayContaining(['accounts-001-init', 'circuit-001-init', 'jack-001-init', 'jack-auth-001-init', 'platform-001-mcp-pins']));
    expect(await migrateAll(PG!)).toEqual([]);
    const noRls = await admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'graphmind' AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname <> '_migrations'`,
    );
    expect(noRls.map((r) => r.relname)).toEqual([]);
  });

  it('signs in through Supabase, runs a workflow through the in-process MCP server, persists in Postgres', async () => {
    h = await createHostedPlatform({ env, waitUntil: d.waitUntil, fetch: fakeFetch });
    expect(h.mode).toBe('postgres');
    const login = await h.app.request(`${ORIGIN}/app/auth/login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pg@example.com', password: 'whatever-it-is' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie.startsWith('__Host-gm_session=')).toBe(true);
    expect((await h.app.request(`${ORIGIN}/app/circuit/`, { headers: { cookie } })).status).toBe(200);
    expect((await h.app.request(`${ORIGIN}/app/jack/`, { headers: { cookie } })).status).toBe(200);

    const start = await h.app.request(`${ORIGIN}/app/circuit/v1/workflows/refund-request/runs`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { chargeId: 'ch_1', reason: 'damaged' } }),
    });
    expect(start.status).toBeLessThan(300);
    const run = { id: ((await start.json()) as { runId: string }).runId };
    const status = await waitForRun(h, cookie, run.id, (s) => s !== 'queued' && s !== 'running', d.settle);
    expect(status).not.toBe('failed');
    const [row] = await admin.query<{ n: number }>('SELECT count(*)::bigint AS n FROM graphmind.journal WHERE run_id = $1', [run.id]);
    expect(row!.n).toBeGreaterThan(0);
  });

  it('authenticates the tick with a constant-time bearer check', async () => {
    const bad = await h.app.request(`${ORIGIN}/api/internal/tick`, { method: 'POST', headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    const good = await h.app.request(`${ORIGIN}/api/internal/tick`, { method: 'POST', headers: { authorization: `Bearer ${CRON}` } });
    expect(good.status).toBe(202);
    await d.settle();
  });
});
