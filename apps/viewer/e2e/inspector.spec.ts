/**
 * The inspector: what you actually read when a run breaks at 3am.
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

function inspector(page: import('@playwright/test').Page) {
  return page.getByRole('complementary', { name: 'Node inspector' });
}

test('clicking a node opens the inspector with its input and output', async ({ page }) => {
  await openFixtureRun(page);
  await expect(inspector(page)).toBeHidden();

  await expect(nodeBody(page, FIXTURE_NODES.flights)).toHaveClass(/gm-node--ok/, {
    timeout: 25_000,
  });
  await nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node-title').click();

  const panel = inspector(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator('.gm-inspect-head')).toContainText('searchFlights');
  await expect(panel.locator('.gm-kind-badge')).toHaveText('tool');
  await expect(panel.locator('.gm-inspect-id')).toContainText(FIXTURE_NODES.flights);

  // The payloads, both directions.
  await expect(panel).toContainText('Input');
  await expect(panel).toContainText('depart');
  await expect(panel).toContainText('VIE');
  await expect(panel).toContainText('Output');
  await expect(panel).toContainText('options');

  // The numbers.
  await expect(panel.locator('.gm-inspect-stat-label').filter({ hasText: 'duration' })).toBeVisible();
  await expect(panel.locator('.gm-inspect-kv')).toContainText('call_f1');

  // Selection is reflected on the canvas and in the URL.
  await expect(nodeBody(page, FIXTURE_NODES.flights)).toHaveClass(/gm-node--selected/);
  expect(page.url()).toContain('node/tool%3AsearchFlights');

  // Escape closes it again.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('a failed node leads with why it failed, including the stack', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);

  // Click the card head, not the action row (the banner stops propagation on
  // purpose so a resume click never also re-selects).
  await nodeCard(page, FIXTURE_NODES.currency).locator('.gm-node-title').click();

  const panel = inspector(page);
  const why = panel.locator('.gm-why');
  await expect(why).toBeVisible();
  await expect(why.locator('.gm-why-error-name')).toHaveText('RateLimitError');
  await expect(why.locator('.gm-why-error-message')).toContainText('fx.live quota exceeded');

  // The stack is one click away and is a real stack.
  const stackToggle = why.getByRole('button', { name: /stack trace/ });
  await expect(stackToggle).toHaveAttribute('aria-expanded', 'false');
  await stackToggle.click();
  await expect(stackToggle).toHaveAttribute('aria-expanded', 'true');
  const stack = why.locator('.gm-why-stack');
  await expect(stack).toBeVisible();
  await expect(stack).toContainText('RateLimitError:');
  await expect(stack).toContainText('at ');

  // The input that produced it, and the neighbours that did not fail.
  await expect(why).toContainText('The input that produced it');
  await expect(why.locator('.gm-why-input')).toContainText('EUR');
  await expect(why.locator('.gm-why-context .gm-why-chip').first()).toBeVisible();
});

test('the inspector follows the selection to a sibling from the failure context', async ({
  page,
}) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);
  await nodeCard(page, FIXTURE_NODES.currency).locator('.gm-node-title').click();

  const panel = inspector(page);
  const sibling = panel.locator('.gm-why-context .gm-why-chip', { hasText: 'getWeather' }).first();
  await expect(sibling).toBeVisible();
  await sibling.click();

  await expect(panel.locator('.gm-inspect-head')).toContainText('getWeather');
  await expect(panel).toContainText('forecast');
  await expect(nodeBody(page, FIXTURE_NODES.weather)).toHaveClass(/gm-node--selected/);
});

test('an LLM step keeps usage and the full stream, per execution', async ({ page }) => {
  await openFixtureRun(page);
  // Hold the run so the step has exactly two finished executions — otherwise
  // the inspector's "latest execution" default is a moving target.
  await waitForPlantedPause(page);
  // The camera is parked on the held node; bring the whole graph back.
  await fitGraph(page);

  await nodeCard(page, FIXTURE_NODES.llm).locator('.gm-node-title').click();
  const panel = inspector(page);
  await expect(panel.locator('.gm-inspect-head')).toContainText('llm step');

  // Two attempts so far, and the numbers for the one on screen.
  const chips = panel.locator('.gm-exec-chip');
  await expect(chips).toHaveCount(2);
  await expect(panel.locator('.gm-inspect-stat-label').filter({ hasText: 'tokens in' })).toBeVisible();
  await expect(panel.locator('.gm-inspect-stats').first()).toContainText('1.4k'); // 1418 in
  await expect(panel.locator('.gm-stream').first()).toContainText('TAP at €214');

  // Streams are archived per execution, not smeared into one buffer: the
  // first step still has its own text *and* its reasoning trace.
  await chips.first().click();
  await expect(panel.locator('.gm-stream').first()).toContainText("I'll start by finding");
  await expect(panel.locator('.gm-stream--reasoning')).toContainText('Budget of');
  await expect(panel.locator('.gm-inspect-stats').first()).toContainText('612');
});
