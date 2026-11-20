/**
 * Accounts on the Circuit control plane: sign-up gates /v1, interventions
 * are attributed to the account, tokens serve the CLI, the operator key
 * still works.
 */
import { describe, expect, it } from 'vitest';
import { workflow, type Ctx } from '@graphmind-ai/circuit-sdk';
import { Executor, ManualClock, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { createApi } from '../src/index.js';

const ORIGIN = 'http://127.0.0.1:4810';

function setup(opts: { apiKeys?: string[] } = {}) {
  let healthy = false;
  const wf = workflow({ name: 'flaky' }, async (ctx: Ctx) => {
    const v = await ctx.step('fetch', () => {
      if (!healthy) throw new Error('down');
      return { ok: true };
    });
    return v;
  });
  const store = new SqliteJournalStore(':memory:');
  const executor = new Executor({ store, clock: new ManualClock(), owner: 'accounts-test', workflows: [wf] });
  const accounts = createAccounts({ store: new SqliteAccountStore(':memory:'), publicOrigin: ORIGIN });
  const app = createApi({ executor, store, workflows: [wf], accounts, ...(opts.apiKeys ? { apiKeys: opts.apiKeys } : {}) });

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
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        /* empty */
      }
      return { status: res.status, json };
    };
  };
  const cli = (bearer?: string) => async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* empty */
    }
    return { status: res.status, json };
  };
  return { app, executor, browser, cli, heal: () => (healthy = true) };
}

describe('circuit with accounts', () => {
  it('gates /v1 behind a sign-in and advertises accounts publicly', async () => {
    const { cli, browser } = setup();
    expect((await cli()('GET', '/health')).json).toMatchObject({ ok: true, service: 'circuit', auth: true, accounts: true, signup: true });
    expect((await cli()('GET', '/v1/workflows')).status).toBe(401);
    expect((await cli()('POST', '/v1/workflows/flaky/runs', {})).status).toBe(401);

    const b = browser();
    expect((await b('POST', '/auth/signup', { email: 'ada@example.com', password: 'a-long-enough-password' })).status).toBe(201);
    const health = await b('GET', '/v1/health');
    expect(health.json).toMatchObject({ accounts: true, user: { email: 'ada@example.com' } });
    expect((await b('GET', '/v1/workflows')).json.workflows).toHaveLength(1);
  });

  it('attributes fixes and approvals to the signed-in account, not to a header', async () => {
    const { executor, browser, heal } = setup();
    const ada = browser();
    await ada('POST', '/auth/signup', { email: 'ada@example.com', password: 'a-long-enough-password' });
    const { json } = await ada('POST', '/v1/workflows/flaky/runs', { input: {} });
    await executor.drain();
    expect((await ada('GET', `/v1/runs/${json.runId}`)).json.run.status).toBe('paused');
    heal();
    const r = await ada('POST', `/v1/runs/${json.runId}/entries/0/resume`, { action: 'retry', reason: 'back up' }, { 'x-circuit-actor': 'someone-else' });
    expect(r.status).toBe(200);
    await executor.drain();
    const detail = await ada('GET', `/v1/runs/${json.runId}`);
    expect(detail.json.run.status).toBe('completed');
    const intervention = detail.json.journal[0].intervention ?? detail.json.journal[0].interventions?.[0];
    expect(JSON.stringify(intervention)).toContain('ada@example.com');
    expect(JSON.stringify(intervention)).not.toContain('someone-else');
  });

  it('serves the CLI with a personal token and the operator with a static key', async () => {
    const { browser, cli } = setup({ apiKeys: ['op-key'] });
    const ada = browser();
    await ada('POST', '/auth/signup', { email: 'ada@example.com', password: 'a-long-enough-password' });
    const minted = await ada('POST', '/auth/tokens', { name: 'laptop' });
    expect(minted.status).toBe(201);
    expect((await cli(minted.json.token)('GET', '/v1/workflows')).status).toBe(200);
    expect((await cli(minted.json.token)('POST', '/v1/workflows/flaky/runs', { input: {} })).status).toBe(202);
    expect((await cli('op-key')('GET', '/v1/workflows')).status).toBe(200);
    expect((await cli('nope')('GET', '/v1/workflows')).status).toBe(401);
  });

  it('refuses cross-site writes from a session', async () => {
    const { browser } = setup();
    const ada = browser();
    await ada('POST', '/auth/signup', { email: 'ada@example.com', password: 'a-long-enough-password' });
    expect((await ada('POST', '/v1/workflows/flaky/runs', { input: {} }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await ada('POST', '/v1/workflows/flaky/runs', { input: {} })).status).toBe(202);
  });
});

describe('circuit runs belong to accounts', () => {
  const PASSWORD = 'a-long-enough-password';

  it('each account sees and acts on its own runs only; the operator key sees all', async () => {
    const { executor, browser, cli } = setup({ apiKeys: ['op-key'] });
    const ada = browser();
    const bob = browser();
    await ada('POST', '/auth/signup', { email: 'ada@example.com', password: PASSWORD });
    await bob('POST', '/auth/signup', { email: 'bob@example.com', password: PASSWORD });

    const mine = (await ada('POST', '/v1/workflows/flaky/runs', { input: {}, idempotencyKey: 'same' })).json.runId as string;
    const theirs = (await bob('POST', '/v1/workflows/flaky/runs', { input: {}, idempotencyKey: 'same' })).json.runId as string;
    expect(theirs).not.toBe(mine); // idempotency keys are per account
    await executor.drain();

    expect((await ada('GET', '/v1/runs')).json.runs.map((r: { id: string }) => r.id)).toEqual([mine]);
    expect((await bob('GET', '/v1/runs')).json.runs.map((r: { id: string }) => r.id)).toEqual([theirs]);

    // Every per-run route answers 404 for another account's run, as if it did not exist.
    for (const [method, path, body] of [
      ['GET', `/v1/runs/${mine}`, undefined],
      ['GET', `/v1/runs/${mine}/fixture`, undefined],
      ['POST', `/v1/runs/${mine}/entries/0/resume`, { action: 'abort' }],
      ['POST', `/v1/runs/${mine}/approvals/0`, { approved: true, by: 'bob' }],
      ['POST', `/v1/runs/${mine}/fork`, { uptoSeq: 0 }],
      ['POST', `/v1/runs/${mine}/cancel`, undefined],
    ] as const) {
      expect((await bob(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect((await executor.getRun(mine))?.status).toBe('paused'); // untouched

    const op = cli('op-key');
    expect((await op('GET', '/v1/runs')).json.runs).toHaveLength(2);
    expect((await op('GET', `/v1/runs/${mine}`)).status).toBe(200);
  });

  it('breakpoints from an account pause only its runs, whatever the body claims', async () => {
    const { executor, browser } = setup();
    const ada = browser();
    const bob = browser();
    await ada('POST', '/auth/signup', { email: 'ada@example.com', password: PASSWORD });
    await bob('POST', '/auth/signup', { email: 'bob@example.com', password: PASSWORD });
    const bobId = (await bob('GET', '/auth/me')).json.user.id as string;

    // Ada tries to plant a breakpoint on Bob's account.
    expect((await ada('POST', '/v1/breakpoints', { step: 'fetch', point: 'before', accountId: bobId })).status).toBe(201);
    const bobRun = (await bob('POST', '/v1/workflows/flaky/runs', { input: {} })).json.runId as string;
    const adaRun = (await ada('POST', '/v1/workflows/flaky/runs', { input: {} })).json.runId as string;
    await executor.drain();
    expect((await executor.getJournal(bobRun))[0]?.pausePoint).not.toBe('before');
    expect((await executor.getJournal(adaRun))[0]?.pausePoint).toBe('before');

    // Bob clearing breakpoints leaves Ada's alone.
    await bob('DELETE', '/v1/breakpoints');
    const again = (await ada('POST', '/v1/workflows/flaky/runs', { input: {} })).json.runId as string;
    await executor.drain();
    expect((await executor.getJournal(again))[0]?.pausePoint).toBe('before');
  });
});

describe('circuit insights', () => {
  it('per account: a step fixed by hand in run after run becomes a recommendation; others see none of it', async () => {
    const { executor, browser } = setup();
    const ada = browser();
    const bob = browser();
    await ada('POST', '/auth/signup', { email: 'ada@example.com', password: 'a-long-enough-password' });
    await bob('POST', '/auth/signup', { email: 'bob@example.com', password: 'a-long-enough-password' });
    for (let i = 0; i < 3; i += 1) {
      const runId = (await ada('POST', '/v1/workflows/flaky/runs', { input: {} })).json.runId as string;
      await executor.drain();
      expect((await ada('POST', `/v1/runs/${runId}/entries/0/resume`, { action: 'inject', output: { ok: true } })).status).toBe(200);
      await executor.drain();
    }
    const mine = await ada('GET', '/v1/insights');
    expect(mine.status).toBe(200);
    const flaky = mine.json.workflows.find((w: { workflow: string }) => w.workflow === 'flaky');
    expect(flaky.trend.runs).toBe(3);
    expect(flaky.trend.points).toBeUndefined();
    const rec = flaky.recommendations.find((r: { id: string }) => r.id === 'R-manual-fix');
    expect(rec).toMatchObject({ target: { name: 'fetch' }, evidence: { runs: 3, counts: { inject: 3 } } });

    const theirs = await bob('GET', '/v1/insights?workflow=flaky');
    expect(theirs.json.workflows[0]).toMatchObject({ workflow: 'flaky', trend: { runs: 0 }, recommendations: [] });
    expect((await bob('GET', '/v1/insights?workflow=nope')).status).toBe(404);
  });
});
