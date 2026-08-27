/**
 * The gate. This is the thing GraphMind claims that a trace viewer cannot:
 * execution is *held*, and the developer decides what happens next.
 *
 * The bundled replay implements the real control round-trip — it stops on
 * `exec.paused` and only moves again when the viewer sends `exec.resume` —
 * so these tests exercise the same code path a live run does, minus the
 * socket.
 */
import {
  FIXTURE_NODES,
  edgeInto,
  executionCount,
  expect,
  nodeBody,
  nodeCard,
  openFixtureRun,
  runStatusPill,
  test,
  waitForPlantedPause,
} from './harness.js';

const RESUME_ACTIONS = ['Continue', 'Step', 'Retry', 'Inject…', 'Abort'];

/**
 * The LLM step's execution counter — the cheapest proof that execution has
 * (or has not) moved on. The recording runs the step three times; the gate
 * holds before the third.
 */
function llmBadge(page: import('@playwright/test').Page) {
  return nodeCard(page, FIXTURE_NODES.llm).locator('.gm-badge-count');
}

test('the run genuinely stops at the planted error and offers every resume action', async ({
  page,
}) => {
  await openFixtureRun(page);
  const banner = await waitForPlantedPause(page);

  await expect(banner.locator('.gm-pause-label')).toHaveText(/Paused on error/);
  await expect(banner.locator('.gm-pause-error')).toContainText('RateLimitError');
  await expect(banner.locator('.gm-pause-error')).toContainText('HTTP 429');

  for (const label of RESUME_ACTIONS) {
    await expect(banner.getByRole('button', { name: label, exact: true })).toBeVisible();
  }

  // The whole UI agrees that execution is held.
  await expect(runStatusPill(page)).toHaveText('paused');
  await expect(nodeBody(page, FIXTURE_NODES.currency)).toHaveClass(/gm-node--paused/);
  await expect(edgeInto(page, FIXTURE_NODES.currency)).toHaveClass(/gm-edge-paused/);

  // …and it is a real hold, not a badge. The recording's third LLM step is
  // the next thing that would run; while the gate is held it never starts,
  // so the step card stays at two executions no matter how long we wait.
  await expect(llmBadge(page)).toHaveText('×2');
  await page.waitForTimeout(4_000);
  await expect(llmBadge(page)).toHaveText('×2');
  await expect(runStatusPill(page)).toHaveText('paused');
  await expect(banner).toBeVisible();
});

test('Continue releases the gate and the run finishes', async ({ page }) => {
  await openFixtureRun(page);
  const banner = await waitForPlantedPause(page);

  await banner.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(banner).toBeHidden();
  // Execution moves again: the third LLM step starts.
  await expect(llmBadge(page)).toHaveText('×3', { timeout: 20_000 });
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });
  await expect(nodeBody(page, FIXTURE_NODES.agent)).toHaveClass(/gm-node--ok/);
});

test('Retry runs the failed call again and it succeeds the second time', async ({ page }) => {
  await openFixtureRun(page);
  const banner = await waitForPlantedPause(page);

  await expect(executionCount(page, FIXTURE_NODES.currency)).resolves.toBe(1);

  await banner.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(banner).toBeHidden();

  // Honest about what the fixture can prove: the replay does not re-execute
  // anything, it plays the recorded retry that follows the gate. So this
  // asserts the *visible* contract of the Retry button — gate released, the
  // failed call runs a second time, that attempt succeeds — not that a
  // `retry` control reached a live adapter. The adapter side of that round
  // trip is covered by examples/e2e against a real server.

  // What "run this call again" has to mean on screen: a second execution of
  // the same logical node, and that one succeeds.
  await expect(nodeCard(page, FIXTURE_NODES.currency).locator('.gm-badge-count')).toHaveText('×2', {
    timeout: 20_000,
  });
  await expect(nodeBody(page, FIXTURE_NODES.currency)).toHaveClass(/gm-node--ok/, {
    timeout: 20_000,
  });
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });

  // The inspector keeps both attempts, the failure and the retry.
  await nodeCard(page, FIXTURE_NODES.currency).locator('.gm-node-title').click();
  const inspector = page.getByRole('complementary', { name: 'Node inspector' });
  await expect(inspector.locator('.gm-exec-chip')).toHaveCount(2);
  await expect(inspector.locator('.gm-exec-chip--error')).toHaveCount(1);
  await expect(inspector.locator('.gm-exec-chip--ok')).toHaveCount(1);
});

test('Abort ends the run instead of continuing it', async ({ page }) => {
  await openFixtureRun(page);
  const banner = await waitForPlantedPause(page);

  await banner.getByRole('button', { name: 'Abort', exact: true }).click();

  await expect(banner).toBeHidden();
  await expect(runStatusPill(page)).toHaveText('aborted', { timeout: 20_000 });

  // Abort means abort: the recorded remainder (the retry, the third LLM
  // step, the successful finish) must never play.
  await page.waitForTimeout(5_000);
  await expect(runStatusPill(page)).toHaveText('aborted');
  await expect(llmBadge(page)).toHaveText('×2');
  await expect(nodeBody(page, FIXTURE_NODES.agent)).not.toHaveClass(/gm-node--ok/);
});

test('Inject substitutes a result: editor, JSON validation, injected badge, happy ending', async ({
  page,
}) => {
  await openFixtureRun(page);
  const banner = await waitForPlantedPause(page);

  await banner.getByRole('button', { name: 'Inject…', exact: true }).click();

  const editor = banner.locator('.gm-inject textarea');
  await expect(editor).toBeVisible();
  // Prefilled from the failed call so you edit a shape instead of inventing one.
  await expect(editor).toHaveValue(/"amount": 1372/);

  // Bad JSON is refused, in place, without resuming anything.
  await editor.fill('{ not json');
  await banner.locator('.gm-inject').getByRole('button', { name: /Inject/ }).click();
  await expect(banner.locator('.gm-inject').getByRole('button', { name: 'Invalid JSON' })).toBeVisible();
  await expect(editor).toHaveClass(/gm-invalid/);
  await expect(runStatusPill(page)).toHaveText('paused');

  // Good JSON resumes the run with the substituted output.
  await editor.fill('{"rate": 1.0834, "converted": "$1,486.43", "source": "injected-by-e2e"}');
  await banner.locator('.gm-inject').getByRole('button', { name: 'Inject & resume' }).click();

  const card = nodeCard(page, FIXTURE_NODES.currency);
  await expect(card.locator('.gm-pill--injected')).toHaveText('injected', { timeout: 20_000 });
  await expect(nodeBody(page, FIXTURE_NODES.currency)).toHaveClass(/gm-node--ok/);
  // The injected result replaces the failure — there is no second attempt.
  await expect(card.locator('.gm-badge-count')).toHaveCount(0);

  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });

  // …and the inspector reports where that value came from.
  await card.locator('.gm-node-title').click();
  const inspector = page.getByRole('complementary', { name: 'Node inspector' });
  await expect(inspector).toContainText('injected from the debugger');
  await expect(inspector).toContainText('injected-by-e2e');
});

test('Step switches the debugger into step mode as it resumes', async ({ page }) => {
  await openFixtureRun(page);
  const banner = await waitForPlantedPause(page);

  const stepButton = page.getByRole('radio', { name: 'Step' });
  await expect(stepButton).toHaveAttribute('aria-checked', 'false');

  await banner.getByRole('button', { name: 'Step', exact: true }).click();

  await expect(banner).toBeHidden();
  await expect(stepButton).toHaveAttribute('aria-checked', 'true');
  await expect(llmBadge(page)).toHaveText('×3', { timeout: 20_000 });
});
