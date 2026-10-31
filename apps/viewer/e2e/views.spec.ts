/**
 * The lenses: folding subtrees, the waterfall, filters and the theme toggle.
 * All of it is chrome no unit test can see.
 */
import {
  FIXTURE_NODES,
  expect,
  fitGraph,
  nodeBody,
  nodeCard,
  openDebugMenu,
  openFixtureRun,
  openViewMenu,
  test,
  waitForPlantedPause,
} from './harness.js';

test('collapse folds the run into one summary card, expand puts it back', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  const cards = page.locator('.react-flow__node');
  await expect(cards).toHaveCount(7);

  (await openViewMenu(page)).getByRole('button', { name: 'Collapse' }).click();

  // Everything under the agent folds into it.
  await expect(cards).toHaveCount(1);
  const group = nodeCard(page, FIXTURE_NODES.agent);
  await expect(group.locator('.gm-node--group')).toBeVisible();
  await expect(group).toContainText('nodes');
  await expect(group).toContainText('calls');
  // The toolbar counts the fold on the View button, and the menu offers the
  // inverse — "you are not seeing everything" stays visible in the bar.
  await expect(page.getByRole('button', { name: 'View 1' })).toBeVisible();
  await (await openViewMenu(page)).getByRole('button', { name: 'Expand 1 folded' }).click();
  await expect(cards).toHaveCount(7);
  await expect(nodeCard(page, FIXTURE_NODES.currency)).toBeVisible();
});

test('a single node folds and unfolds from its own chevron', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);
  await fitGraph(page);

  const fold = nodeCard(page, FIXTURE_NODES.llm).getByRole('button', { name: /^Collapse / });
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await fold.click();

  // The step's five tools disappear into it; the agent above stays.
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(nodeCard(page, FIXTURE_NODES.agent)).toBeVisible();
  await expect(nodeCard(page, FIXTURE_NODES.currency)).toHaveCount(0);

  const unfold = nodeCard(page, FIXTURE_NODES.llm).getByRole('button', { name: /^Expand / });
  await unfold.click();
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
});

test('⇧T opens the waterfall next to the graph, and the view segments switch panes', async ({
  page,
}) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  const timeline = page.locator('.gm-timeline');
  const graph = page.locator('.gm-runpage-graph');
  await expect(timeline).toBeHidden();

  await page.keyboard.press('Shift+T');
  await expect(timeline).toBeVisible();
  await expect(graph).toBeVisible();

  // It is a real waterfall: a row per logical node, bars with durations, and
  // a marker where the gate held.
  await expect(timeline.locator('.gm-timeline-row')).not.toHaveCount(0);
  await expect(timeline.locator('.gm-timeline-label').filter({ hasText: 'currencyConvert' })).toBeVisible();
  await expect(timeline.locator('.gm-bar').first()).toBeVisible();
  // The held call is still open, so it draws as a running bar with a pause
  // marker on the ruler rather than a finished error bar.
  await expect(timeline.locator('.gm-bar--running')).not.toHaveCount(0);
  await expect(timeline.locator('.gm-timeline-marker--pause')).not.toHaveCount(0);

  // Zoom controls change the track width.
  const zoomLabel = timeline.locator('.gm-timeline-zoom');
  await expect(zoomLabel).toHaveText('1.0×');
  await timeline.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoomLabel).toHaveText('1.6×');
  await timeline.getByRole('button', { name: 'Fit the whole run' }).click();
  await expect(zoomLabel).toHaveText('1.0×');

  // Timeline-only hides the graph; graph-only hides the timeline.
  await (await openViewMenu(page)).getByRole('radio', { name: 'Timeline' }).click();
  await expect(graph).toBeHidden();
  await expect(timeline).toBeVisible();

  await (await openViewMenu(page)).getByRole('radio', { name: 'Graph' }).click();
  await expect(graph).toBeVisible();
  await expect(timeline).toBeHidden();
});

test('clicking a timeline row opens that call', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);
  await page.keyboard.press('Shift+T');

  const row = page
    .locator('.gm-timeline-row')
    .filter({ has: page.locator('.gm-timeline-name', { hasText: 'searchHotels' }) })
    .first();
  await row.locator('.gm-timeline-label').click();

  await expect(
    page.getByRole('region', { name: 'Call detail' }).locator('.gm-nodehead-name'),
  ).toHaveText('searchHotels');
  await page.keyboard.press('Escape');
  await expect(nodeBody(page, FIXTURE_NODES.hotels)).toHaveClass(/gm-node--selected/);
});

test('the kind filter dims what it excludes instead of hiding it', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  const popover = page.getByRole('dialog', { name: 'Canvas filters' });
  await expect(popover).toBeVisible();
  await popover.getByRole('button', { name: 'tool', exact: true }).click();

  // Tools stay lit, everything else dims — and nothing disappears.
  await expect(nodeCard(page, FIXTURE_NODES.currency)).not.toHaveClass(/gm-dim/);
  await expect(nodeCard(page, FIXTURE_NODES.agent)).toHaveClass(/gm-dim/);
  await expect(page.locator('.react-flow__node')).toHaveCount(7);

  await popover.getByRole('button', { name: 'Clear filters' }).click();
  await expect(nodeCard(page, FIXTURE_NODES.agent)).not.toHaveClass(/gm-dim/);
});

test('the theme is picked outright in the View menu and survives a reload', async ({ page }) => {
  await openFixtureRun(page, { theme: 'system', colorScheme: 'dark' });

  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-theme', /.*/);

  // Three radios rather than a cycler: "light" is one click from anywhere,
  // not two-and-hope.
  const themes = (await openViewMenu(page)).getByRole('radiogroup', { name: 'Theme' });
  await expect(themes.getByRole('radio', { name: 'System' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await themes.getByRole('radio', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await themes.getByRole('radio', { name: 'Light' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');

  // The choice is remembered.
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test('the breakpoint dot on a tool card registers a breakpoint chip', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);
  await fitGraph(page);

  await nodeCard(page, FIXTURE_NODES.hotels)
    .getByRole('button', { name: 'Set breakpoint on searchHotels' })
    .click();

  // The header counts it without being opened; the menu names it.
  await expect(page.getByRole('button', { name: /^(Debug|Step) 1$/ })).toBeVisible();
  const menu = await openDebugMenu(page);
  const chip = menu.locator('.gm-chip--bp', { hasText: 'searchHotels' });
  await expect(chip).toBeVisible();

  await chip.getByRole('button', { name: /Clear breakpoint/ }).click();
  await expect(menu.locator('.gm-chip--bp')).toHaveCount(0);
});
