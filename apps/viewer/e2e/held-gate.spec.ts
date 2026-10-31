/**
 * The paused moment as a *decision surface*.
 *
 * `pause-resume.spec.ts` proves the gate really holds and each verb really
 * acts. This file is about the frame around that: when a run stops, does the
 * viewer say so wherever you are standing, can you act without hunting for a
 * button or reaching for the mouse, and does drilling in put the evidence
 * and the decision on the same screen?
 *
 * The rule it exists to defend: a hold is the one piece of state that cannot
 * wait for you to navigate to it — but it is also not allowed to move you.
 * Stopping is when you most want to see *where* in the shape it stopped.
 */
import {
  FIXTURE_NODES,
  callDetail,
  expect,
  holdStrip,
  nodeCard,
  openFixtureRun,
  openHeldCall,
  pauseBanner,
  runStatusPill,
  settleAnimations,
  test,
  waitForPlantedPause,
} from './harness.js';

/** The decision row on the node place. */
function held(page: import('@playwright/test').Page) {
  return callDetail(page).locator('.gm-inspect-held');
}

test('a gate announces itself from the graph, without taking the graph away', async ({ page }) => {
  await openFixtureRun(page);
  await expect(holdStrip(page)).toHaveCount(0);

  await waitForPlantedPause(page);

  // The band says which call and why, from the run place.
  const strip = holdStrip(page);
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('currencyConvert');
  await expect(strip).toContainText('RateLimitError');

  // …and the graph is still the graph. Seeing where it stopped is the point.
  await expect(nodeCard(page, FIXTURE_NODES.agent)).toBeVisible();
  await expect(pauseBanner(page, FIXTURE_NODES.currency)).toBeVisible();
  await expect(callDetail(page)).toHaveCount(0);
});

test('one click opens the held call, with the evidence and the decision together', async ({
  page,
}) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  const detail = await openHeldCall(page);
  await expect(detail.locator('.gm-nodehead-name')).toHaveText('currencyConvert');
  await expect(detail.locator('.gm-why-error-name')).toHaveText('RateLimitError');
  await expect(detail.locator('.gm-why-input')).toContainText('EUR');
  await expect(detail.locator('.gm-why-context .gm-why-chip')).not.toHaveCount(0);

  // The decision is above the evidence, where a scroll cannot lose it.
  const actions = held(page);
  await expect(actions).toBeVisible();
  for (const label of ['Continue', 'Step', 'Retry', 'Inject…', 'Abort']) {
    await expect(actions.getByRole('button', { name: label, exact: true })).toBeVisible();
  }

  // Already looking at it: the band stands down rather than offering a
  // second Continue on the same screen.
  await expect(holdStrip(page)).toHaveCount(0);
});

test('reading another call when a gate opens does not move you', async ({ page }) => {
  await openFixtureRun(page);
  await expect(nodeCard(page, FIXTURE_NODES.flights)).toBeVisible();
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();
  await expect(callDetail(page).locator('.gm-nodehead-name')).toHaveText('searchFlights');

  // The canvas is not on screen to watch, so the band is the only signal —
  // which is exactly the claim: you find out without being moved.
  await expect(holdStrip(page)).toContainText('currencyConvert', { timeout: 45_000 });
  await expect(callDetail(page).locator('.gm-nodehead-name')).toHaveText('searchFlights');
});

test('inject is reachable beside the evidence it replaces', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);
  await openHeldCall(page);

  const actions = held(page);
  const injectButton = actions.getByRole('button', { name: 'Inject…', exact: true });
  await expect(injectButton).toBeVisible();
  await injectButton.click();

  const editor = actions.locator('.gm-inject textarea');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(/"amount": 1372/);

  await editor.fill('{"rate": 1.09, "converted": "$1,495.48", "source": "inspector"}');
  await actions.getByRole('button', { name: 'Inject & resume' }).click();

  await expect(runStatusPill(page)).toHaveCount(0); // we are on the node place
  await page.keyboard.press('Escape');
  const card = nodeCard(page, FIXTURE_NODES.currency);
  await expect(card.locator('.gm-pill--injected')).toHaveText('injected', { timeout: 20_000 });
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });
});

test('the held gate can be released from the keyboard without leaving the graph', async ({
  page,
}) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  // `r` retries the failed call from the run place; the recording's retry
  // succeeds. No navigation, no mouse.
  await page.keyboard.press('r');
  await expect(nodeCard(page, FIXTURE_NODES.currency).locator('.gm-badge-count')).toHaveText('×2', {
    timeout: 20_000,
  });
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });
});

test('`i` takes you to the call, because injecting needs the payload', async ({ page }) => {
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
});

test('`c` continues, and the shortcuts are inert once nothing is held', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  await page.keyboard.press('c');
  await expect(holdStrip(page)).toHaveCount(0);
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });

  // Nothing is held: the verbs do not fire into the void.
  await page.keyboard.press('r');
  await page.keyboard.press('c');
  await expect(runStatusPill(page)).toHaveText('done');
});

test('every resume button stays inside the card', async ({ page }) => {
  await openFixtureRun(page);
  const banner = await waitForPlantedPause(page);
  const card = nodeCard(page, FIXTURE_NODES.currency);
  // The card grows for its action row and the camera re-frames to keep it on
  // screen; measuring mid-flight measures a card that is still arriving.
  await settleAnimations(page);
  await page.waitForTimeout(400);

  const cardBox = await card.boundingBox();
  expect(cardBox).not.toBeNull();
  for (const label of ['Continue', 'Step', 'Retry', 'Abort']) {
    const box = await banner.getByRole('button', { name: label, exact: true }).boundingBox();
    expect(box, label).not.toBeNull();
    if (box === null || cardBox === null) continue;
    expect(box.x, `${label} starts inside the card`).toBeGreaterThanOrEqual(cardBox.x - 1);
    expect(box.x + box.width, `${label} ends inside the card`).toBeLessThanOrEqual(
      cardBox.x + cardBox.width + 1,
    );
  }
});
