/**
 * Held time is not run time — what the user actually reads.
 *
 * A developer who thinks for 40 s at a breakpoint must not see a 40 s tool
 * call. The SDK reports `heldMs`; older streams get it derived from the
 * pause/resume timestamps. Either way the card, the inspector, the timeline
 * and the run list show what the node itself took, and say how long it was
 * held next to it.
 */
import { readFileSync } from 'node:fs';
import {
  FIXTURE_NODES,
  expect,
  fitGraph,
  nodeCard,
  openFixtureRun,
  openViewer,
  test,
  waitForPlantedPause,
} from './harness.js';

const RECORDED: Record<string, unknown>[] = JSON.parse(
  readFileSync(new URL('../src/fixtures/demo-run.json', import.meta.url), 'utf8'),
) as Record<string, unknown>[];

/**
 * The bundled recording with one change: `searchFlights` reports that
 * 40 s of its 40.0024 s were the debugger holding it — the shape a 0.5+
 * SDK emits after a breakpoint.
 */
function runWithHeldFlights(): Record<string, unknown>[] {
  return RECORDED.map((event) => {
    const payload = event['payload'] as Record<string, unknown>;
    if (event['type'] === 'node.finished' && payload['nodeId'] === FIXTURE_NODES.flights) {
      return { ...event, payload: { ...payload, durationMs: 40_002.4, heldMs: 40_000 } };
    }
    return event;
  });
}

function inspector(page: import('@playwright/test').Page) {
  return page.getByRole('complementary', { name: 'Node inspector' });
}

test('a node the SDK reports as held shows what it ran, with the held time beside it', async ({ page }) => {
  await openViewer(page, { embeddedRun: runWithHeldFlights() });
  await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 10_000 });

  // The card: 2.4ms, not 40.0s.
  const card = nodeCard(page, FIXTURE_NODES.flights);
  await expect(card.locator('.gm-node-ms')).toHaveText('2.4ms');
  await expect(card.locator('.gm-node-ms')).toHaveAttribute('title', 'ran 2.4ms · held 40.0s');

  // The inspector: "ran 2.4ms · held 40.0s" as two cells.
  await card.locator('.gm-node-title').click();
  const panel = inspector(page);
  await expect(panel).toBeVisible();
  const stats = panel.locator('.gm-inspect-stats').first();
  await expect(stats.locator('.gm-inspect-stat').filter({ hasText: 'ran' })).toContainText('2.4ms');
  await expect(stats.locator('.gm-inspect-stat').filter({ hasText: 'held' })).toContainText('40.0s');

  // The timeline: geometry still spans the wall, the label reads ran.
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  const timeline = page.locator('.gm-timeline');
  await expect(timeline).toBeVisible();
  const bar = timeline.locator('.gm-bar').filter({ hasText: /2\.4ms/ }).first();
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('aria-label', /searchFlights execution 1, ran 2\.4ms, held 40,?000ms/);
});

test('a hold played live in the fixture is derived from the pause envelopes and clamped to the recording', async ({
  page,
}) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);
  // Think about it for a while before continuing — the recorded durationMs
  // must not be reduced by this real-world pause.
  await page.waitForTimeout(1500);
  await page.keyboard.press('c');
  await expect(nodeCard(page, FIXTURE_NODES.currency).locator('.gm-badge-count')).toHaveText('×2', {
    timeout: 20_000,
  });
  await fitGraph(page);

  await nodeCard(page, FIXTURE_NODES.currency).locator('.gm-node-title').click();
  const panel = inspector(page);
  // Execution #1 is the one the gate held.
  await panel.locator('.gm-exec-chip').first().click();
  const stats = panel.locator('.gm-inspect-stats').first();
  const held = stats.locator('.gm-inspect-stat').filter({ hasText: 'held' });
  await expect(held).toBeVisible();
  // The recording holds it for 340 ms (pause → finish); the live wait is not
  // charged to a recorded duration.
  await expect(held).toContainText('340ms');
  await expect(stats.locator('.gm-inspect-stat').filter({ hasText: 'ran' })).toContainText('1.4s');
});

test('the run list and top bar report run time, with held time called out', async ({ page }) => {
  await openFixtureRun(page);
  await waitForPlantedPause(page);
  await page.waitForTimeout(1200);
  await page.keyboard.press('c');
  await expect(page.locator('.gm-run-item-status').first()).toHaveText('done', { timeout: 30_000 });

  // The top bar grows a "held" stat once a gate was held.
  const held = page.locator('.gm-topbar-stats .gm-stat').filter({ hasText: 'held' });
  await expect(held).toBeVisible();
  const heldText = (await held.textContent()) ?? '';
  expect(heldText).toMatch(/\d/);

  // The run item shows elapsed minus held, and the tooltip carries both.
  const item = page.locator('.gm-run-item').first();
  const elapsedCell = item.locator('.gm-run-item-meta span[title*="held at gates"]');
  await expect(elapsedCell).toHaveCount(1);
  await expect(elapsedCell).toHaveAttribute('title', /wall · .* held at gates/);
});
