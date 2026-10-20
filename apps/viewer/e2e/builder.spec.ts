/**
 * The Build page (#/build) in the built viewer, with no server attached.
 *
 * What a user gets with nothing running: the form, the diagram that follows
 * it, honest copy about what needs a server, and no crash. The parts that
 * need `graphmind serve` (code preview, Create, Run) are covered by the CLI
 * suite against a real server; here they must be visibly disabled, not
 * silently broken.
 */
import { expect, openViewer, test } from './harness.js';

const WS_FAILURE = /WebSocket connection to .* failed|ws:\/\/127\.0\.0\.1:4747/;

test('opens from the rail, follows the form in the diagram, and says what needs a server', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page);

  await page.getByRole('button', { name: 'Build a workflow' }).first().click();
  await expect(page).toHaveURL(/#\/build$/);
  await expect(page.locator('.gm-builder-bar h1')).toHaveText('New workflow');

  // The starter spec: agent -> llm -> two tools.
  const cards = page.locator('.gm-bpreview-card');
  await expect(cards).toHaveCount(4);
  await expect(cards.filter({ hasText: 'getWeather' })).toBeVisible();

  // Add a tool: the diagram grows with the form.
  await page.getByRole('button', { name: '+ Add a tool' }).click();
  await expect(cards).toHaveCount(5);
  await expect(cards.filter({ hasText: 'tool3' })).toBeVisible();

  // Rename it to something invalid: the field says so, inline.
  const names = page.getByLabel('Tool name');
  await names.last().fill('bad-name');
  await expect(names.last()).toHaveAttribute('title', /letters, digits and underscores/);

  // Switch to Python + OpenAI SDK: the provider follows the target.
  await page.getByRole('radio', { name: /Python.*OpenAI SDK/ }).click();
  await expect(page.locator('.gm-builder-sub')).toHaveText(/Python · OpenAI SDK · openai/);
  await expect(cards.filter({ hasText: 'gpt-5.1' })).toBeVisible();

  // No server: the page says so and the write/run actions are disabled.
  await expect(page.locator('.gm-builder-blocked')).toContainText(/No debugger server|viewer token/);
  await expect(page.getByRole('button', { name: 'Create project' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Install & run|Run/ })).toBeDisabled();

  // Back to the debugger, and the hash follows.
  await page.getByRole('button', { name: 'Close the builder' }).click();
  await expect(page.locator('.gm-builder-bar')).toHaveCount(0);
  await expect(page).not.toHaveURL(/#\/build/);
});

test('#/build deep-links straight to the page', async ({ page, consoleGuard }) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page, { hash: '#/build' });
  await expect(page.locator('.gm-builder-bar h1')).toHaveText('New workflow');
  await expect(page.locator('.gm-bpreview-card')).toHaveCount(4);
  // The rail button reads as pressed while the page is open.
  await expect(page.getByRole('button', { name: 'Build a workflow' }).first()).toHaveAttribute('aria-pressed', 'true');
});
