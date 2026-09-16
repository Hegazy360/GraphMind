/**
 * The loop fixture replayed LIVE (`?fixture=loop`), not as an exported run:
 * the replay stops at the loop hold and waits for a resume, so the banner
 * must carry a working action row and Continue must release it. The exported
 * variant (loop.spec.ts) proves the copy; this proves the controls.
 */
import { LOOP_NODES } from '../src/store/loop.js';
import { expect, openViewer, pauseBanner, runStatusPill, test } from './harness.js';

test('the loop hold replays live with a working action row, and Continue releases it', async ({
  page,
}) => {
  await openViewer(page, { query: 'fixture=loop' });

  const banner = pauseBanner(page, LOOP_NODES.flights);
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner.locator('.gm-pause-label')).toHaveText(
    'Loop: 3× searchFlights with identical arguments',
  );
  await expect(runStatusPill(page)).toHaveText('paused');
  for (const label of ['Continue', 'Abort']) {
    await expect(banner.getByRole('button', { name: label, exact: true })).toBeVisible();
  }

  await banner.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(pauseBanner(page, LOOP_NODES.flights)).toHaveCount(0, { timeout: 20_000 });
  await expect(runStatusPill(page)).not.toHaveText('paused', { timeout: 20_000 });
});
