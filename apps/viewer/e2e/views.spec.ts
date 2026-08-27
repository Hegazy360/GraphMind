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
  openFixtureRun,
  test,
  waitForPlantedPause,
} from './harness.js';

test('collapse folds the run into one summary card, expand puts it back', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  const cards = page.locator('.react-flow__node');
  await expect(cards).toHaveCount(7);

  await page.getByRole('button', { name: 'Collapse', exact: true }).click();

  // Everything under the agent folds into it.
  await expect(cards).toHaveCount(1);
  const group = nodeCard(page, FIXTURE_NODES.agent);
  await expect(group.locator('.gm-node--group')).toBeVisible();
  await expect(group).toContainText('nodes');
  await expect(group).toContainText('calls');
  // The toolbar reports the fold and offers the inverse.
  const expand = page.getByRole('button', { name: '1 folded' });
  await expect(expand).toBeVisible();
  await expand.click();
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
  const graph = page.locator('.gm-workspace-graph');
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
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(graph).toBeHidden();
  await expect(timeline).toBeVisible();

  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await expect(graph).toBeVisible();
  await expect(timeline).toBeHidden();
});

test('clicking a timeline row selects the node on the canvas', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);
  await page.keyboard.press('Shift+T');

  const row = page
    .locator('.gm-timeline-row')
    .filter({ has: page.locator('.gm-timeline-name', { hasText: 'searchHotels' }) })
    .first();
  await row.locator('.gm-timeline-label').click();

  await expect(page.getByRole('complementary', { name: 'Node inspector' })).toContainText(
    'searchHotels',
  );
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

test('the theme toggle cycles system → dark → light and survives a reload', async ({ page }) => {
  await openFixtureRun(page, { theme: 'system', colorScheme: 'dark' });

  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-theme', /.*/);

  const toggle = page.getByRole('button', { name: 'System theme' });
  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Dark theme' }).click();
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

  const chip = page.locator('.gm-chip--bp', { hasText: 'searchHotels' });
  await expect(chip).toBeVisible();

  await chip.getByRole('button', { name: /Clear breakpoint/ }).click();
  await expect(page.locator('.gm-chip--bp')).toHaveCount(0);
});
