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

/**
 * The resume buttons must stay inside the card that owns them.
 *
 * They did not. `.gm-action` used `flex: 1`, which looks like it shrinks its
 * items — but a flex item's default `min-width: auto` floors it at min-content,
 * and `white-space: nowrap` makes min-content the whole label. So five buttons
 * needing ~341px sat in a 240px card and simply overflowed it: `Abort`
 * rendered ~100px outside its own border, over whatever was behind it.
 *
 * Asserted geometrically rather than by screenshot, because the failure is a
 * measurement ("is it outside the box") and a pixel diff would go red for
 * every unrelated restyle.
 */
test('every resume button stays inside the card, on both variants', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  const card = nodeCard(page, FIXTURE_NODES.currency);
  await expect(card.locator('.gm-action--danger')).toBeVisible();

  /*
   * Every rectangle is read in ONE evaluate, and only once the canvas has
   * stopped moving.
   *
   * Opening a gate re-frames the camera, so the card is under a running
   * transform for a few hundred milliseconds. Taking the card's box and each
   * button's box as separate round trips samples them at different moments of
   * that animation, and the test then reports a 20px "overflow" that is
   * really just the canvas having moved between two measurements. The bug
   * being guarded here is ~100px and geometric, so measuring atomically costs
   * nothing and removes the only way this test can lie.
   */
  const cameraTransform = async (): Promise<string> =>
    page.evaluate(() => {
      const el = document.querySelector('.react-flow__viewport');
      return el === null ? '' : getComputedStyle(el).transform;
    });
  let previous = await cameraTransform();
  await expect
    .poll(
      async () => {
        const now = await cameraTransform();
        const settled = now === previous;
        previous = now;
        return settled;
      },
      { message: 'the camera should settle before measuring', timeout: 15_000, intervals: [200] },
    )
    .toBe(true);

  const measured = await card.evaluate((cardEl) => {
    const box = cardEl.getBoundingClientRect();
    const buttons = [...cardEl.querySelectorAll('.gm-actions .gm-action')].map((b) => {
      const r = b.getBoundingClientRect();
      return {
        name: (b.textContent ?? '').trim(),
        left: r.left,
        right: r.right,
        width: r.width,
        danger: b.classList.contains('gm-action--danger'),
        primary: b.classList.contains('gm-action--primary'),
      };
    });
    return { left: box.left, right: box.right, buttons };
  });

  expect(measured.buttons.length, 'continue/step/retry/inject/abort').toBe(5);
  for (const b of measured.buttons) {
    // A sub-pixel bleed is layout rounding; 100px is the bug.
    expect(b.left, `${b.name} starts left of the card`).toBeGreaterThanOrEqual(measured.left - 1);
    expect(b.right, `${b.name} overflows the card`).toBeLessThanOrEqual(measured.right + 1);
  }

  // Abort must never become the widest thing on its line: a destructive verb
  // should not be the easiest target to hit.
  const abort = measured.buttons.find((b) => b.danger);
  const primary = measured.buttons.find((b) => b.primary);
  expect(abort?.width ?? 0).toBeLessThan(primary?.width ?? 0);
});
