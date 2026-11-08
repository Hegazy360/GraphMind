// Browser test of the dashboard: the full invoice story driven by clicks,
// exactly as a person would. Run: pnpm --filter circuit-api test:e2e
// Saves screenshots to $CIRCUIT_SHOTS (if set) for visual review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { workflow, z } from '@graphmind-ai/circuit-sdk';
import { Executor, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { createApi, startEngineLoop } from '../dist/index.js';

let erpHealthy = false;
const triage = workflow(
  { name: 'triage-invoice', input: z.object({ invoiceId: z.string() }), retries: 1 },
  async (ctx, input) => {
    const invoice = await ctx.step('fetch-invoice', () => {
      if (!erpHealthy) throw new Error('ERP 503');
      return { invoiceId: input.invoiceId, amount: 25_000 };
    });
    if (invoice.amount > 10_000) {
      const ok = await ctx.approval('finance-signoff', { approvers: ['role:finance'], context: invoice });
      if (!ok.approved) return { status: 'escalated' };
    }
    const paid = await ctx.waitForEvent('payment', { name: 'payment.settled', match: { invoiceId: input.invoiceId } });
    return { status: paid ? 'paid' : 'escalated', amount: invoice.amount };
  },
);

const shots = process.env.CIRCUIT_SHOTS;
let server, browser, page, base, loop, store;

before(async () => {
  store = new SqliteJournalStore(':memory:');
  const executor = new Executor({ store, workflows: [triage] });
  loop = startEngineLoop(executor, 50);
  let defs = [triage];
  const app = createApi({
    executor,
    store,
    workflows: () => defs,
    onWork: loop.kick,
    devTools: {
      templates: ['blank', 'approval'],
      scaffold: (name) => {
        const extra = workflow({ name, input: z.object({}) }, async (ctx) => ctx.step('first-step', () => 'hi'));
        defs = [...defs, extra];
        executor.replaceWorkflows(defs);
        return { file: '/dev/workflows.mjs' };
      },
    },
  });
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('pageerror', (err) => { throw err; });
});

after(async () => {
  await browser?.close();
  loop?.stop();
  server?.close();
  store?.close();
});

const snap = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

test('start → pause on error → inject fix → approve → event → completed, all from the UI', async () => {
  await page.goto(base);
  await page.getByText('connected').waitFor();
  await snap('01-empty');

  // Start a run through the dialog.
  await page.getByRole('button', { name: 'New run' }).click();
  await page.getByRole('button', { name: 'Start run' }).click();

  // It pauses at the error gate; the fix panel is shown.
  await page.getByText('This step failed — fix it and resume').waitFor({ timeout: 5000 });
  await page.getByText('ERP 503').first().waitFor();
  await snap('02-paused-on-error');

  // Inject a corrected result with a reason.
  await page.locator('.tabs').getByRole('button', { name: 'Inject result' }).click();
  await page.locator('#fix-json').fill('{"invoiceId":"flaky-big-001","amount":25000}');
  await page.locator('#fix-reason').fill('ERP down; amount from the PDF');
  await page.locator('.fix-panel').getByRole('button', { name: 'Inject result' }).last().click();

  // Held at the approval.
  await page.getByText('Approval requested').waitFor({ timeout: 5000 });
  await page.getByText('Paused at "finance-signoff"').waitFor();
  await snap('03-approval');
  await page.getByRole('button', { name: 'Approve' }).click();

  // Waiting for the payment event; send it from the dialog.
  await page.locator('.node', { hasText: 'payment' }).getByText('waiting for "payment.settled"').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Send event' }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Completed.').waitFor({ timeout: 5000 });
  await snap('04-completed');

  // The human fix is visible on the step.
  await page.locator('.node', { hasText: 'fetch-invoice' }).click();
  await page.getByText("inject by dashboard").first().waitFor();
  await page.getByText("approved by dashboard").waitFor();
  await page.getByText('"ERP down; amount from the PDF"', { exact: false }).waitFor();
  await snap('05-inspector');

  // Fork: what if the amount had been small?
  await page.getByRole('button', { name: 'Fork from here…' }).click();
  await page.locator('#fork-out').fill('{"invoiceId":"flaky-big-001","amount":50}');
  await page.getByRole('button', { name: 'Fork', exact: true }).click();
  await page.getByText('forked from').waitFor({ timeout: 5000 });
  await page.locator('.node', { hasText: 'payment' }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.node', { hasText: 'finance-signoff' }).count(), 0, 'small invoice skips approval');
  await snap('06-fork');

  // Deploy check from the header.
  await page.getByRole('button', { name: 'Deploy check' }).click();
  await page.getByText('Deploy check passed').waitFor();
});

test('runs list filters and highlights paused runs', async () => {
  erpHealthy = false;
  await page.goto(base);
  await page.getByRole('button', { name: 'New run' }).click();
  await page.getByRole('button', { name: 'Start run' }).click();
  await page.locator('.run-list li.needs-human').first().waitFor({ timeout: 5000 });
  await page.selectOption('#status-filter', 'paused');
  await page.waitForTimeout(300);
  const statuses = await page.locator('.run-list .badge').allTextContents();
  assert.ok(statuses.length >= 1 && statuses.every((s) => s === 'paused'), `got ${statuses}`);
});

test('New workflow scaffolds a template and it becomes runnable', async () => {
  await page.goto(base);
  const btn = page.getByRole('button', { name: 'New workflow' });
  await btn.waitFor();
  await btn.click();
  await page.locator('#nwf-name').fill('scaffolded-flow');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByText("'scaffolded-flow' added").waitFor();
  await page.waitForTimeout(1000); // the dialog refetches /v1/workflows
  await page.getByRole('button', { name: 'New run' }).click();
  const options = await page.locator('#nr-wf option').allTextContents();
  assert.ok(options.includes('scaffolded-flow'), `got ${options}`);
  await page.selectOption('#nr-wf', 'scaffolded-flow');
  await page.getByRole('button', { name: 'Start run' }).click();
  await page.getByText('Completed.').waitFor({ timeout: 5000 });
});

test('customer data is rendered as text, never as HTML', async () => {
  erpHealthy = true;
  await page.goto(base);
  await page.getByRole('button', { name: 'New run' }).click();
  await page.locator('#nr-input').fill('{"invoiceId":"<img src=x onerror=alert(1)>"}');
  await page.getByRole('button', { name: 'Start run' }).click();
  await page.getByText('Approval requested').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('img').count(), 0);
  await page.getByText('<img src=x onerror=alert(1)>').first().waitFor();
});
