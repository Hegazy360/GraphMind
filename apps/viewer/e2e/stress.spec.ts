/**
 * A big graph. `?stress=300` pushes a synthetic 300-node run through the
 * real ingest path — same reducer, same token registry, same layout, same
 * canvas — so this is the scaling claim being checked in a browser rather
 * than asserted in a comment.
 */
import { expect, test } from './harness.js';

interface StressReport {
  runId: string;
  nodes: number;
  events: number;
  ingestMs: number;
  eventsPerSecond: number;
}

async function stressReport(page: import('@playwright/test').Page): Promise<StressReport> {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => (window as unknown as Record<string, unknown>)['__graphmindStress'] !== undefined,
        ),
      { message: 'the stress run should finish ingesting', timeout: 60_000 },
    )
    .toBe(true);
  return await page.evaluate(
    () => (window as unknown as Record<string, unknown>)['__graphmindStress'] as StressReport,
  );
}

test('a 300-node run ingests, folds itself, and stays interactive', async ({ page }, testInfo) => {
  await page.goto('/?stress=300&pace=0');

  const report = await stressReport(page);
  await testInfo.attach('stress-report.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.nodes).toBeGreaterThan(250);
  expect(report.events).toBeGreaterThan(1000);
  expect(Number.isFinite(report.ingestMs)).toBe(true);

  // The toolbar knows how big it is…
  const stats = page.locator('.gm-topbar-stats');
  await expect(stats).toBeVisible();
  await expect(stats).toContainText('nodes');

  // …and a run this size opens folded rather than as a 15,000px-wide row of
  // unreadable dots (AUTO_COLLAPSE_NODES in RunCanvas).
  const folded = page.getByRole('button', { name: /folded$/ });
  await expect(folded).toBeVisible();
  const cardsWhenFolded = await page.locator('.react-flow__node').count();
  expect(cardsWhenFolded).toBeGreaterThan(0);
  expect(cardsWhenFolded).toBeLessThan(report.nodes);

  // A graph this size gets a minimap.
  await expect(page.locator('.gm-minimap')).toBeVisible();
  // …and the level-of-detail HUD.
  await expect(page.locator('.gm-canvas-hud')).toContainText('nodes');

  // Unfold everything: now the whole graph is laid out.
  await folded.click();
  await expect(page.getByRole('button', { name: 'Collapse', exact: true })).toBeVisible();
  const hud = page.locator('.gm-canvas-hud');
  await expect
    .poll(
      async () => Number((await hud.innerText()).split(' ')[0] ?? '0'),
      { message: 'the HUD should report the full, unfolded graph', timeout: 30_000 },
    )
    .toBeGreaterThan(report.nodes - 5);

  // React Flow virtualizes above 90 nodes: the DOM holds only what is on
  // screen, not three hundred cards.
  const mounted = await page.locator('.react-flow__node').count();
  expect(mounted, 'only the visible slice should be mounted').toBeLessThan(report.nodes / 2);

  // Framing the whole run brings the rest into view (and drops the level of
  // detail, which is what keeps that affordable).
  await page.getByRole('button', { name: 'Fit view' }).click();
  await expect
    .poll(async () => await page.locator('.react-flow__node').count(), { timeout: 15_000 })
    .toBeGreaterThan(mounted);
  await expect(hud).toContainText(/detail|compact|overview/);

  // Interactive: a click still lands, and the inspector opens promptly.
  const started = Date.now();
  await page.locator('.react-flow__node .gm-node-title').first().click();
  const inspector = page.getByRole('complementary', { name: 'Node inspector' });
  await expect(inspector).toBeVisible({ timeout: 10_000 });
  expect(
    Date.now() - started,
    'selecting a node in a 300-node graph should feel immediate',
  ).toBeLessThan(6_000);
});

test('the command palette can still find one node among hundreds', async ({ page }) => {
  await page.goto('/?stress=300&pace=0');
  await stressReport(page);

  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();

  const started = Date.now();
  await palette.getByRole('textbox').fill('runSql');
  const first = palette.getByRole('option').first();
  await expect(first).toContainText('runSql');
  expect(Date.now() - started, 'searching a large run should not stall').toBeLessThan(6_000);

  await first.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Node inspector' })).toContainText('runSql');
});

test('the minimap pans the camera on a large graph', async ({ page }) => {
  await page.goto('/?stress=300&pace=0');
  await stressReport(page);

  const minimap = page.locator('.gm-minimap');
  await expect(minimap).toBeVisible();

  const before = await page.evaluate(
    () => document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '',
  );
  const box = await minimap.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.7, { steps: 10 });
    await page.mouse.up();
  }
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '',
        ),
      { message: 'dragging the minimap should move the viewport', timeout: 10_000 },
    )
    .not.toBe(before);
});
