/**
 * The paused moment as a *decision surface*.
 *
 * `pause-resume.spec.ts` proves the gate really holds and each verb really
 * acts. This file is about the frame around that: when a run stops, is what
 * you need to decide already on screen, and can you act on it without
 * hunting for a button or reaching for the mouse?
 *
 * The specific papercut under test: the inspector is an overlay, so the
 * natural flow — read *why* it failed, then inject a fix — used to end with
 * the inject button underneath the panel explaining the failure.
 */
import {
  FIXTURE_NODES,
  expect,
  nodeCard,
  openFixtureRun,
  runStatusPill,
  test,
  waitForPlantedPause,
} from './harness.js';

function inspector(page: import('@playwright/test').Page) {
  return page.getByRole('complementary', { name: 'Node inspector' });
}

function held(page: import('@playwright/test').Page) {
  return inspector(page).locator('.gm-inspect-held');
}

test('a gate opening brings up the evidence without being asked', async ({ page }) => {
  await openFixtureRun(page);
  await expect(inspector(page)).toBeHidden();

  await waitForPlantedPause(page);

  // The error, the input that produced it, and what ran alongside it.
  const panel = inspector(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator('.gm-inspect-head')).toContainText('currencyConvert');
  await expect(panel.locator('.gm-why-error-name')).toHaveText('RateLimitError');
  await expect(panel.locator('.gm-why-input')).toContainText('EUR');
  await expect(panel.locator('.gm-why-context .gm-why-chip')).not.toHaveCount(0);

  // …and the decision, pinned where it cannot be scrolled away from.
  const actions = held(page);
  await expect(actions).toBeVisible();
  for (const label of ['Continue', 'Step', 'Retry', 'Inject…', 'Abort']) {
    await expect(actions.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
});

test('a selection the user already made is never stolen by a gate', async ({ page }) => {
  await openFixtureRun(page);
  await expect(nodeCard(page, FIXTURE_NODES.flights)).toBeVisible();
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();
  await expect(inspector(page).locator('.gm-inspect-head')).toContainText('searchFlights');

  await waitForPlantedPause(page);

  // Still reading searchFlights; the held node announces itself on the canvas.
  await expect(inspector(page).locator('.gm-inspect-head')).toContainText('searchFlights');
  await expect(runStatusPill(page)).toHaveText('paused');
});

test('inject is reachable from the inspector, where nothing can cover it', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  const actions = held(page);
  const injectButton = actions.getByRole('button', { name: 'Inject…', exact: true });

  // The button the flow ends on is on screen and hittable — this is the
  // regression: it used to be behind the inspector.
  await expect(injectButton).toBeVisible();
  await injectButton.click();

  const editor = actions.locator('.gm-inject textarea');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(/"amount": 1372/);

  await editor.fill('{"rate": 1.09, "converted": "$1,495.48", "source": "inspector"}');
  await actions.getByRole('button', { name: 'Inject & resume' }).click();

  const card = nodeCard(page, FIXTURE_NODES.currency);
  await expect(card.locator('.gm-pill--injected')).toHaveText('injected', { timeout: 20_000 });
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });
});

test('the held gate can be released entirely from the keyboard', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  // The keyboard is already on the decision when the gate opens.
  await expect
    .poll(async () => await page.evaluate(() => document.activeElement?.textContent ?? ''))
    .toContain('Continue');

  // `r` retries the failed call; the recording's retry succeeds.
  await page.keyboard.press('r');
  await expect(nodeCard(page, FIXTURE_NODES.currency).locator('.gm-badge-count')).toHaveText('×2', {
    timeout: 20_000,
  });
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });
});

test('`i` opens the inject editor on the copy that cannot be occluded', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  await page.keyboard.press('i');

  const editor = held(page).locator('.gm-inject textarea');
  await expect(editor).toBeVisible();
  // …focused, so the next keystroke edits the payload rather than releasing
  // the gate.
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(runStatusPill(page)).toHaveText('paused');
});

test('`c` continues, and the shortcuts are inert once nothing is held', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  await page.keyboard.press('c');
  await expect(held(page)).toBeHidden();
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });

  // With no gate open the same keys must not do anything at all — in
  // particular they must not reach a stale pause id.
  const before = await page.locator('.react-flow__node').count();
  await page.keyboard.press('c');
  await page.keyboard.press('r');
  await page.keyboard.press('s');
  await expect(runStatusPill(page)).toHaveText('done');
  expect(await page.locator('.react-flow__node').count()).toBe(before);
});
