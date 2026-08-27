/**
 * A run exported by `graphmind record --html` is a frozen record: no
 * process, no server, nowhere for a control to go. The `FixtureConnection`
 * that backs such a page drops everything except `exec.resume`, so every
 * other debugger control was UI theatre — the Run/Step segments and "Break
 * everywhere" changed local state and broadcast into the void, and the
 * per-tool breakpoint dots lit up red for a breakpoint nothing would ever
 * honour.
 *
 * The rule this file holds: a control that cannot act is visibly dead and
 * says why. (The resume actions inside a held gate are covered in
 * deep-links.spec.ts — that page already offers none.)
 */
import { readFileSync } from 'node:fs';
import { auditPage } from './audit.js';
import { FIXTURE_NODES, expect, nodeCard, openFixtureRun, openViewer, test } from './harness.js';

const EXPORTED_RUN: unknown[] = JSON.parse(
  readFileSync(new URL('../src/fixtures/demo-run.json', import.meta.url), 'utf8'),
) as unknown[];

/** Load the exported run and wait for its cards. */
async function openExported(page: import('@playwright/test').Page): Promise<void> {
  await openViewer(page, { embeddedRun: EXPORTED_RUN });
  await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 10_000 });
}

test('the run/step segments are disabled in an exported run, and say why', async ({ page }) => {
  await openExported(page);

  const run = page.getByRole('radio', { name: 'Run', exact: true });
  const step = page.getByRole('radio', { name: 'Step', exact: true });
  await expect(run).toBeDisabled();
  await expect(step).toBeDisabled();
  await expect(step).toHaveAttribute('title', /frozen record|Nothing is executing/);

  // And clicking gets you nowhere: the mode does not change.
  await step.click({ force: true }).catch(() => undefined);
  await expect(run).toHaveClass(/gm-seg--on/);
  await expect(step).not.toHaveClass(/gm-seg--on/);
});

test('"Break everywhere" is disabled in an exported run and adds no breakpoint', async ({
  page,
}) => {
  await openExported(page);

  const breakAll = page.getByRole('button', { name: /Break everywhere/ });
  await expect(breakAll).toBeDisabled();
  await expect(breakAll).toHaveAttribute('title', /frozen record|Nothing is executing/);

  await breakAll.click({ force: true }).catch(() => undefined);
  // No chip: nothing was armed, so nothing claims to be armed.
  await expect(page.locator('.gm-chip--bp')).toHaveCount(0);
});

test('per-tool breakpoint dots are inert in an exported run', async ({ page }) => {
  await openExported(page);

  const card = nodeCard(page, FIXTURE_NODES.flights);
  // The dot still reads as part of the card, but it is not a control.
  await expect(card.locator('.gm-bp--dead')).toHaveCount(1);
  await expect(card.locator('button.gm-bp')).toHaveCount(0);
  await expect(card.locator('.gm-bp--dead')).toHaveAttribute('title', /recorded run/);

  await card.locator('.gm-bp--dead').click();
  await expect(card.locator('.gm-bp--set')).toHaveCount(0);
  await expect(page.locator('.gm-chip--bp')).toHaveCount(0);
});

test('the run bar names what it is attached to: nothing', async ({ page }) => {
  await openExported(page);
  await expect(page.locator('.gm-runbar-endpoint')).toHaveText('recorded · no server');
  await expect(page.locator('.gm-conn-label')).toHaveText('replaying');
});

/**
 * The guard on the other side: a paced fixture replay is a *local* session
 * with a `FixtureConnection` that really does honour `exec.resume`, and the
 * viewer is authoritative for mode and breakpoints. Those controls stay
 * live — this fix disables what cannot act, not everything that is offline.
 */
test('a paced replay keeps its debugger controls', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/WebSocket connection to .* failed|ws:\/\/127\.0\.0\.1:\d+\/ws\/ui/);
  await openFixtureRun(page);

  await expect(page.getByRole('radio', { name: 'Step', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Break everywhere/ })).toBeEnabled();

  await page.getByRole('button', { name: /Break everywhere/ }).click();
  await expect(page.locator('.gm-chip--bp')).toHaveCount(1);
});

/**
 * Disabled must not mean unreadable. A control that has been switched off
 * still has to say what it is and why it is off, in both themes — greying it
 * into the background would trade one dishonesty for another.
 */
for (const theme of ['dark', 'light'] as const) {
  test(`${theme} theme: the disabled controls stay legible`, async ({ page }, testInfo) => {
    await openViewer(page, { embeddedRun: EXPORTED_RUN, theme, colorScheme: theme });
    await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 10_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const report = await auditPage(page, {
      textSelectors: ['.gm-seg button', '.gm-toolbtn', '.gm-conn-label', '.gm-runbar-endpoint'],
      rowSelectors: ['.gm-runbar', '.gm-seg'],
      minRatio: 3,
    });
    await testInfo.attach(`recorded-runbar-${theme}.png`, {
      body: await page.locator('.gm-runbar').screenshot(),
      contentType: 'image/png',
    });
    expect(report.inspected).toBeGreaterThan(3);
    expect(report.clipped, 'a disabled control with its label cut off').toEqual([]);
    expect(report.overlapping, 'run bar controls overlapping').toEqual([]);
    expect(report.contrast, 'a disabled control faded below 3:1').toEqual([]);
  });
}
