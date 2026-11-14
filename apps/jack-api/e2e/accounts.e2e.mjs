// Browser test of the Jack dashboard with accounts on, running on its own
// (`jack serve --accounts`): the first visitor is offered sign-up, gets a
// workspace of their own, mints an API token on the shared account page
// (the same component the platform hub uses), signs out and back in; a
// second account sees none of the first one's projects.
// Run: pnpm --filter jack-api test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { createJack, SqliteStore } from '../dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'jack-accounts-e2e-'));
let server, jack, browser, base;
const pageErrors = [];

before(async () => {
  let handler;
  server = await new Promise((resolve) => {
    const s = serve({ fetch: (r) => handler(r), port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const accounts = createAccounts({ store: new SqliteAccountStore(join(dir, 'accounts.db')), publicOrigin: base });
  jack = createJack({ store: new SqliteStore(join(dir, 'jack.db')), publicOrigin: base, dataDir: join(dir, 'data'), secretKey: randomBytes(32), egress: 'any', accounts });
  handler = jack.app.fetch;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await jack?.close();
  await new Promise((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function newPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    // The browser logs every non-2xx fetch; the 401 from probing /auth/me before sign-in is expected.
    if (m.type() === 'error' && !/status of 401/.test(m.text())) pageErrors.push(m.text());
  });
  return page;
}

test('first visitor: sign up, own workspace, API token, sign out, sign in', async () => {
  const page = await newPage();
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid=signup-form]');
  await page.fill('#auth-email', 'ada@example.com');
  await page.fill('#auth-name', 'Ada');
  await page.fill('#auth-password', 'correct-horse-battery');
  await page.click('[data-testid=auth-submit]');
  await page.waitForSelector('[data-testid=start]'); // the empty home: "Import your API"
  assert.equal(await page.textContent('[data-testid=who] .gm-user-name'), 'Ada');
  assert.equal(await page.textContent('.gm-products .on'), 'Jack'); // standalone: no product switcher, just this product

  // Create a project so there is something to be private.
  await page.goto(`${base}/#/new`);
  await page.fill('#spec-text', JSON.stringify({ openapi: '3.0.3', info: { title: 'Ada API', version: '1' }, servers: [{ url: 'https://api.ada.test' }], paths: { '/things': { get: { operationId: 'listThings', summary: 'List the things.', responses: {} } } } }));
  await page.click('#analyze');
  await page.waitForSelector('[data-testid=import-preview]');
  await page.click('#create-project');
  await page.waitForSelector('[data-testid=project-name]');
  assert.equal(await page.textContent('[data-testid=project-name]'), 'Ada API');

  // The account page, from the user menu: mint a token, shown once.
  await page.click('[data-testid=who]');
  await page.click('[data-testid=menu-account]');
  await page.waitForSelector('[data-testid=account-page]');
  assert.ok(await page.isHidden('[data-gm-app]')); // the dashboard steps aside while the account page is up
  assert.ok((await page.textContent('[data-testid=account-page]')).includes(`jack deploy --server ${base} --api-key`));
  await page.fill('#token-name', 'laptop');
  await page.click('[data-testid=mint-token]');
  await page.waitForSelector('[data-testid=minted-token]');
  const token = (await page.textContent('[data-testid=minted-token]')).trim();
  assert.ok(token.startsWith('gmt_'), token);
  assert.ok((await page.textContent('[data-testid=tokens]')).includes('laptop'));

  // The token works from a CLI (no cookies) and sees Ada's project.
  const res = await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).projects.map((p) => p.name), ['Ada API']);

  // Sign out, then back in.
  await page.click('[data-testid=sign-out]');
  await page.waitForSelector('[data-testid=signin-form]');
  await page.fill('#auth-email', 'ada@example.com');
  await page.fill('#auth-password', 'wrong-password-here');
  await page.click('[data-testid=auth-submit]');
  await page.waitForFunction(() => document.querySelector('[data-testid=auth-status]')?.textContent?.includes('wrong email or password'));
  await page.fill('#auth-password', 'correct-horse-battery');
  await page.click('[data-testid=auth-submit]');
  await page.waitForSelector('#project-list a');
  assert.equal(await page.textContent('#project-list a'), 'Ada APInot deployed');
  await page.context().close();
});

test('second account: the first one’s projects do not exist', async () => {
  const page = await newPage();
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid=signin-form]'); // not the first user any more: sign-in first
  await page.click('[data-testid=to-signup]');
  await page.waitForSelector('[data-testid=signup-form]');
  await page.fill('#auth-email', 'bob@example.com');
  await page.fill('#auth-password', 'another-long-password');
  await page.click('[data-testid=auth-submit]');
  await page.waitForSelector('[data-testid=start]');
  assert.equal(await page.$$eval('#project-list a', (as) => as.length), 0);
  await page.context().close();
});

test('the pages ran without script or CSP errors', () => {
  assert.deepEqual(pageErrors, []);
});
