/**
 * What the run page looks like out of the box, and how it grows.
 *
 * Every other spec in this suite asks "does this feature work". This one asks
 * the question a new reader actually has: how much is on screen before I have
 * asked for anything, and can I get the rest when I want it. The two have to
 * be tested separately, because a suite that seeds "everything" everywhere
 * would never notice the base regressing back into a wall.
 */
import {
  FIXTURE_NODES,
  expect,
  fitGraph,
  nodeBody,
  nodeCard,
  openDebugMenu,
  openFixtureRun,
  openHeldCall,
  openViewMenu,
  test,
  waitForPlantedPause,
} from './harness.js';

function inspector(page: import('@playwright/test').Page) {
  return page.getByRole('region', { name: 'Call detail' });
}

function customize(page: import('@playwright/test').Page) {
  return page.getByRole('dialog', { name: 'Customize the workspace' });
}

async function openCustomize(page: import('@playwright/test').Page) {
  await (await openViewMenu(page)).getByRole('button', { name: /Essentials|Everything|Custom/ }).click();
  const dialog = customize(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test('out of the box the inspector shows the base and says what else exists', async ({ page }) => {
  await openFixtureRun(page);
  await expect(nodeBody(page, FIXTURE_NODES.flights)).toHaveClass(/gm-node--ok/, {
    timeout: 25_000,
  });
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();

  const panel = inspector(page);
  // The base: what the call received, what it returned, how long it took.
  await expect(panel).toContainText('Input');
  await expect(panel).toContainText('Output');
  await expect(panel.locator('.gm-inspect-stat-label').filter({ hasText: 'duration' })).toBeVisible();

  // Not the base — and none of it is lost, it is listed one click away.
  await expect(panel.locator('.gm-nodehead-id')).toHaveCount(0);
  await expect(panel.locator('.gm-stream')).toHaveCount(0);
  await expect(panel.getByText('5 more panels available — customize')).toBeVisible();

  // The Debug menu keeps its controls but drops the endpoint jargon.
  const menu = await openDebugMenu(page);
  await expect(menu.getByRole('button', { name: 'Break everywhere' })).toBeVisible();
  await expect(menu).not.toContainText('ws · /ws/ui');
  await page.keyboard.press('Escape');
});

test('a held run shows why it is held and how to release it, base or not', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  // The decision is not a panel: it is on the card, in the band, and on the
  // call, under the shipped default, with the evidence beside it.
  const panel = await openHeldCall(page);
  await expect(panel).toContainText('Why this failed');
  await expect(panel).toContainText('RateLimitError');
  await expect(panel).toContainText('The input that produced it');
  await expect(panel.locator('.gm-inspect-held')).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Continue/ })).toBeVisible();

  // …and the error's input is printed once, not twice. It used to lead the
  // panel under the error and then appear again as its own section.
  await expect(panel.locator('.gm-section-label').filter({ hasText: /^Input$/ })).toHaveCount(0);
});

test('the customize dialog switches panels on, and the choice survives a reload', async ({
  page,
}) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);
  await fitGraph(page);
  await nodeCard(page, FIXTURE_NODES.llm).locator('.gm-node-title').click();

  const panel = inspector(page);
  await expect(panel.locator('.gm-stream')).toHaveCount(0);

  const dialog = await openCustomize(page);
  await expect(dialog.getByRole('radio', { name: 'Essentials' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // One switch: the page updates underneath, with no apply and no cancel.
  await dialog.getByRole('switch', { name: /Streamed text/ }).click();
  await expect(panel.locator('.gm-stream').first()).toBeVisible();
  // One toggle off the preset is "custom" — not a third mode to escape from.
  await expect(dialog.getByRole('radio', { name: 'Custom' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(customize(page)).toHaveCount(0);

  // The hash kept the place, so a reload lands back on the same call — and
  // the panel is still switched on.
  await page.reload();
  await expect(inspector(page).locator('.gm-nodehead-name')).toHaveText('llm step', {
    timeout: 25_000,
  });
  await expect(inspector(page).locator('.gm-stream').first()).toBeVisible();
});

test('"Everything" turns the whole page on, and "Essentials" puts it back', async ({ page }) => {
  await openFixtureRun(page);
  await expect(nodeBody(page, FIXTURE_NODES.flights)).toHaveClass(/gm-node--ok/, {
    timeout: 25_000,
  });
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();

  const dialog = await openCustomize(page);
  await dialog.getByRole('radio', { name: 'Everything' }).click();
  await expect(dialog).toContainText('Everything this run reported is on screen.');

  const panel = inspector(page);
  await expect(panel.locator('.gm-nodehead-id')).toContainText(FIXTURE_NODES.flights);
  await expect(panel.getByText(/more panels available/)).toHaveCount(0);

  await dialog.getByRole('radio', { name: 'Essentials' }).click();
  await expect(panel.locator('.gm-nodehead-id')).toHaveCount(0);
});

test('the footer link in the inspector is a way into the dialog', async ({ page }) => {
  await openFixtureRun(page);
  await expect(nodeBody(page, FIXTURE_NODES.flights)).toHaveClass(/gm-node--ok/, {
    timeout: 25_000,
  });
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();

  await inspector(page).getByText(/more panels available/).click();
  await expect(customize(page)).toBeVisible();
});

test('the palette can reach it too, from anywhere', async ({ page }) => {
  await openFixtureRun(page);
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByRole('dialog', { name: 'Command palette' }).getByRole('textbox').fill('>panels');
  await page.getByRole('option').first().press('Enter');
  await expect(customize(page)).toBeVisible();
});
