/**
 * "Edit arguments" as the user meets it (0.6.0, contract C2).
 *
 * `?fixture=edit` replays an agent whose `run_sql` call throws and holds at
 * an editable error gate; the fixture answers edits the way the app does
 * (store/editFixture.ts) — a schema refusal keeps the gate held, an accepted
 * edit releases it and the recorded retry succeeds. No GraphMind server is
 * involved: until the hub forwards input edits (W3), this is the whole loop
 * the viewer owns — the editor, the changed-keys payload, the refusal, the
 * edited pill and the before/after.
 */
import { EDIT_NODES } from '../src/store/editFixture.js';
import { expect, nodeCard, openFixtureRun, openViewer, pauseBanner, runStatusPill, test, waitForPlantedPause } from './harness.js';
import type { Page } from '@playwright/test';

function inspector(page: Page) {
  return page.getByRole('complementary', { name: 'Node inspector' });
}

function footer(page: Page) {
  return inspector(page).locator('footer.gm-inspect-held');
}

function editor(page: Page) {
  return page.getByRole('group', { name: 'Edit arguments for run_sql' });
}

async function openEditRun(page: Page): Promise<void> {
  await openViewer(page, { query: 'fixture=edit' });
  await expect(pauseBanner(page, EDIT_NODES.sql)).toBeVisible({ timeout: 30_000 });
  await expect(runStatusPill(page)).toHaveText('paused');
  // The held node opens the inspector on its own.
  await expect(footer(page)).toBeVisible();
}

/** The draft as the model asked for it, with some keys replaced. */
async function draftWith(page: Page, patch: Record<string, unknown>): Promise<void> {
  const box = editor(page).getByRole('textbox', { name: 'Arguments for run_sql, as JSON' });
  const current = JSON.parse(await box.inputValue()) as Record<string, unknown>;
  await box.fill(JSON.stringify({ ...current, ...patch }, null, 2));
}

test('edit, get refused, fix, retry: the call runs with the changed keys and is marked edited', async ({ page }) => {
  await openEditRun(page);

  // Offered on the card (short label) and in the panel, with the e shortcut.
  await expect(pauseBanner(page, EDIT_NODES.sql).getByRole('button', { name: 'Edit args…', exact: true })).toBeVisible();
  const open = footer(page).getByRole('button', { name: 'Edit arguments…', exact: true });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('e');
  await expect(editor(page)).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  const box = editor(page).getByRole('textbox', { name: 'Arguments for run_sql, as JSON' });
  await expect(box).toBeFocused();
  // Prefilled from the recorded arguments of the held call.
  await expect(box).toHaveValue(/FROM user ORDER BY/);
  await expect(editor(page).getByTestId('edit-scope')).toHaveText(
    'This call only. The model still sees the arguments it asked for.',
  );
  // The preview key is called out before anyone edits it.
  await expect(editor(page)).toContainText('"context" was recorded as a preview');
  await expect(editor(page).getByRole('button', { name: 'No changes yet' })).toBeDisabled();

  // Two changes; the diff says so before anything runs.
  await draftWith(page, { query: 'SELECT name, created_at FROM users ORDER BY created_at DESC', limit: 500 });
  const diff = editor(page).getByTestId('edit-diff');
  await expect(diff).toContainText('2 changes — only these keys are sent');
  await expect(diff.getByTestId('edit-change')).toHaveCount(2);
  await expect(diff.getByTestId('edit-change').nth(1)).toContainText('limit');
  await expect(diff.getByTestId('edit-change').nth(1)).toContainText('500');

  // The tool's schema refuses; the gate stays held and the draft stays.
  await editor(page).getByRole('button', { name: 'Retry with 2 changes' }).click();
  const refusal = editor(page).getByTestId('edit-refusal');
  await expect(refusal).toHaveText("The tool's schema rejected this: limit: must be an integer from 1 to 100");
  await expect(runStatusPill(page)).toHaveText('paused');
  await expect(box).toHaveValue(/"limit": 500/);

  // Fix and retry with ⌘/ctrl-Enter.
  await draftWith(page, { limit: 50 });
  await box.press('ControlOrMeta+Enter');
  await expect(pauseBanner(page, EDIT_NODES.sql)).toHaveCount(0, { timeout: 20_000 });

  // The trail: the edited pill on the card, before/after in the inspector.
  await expect(nodeCard(page, EDIT_NODES.sql).locator('.gm-pill--edited')).toHaveText('edited');
  const edited = inspector(page).getByTestId('edited-args');
  await expect(edited).toBeVisible();
  await expect(edited).toContainText('This call only. The model still sees the arguments it asked for.');
  const rows = edited.getByTestId('edited-change');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('FROM user ORDER BY');
  await expect(rows.nth(0)).toContainText('FROM users ORDER BY');
  await expect(rows.nth(1)).toContainText('20');
  await expect(rows.nth(1)).toContainText('50');
  // The recorded retry plays out.
  await expect(runStatusPill(page)).toHaveText('done', { timeout: 20_000 });
});

test('a truncated preview can be kept or replaced whole, never edited inside; a removed key is blocked', async ({
  page,
}) => {
  await openEditRun(page);
  await footer(page).getByRole('button', { name: 'Edit arguments…', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  const box = editor(page).getByRole('textbox', { name: 'Arguments for run_sql, as JSON' });

  // Editing inside the preview: blocked, with the way out.
  const recorded = JSON.parse(await box.inputValue()) as Record<string, string>;
  await draftWith(page, { context: String(recorded['context']).replace('Weekly', 'Monthly') });
  const problems = editor(page).getByTestId('edit-problems');
  await expect(problems).toContainText('"context" was recorded as a truncated preview');
  await expect(editor(page).getByRole('button', { name: 'Retry with 1 change' })).toBeDisabled();

  // Replacing it whole: allowed.
  await draftWith(page, { context: 'Short, complete context.' });
  await expect(problems).toHaveCount(0);
  await expect(editor(page).getByRole('button', { name: 'Retry with 1 change' })).toBeEnabled();

  // Removing a key cannot be expressed (unmentioned keys keep their live value).
  const { database: _database, ...rest } = JSON.parse(await box.inputValue()) as Record<string, unknown>;
  await box.fill(JSON.stringify(rest, null, 2));
  await expect(editor(page).getByTestId('edit-problems')).toContainText('"database" was removed');

  // Escape closes the editor — and only the editor.
  await box.press('Escape');
  await expect(editor(page)).toHaveCount(0);
  await expect(inspector(page)).toBeVisible();
  await expect(runStatusPill(page)).toHaveText('paused');

  // The draft survives: reopening shows what was typed.
  await footer(page).getByRole('button', { name: 'Edit arguments…', exact: true }).click();
  await expect(box).not.toHaveValue(/"database"/);
});

test('the card’s button opens the editor in the inspector', async ({ page }) => {
  await openEditRun(page);
  await inspector(page).getByRole('button', { name: 'Close inspector' }).click();
  await expect(inspector(page)).toHaveCount(0);
  await pauseBanner(page, EDIT_NODES.sql).getByRole('button', { name: 'Edit args…', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByRole('textbox', { name: 'Arguments for run_sql, as JSON' })).toBeFocused();
});

test('a gate that is not editable offers no editor, and e does nothing', async ({ page }) => {
  await openFixtureRun(page);
  const banner = await waitForPlantedPause(page);
  await expect(banner.getByRole('button', { name: 'Inject…', exact: true })).toBeVisible();
  await expect(banner.getByRole('button', { name: /^Edit arg/ })).toHaveCount(0);
  await page.keyboard.press('e');
  await expect(page.getByRole('group', { name: /^Edit arguments for/ })).toHaveCount(0);
  await expect(runStatusPill(page)).toHaveText('paused');
});
