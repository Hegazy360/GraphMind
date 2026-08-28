/**
 * An MCP server session on the canvas.
 *
 * There is no recorded MCP run to ship yet — the schema gained `server`,
 * `resource` and `prompt` before any adapter could emit them — so the fixture
 * is generated (src/store/mcpFixture.ts) and replayed through the same
 * paced path as the bundled demo. What is under test is the thing a unit
 * test cannot see: that a session of JSON-RPC requests *reads* as one, that
 * each MCP kind is identifiable at a glance, and that a gate holds in an MCP
 * run exactly as it does in an agent run.
 */
import { expect, nodeBody, nodeCard, openViewer, runStatusPill, test } from './harness.js';

const NODES = {
  session: 'server:docs-mcp',
  prompt: 'prompt:release_notes',
  changelog: 'resource:file:///CHANGELOG.md',
  issues: 'resource:db://issues/open',
  search: 'tool:search_issues',
  create: 'tool:create_issue',
  sampling: 'llm:sampling',
} as const;

async function openMcpRun(page: import('@playwright/test').Page): Promise<void> {
  await openViewer(page, { query: 'fixture=mcp' });
  await expect(nodeCard(page, NODES.session)).toBeVisible();
}

test('an MCP session renders every kind, with its catalogue on screen from the start', async ({
  page,
}) => {
  await openMcpRun(page);

  // The server advertises what it can do before anything is called: every
  // node is on the canvas immediately, and the ones that have not run yet
  // are ghosts.
  for (const nodeId of Object.values(NODES)) {
    await expect(nodeCard(page, nodeId)).toBeVisible();
  }
  await expect(nodeBody(page, NODES.create)).toHaveClass(/gm-node--ghost/);

  // Each kind says what it is, and is tagged for the kind-colour system.
  const session = nodeCard(page, NODES.session);
  await expect(session.locator('.gm-node-kind')).toHaveText('server');
  await expect(nodeBody(page, NODES.session)).toHaveClass(/gm-kind--server/);
  await expect(nodeCard(page, NODES.prompt).locator('.gm-node-kind')).toHaveText('prompt');
  await expect(nodeBody(page, NODES.prompt)).toHaveClass(/gm-kind--prompt/);
  await expect(nodeCard(page, NODES.changelog).locator('.gm-node-kind')).toHaveText('resource');
  await expect(nodeBody(page, NODES.changelog)).toHaveClass(/gm-kind--resource/);
  await expect(nodeCard(page, NODES.sampling).locator('.gm-node-kind')).toHaveText('llm');

  // Kind is carried by shape too, not colour alone.
  await expect(nodeCard(page, NODES.session).locator('.gm-node-kind svg')).toBeVisible();

  // The session counts requests, not "steps and tool calls".
  await expect(session).toContainText('request', { timeout: 25_000 });
});

test('MCP requests light up as the client makes them, and sampling streams', async ({ page }) => {
  await openMcpRun(page);

  await expect(nodeBody(page, NODES.prompt)).toHaveClass(/gm-node--ok/, { timeout: 25_000 });
  await expect(nodeBody(page, NODES.changelog)).toHaveClass(/gm-node--ok/, { timeout: 25_000 });
  await expect(nodeBody(page, NODES.search)).toHaveClass(/gm-node--ok/, { timeout: 25_000 });

  // sampling/createMessage is a model call: it gets the llm card and a live tail.
  const tail = nodeCard(page, NODES.sampling).locator('.gm-token-tail');
  await expect(tail).toContainText('changelog', { timeout: 30_000 });
});

test('a gate holds an MCP resources/read, and the inspector explains it', async ({ page }) => {
  await openMcpRun(page);

  const banner = nodeCard(page, NODES.issues).locator('.gm-pause-banner');
  await expect(banner).toBeVisible({ timeout: 45_000 });
  await expect(banner.locator('.gm-pause-label')).toHaveText(/Paused on error/);
  await expect(banner.locator('.gm-pause-error')).toContainText('McpError');
  await expect(runStatusPill(page)).toHaveText('paused');

  // The inspector opened itself on the held node, with the JSON-RPC request
  // that produced the failure and the session it belongs to.
  const inspector = page.getByRole('complementary', { name: 'Node inspector' });
  await expect(inspector).toBeVisible();
  await expect(inspector.locator('.gm-kind-badge')).toHaveText('resource');
  await expect(inspector.locator('.gm-why-error-name')).toHaveText('McpError');
  await expect(inspector.locator('.gm-why-input')).toContainText('resources/read');
  await expect(inspector.locator('.gm-why-context')).toContainText('docs-mcp');

  // …and releasing it lets the rest of the session run.
  await inspector.locator('.gm-inspect-held').getByRole('button', { name: 'Continue' }).click();
  await expect(nodeBody(page, NODES.create)).toHaveClass(/gm-node--ok/, { timeout: 30_000 });
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });
});

test('the filter popover can single out an MCP kind', async ({ page }) => {
  await openMcpRun(page);
  await expect(nodeBody(page, NODES.changelog)).toHaveClass(/gm-node--ok/, { timeout: 25_000 });

  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  const popover = page.getByRole('dialog', { name: 'Canvas filters' });
  await popover.getByRole('button', { name: 'resource', exact: true }).click();

  await expect(nodeCard(page, NODES.changelog)).not.toHaveClass(/gm-dim/);
  await expect(nodeCard(page, NODES.search)).toHaveClass(/gm-dim/);
  await expect(nodeCard(page, NODES.session)).toHaveClass(/gm-dim/);
});
