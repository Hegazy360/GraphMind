/**
 * The very first screen, and the page it leads to.
 *
 * This is what a stranger sees before they have a run, so it has to explain
 * itself, offer a way in, and fail open — no crash, no blank page, no
 * unhandled error when the socket is not there.
 *
 * "Connect an agent" is deliberately one screen. It was a five-step wizard;
 * if a Next button ever comes back, these tests should start failing.
 */
import {
  FIXTURE_NODES,
  expect,
  nodeCard,
  openViewer,
  runCrumb,
  skipSetupGuide,
  test,
} from './harness.js';

/**
 * There is deliberately no server on 4747 in this suite, so Chromium logs
 * the failed WebSocket handshake. The viewer handling that gracefully is the
 * point of the test — it is expected noise, and the only thing allowed.
 */
const WS_FAILURE = /WebSocket connection to .* failed|ws:\/\/127\.0\.0\.1:4747/;

function connectPage(page: import('@playwright/test').Page) {
  return page.getByRole('heading', { name: 'Connect an agent' });
}

test('a cold start lands on the connect page rather than an empty list', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page);

  await expect(connectPage(page)).toBeVisible({ timeout: 25_000 });

  // The connection state is reported honestly, and it keeps trying.
  await expect(page.locator('.gm-conn-label')).toHaveText(/connecting|detached|offline/);

  // No control that cannot act: the debugger's menu is in the header, but
  // there is no canvas to step and nothing to break on here.
  await expect(page.getByRole('button', { name: 'Break everywhere' })).toHaveCount(0);
});

test('connecting an agent is one screen: pick a stack, copy two things', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page, { hash: '#/connect' });
  await expect(connectPage(page)).toBeVisible({ timeout: 25_000 });

  // No wizard: nothing to advance through, and everything on one screen.
  await expect(page.getByRole('button', { name: /^(Next|Install it|Wire it up)$/ })).toHaveCount(0);
  await expect(page.locator('.gm-stepper')).toHaveCount(0);

  const blocks = page.locator('.gm-code');
  await expect(blocks).toHaveCount(2);
  await expect(blocks.first()).toContainText('npm i -D @graphmind-ai/sdk');
  await expect(blocks.last()).toContainText("from '@graphmind-ai/sdk'");

  // Picking a stack rewrites both, in place.
  await page.getByRole('radio', { name: 'OpenAI or Anthropic SDK' }).click();
  await expect(blocks.first()).toContainText('pip install graphmind-ai');
  await expect(blocks.last()).toContainText('import graphmind as gm');

  // …and what a gate can do there, which differs per stack, is stated
  // before you wire it up rather than after.
  await expect(page.locator('.gm-note')).toContainText('pause, step, retry');
  await page.getByRole('radio', { name: 'LangGraph / LangChain' }).click();
  await expect(page.locator('.gm-note')).toContainText('cannot substitute its return value');
});

test('the chosen stack is remembered, so it is not a question twice', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page, { hash: '#/connect' });
  await page.getByRole('radio', { name: 'OpenAI SDK', exact: true }).click();
  await expect(page.locator('.gm-code').first()).toContainText('@graphmind-ai/openai');

  await page.reload();
  await expect(page.getByRole('radio', { name: 'OpenAI SDK', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
    { timeout: 25_000 },
  );
});

test('a returning user gets the runs list, with the connect page one click away', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_FAILURE);
  await skipSetupGuide(page);
  await openViewer(page);

  const card = page.locator('.gm-empty-card');
  await expect(card).toBeVisible({ timeout: 25_000 });
  await expect(card).toContainText(/Connecting to the debugger|No debugger server|Waiting for a run/);
  await expect(card.getByRole('button', { name: 'Connect an agent' })).toBeVisible();

  await card.getByRole('button', { name: 'Connect an agent' }).click();
  await expect(connectPage(page)).toBeVisible();
});

test('the demo replays from the empty state without a server', async ({ page, consoleGuard }) => {
  consoleGuard.allow(WS_FAILURE);
  await skipSetupGuide(page);
  await openViewer(page);

  const demo = page.getByRole('button', { name: 'Replay the bundled demo run' });
  await expect(demo).toBeVisible({ timeout: 25_000 });
  await demo.click();

  await expect(nodeCard(page, FIXTURE_NODES.agent)).toBeVisible({ timeout: 20_000 });
  await expect(runCrumb(page)).toHaveText('trip-planner');
  // A replay is running, so the header offers to restart it…
  await expect(page.getByRole('button', { name: 'Restart the replay' })).toBeVisible();
  // …and the label names what is on screen, not an attachment it lacks.
  await expect(page.locator('.gm-conn-label')).toHaveText('replaying');
  await expect(page.locator('.gm-conn-group')).toHaveAttribute('title', /no debug server attached/);
});

test('a bogus ?ws= endpoint degrades instead of throwing', async ({ page, consoleGuard }) => {
  consoleGuard.allow(WS_FAILURE, /ws:\/\/127\.0\.0\.1:1\/nope/);
  await skipSetupGuide(page);
  await openViewer(page, { query: 'ws=ws://127.0.0.1:1/nope' });

  await expect(page.locator('.gm-empty-card')).toBeVisible();
  await expect(page.locator('.gm-conn-label')).toHaveText(/connecting|detached|offline/, {
    timeout: 25_000,
  });
  // Still usable: the palette opens, the app has not fallen over.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});
