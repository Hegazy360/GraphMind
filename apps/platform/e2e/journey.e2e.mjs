// The end-user journey, in a real browser: graphmind.ai's homepage → "Create a
// free account" → the hub → Circuit (start a run, see it pause) → Jack (import
// an API) → back to the hub, signed in throughout with one session.
// Run: pnpm platform:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { Executor, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { loadWorkflows } from '@graphmind-ai/circuit-cli';
import { createApi as createCircuit, startEngineLoop } from 'circuit-api';
import { createJack, SqliteStore as JackStore } from 'jack-api';
import { createPlatform } from '../dist/index.js';

const repo = resolve(import.meta.dirname, '..', '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'platform-journey-'));
let server, loop, jack, browser, page, base;
const pageErrors = [];

before(async () => {
  let handler;
  server = await new Promise((r) => {
    const s = serve({ fetch: (req) => handler(req), port: 0, hostname: '127.0.0.1' }, () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const accounts = createAccounts({ store: new SqliteAccountStore(join(dir, 'accounts.db')), publicOrigin: base });
  const defs = await loadWorkflows(resolve(repo, 'examples', 'circuit-onboarding', 'workflows.mjs'));
  const journal = new SqliteJournalStore(join(dir, 'circuit.db'));
  const executor = new Executor({ store: journal, workflows: defs });
  loop = startEngineLoop(executor);
  const circuit = createCircuit({ executor, store: journal, workflows: () => defs, onWork: loop.kick, accounts });
  jack = createJack({ store: new JackStore(join(dir, 'jack.db')), accounts, publicOrigin: base, dataDir: join(dir, 'jack'), secretKey: randomBytes(32), egress: 'any', dashboardPath: '/app/jack/' });
  handler = createPlatform({ accounts, circuit, jack, site: resolve(repo, 'apps', 'web') }).fetch;
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 401/.test(m.text())) pageErrors.push(m.text());
  });
});

after(async () => {
  await browser?.close();
  loop?.stop();
  await jack?.close();
  await new Promise((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

test('homepage → create a free account → the hub', async () => {
  await page.goto(`${base}/`);
  assert.equal(await page.title(), 'GraphMind — The debugger for AI agents');
  await page.click('.hero-actions a.btn-solid'); // "Start free" → /signup → /app/#/signup
  await page.waitForSelector('[data-testid=signup-form]');
  assert.equal(new URL(page.url()).pathname, '/app/');
  await page.fill('#auth-email', 'ada@example.com');
  await page.fill('#auth-name', 'Ada');
  await page.fill('#auth-password', 'correct-horse-battery');
  await page.click('[data-testid=auth-submit]');
  await page.waitForSelector('[data-testid=open-circuit]');
  assert.equal(await page.textContent('[data-testid=who] .gm-user-name'), 'Ada');
  assert.equal(await page.textContent('.gm-products .on'), 'Home');
});

test('Circuit, already signed in: start the demo run and watch it pause', async () => {
  await page.click('[data-testid=open-circuit]');
  await page.waitForFunction(() => document.getElementById('conn')?.textContent?.includes('you are ada@example.com'));
  assert.equal(new URL(page.url()).pathname, '/app/circuit/');
  // The same bar as the hub: the switcher marks Circuit, the user menu is the same account.
  assert.equal(await page.textContent('.gm-products .on'), 'Circuit');
  assert.equal(await page.textContent('[data-testid=who] .gm-user-name'), 'Ada');
  await page.getByRole('button', { name: 'New run' }).click();
  await page.selectOption('#nr-wf', 'triage-invoice'); // pre-fills the flaky demo invoice, which pauses
  await page.getByRole('button', { name: 'Start run' }).click();
  await page.getByText('This step failed — fix it and resume').waitFor({ timeout: 10_000 });
  await page.getByText('ERP 503').first().waitFor();
});

test('Jack, same session: import an API and get an MCP URL at the origin root', async () => {
  await page.goto(`${base}/app/jack/`);
  await page.waitForSelector('[data-testid=start]'); // no sign-in asked: the hub's session is good here
  assert.equal(await page.textContent('[data-testid=who] .gm-user-name'), 'Ada');
  assert.equal(await page.textContent('.gm-products .on'), 'Jack');
  await page.goto(`${base}/app/jack/#/new`);
  await page.fill('#spec-text', JSON.stringify({ openapi: '3.0.3', info: { title: 'Ada API', version: '1' }, servers: [{ url: 'https://api.ada.test' }], paths: { '/things': { get: { operationId: 'listThings', summary: 'List the things.', responses: {} } } } }));
  await page.click('#analyze');
  await page.waitForSelector('[data-testid=import-preview]');
  await page.click('#create-project');
  await page.waitForSelector('[data-testid=project-name]');
  const mcpUrl = await page.textContent('.head .meta .mono');
  assert.equal(mcpUrl.trim(), `${base}/p/ada-api/mcp`);
});

test('account settings live in one place: every product\'s menu leads to the hub', async () => {
  // From Jack's user menu...
  await page.click('[data-testid=who]');
  await page.click('[data-testid=menu-account]');
  await page.waitForSelector('[data-testid=account-page]');
  assert.equal(new URL(page.url()).pathname, '/app/');
  assert.equal(new URL(page.url()).hash, '#/account');
  // ...and from Circuit's, and a dashboard's own #/account forwards there too.
  await page.goto(`${base}/app/circuit/`);
  await page.click('[data-testid=who]');
  await page.click('[data-testid=menu-account]');
  await page.waitForSelector('[data-testid=account-page]');
  assert.equal(new URL(page.url()).pathname, '/app/');
  await page.goto(`${base}/app/jack/#/account`);
  await page.waitForURL(`${base}/app/#/account`);
  // It shows both CLIs pointed at this platform.
  const text = await page.textContent('[data-testid=account-page]');
  assert.ok(text.includes(`jack deploy --server ${base}/app/jack --api-key`), text);
  assert.ok(text.includes(`circuit mcp serve --api ${base}/app/circuit --api-key`), text);
});

test('signed out, a dashboard sends you to the hub to sign in, and back', async () => {
  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  other.on('pageerror', (e) => pageErrors.push(String(e)));
  await other.goto(`${base}/app/jack/#/new`);
  await other.waitForSelector('[data-testid=signin-form]');
  assert.equal(new URL(other.url()).pathname, '/app/'); // the hub's sign-in, not a second one
  await other.fill('#auth-email', 'ada@example.com');
  await other.fill('#auth-password', 'correct-horse-battery');
  await other.click('[data-testid=auth-submit]');
  await other.waitForURL(`${base}/app/jack/#/new`); // ...and straight back where they were going
  await other.waitForSelector('#spec-url');
  await fresh.close();
});

test('back on the hub: token, sign out; the homepage still stands', async () => {
  await page.goto(`${base}/app/#/account`);
  await page.waitForSelector('[data-testid=mint-token]');
  await page.click('[data-testid=mint-token]');
  await page.waitForSelector('[data-testid=minted-token]');
  const token = (await page.textContent('[data-testid=minted-token]')).trim();
  const res = await fetch(`${base}/app/circuit/v1/runs`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).runs.length, 1);
  await page.click('[data-testid=sign-out]');
  await page.waitForSelector('[data-testid=signin-form]');
  await page.goto(`${base}/login`);
  await page.waitForSelector('[data-testid=signin-form]');
  assert.deepEqual(pageErrors, []);
});
