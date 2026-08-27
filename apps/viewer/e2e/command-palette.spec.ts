/**
 * ⌘K. The fast path to everything — and the one surface where a broken
 * keyboard handler is invisible until someone reaches for it.
 */
import {
  FIXTURE_NODES,
  expect,
  nodeBody,
  nodeCard,
  openFixtureRun,
  openPalette,
  test,
} from './harness.js';

/** Where a node card sits relative to the canvas viewport. */
async function cardPosition(
  page: import('@playwright/test').Page,
  nodeId: string,
): Promise<{ inside: boolean; dx: number; dy: number }> {
  const result = await page.evaluate((id) => {
    const canvas = document.querySelector('.gm-canvas');
    const card = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (canvas === null || card === null) return null;
    const c = canvas.getBoundingClientRect();
    const n = card.getBoundingClientRect();
    const cx = n.left + n.width / 2;
    const cy = n.top + n.height / 2;
    return {
      inside: cx > c.left && cx < c.right && cy > c.top && cy < c.bottom,
      dx: Math.abs(cx - (c.left + c.width / 2)),
      dy: Math.abs(cy - (c.top + c.height / 2)),
    };
  }, nodeId);
  if (result === null) throw new Error(`no canvas or card for ${nodeId}`);
  return result;
}

/**
 * Drag the pane so the graph leaves the viewport. The grab point has to be
 * empty background — grabbing a card would drag the node instead of panning.
 */
async function panCanvas(page: import('@playwright/test').Page, dx: number, dy: number) {
  const grab = await page.evaluate(() => {
    const canvas = document.querySelector('.gm-canvas');
    if (canvas === null) return null;
    const box = canvas.getBoundingClientRect();
    for (let fy = 0.9; fy > 0.1; fy -= 0.1) {
      for (let fx = 0.08; fx < 0.95; fx += 0.08) {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit?.classList.contains('react-flow__pane') === true) return { x, y };
      }
    }
    return null;
  });
  if (grab === null) throw new Error('no empty canvas background to grab');
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + dx, grab.y + dy, { steps: 12 });
  await page.mouse.up();
}

test('⌘K opens the palette, searches, and navigates to a node', async ({ page }) => {
  await openFixtureRun(page);
  await expect(nodeBody(page, FIXTURE_NODES.hotels)).toHaveClass(/gm-node--ok/, {
    timeout: 25_000,
  });

  // Stop the camera chasing the live run, then shove the graph off screen so
  // "navigates to a node" has something to prove.
  const follow = page.getByRole('button', { name: 'Follow the active node' });
  await follow.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await panCanvas(page, -1200, -700);
  expect((await cardPosition(page, FIXTURE_NODES.hotels)).inside).toBe(false);

  const palette = await openPalette(page);
  const input = palette.getByRole('textbox');
  await expect(input).toBeFocused();

  // Unfiltered, the run's own nodes lead.
  await expect(palette.locator('.gm-palette-group').first()).toHaveText('Nodes');
  await expect(palette.getByRole('option')).not.toHaveCount(0);

  await input.fill('searchHotels');
  const results = palette.getByRole('option');
  await expect(results.first()).toContainText('searchHotels');
  await expect(results.first()).toHaveAttribute('aria-selected', 'true');

  await input.press('Enter');
  await expect(palette).toBeHidden();

  // Navigated: selected, deep-linked, and centred on the canvas.
  await expect(nodeBody(page, FIXTURE_NODES.hotels)).toHaveClass(/gm-node--selected/);
  await expect(page.getByRole('complementary', { name: 'Node inspector' })).toContainText(
    'searchHotels',
  );
  expect(page.url()).toContain('node/tool%3AsearchHotels');

  // The camera brought it back into view, roughly centred.
  await page.waitForTimeout(900); // setCenter animates for 550ms
  const position = await cardPosition(page, FIXTURE_NODES.hotels);
  expect(position.inside, 'the palette should bring the node into view').toBe(true);
  expect(position.dx).toBeLessThan(260);
  expect(position.dy).toBeLessThan(260);
});

test('arrow keys move the selection and Escape closes the palette', async ({ page }) => {
  await openFixtureRun(page);
  const palette = await openPalette(page);
  const options = palette.getByRole('option');

  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('ArrowUp');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('">" narrows the palette to actions, and an action actually runs', async ({ page }) => {
  await openFixtureRun(page);

  // `>` from the canvas opens the palette pre-seeded in actions mode.
  await page.keyboard.press('Shift+Period');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('textbox')).toHaveValue('>');
  const groups = palette.locator('.gm-palette-group');
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toHaveText('Actions');

  await palette.getByRole('textbox').fill('>error path');
  const first = palette.getByRole('option').first();
  await expect(first).toContainText('Show only the error path');
  await first.press('Enter');

  await expect(palette).toBeHidden();
  // The filter is on: it dims everything that is not upstream of the failure.
  await expect(page.locator('.gm-toolbtn--on').first()).toBeVisible();
  await expect(nodeCard(page, FIXTURE_NODES.hotels)).toHaveClass(/gm-dim/, { timeout: 20_000 });
  await expect(nodeCard(page, FIXTURE_NODES.currency)).not.toHaveClass(/gm-dim/);
});

test('a missing term reports no match instead of an empty box', async ({ page }) => {
  await openFixtureRun(page);
  const palette = await openPalette(page);
  await palette.getByRole('textbox').fill('zzzz-not-a-thing');
  await expect(palette.locator('.gm-palette-empty')).toContainText('No match for');
  await expect(palette.getByRole('option')).toHaveCount(0);
});

test('the palette can jump between runs', async ({ page }) => {
  await openFixtureRun(page);
  const palette = await openPalette(page);
  await palette.getByRole('textbox').fill('trip-planner');
  const runOption = palette
    .getByRole('option')
    .filter({ hasText: 'run-lisbon-7f2e' })
    .first();
  await expect(runOption).toBeVisible();
  await runOption.click();
  await expect(palette).toBeHidden();
  await expect(page.locator('.gm-topbar-title h1')).toHaveText('trip-planner');
});
