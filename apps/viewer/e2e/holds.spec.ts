/**
 * The 0.6.0 hold kinds as the user meets them (contract C4): each names
 * itself on the held card, and the inspector lays out the evidence. The runs
 * are synthetic (src/store/holdFixtures.ts) inlined the way `graphmind
 * record --html` does it, so the gate reads in the past tense and offers no
 * controls — the copy and the canvas are what is under test here.
 */
import {
  HOLD_NODES,
  generateCycleRun,
  generateErrorRepeatRun,
  generateSmartRun,
} from '../src/store/holdFixtures.js';
import { expect, nodeBody, nodeCard, openViewer, pauseBanner, test } from './harness.js';
import type { Page } from '@playwright/test';

function inspector(page: Page) {
  return page.getByRole('complementary', { name: 'Node inspector' });
}

async function openInspectorOn(page: Page, nodeId: string): Promise<void> {
  if (!(await inspector(page).isVisible())) {
    await nodeCard(page, nodeId).locator('.gm-node-title').click();
  }
  await expect(inspector(page)).toBeVisible();
}

test('a cycle names its lap on the card, outlines the lap on the canvas, and lists one round', async ({ page }) => {
  await openViewer(page, { embeddedRun: generateCycleRun() });
  const banner = pauseBanner(page, HOLD_NODES.search);
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner.getByTestId('hold-label')).toHaveText(
    'Was held — loop: search → fetch, 3 identical rounds (same arguments, same results). Holding round 4 at search.',
  );
  // An exported run: no editor, even though the pause was editable.
  await expect(banner.getByRole('button', { name: /^Edit arg/ })).toHaveCount(0);

  // Both calls of the lap are outlined; the LLM step between them is not.
  await expect(nodeBody(page, HOLD_NODES.search)).toHaveAttribute('data-lap', 'true');
  await expect(nodeBody(page, HOLD_NODES.fetch)).toHaveAttribute('data-lap', 'true');
  await expect(nodeBody(page, HOLD_NODES.fetch)).toHaveClass(/gm-node--lap/);
  await expect(page.locator('[data-lap]')).toHaveCount(2);

  await openInspectorOn(page, HOLD_NODES.search);
  const evidence = inspector(page).getByTestId('cycle-evidence');
  await expect(evidence).toBeVisible();
  const calls = evidence.getByTestId('lap-call');
  await expect(calls).toHaveCount(2);
  await expect(calls.nth(0)).toContainText('search');
  await expect(calls.nth(0)).toContainText('held here, round 4');
  await expect(calls.nth(1)).toContainText('fetch');
  await expect(calls.nth(1)).toContainText('arxiv.org');
  await expect(evidence).toContainText('GRAPHMIND_LOOP_ALLOW');
});

test('an error-repeat names the streak and shows the shared error and each call’s arguments', async ({ page }) => {
  await openViewer(page, { embeddedRun: generateErrorRepeatRun() });
  const banner = pauseBanner(page, HOLD_NODES.sql);
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner.getByTestId('hold-label')).toHaveText(
    'Was held — repeated error: run_sql failed 3× in a row with the same error (arguments varied).',
  );
  await openInspectorOn(page, HOLD_NODES.sql);
  const evidence = inspector(page).getByTestId('error-repeat-evidence');
  await expect(evidence).toContainText('relation "users" does not exist');
  await expect(evidence.getByTestId('error-call')).toHaveCount(3);
  await expect(evidence.getByTestId('error-call').nth(2)).toContainText('count(*)');
});

test('smart holds say what they caught, in words', async ({ page }) => {
  await openViewer(page, { embeddedRun: generateSmartRun('error-result') });
  const banner = pauseBanner(page, HOLD_NODES.search);
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner.getByTestId('hold-label')).toHaveText(
    'Was held — search returned an error result without throwing',
  );
  await openInspectorOn(page, HOLD_NODES.search);
  const evidence = inspector(page).getByTestId('smart-evidence');
  await expect(evidence.getByTestId('smart-detail')).toHaveText('the result has isError: true');
  await expect(evidence).toContainText('GRAPHMIND_BREAK_ON_ERROR_RESULT=0');
});

test('a truncated tool call holds the LLM step and says so', async ({ page }) => {
  await openViewer(page, { embeddedRun: generateSmartRun('truncated-tool-call') });
  const banner = pauseBanner(page, HOLD_NODES.llm);
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner.getByTestId('hold-label')).toHaveText(
    'Was held — the model stopped at the token limit in the middle of a tool call',
  );
});
