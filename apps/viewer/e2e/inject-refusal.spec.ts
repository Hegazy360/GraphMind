/**
 * A refused inject must say why and keep the editor open. The only refusal
 * today is a value that still contains the redaction placeholder — the
 * pre-filled editor is the whole reason the guard exists (0.5.0, W7) — and
 * before this the editor simply closed, indistinguishable from success.
 */
import { expect, openFixtureRun, runStatusPill, test, waitForPlantedPause } from './harness.js';

test('an inject that still contains the redaction placeholder is refused, with the reason', async ({
  page,
}) => {
  await openFixtureRun(page);
  const banner = await waitForPlantedPause(page);

  await banner.getByRole('button', { name: 'Inject…', exact: true }).click();
  const editor = banner.locator('.gm-inject textarea');
  await expect(editor).toBeVisible();
  await editor.fill('{"converted": "__REDACTED__"}');
  await banner.getByRole('button', { name: 'Inject & resume' }).click();

  const refusal = banner.locator('.gm-inject-refusal');
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('redacted');
  // Nothing was sent: the editor is still open and the run is still held.
  await expect(editor).toBeVisible();
  await expect(runStatusPill(page)).toHaveText('paused');

  // Fix the value and the same button injects.
  await editor.fill('{"converted": 91.3}');
  await banner.getByRole('button', { name: 'Inject & resume' }).click();
  await expect(banner.locator('.gm-inject-refusal')).toHaveCount(0);
  await expect(runStatusPill(page)).not.toHaveText('paused', { timeout: 20_000 });
});
