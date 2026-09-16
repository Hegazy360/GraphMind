/**
 * The loop hold as the user meets it.
 *
 * The SDK holds the third identical tool call and says why on the wire; this
 * proves the two surfaces that turn that into a decision: the banner on the
 * held card ("Loop: 3× searchFlights with identical arguments") and the
 * inspector block that lays the identical calls and their identical outputs
 * side by side. The run is a synthetic stream inlined the way `graphmind
 * record --html` does it (src/store/loop.ts) — an exported run, so the gate
 * reads in the past tense and offers no controls, exactly as a recorded
 * loop hold should.
 */
import { generateLoopRun, LOOP_NODES } from '../src/store/loop.js';
import { expect, nodeCard, openViewer, pauseBanner, runStatusPill, test } from './harness.js';

function inspector(page: import('@playwright/test').Page) {
  return page.getByRole('complementary', { name: 'Node inspector' });
}

async function openLoopRun(page: import('@playwright/test').Page): Promise<void> {
  await openViewer(page, { embeddedRun: generateLoopRun() });
  await expect(nodeCard(page, LOOP_NODES.flights)).toBeVisible({ timeout: 10_000 });
}

test('the held card says it is a loop, in the tool\'s own name', async ({ page }) => {
  await openLoopRun(page);

  const banner = pauseBanner(page, LOOP_NODES.flights);
  await expect(banner).toBeVisible();
  await expect(banner.locator('.gm-pause-label')).toHaveText(
    'Was held — loop: 3× searchFlights with identical arguments',
  );
  // An exported run: a fact, not a control surface — no Continue to click.
  await expect(banner.locator('.gm-pause-note')).toContainText('cannot be resumed');
  await expect(banner.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  await expect(runStatusPill(page)).toHaveText('paused');

  // Three executions of one logical node, not three nodes.
  await expect(nodeCard(page, LOOP_NODES.flights).locator('.gm-badge-count')).toHaveText(/3/);
  await expect(page.locator(`.react-flow__node[data-id^="tool:searchFlights"]`)).toHaveCount(1);
});

test('the inspector lays the identical calls and their identical outputs side by side', async ({
  page,
}) => {
  await openLoopRun(page);

  if (!(await inspector(page).isVisible())) {
    await nodeCard(page, LOOP_NODES.flights).locator('.gm-node-title').click();
  }
  const panel = inspector(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator('.gm-inspect-head')).toContainText('searchFlights');

  const evidence = panel.getByTestId('loop-evidence');
  await expect(evidence).toBeVisible();
  await expect(evidence.locator('.gm-why-head')).toHaveText(
    'Loop: 3× searchFlights with identical arguments',
  );
  await expect(evidence).toContainText('same arguments 3 times in a row');
  await expect(evidence).toContainText('got the same answer back every time');

  // The arguments it keeps sending, then the calls of the streak.
  await expect(evidence).toContainText('AMS');
  await expect(evidence).toContainText('LIS');
  const calls = evidence.getByTestId('loop-call');
  await expect(calls).toHaveCount(3);
  await expect(calls.nth(0)).toContainText('#1');
  await expect(calls.nth(0)).toContainText('ok');
  await expect(calls.nth(1)).toContainText('same output as the call before');
  await expect(calls.nth(2)).toContainText('this call — held');
  // Real outputs, not placeholders: the flight price is on screen twice.
  await expect(calls.nth(0)).toContainText('128');
  await expect(calls.nth(1)).toContainText('128');
  // The held call has no output yet, so nothing is invented for it.
  await expect(calls.nth(2)).not.toContainText('128');

  // The way out for a legitimate poll is named right there.
  await expect(evidence).toContainText('loopGuard.allowNodes');
});

test('an ordinary held gate is untouched: no loop block, the usual label', async ({ page }) => {
  // Same generator, but the hold is a plain breakpoint: the loop surfaces
  // must not appear just because the tool ran three times.
  const events = generateLoopRun();
  const last = events[events.length - 1];
  if (last === undefined) throw new Error('empty fixture');
  const { reason: _reason, loop: _loop, ...plain } = last.payload as Record<string, unknown>;
  events[events.length - 1] = { ...last, payload: plain };
  await openViewer(page, { embeddedRun: events });
  await expect(nodeCard(page, LOOP_NODES.flights)).toBeVisible({ timeout: 10_000 });

  const banner = pauseBanner(page, LOOP_NODES.flights);
  await expect(banner.locator('.gm-pause-label')).toHaveText(/Was held before call/);
  if (!(await inspector(page).isVisible())) {
    await nodeCard(page, LOOP_NODES.flights).locator('.gm-node-title').click();
  }
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).getByTestId('loop-evidence')).toHaveCount(0);
});
