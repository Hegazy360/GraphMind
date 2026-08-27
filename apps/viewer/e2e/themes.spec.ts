/**
 * Both themes, measured rather than eyeballed.
 *
 * Two failure modes are worth failing CI over: text that the browser cuts
 * off without saying so, and text that disappears into its own background
 * because a token was only redefined for one theme. `audit.ts` measures both
 * from computed styles and real geometry, across the UI states that actually
 * carry information — the graph, the inspector, the waterfall, the palette
 * and the inject editor.
 */
import {
  FIXTURE_NODES,
  expect,
  nodeCard,
  openFixtureRun,
  settleAnimations,
  test,
  waitForPlantedPause,
} from './harness.js';
import {
  DEFAULT_ROW_SELECTORS,
  DEFAULT_TEXT_SELECTORS,
  auditPage,
  type AuditReport,
} from './audit.js';

/**
 * Anything below this is not a design choice, it is a mistake: text at 3:1
 * against its own background is on its way to invisible. The palette's
 * deliberately quiet labels sit at ~3.8–5.5 in both themes, so this floor
 * catches regressions without dictating the design.
 */
const MIN_RATIO = 3;

/** The text a user has to be able to read, whatever else recedes. */
const PRIMARY_SELECTORS = [
  '.gm-topbar-title h1',
  '.gm-node-title',
  '.gm-palette-title',
  '.gm-why-error-message',
  '.gm-pause-label',
];
const PRIMARY_MIN_RATIO = 4.5;

function summarize(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

async function audit(page: import('@playwright/test').Page, minRatio = MIN_RATIO) {
  // Measuring colour mid-fade reports contrast failures that do not exist.
  await settleAnimations(page);
  return await auditPage(page, {
    textSelectors: DEFAULT_TEXT_SELECTORS,
    rowSelectors: DEFAULT_ROW_SELECTORS,
    minRatio,
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} theme: nothing is clipped, overlapping, or invisible`, async ({
    page,
  }, testInfo) => {
    await openFixtureRun(page, { theme, colorScheme: theme });
    await waitForPlantedPause(page);

    // Put every information-carrying surface on screen at once.
    await nodeCard(page, FIXTURE_NODES.currency).locator('.gm-node-title').click();
    await page.keyboard.press('Shift+T');
    await expect(page.locator('.gm-timeline')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Node inspector' })).toBeVisible();

    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const report = await audit(page);
    await testInfo.attach(`audit-${theme}.json`, {
      body: summarize(report),
      contentType: 'application/json',
    });
    await testInfo.attach(`screenshot-${theme}.png`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });

    // The audit has to have actually looked at something.
    expect(report.inspected, 'the audit found no text to inspect').toBeGreaterThan(30);

    expect(report.clipped, `${theme}: text cut off with no ellipsis`).toEqual([]);
    expect(report.overlapping, `${theme}: overlapping text boxes`).toEqual([]);
    expect(report.contrast, `${theme}: text below ${MIN_RATIO}:1 contrast`).toEqual([]);

    // Headline text is held to the stricter, readable-at-a-glance bar.
    await settleAnimations(page);
    const primary = await auditPage(page, {
      textSelectors: PRIMARY_SELECTORS,
      rowSelectors: [],
      minRatio: PRIMARY_MIN_RATIO,
    });
    expect(primary.contrast, `${theme}: primary text below ${PRIMARY_MIN_RATIO}:1`).toEqual([]);
  });

  test(`${theme} theme: overlays (palette, inject editor) stay legible`, async ({
    page,
  }, testInfo) => {
    await openFixtureRun(page, { theme, colorScheme: theme });
    const banner = await waitForPlantedPause(page);

    // The inject editor sits inside a node card, over the canvas.
    await banner.getByRole('button', { name: 'Inject…', exact: true }).click();
    await expect(banner.locator('.gm-inject textarea')).toBeVisible();
    const withEditor = await audit(page);
    expect(withEditor.clipped, `${theme}: inject editor clips text`).toEqual([]);
    expect(withEditor.contrast, `${theme}: inject editor text below ${MIN_RATIO}:1`).toEqual([]);

    // …and the palette floats over everything.
    await page.keyboard.press('ControlOrMeta+KeyK');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('option').first()).toBeVisible();

    const withPalette = await audit(page);
    await testInfo.attach(`audit-${theme}-overlays.json`, {
      body: summarize(withPalette),
      contentType: 'application/json',
    });
    await testInfo.attach(`screenshot-${theme}-palette.png`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
    expect(withPalette.clipped, `${theme}: palette clips text`).toEqual([]);
    expect(withPalette.overlapping, `${theme}: palette overlaps text`).toEqual([]);
    expect(withPalette.contrast, `${theme}: palette text below ${MIN_RATIO}:1`).toEqual([]);
  });
}

test('the two themes are actually different, and the OS preference is honoured', async ({
  page,
}) => {
  await openFixtureRun(page, { theme: 'dark', colorScheme: 'light' });
  const forcedDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.goto('/?fixture=1'); // same context, theme still pinned in storage
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const second = await page.context().newPage();
  await second.emulateMedia({ colorScheme: 'light' });
  await second.addInitScript(() => {
    try {
      localStorage.removeItem('graphmind.theme');
    } catch {
      /* storage blocked */
    }
  });
  await second.goto('/?fixture=1');
  await expect(second.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  const systemLight = await second.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  await second.close();

  // A pinned dark theme must not follow a light OS, and the two grounds must
  // not be the same colour.
  expect(forcedDark).not.toBe(systemLight);
  const darkness = (value: string): number => {
    const parts = /rgba?\(([^)]+)\)/.exec(value)?.[1]?.split(',') ?? [];
    return parts.slice(0, 3).reduce((sum, part) => sum + Number.parseFloat(part), 0) / 3;
  };
  expect(darkness(forcedDark), 'a dark theme should have a dark ground').toBeLessThan(60);
  expect(darkness(systemLight), 'a light theme should have a light ground').toBeGreaterThan(200);
});
