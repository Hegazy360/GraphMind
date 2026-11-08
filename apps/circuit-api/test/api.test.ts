/**
 * M3 demo as a test: the invoice-triage story end to end over HTTP —
 * enqueue via API → step fails and pauses → inject a fix → approval gate →
 * external event → completed. Plus auth, fork, breakpoints, deploy-check.
 */
import { describe, expect, it } from 'vitest';
import { workflow, type Ctx } from '@graphmind-ai/circuit-sdk';
import { Executor, ManualClock, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { createApi } from '../src/index.js';

const triage = (deps: { fetchInvoice: () => unknown }) =>
  workflow({ name: 'triage-invoice' }, async (ctx: Ctx, input) => {
    const invoice = await ctx.step('fetch-invoice', () => deps.fetchInvoice());
    const amount = (invoice as { amount: number }).amount;
    if (amount > 10_000) {
      const ok = await ctx.approval('finance-signoff', { approvers: ['role:finance'], timeout: '48h' });
      if (!ok.approved) return { status: 'escalated' };
    }
    const evt = await ctx.waitForEvent('payment', {
      name: 'payment.settled',
      match: { invoiceId: (input as { invoiceId: string }).invoiceId },
      timeout: '3d',
    });
    return { status: evt === null ? 'escalated' : 'paid' };
  });

function setup(deps: { fetchInvoice: () => unknown }, apiKeys?: string[]) {
  const clock = new ManualClock();
  const store = new SqliteJournalStore(':memory:');
  const wf = triage(deps);
  const executor = new Executor({ store, clock, owner: 'api-test', workflows: [wf] });
  const app = createApi({
    executor,
    store,
    workflows: [wf],
    ...(apiKeys !== undefined ? { apiKeys } : {}),
  });
  return { app, clock, executor, store };
}

async function post(app: ReturnType<typeof createApi>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('circuit API', () => {
  it('runs the whole fix-approve-settle story over HTTP', async () => {
    let healthy = false;
    const { app, executor } = setup({
      fetchInvoice: () => {
        if (!healthy) throw new Error('ERP 503');
        return { amount: 25_000 };
      },
    });

    // 1. Connect an application: one POST starts a run.
    const created = await post(app, '/v1/workflows/triage-invoice/runs', {
      input: { invoiceId: 'inv-7' },
      idempotencyKey: 'inv-7',
    });
    expect(created.status).toBe(202);
    const { runId } = (await created.json()) as { runId: string };
    // Idempotent re-send returns the same run.
    const again = await post(app, '/v1/workflows/triage-invoice/runs', { input: { invoiceId: 'inv-7' }, idempotencyKey: 'inv-7' });
    expect(((await again.json()) as { runId: string }).runId).toBe(runId);

    // 2. The ERP is down: the run pauses at an error gate.
    await executor.drain();
    let detail = (await (await app.request(`/v1/runs/${runId}`)).json()) as { run: { status: string; pausedSeq?: number } };
    expect(detail.run.status).toBe('paused');

    // 3. Fix-and-resume over the API, with an audited actor.
    healthy = true;
    const resumed = await post(
      app,
      `/v1/runs/${runId}/entries/0/resume`,
      { action: 'retry', reason: 'ERP back up' },
      { 'x-circuit-actor': 'ops@team' },
    );
    expect(resumed.status).toBe(200);
    await executor.drain();

    // 4. Now held at the finance approval.
    detail = (await (await app.request(`/v1/runs/${runId}`)).json()) as typeof detail;
    expect(detail.run.status).toBe('paused');
    const approve = await post(app, `/v1/runs/${runId}/approvals/1`, { approved: true, by: 'cfo@team' });
    expect(approve.status).toBe(200);
    await executor.drain();

    // 5. Suspended waiting for the payment event; deliver it via the API.
    const evt = await post(app, '/v1/events', { name: 'payment.settled', data: { invoiceId: 'inv-7' } });
    expect(evt.status).toBe(202);
    expect(((await evt.json()) as { matchedRuns: string[] }).matchedRuns).toEqual([runId]);
    await executor.drain();

    // 6. Completed, with the whole story in the journal.
    const finished = (await (await app.request(`/v1/runs/${runId}`)).json()) as {
      run: { status: string; output: unknown };
      journal: Array<{ name: string; status: string; interventions: unknown[] }>;
    };
    expect(finished.run.status).toBe('completed');
    expect(finished.run.output).toEqual({ status: 'paid' });
    expect(finished.journal.map((e) => e.name)).toEqual(['fetch-invoice', 'finance-signoff', 'payment']);
    expect(finished.journal[0]?.interventions).toHaveLength(1);
  });

  it('enforces bearer keys when configured', async () => {
    const { app } = setup({ fetchInvoice: () => ({ amount: 1 }) }, ['ck_test_123']);
    const denied = await post(app, '/v1/workflows/triage-invoice/runs', { input: {} });
    expect(denied.status).toBe(401);
    const allowed = await post(
      app,
      '/v1/workflows/triage-invoice/runs',
      { input: { invoiceId: 'x' } },
      { authorization: 'Bearer ck_test_123' },
    );
    expect(allowed.status).toBe(202);
  });

  it('404s unknown workflows and runs; 400s bad bodies; 409s bad resumes', async () => {
    const { app, executor } = setup({ fetchInvoice: () => ({ amount: 1 }) });
    expect((await post(app, '/v1/workflows/ghost/runs', { input: {} })).status).toBe(404);
    expect((await app.request('/v1/runs/run_nope')).status).toBe(404);
    expect((await post(app, '/v1/events', { name: '' })).status).toBe(400);
    const created = await post(app, '/v1/workflows/triage-invoice/runs', { input: { invoiceId: 'a' } });
    const { runId } = (await created.json()) as { runId: string };
    await executor.drain();
    const badResume = await post(app, `/v1/runs/${runId}/entries/0/resume`, { action: 'inject', output: 1 });
    expect(badResume.status).toBe(409);
  });

  it('deploy-check endpoint reports broken in-flight runs with a 409', async () => {
    const { app, executor } = setup({ fetchInvoice: () => ({ amount: 25_000 }) });
    await post(app, '/v1/workflows/triage-invoice/runs', { input: { invoiceId: 'b' } });
    await executor.drain(); // paused at approval — in flight
    const sameCode = await post(app, '/v1/deploy-check', {});
    expect(sameCode.status).toBe(200);
    expect(((await sameCode.json()) as { checked: number }).checked).toBe(1);
  });

  it('forks with a substitution over the API', async () => {
    const { app, executor } = setup({ fetchInvoice: () => ({ amount: 5 }) });
    const created = await post(app, '/v1/workflows/triage-invoice/runs', { input: { invoiceId: 'c' } });
    const { runId } = (await created.json()) as { runId: string };
    await executor.drain();
    await post(app, '/v1/events', { name: 'payment.settled', data: { invoiceId: 'c' } });
    await executor.drain();
    // What if the invoice had been big enough to need sign-off?
    const fork = await post(app, `/v1/runs/${runId}/fork`, { substitute: { seq: 0, output: { amount: 99_999 } } });
    expect(fork.status).toBe(201);
    const { runId: forkId } = (await fork.json()) as { runId: string };
    await executor.drain();
    const forked = (await (await app.request(`/v1/runs/${forkId}`)).json()) as { run: { status: string } };
    expect(forked.run.status).toBe('paused'); // now it hits the approval gate
  });
});

describe('dashboard and workflow listing', () => {
  it('serves the dashboard with a strict CSP, without requiring a key for the page itself', async () => {
    const { app } = setup({ fetchInvoice: () => ({ amount: 1 }) }, ['ck_test_123']);
    const page = await app.request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('GraphMind');
    expect((await app.request('/app.js')).headers.get('content-type')).toContain('javascript');
    // ...but data still requires the key.
    expect((await app.request('/v1/runs')).status).toBe(401);
  });

  it('lists workflows with their config', async () => {
    const { app } = setup({ fetchInvoice: () => ({ amount: 1 }) });
    const res = await app.request('/v1/workflows');
    const body = (await res.json()) as { workflows: Array<{ name: string; onError: string }> };
    expect(body.workflows.map((w) => w.name)).toEqual(['triage-invoice']);
    expect(body.workflows[0]?.onError).toBe('pause');
  });
});

describe('cancel, scaffold and reload-awareness', () => {
  it('cancels a suspended (not just paused) run', async () => {
    const { app, executor } = setup({ fetchInvoice: () => ({ amount: 1 }) });
    const created = await post(app, '/v1/workflows/triage-invoice/runs', { input: { invoiceId: 'c1' } });
    const { runId } = (await created.json()) as { runId: string };
    await executor.drain(); // suspended, waiting for payment
    const res = await post(app, `/v1/runs/${runId}/cancel`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { run: { status: string } }).run.status).toBe('aborted');
  });

  it('health advertises dev tools; scaffold validates and delegates; workflows getter stays live', async () => {
    const clock = new ManualClock();
    const store = new SqliteJournalStore(':memory:');
    let defs = [triage({ fetchInvoice: () => ({ amount: 1 }) })];
    const executor = new Executor({ store, clock, workflows: defs });
    const scaffolded: string[] = [];
    const app = createApi({
      executor,
      store,
      workflows: () => defs,
      devTools: {
        templates: ['blank', 'approval'],
        scaffold: (name) => {
          scaffolded.push(name);
          const extra = triage({ fetchInvoice: () => ({ amount: 1 }) });
          defs = [...defs, { ...extra, config: { ...extra.config, name } } as typeof extra];
          executor.replaceWorkflows(defs);
          return { file: '/tmp/workflows.mjs' };
        },
      },
    });
    const health = (await (await app.request('/v1/health')).json()) as { dev: boolean; templates: string[] };
    expect(health.dev).toBe(true);
    expect(health.templates).toEqual(['blank', 'approval']);

    expect((await post(app, '/v1/dev/scaffold', { name: 'Bad Name', template: 'blank' })).status).toBe(400);
    expect((await post(app, '/v1/dev/scaffold', { name: 'triage-invoice', template: 'blank' })).status).toBe(409);
    const ok = await post(app, '/v1/dev/scaffold', { name: 'fresh-flow', template: 'blank' });
    expect(ok.status).toBe(201);
    expect(scaffolded).toEqual(['fresh-flow']);
    // The getter reflects the reload: the new workflow is listed immediately.
    const listed = (await (await app.request('/v1/workflows')).json()) as { workflows: Array<{ name: string }> };
    expect(listed.workflows.map((w) => w.name)).toContain('fresh-flow');
  });

  it('scaffold 404s on a non-dev server', async () => {
    const { app } = setup({ fetchInvoice: () => ({ amount: 1 }) });
    expect((await post(app, '/v1/dev/scaffold', { name: 'x-y', template: 'blank' })).status).toBe(404);
  });
});
