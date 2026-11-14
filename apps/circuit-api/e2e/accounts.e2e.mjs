// Browser test of the Circuit dashboard with accounts on: sign up, see the
// runs list, start a run, mint an API token, sign out, sign in.
// Run: pnpm --filter circuit-api test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { workflow } from '@graphmind-ai/circuit-sdk';
import { Executor, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { createApi, startEngineLoop } from '../dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'circuit-accounts-e2e-'));
let server, loop, browser, base;
const pageErrors = [];

before(async () => {
  const wf = workflow({ name: 'hello' }, async (ctx) => ctx.step('greet', () => ({ hello: 'world' })));
  const store = new SqliteJournalStore(join(dir, 'dev.db'));
  const executor = new Executor({ store, owner: 'e2e', workflows: [wf] });
  loop = startEngineLoop(executor);
  let handler;
  server = await new Promise((resolve) => {
    const s = serve({ fetch: (r) => handler(r), port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const accounts = createAccounts({ store: new SqliteAccountStore(join(dir, 'accounts.db')), publicOrigin: base });
  handler = createApi({ executor, store, workflows: [wf], onWork: loop.kick, accounts }).fetch;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  loop?.stop();
  await new Promise((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

test('sign up, start a run as yourself, mint a token, sign out and in', async () => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    // The browser logs every non-2xx fetch; the 401 from probing /auth/me before sign-in is expected.
    if (m.type() === 'error' && !/status of 401/.test(m.text())) pageErrors.push(m.text());
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid=signup-form]');
  await page.fill('#auth-email', 'ada@example.com');
  await page.fill('#auth-password', 'correct-horse-battery');
  await page.click('[data-testid=auth-submit]');
  await page.waitForFunction(() => document.getElementById('conn')?.textContent?.includes('you are ada@example.com'));

  await page.click('#btn-new-run');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button.primary');
  await page.waitForFunction(() => document.querySelectorAll('#run-list li:not(.none)').length === 1);

  // Account settings are the shared account page, from the user menu (the same component as the hub's).
  await page.click('[data-testid=who]');
  await page.click('[data-testid=menu-account]');
  await page.waitForSelector('[data-testid=account-page]');
  assert.ok((await page.textContent('[data-testid=account-page]')).includes(`circuit mcp serve --api ${base} --api-key`));
  await page.click('[data-testid=mint-token]');
  await page.waitForSelector('[data-testid=minted-token]');
  const token = (await page.textContent('[data-testid=minted-token]')).trim();
  assert.ok(token.startsWith('gmt_'));
  const res = await fetch(`${base}/v1/runs`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).runs.length, 1);

  await page.click('[data-testid=sign-out]');
  await page.waitForSelector('[data-testid=signin-form]');
  await page.fill('#auth-email', 'ada@example.com');
  await page.fill('#auth-password', 'correct-horse-battery');
  await page.click('[data-testid=auth-submit]');
  await page.waitForFunction(() => document.getElementById('conn')?.textContent?.includes('you are ada@example.com'));
  assert.deepEqual(pageErrors, []);
  await page.close();
});
