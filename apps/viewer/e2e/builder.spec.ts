/**
 * The Build page (#/build) in the built viewer, with no server attached.
 *
 * What a user gets with nothing running: the canvas, the palette, the
 * inspector that follows the selected node, honest copy about what needs a
 * server, and no crash. The parts that need `graphmind serve` (code, Create,
 * Run) are covered by the CLI suite against a real server; here they must be
 * visibly disabled, not silently broken.
 */
import { expect, openViewer, skipSetupGuide, test } from './harness.js';

const WS_FAILURE = /WebSocket connection to .* failed|ws:\/\/127\.0\.0\.1:4747/;

test('places nodes on the canvas, edits the selected one, and says what needs a server', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_FAILURE);
  await skipSetupGuide(page);
  await openViewer(page);

  await page.getByRole('button', { name: 'Build a workflow' }).first().click();
  await expect(page).toHaveURL(/#\/build$/);
  await expect(page.locator('.gm-builder-bar h1')).toHaveText('Workflow');

  // The starter graph: the agent and its two tools.
  const cards = page.locator('.gm-bnode');
  await expect(cards).toHaveCount(3);
  await expect(cards.filter({ hasText: 'getWeather' })).toBeVisible();

  // Add an MCP server: it arrives wired to the agent and selected for editing.
  await page.getByRole('button', { name: '+ MCP server' }).click();
  await expect(cards).toHaveCount(4);
  await expect(page.getByLabel('MCP server name')).toHaveValue('mcp');
  await page.getByLabel('MCP server name').fill('filesystem');
  await expect(cards.filter({ hasText: 'filesystem' })).toBeVisible();

  // Switching it to http asks for the things http needs, by name.
  await page.getByLabel('MCP transport').selectOption('http');
  await page.getByLabel('MCP URL').fill('not-a-url');
  await expect(page.locator('.gm-bnode--bad')).toHaveCount(1);
  await page.getByLabel('MCP URL').fill('https://mcp.example.com/mcp');
  await expect(page.locator('.gm-bnode--bad')).toHaveCount(0);

  // Test connection answers even when it cannot run: a control that does
  // nothing on click, and explains itself only in a tooltip, reads as broken.
  const probe = page.getByRole('button', { name: 'Test connection' });
  await expect(probe).toBeEnabled();
  await probe.click();
  await expect(page.locator('.gm-builder-railbody .gm-btoken')).toContainText(/debugger server/);

  // A sub-agent is a node too — and adding to it sticks: after the first
  // tool lands on the sub-agent (and is selected), the next one must land
  // there as well, without re-selecting the sub-agent.
  await page.getByRole('button', { name: '+ Sub-agent' }).click();
  await expect(cards).toHaveCount(5);
  await expect(page.getByLabel('Sub-agent name')).toBeVisible();
  await page.getByRole('button', { name: '+ Tool' }).click();
  await page.getByRole('button', { name: '+ MCP server' }).click();
  await expect(cards).toHaveCount(7);
  await expect(page.getByLabel('MCP server name')).toHaveValue('mcp');
  await expect(page.locator('.react-flow__edge[aria-label^="Edge from subagent"]')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge[aria-label^="Edge from agent"]')).toHaveCount(4);
  // Delete the two so the rest of the test sees the graph it expects.
  await page.getByRole('button', { name: 'Delete' }).click();
  await cards.filter({ hasText: 'myTool' }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(cards).toHaveCount(5);

  // Pick the agent card: the project-level choices live there.
  await cards.filter({ hasText: 'my-agent' }).click();
  await expect(page.locator('.gm-builder-sub')).toHaveText(/TypeScript · Vercel AI SDK · anthropic/);

  // More than two providers: the OpenAI SDK target offers every compatible one.
  await page.getByLabel('Provider').selectOption('groq');
  await expect(page.locator('.gm-builder-sub')).toHaveText(/groq/);
  await expect(page.locator('.gm-bnode--agent')).toContainText('llama-3.3-70b-versatile');

  // Python has no MCP or sub-agent generator, and the page says which nodes.
  await page.getByRole('radio', { name: /Python.*OpenAI SDK/ }).click();
  await expect(page.locator('.gm-builder-sub')).toHaveText(/Python · OpenAI SDK · groq/);
  await expect(page.locator('.gm-bnode--bad')).toHaveCount(2);
  await page.getByRole('radio', { name: /TypeScript.*Vercel AI SDK/ }).click();
  await expect(page.locator('.gm-bnode--bad')).toHaveCount(0);

  // No server: the page says so, and says what to do about it.
  await expect(page.locator('.gm-builder-blocked')).toContainText(/debugger server/);
  await page.getByRole('tab', { name: 'Run' }).click();
  await expect(page.getByRole('button', { name: 'Create project' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Install & run|Run$/ })).toBeDisabled();

  // Back to the debugger, and the hash follows.
  await page.getByRole('button', { name: 'Close the builder' }).click();
  await expect(page.locator('.gm-builder-bar')).toHaveCount(0);
  await expect(page).not.toHaveURL(/#\/build/);
});

test('with no server, the page names the fix rather than the symptom', async ({ page, consoleGuard }) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page, { hash: '#/build' });

  const banner = page.locator('.gm-builder-blocked');
  await expect(banner).toContainText(/npx graphmind-ai|graphmind serve/);

  // The Run tab repeats it where Create and Run are, so the reason for a
  // disabled button is next to the button.
  await page.getByRole('tab', { name: 'Run' }).click();
  await expect(page.locator('.gm-builder-railbody .gm-btoken')).toBeVisible();
});

test('offers a key that is never written down, and never shows one back', async ({ page, consoleGuard }) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page, { hash: '#/build' });
  await page.getByRole('tab', { name: 'Run' }).click();

  // "This session only" is the default: nothing reaches the disk unless asked.
  await expect(page.getByRole('radio', { name: /This session only/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: /Save to .env/ })).toHaveAttribute('aria-checked', 'false');

  // The key field hides what is typed and is never persisted by the page.
  const key = page.getByLabel('ANTHROPIC_API_KEY');
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveAttribute('autocomplete', 'off');
  await key.fill('sk-ant-test-value');
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain('sk-ant-test-value');
  expect(page.url()).not.toContain('sk-ant-test-value');
});

test('#/build deep-links straight to the canvas', async ({ page, consoleGuard }) => {
  consoleGuard.allow(WS_FAILURE);
  await openViewer(page, { hash: '#/build' });
  await expect(page.locator('.gm-builder-bar h1')).toHaveText('Workflow');
  await expect(page.locator('.gm-bnode')).toHaveCount(3);
});
