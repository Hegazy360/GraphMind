// Browser test of the Jack dashboard: the whole setup story by clicks, as a
// person would do it — from pasting a spec to a revoked user.
// Run: pnpm --filter jack-api test:e2e   (screenshots to $JACK_SHOTS if set)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createJack, SqliteStore } from '../dist/index.js';
import { createTasksApp } from '../../../examples/jack-tasks/dist/app.js';

const spec = readFileSync(new URL('../../../examples/jack-tasks/openapi.json', import.meta.url), 'utf8');
const shots = process.env.JACK_SHOTS;
const dir = mkdtempSync(join(tmpdir(), 'jack-e2e-'));
let acmeServer, jackServer, jack, browser, page, base, acmeUrl;
const pageErrors = [];

/** Listen on a free port, then build the app with its real origin (issuers must match exactly). */
async function listen(make) {
  let handler;
  const server = await new Promise((resolve) => {
    const s = serve({ fetch: (r) => handler(r), port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = await make(origin);
  return { server, origin };
}

const shot = async (name) => shots && page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
const tab = async (id) => {
  await page.click(`[data-tab=${id}]`);
  await page.waitForTimeout(250);
};

before(async () => {
  const acme = await listen(async (origin) => (await createTasksApp({ origin })).app.fetch);
  acmeServer = acme.server;
  acmeUrl = acme.origin;
  const j = await listen(async (origin) => {
    jack = createJack({ store: new SqliteStore(':memory:'), publicOrigin: origin, dataDir: dir, secretKey: randomBytes(32), egress: 'any' });
    return jack.app.fetch;
  });
  jackServer = j.server;
  base = j.origin;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});

after(async () => {
  await browser?.close();
  await jack?.close();
  jackServer?.close();
  acmeServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('import a spec by pasting it, and create the project', async () => {
  await page.goto(`${base}/`);
  await page.click('[data-testid=start]');
  await page.fill('#spec-text', spec);
  await page.fill('#spec-upstream', acmeUrl);
  await page.click('#analyze');
  await page.waitForSelector('[data-testid=import-preview]');
  const preview = await page.textContent('[data-testid=import-preview]');
  assert.match(preview, /13 operations/);
  assert.match(preview, /6 read tools will start enabled; 6 operations that change data start disabled/);
  await shot('01-import');
  await page.fill('#project-slug', 'acme');
  await page.click('#create-project');
  await page.waitForSelector('[data-testid=tool-count]');
  assert.equal(await page.textContent('[data-testid=tool-count]'), '6 of 13 tools enabled');
  assert.match(await page.textContent('[data-testid=draft-banner]'), /not deployed yet/);
});

test('curate tools: enable writes, rewrite a description, require approval for deletes', async () => {
  await page.click('[data-testid=toggle-create_task] + span');
  await page.waitForFunction(() => document.querySelector('[data-testid=tool-count]')?.textContent === '7 of 13 tools enabled');
  await page.click('[data-testid=edit-delete_task]');
  await page.fill('[data-testid=edit-description]', 'Permanently delete one task by id (tsk_…). The user is asked to approve first.');
  await page.check('[data-testid=edit-confirm]');
  await page.click('[data-testid=save-tool]');
  await page.click('[data-testid=toggle-delete_task] + span');
  await page.waitForFunction(() => document.querySelector('[data-testid=tool-count]')?.textContent === '8 of 13 tools enabled');
  const row = await page.textContent('tr[data-tool=delete_task]');
  assert.match(row, /Permanently delete one task by id/);
  assert.match(row, /approval/);
  await shot('02-tools');
});

test('choose sign-in: users paste their own API key, checked with get_me', async () => {
  await tab('signin');
  await page.check('[data-testid=mode-apikey]');
  await page.selectOption('select', 'get_me');
  await page.click('[data-testid=save-signin]');
  await page.waitForSelector('[data-testid=draft-banner]');
  await shot('03-signin');
});

test('deploy: the diff, then live v1 with a copyable MCP URL', async () => {
  await tab('deploy');
  await page.fill('[data-testid=deploy-message]', 'first version');
  await page.click('[data-testid=deploy]');
  await page.waitForSelector('[data-testid=live-version]');
  assert.equal(await page.textContent('[data-testid=live-version]'), 'live v1');
  assert.equal(await page.textContent('[data-testid=mcp-url]'), `${base}/p/acme/mcp`);
  assert.match(await page.textContent('[data-testid=history]'), /v1\s*live[\s\S]*first version[\s\S]*\+8 added/);
  await shot('04-deploy');
});

test('test sign-in through the real pages, then try tools as that user', async () => {
  await tab('try');
  await page.click('[data-testid=test-signin]');
  await page.waitForSelector('#jack-apikey'); // Jack's own key page, served at /p/acme/oauth/apikey
  assert.ok(page.url().startsWith(`${base}/p/acme/oauth/apikey`));
  await page.fill('#api_key', 'tk_demo_alice');
  await page.click('#jack-apikey button[type=submit]');
  await page.waitForSelector('#jack-consent');
  assert.match(await page.textContent('body'), /Signed in as Alice Martin/);
  await shot('05-consent');
  await page.click('#jack-consent button[value=approve]');
  await page.waitForSelector('[data-testid=signed-in-as]');
  assert.equal(await page.textContent('[data-testid=signed-in-as]'), 'Signed in for testing as Alice Martin');

  await page.selectOption('[data-testid=try-tool]', 'create_task');
  await page.fill('[data-testid=try-args]', JSON.stringify({ projectId: 'prj_0001', title: 'Made from the dashboard' }));
  await page.click('[data-testid=try-run]');
  await page.waitForSelector('[data-testid=try-result]');
  assert.equal(await page.textContent('[data-testid=try-status]'), 'ok');
  assert.match(await page.textContent('[data-testid=try-result]'), /Made from the dashboard/);

  // A tool that needs approval: declined first (nothing happens), then approved.
  await page.selectOption('[data-testid=try-tool]', 'delete_task');
  await page.fill('[data-testid=try-args]', JSON.stringify({ taskId: 'tsk_0007' }));
  await page.click('[data-testid=try-run]');
  await page.waitForFunction(() => /did not approve/.test(document.querySelector('[data-testid=try-result]')?.textContent ?? ''));
  await page.check('[data-testid=try-approve]');
  await page.click('[data-testid=try-run]');
  await page.waitForFunction(() => /HTTP 204/.test(document.querySelector('[data-testid=try-result]')?.textContent ?? ''));
  await shot('06-try');
});

test('activity shows every call, users shows Alice, and disconnecting her works', async () => {
  await tab('activity');
  await page.waitForSelector('[data-testid=calls]');
  const calls = await page.textContent('[data-testid=calls]');
  assert.match(calls, /delete_task[\s\S]*ok[\s\S]*delete_task[\s\S]*declined[\s\S]*create_task/);
  assert.match(calls, /user:usr_alice/);
  await shot('07-activity');

  await tab('users');
  await page.waitForSelector('[data-testid=grants]');
  assert.match(await page.textContent('[data-testid=grants]'), /Alice Martin[\s\S]*registered app \(unverified\)/);
  await page.click('[data-testid=grants] button.danger');
  await page.waitForFunction(() => /disconnected/.test(document.querySelector('[data-testid=grants]')?.textContent ?? ''));
  await shot('08-users');

  await tab('try');
  assert.equal(await page.$('[data-testid=signed-in-as]'), null, 'the revoked test session is gone');
});

test('deploy again, roll back, export jack.yaml, delete', async () => {
  await tab('tools');
  await page.click('[data-testid=toggle-add_comment] + span');
  await page.waitForFunction(() => document.querySelector('[data-testid=tool-count]')?.textContent === '9 of 13 tools enabled');
  await tab('deploy');
  await page.click('[data-testid=deploy]');
  await page.waitForFunction(() => document.querySelector('[data-testid=live-version]')?.textContent === 'live v2');
  await page.click('[data-testid=rollback-1]');
  await page.waitForFunction(() => document.querySelector('[data-testid=live-version]')?.textContent === 'live v1');
  assert.match(await page.textContent('[data-testid=draft-banner]'), /1 undeployed change/);

  await tab('settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=export]')]);
  const yaml = readFileSync(await download.path(), 'utf8');
  assert.match(yaml, /mode: apikey/);
  assert.match(yaml, /Permanently delete one task by id/);

  await page.fill('[data-testid=delete-confirm]', 'acme');
  await page.click('[data-testid=delete]');
  await page.waitForSelector('[data-testid=start]');
  const gone = await fetch(`${base}/p/acme/mcp`, { method: 'POST' });
  assert.equal(gone.status, 404);
});

test('no page errors and no CSP violations along the way', () => {
  assert.deepEqual(pageErrors, []);
});
