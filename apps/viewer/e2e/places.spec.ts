/**
 * One header, one section — and the stack you walk through it.
 *
 *     runs  →  run  →  node
 *
 * Other specs prove each place works. This one is about the *shape*: that
 * only one is on screen at a time, that the breadcrumb and the browser's
 * back button walk the same path, and that stepping back does not lose
 * where you were.
 */
import {
  FIXTURE_NODES,
  callDetail,
  expect,
  nodeBody,
  nodeCard,
  openFixtureRun,
  openViewer,
  runCrumb,
  test,
} from './harness.js';

/** Every region that used to frame the canvas at once. */
const OLD_CHROME = ['.gm-rail', '.gm-runbar', '.gm-inspector', '.gm-workspace-panes'];

test('exactly one place is on screen, inside one header', async ({ page }) => {
  await openFixtureRun(page);

  // The whole frame: a header, and the section under it.
  await expect(page.locator('.gm-header')).toHaveCount(1);
  await expect(page.locator('main.gm-main')).toHaveCount(1);
  for (const gone of OLD_CHROME) {
    await expect(page.locator(gone), `${gone} should be gone`).toHaveCount(0);
  }

  // On the run place: the graph, and no call detail beside it.
  await expect(page.locator('.gm-runpage-graph')).toBeVisible();
  await expect(callDetail(page)).toHaveCount(0);
  await expect(page.locator('.gm-runs')).toHaveCount(0);

  // On the node place: the call, and no graph behind it.
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();
  await expect(callDetail(page)).toBeVisible();
  await expect(page.locator('.gm-runpage-graph')).toHaveCount(0);
});

test('the breadcrumb is the navigation, and it walks back up', async ({ page }) => {
  await openFixtureRun(page);
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();

  // Three steps, the last one where you are.
  const crumbs = page.locator('.gm-crumb');
  await expect(crumbs).toHaveCount(3);
  await expect(crumbs.nth(0)).toHaveText('Runs');
  await expect(crumbs.nth(1)).toHaveText('trip-planner');
  await expect(crumbs.nth(2)).toHaveText('searchFlights');
  await expect(crumbs.nth(2)).toHaveAttribute('aria-current', 'page');

  // The run crumb goes up one…
  await crumbs.nth(1).click();
  await expect(page.locator('.gm-runpage-graph')).toBeVisible();
  await expect(page.locator('.gm-crumb')).toHaveCount(2);

  // …and the Runs crumb goes up to the list.
  await page.locator('.gm-crumb').nth(0).click();
  await expect(page.locator('.gm-runs')).toBeVisible();
  await expect(page.locator('.gm-runcard')).toHaveCount(1);
});

test('the browser back button walks the same stack', async ({ page }) => {
  await openFixtureRun(page);
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();
  await expect(callDetail(page)).toBeVisible();
  expect(page.url()).toContain('/node/');

  await page.goBack();
  await expect(page.locator('.gm-runpage-graph')).toBeVisible({ timeout: 20_000 });
  expect(page.url()).not.toContain('/node/');
});

test('stepping back up keeps the call you were reading picked on the graph', async ({ page }) => {
  await openFixtureRun(page);
  await expect(nodeBody(page, FIXTURE_NODES.hotels)).toHaveClass(/gm-node--ok/, {
    timeout: 25_000,
  });
  await nodeCard(page, FIXTURE_NODES.hotels).locator('.gm-node-title').click();
  await expect(callDetail(page)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(nodeBody(page, FIXTURE_NODES.hotels)).toHaveClass(/gm-node--selected/);

  // One more Escape leaves the run for the list — the step above it.
  await page.keyboard.press('Escape');
  await expect(page.locator('.gm-runs')).toBeVisible();
});

test('a call can be walked without going back to the graph', async ({ page }) => {
  await openFixtureRun(page);
  await expect(nodeBody(page, FIXTURE_NODES.flights)).toHaveClass(/gm-node--ok/, {
    timeout: 25_000,
  });
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();

  const name = callDetail(page).locator('.gm-nodehead-name');
  await expect(name).toHaveText('searchFlights');
  const position = callDetail(page).locator('.gm-nodehead-pos');
  await expect(position).toHaveText(/^\d+ \/ \d+$/);

  // `]` is the next call in execution order, `[` the previous one. The old
  // panel had no such thing: you went back to the graph and hunted.
  const before = (await position.textContent()) ?? '';
  await page.keyboard.press(']');
  await expect(position).not.toHaveText(before);
  await expect(name).not.toHaveText('searchFlights');

  await page.keyboard.press('[');
  await expect(name).toHaveText('searchFlights');
});

test('the runs list is the first place, and a run card opens its graph', async ({ page }) => {
  await openViewer(page, { query: 'fixture=1', hash: '#/runs' });

  const card = page.locator('.gm-runcard').first();
  await expect(card).toBeVisible({ timeout: 25_000 });
  // A card says enough to choose between runs without opening them.
  await expect(card).toContainText('trip-planner');
  await expect(card.locator('.gm-runcard-meta')).toContainText('nodes');

  await card.click();
  await expect(page.locator('.gm-runpage-graph')).toBeVisible();
  await expect(runCrumb(page)).toHaveText('trip-planner');
});

test('a side trip keeps the trail, and comes back to where it was taken', async ({ page }) => {
  await openFixtureRun(page);
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();
  await expect(callDetail(page)).toBeVisible();

  // Go sideways from a call. This used to be a dead end: the trail
  // collapsed to one un-clickable crumb and there was no way back.
  await page.locator('.gm-header-brand').click();
  await page.getByRole('menuitem', { name: 'Connect an agent' }).click();
  await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible();

  await expect(page.locator('.gm-crumb')).toHaveText([
    'Runs',
    'trip-planner',
    'searchFlights',
    'Connect an agent',
  ]);

  // Escape comes back to the call, not to the top.
  await page.keyboard.press('Escape');
  await expect(callDetail(page).locator('.gm-nodehead-name')).toHaveText('searchFlights');

  // …and so does the browser's back button: a side trip pushes an entry.
  await page.locator('.gm-header-brand').click();
  await page.getByRole('menuitem', { name: 'Connect an agent' }).click();
  await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
  await page.goBack();
  await expect(callDetail(page).locator('.gm-nodehead-name')).toHaveText('searchFlights', {
    timeout: 20_000,
  });
});

test('a crumb from a side trip jumps straight to that level', async ({ page }) => {
  await openFixtureRun(page);
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();
  await page.locator('.gm-header-brand').click();
  await page.getByRole('menuitem', { name: 'Build a workflow' }).click();
  await expect(page.locator('.gm-builder-bar h1')).toHaveText('New workflow');

  await page.locator('.gm-crumb').nth(1).click();
  await expect(page.locator('.gm-runpage-graph')).toBeVisible();
});

test('every place is reachable from every other place', async ({ page }) => {
  await openFixtureRun(page);

  for (const [item, marker] of [
    ['Connect an agent', '.gm-connect'],
    ['Build a workflow', '.gm-builder'],
    ['Runs', '.gm-runs'],
  ] as const) {
    await page.locator('.gm-header-brand').click();
    await page.getByRole('menuitem', { name: item }).click();
    await expect(page.locator(marker), `${item} should be one click away`).toBeVisible();
  }
});
