/**
 * The very first screen: the viewer opened with nothing attached.
 *
 * This is what a stranger sees before they have a run, so it has to explain
 * itself, offer a way in, and fail open — no crash, no blank page, no
 * unhandled error when the socket is not there.
 */
import { FIXTURE_NODES, expect, nodeCard, openViewer, test } from './harness.js';

/**
 * There is deliberately no server on 4747 in this suite, so Chromium logs
 * the failed WebSocket handshake. The viewer handling that gracefully is the
 * point of the test — it is expected noise, and the only thing allowed.
 */
const WS_FAILURE = /WebSocket connection to .* failed|ws:\/\/127\.0\.0\.1:4747/;

test('with no server attached the viewer explains itself instead of going blank', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page);

  const card = page.locator('.gm-empty-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Connecting to the debugger|No debugger server|GraphMind/);

  // The connection state is reported honestly, and it keeps trying.
  await expect(page.locator('.gm-conn-label')).toHaveText(/connecting|detached|offline/);

  // …and it offers a way to see the product with no server at all.
  await expect(page.getByRole('button', { name: 'Replay the bundled demo run' })).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByRole('link', { name: 'Load a 300-node stress run' })).toBeVisible();
});

test('the demo button loads the bundled run without a server', async ({ page, consoleGuard }) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page);

  const demo = page.getByRole('button', { name: 'Replay the bundled demo run' });
  await expect(demo).toBeVisible({ timeout: 25_000 });
  await demo.click();

  await expect(nodeCard(page, FIXTURE_NODES.agent)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.gm-topbar-title h1')).toHaveText('trip-planner');
  // A replay is running, so the run bar offers to restart it.
  await expect(page.getByRole('button', { name: 'Restart the replay' })).toBeVisible();
  // …and the label names what is on screen. The demo button leaves the live
  // socket configured and retrying, so this used to read "detached" over a
  // replay that was visibly playing.
  await expect(page.locator('.gm-conn-label')).toHaveText('replaying');
  // The server really is gone, and the tooltip still says so — the label is
  // honest about the replay, not about an attachment it does not have.
  await expect(page.locator('.gm-conn-group')).toHaveAttribute(
    'title',
    /no debug server attached/,
  );
});

test('a bogus ?ws= endpoint degrades instead of throwing', async ({ page, consoleGuard }) => {
  consoleGuard.allow(WS_FAILURE, /ws:\/\/127\.0\.0\.1:1\/nope/);
  await openViewer(page, { query: 'ws=ws://127.0.0.1:1/nope' });

  await expect(page.locator('.gm-empty-card')).toBeVisible();
  await expect(page.locator('.gm-conn-label')).toHaveText(/connecting|detached|offline/, {
    timeout: 25_000,
  });
  // Still usable: the palette opens, the app has not fallen over.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});
