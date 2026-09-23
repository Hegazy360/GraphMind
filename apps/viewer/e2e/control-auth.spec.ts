/**
 * The viewer half of the 0.6 control plane, in a real browser:
 *
 *  - the control token arrives in the URL fragment (`#token=…`, opened by
 *    `graphmind serve` through a private redirect file) and must leave the
 *    address bar at once — before a screenshot, a bookmark or a copied link
 *    can carry it — while a deep link that follows it survives;
 *  - the audit line: a pause a coding agent released says "resumed by agent",
 *    from the principal the server stamped on `exec.resumed`.
 */
import { readFileSync } from 'node:fs';
import { FIXTURE_NODES, FIXTURE_RUN_ID, expect, openViewer, test } from './harness.js';

const TOKEN = `gmv_${'0123456789abcdef'.repeat(2)}`;

const DEMO_RUN: { seq: number; type: string; payload: Record<string, unknown> }[] = JSON.parse(
  readFileSync(new URL('../src/fixtures/demo-run.json', import.meta.url), 'utf8'),
) as { seq: number; type: string; payload: Record<string, unknown> }[];

test('the #token= fragment is removed from the address bar and kept for this origin', async ({ page }) => {
  await openViewer(page, { query: 'fixture=1', hash: `#token=${TOKEN}` });
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  expect(page.url()).not.toContain('token');
  expect(page.url()).not.toContain(TOKEN);
  const stored = await page.evaluate(() => localStorage.getItem('graphmind.viewerToken'));
  expect(stored).toBe(TOKEN);
  // Nothing in the history entry either: going "back" does not restore it.
  const historyHasToken = await page.evaluate((t) => location.href.includes(t), TOKEN);
  expect(historyHasToken).toBe(false);
});

test('a deep link after the token survives; a malformed token is dropped, not stored', async ({ page }) => {
  await openViewer(page, { query: 'fixture=1', hash: `#token=${TOKEN}&/run/${FIXTURE_RUN_ID}` });
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  expect(page.url()).toContain(`#/run/${FIXTURE_RUN_ID}`);
  expect(page.url()).not.toContain('token');

  await page.evaluate(() => localStorage.removeItem('graphmind.viewerToken'));
  await openViewer(page, { query: 'fixture=1', hash: '#token=%3Cscript%3E' });
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  expect(page.url()).not.toContain('token');
  expect(await page.evaluate(() => localStorage.getItem('graphmind.viewerToken'))).toBeNull();
});

test('a pause released by a coding agent says so in the inspector', async ({ page }) => {
  const paused = DEMO_RUN.find((e) => e.type === 'exec.paused');
  if (paused === undefined) throw new Error('fixture has no pause');
  const last = DEMO_RUN.reduce((max, e) => Math.max(max, e.seq), 0);
  const run = [
    ...DEMO_RUN,
    {
      gm: 1,
      seq: last + 1,
      ts: Date.now(),
      runId: FIXTURE_RUN_ID,
      type: 'exec.resumed',
      payload: { pauseId: paused.payload['pauseId'], action: 'retry', principal: 'agent', operator: 'claude code' },
    },
  ];
  await openViewer(page, {
    embeddedRun: run,
    hash: `#/run/${FIXTURE_RUN_ID}/node/${encodeURIComponent(FIXTURE_NODES.currency)}`,
  });
  const inspector = page.getByRole('complementary', { name: 'Node inspector' });
  await expect(inspector).toBeVisible();
  const line = inspector.getByTestId('resumed-by');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText('error → retry');
  await expect(line).toContainText('resumed by agent');
  await expect(line).toContainText('(claude code)');
});
