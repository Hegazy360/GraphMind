/**
 * Cold loads: a pasted deep link, and a run exported to a single HTML file.
 *
 * Both are "someone else's browser, no server, no warm state" — the two ways
 * a stranger first meets GraphMind.
 */
import { readFileSync } from 'node:fs';
import {
  FIXTURE_NODES,
  FIXTURE_RUN_ID,
  expect,
  nodeBody,
  nodeCard,
  openViewer,
  runStatusPill,
  test,
} from './harness.js';

/** The same envelopes `graphmind record --html` would inline into the page. */
const EXPORTED_RUN: unknown[] = JSON.parse(
  readFileSync(new URL('../src/fixtures/demo-run.json', import.meta.url), 'utf8'),
) as unknown[];

test('a node deep link restores the selection on a cold load', async ({ page }) => {
  await openViewer(page, {
    query: 'fixture=1',
    hash: `#/run/${FIXTURE_RUN_ID}/node/${encodeURIComponent(FIXTURE_NODES.hotels)}`,
  });

  // The run has not even arrived yet when the hash is parsed; the selection
  // has to survive the wait and then land on the right card.
  const inspector = page.getByRole('complementary', { name: 'Node inspector' });
  await expect(inspector).toBeVisible({ timeout: 25_000 });
  await expect(inspector.locator('.gm-inspect-head')).toContainText('searchHotels');
  await expect(nodeBody(page, FIXTURE_NODES.hotels)).toHaveClass(/gm-node--selected/);
  expect(page.url()).toContain(`#/run/${FIXTURE_RUN_ID}/node/tool%3AsearchHotels`);
});

test('a run deep link selects the run without selecting a node', async ({ page }) => {
  await openViewer(page, { query: 'fixture=1', hash: `#/run/${FIXTURE_RUN_ID}` });

  await expect(page.locator('.gm-topbar-title h1')).toHaveText('trip-planner');
  await expect(page.getByRole('complementary', { name: 'Node inspector' })).toBeHidden();
});

test('a hash written by the app is a link that works when pasted back', async ({ page }) => {
  await openViewer(page, { query: 'fixture=1' });
  await expect(nodeBody(page, FIXTURE_NODES.flights)).toHaveClass(/gm-node--ok/, {
    timeout: 25_000,
  });
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();

  const link = page.url();
  expect(link).toContain('#/run/');

  // A brand new page load of exactly that URL lands in the same place.
  const second = await page.context().newPage();
  await second.goto(link);
  const inspector = second.getByRole('complementary', { name: 'Node inspector' });
  await expect(inspector).toBeVisible({ timeout: 25_000 });
  await expect(inspector.locator('.gm-inspect-head')).toContainText('searchFlights');
  await second.close();
});

test('an exported run (window.__GRAPHMIND_RUN__) renders offline, instantly', async ({ page }) => {
  await openViewer(page, { embeddedRun: EXPORTED_RUN });

  // No pacing, no server: the whole recording is on screen immediately.
  await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 10_000 });
  await expect(page.locator('.gm-topbar-title h1')).toHaveText('trip-planner');
  await expect(runStatusPill(page)).toHaveText('done');

  // Every payload travelled with the file.
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();
  const inspector = page.getByRole('complementary', { name: 'Node inspector' });
  await expect(inspector).toContainText('VIE');
  await expect(inspector).toContainText('options');

  // …including the failure and its retry.
  await expect(nodeCard(page, FIXTURE_NODES.currency).locator('.gm-badge-count')).toHaveText('×2');

  // It is honest about not being attached to anything.
  await expect(page.locator('.gm-conn-label')).toHaveText('replaying');
});

test('an exported run reports its gate as history, not as a live hold', async ({ page }) => {
  await openViewer(page, { embeddedRun: EXPORTED_RUN });
  await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 10_000 });

  const banner = nodeCard(page, FIXTURE_NODES.currency).locator('.gm-pause-banner');
  await expect(banner).toBeVisible();

  // Past tense, and the error that caused it is still on the card.
  await expect(banner.locator('.gm-pause-label')).toHaveText(/Was held on error/);
  await expect(banner.locator('.gm-pause-error')).toContainText('RateLimitError');
  await expect(banner.locator('.gm-pause-note')).toContainText('cannot be resumed');

  // No dead buttons: nothing here can reach a running process, so nothing
  // here pretends it can.
  await expect(banner.locator('.gm-action')).toHaveCount(0);
  for (const label of ['Continue', 'Step', 'Retry', 'Inject…', 'Abort']) {
    await expect(banner.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
});
