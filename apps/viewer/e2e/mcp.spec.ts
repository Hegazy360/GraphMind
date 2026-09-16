/**
 * An MCP server session on the canvas.
 *
 * There is no recorded MCP run to ship yet — the schema gained `server`,
 * `resource` and `prompt` before any adapter could emit them — so the fixture
 * is generated (src/store/mcpFixture.ts) and replayed through the same
 * paced path as the bundled demo. What is under test is the thing a unit
 * test cannot see: that a session of JSON-RPC requests *reads* as one, that
 * each MCP kind is identifiable at a glance, that the protocol chatter folds
 * into one card with counts instead of burying the work, and that a gate
 * holds in an MCP run exactly as it does in an agent run.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, nodeBody, nodeCard, openViewer, runStatusPill, test } from './harness.js';

const NODES = {
  session: 'server:docs-mcp',
  protocol: 'mcp:protocol',
  prompt: 'prompt:release_notes',
  changelog: 'resource:file:///CHANGELOG.md',
  issues: 'resource:db://issues/open',
  search: 'tool:search_issues',
  create: 'tool:create_issue',
  sampling: 'llm:sampling',
} as const;

/** The six protocol calls the proxy folds under `mcp:protocol`. */
const PROTOCOL = {
  initialize: 'mcp:initialize',
  initialized: 'mcp:notifications/initialized',
  toolsList: 'mcp:tools/list',
  resourcesList: 'mcp:resources/list',
  templatesList: 'mcp:resources/templates/list',
  promptsList: 'mcp:prompts/list',
} as const;

async function openMcpRun(page: Page): Promise<void> {
  await openViewer(page, { query: 'fixture=mcp' });
  await expect(nodeCard(page, NODES.session)).toBeVisible();
}

/** The fold chevron on a card; `aria-expanded` says which way it points. */
function foldToggle(page: Page, nodeId: string): Locator {
  return nodeCard(page, nodeId).locator('.gm-fold');
}

async function isFolded(page: Page, nodeId: string): Promise<boolean> {
  return (await foldToggle(page, nodeId).getAttribute('aria-expanded')) === 'false';
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

test('protocol traffic is one card the user can fold and unfold, with counts', async ({ page }) => {
  await openMcpRun(page);

  // The group card is on the canvas as soon as the handshake starts, and the
  // six protocol calls settle within the first second of the replay.
  const protocol = nodeCard(page, NODES.protocol);
  await expect(protocol).toBeVisible();
  await expect(protocol.locator('.gm-node-title')).toHaveText('protocol');
  await expect(foldToggle(page, NODES.protocol)).toBeVisible({ timeout: 25_000 });

  // Whether the canvas opened it folded (sender hint honoured) or open, the
  // user must be able to reach both states from the chevron.
  if (!(await isFolded(page, NODES.protocol))) await foldToggle(page, NODES.protocol).click();
  await expect(nodeBody(page, NODES.protocol)).toHaveClass(/gm-node--group/);
  await expect(protocol).toContainText('6 protocol calls', { timeout: 25_000 });
  await expect(protocol).toContainText('702ms');
  await expect(protocol).not.toContainText('failed');
  for (const nodeId of Object.values(PROTOCOL)) {
    await expect(nodeCard(page, nodeId), `${nodeId} should be hidden inside the fold`).toHaveCount(0);
  }
  // The work is never folded away with the chatter.
  await expect(nodeCard(page, NODES.search)).toBeVisible();
  await expect(nodeCard(page, NODES.prompt)).toBeVisible();

  // Unfold: the six protocol calls come back as ordinary cards.
  await foldToggle(page, NODES.protocol).click();
  await expect(nodeBody(page, NODES.protocol)).not.toHaveClass(/gm-node--group/);
  for (const nodeId of Object.values(PROTOCOL)) {
    await expect(nodeCard(page, nodeId)).toBeVisible();
  }
  await expect(nodeBody(page, PROTOCOL.initialize)).toHaveClass(/gm-node--ok/, { timeout: 25_000 });
  await expect(nodeCard(page, PROTOCOL.initialize).locator('.gm-node-title')).toHaveText('initialize');
});

test('the protocol group opens folded on first sight (sender hint `collapsed: true`)', async ({
  page,
}) => {
  // The proxy emits `node.started … collapsed: true`; applyEvent keeps the
  // flag on NodeState and RunCanvas folds hinted roots once, on first sight,
  // whatever the run size. The user's unfold is never re-folded.
  await openMcpRun(page);
  await expect(nodeBody(page, NODES.protocol)).toHaveClass(/gm-node--group/, { timeout: 25_000 });
  await expect(nodeCard(page, PROTOCOL.initialize)).toHaveCount(0);
  await expect(nodeCard(page, NODES.search)).toBeVisible();
  // …and the user can still unfold it.
  await foldToggle(page, NODES.protocol).click();
  await expect(nodeCard(page, PROTOCOL.initialize)).toBeVisible();
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
