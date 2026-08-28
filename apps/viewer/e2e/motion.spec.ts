/**
 * Motion, measured.
 *
 * Animation is the part of a UI that is easiest to assert about and hardest
 * to be honest about, so these tests only check things that are true or false
 * rather than pretty: that a card arriving actually animates from its caller,
 * that `prefers-reduced-motion` really does switch every keyframe off, that
 * the camera puts a held gate on screen, and that none of it costs frames on
 * a 300-node graph.
 */
import { FIXTURE_NODES, expect, nodeCard, openFixtureRun, openViewer, test } from './harness.js';

interface FrameStats {
  frames: number;
  medianMs: number;
  p95Ms: number;
  worstMs: number;
  longFrames: number;
}

/**
 * Sample real frame intervals while the viewport is panned every frame — the
 * hardest thing a canvas does, and the thing an expensive per-card animation
 * ruins first.
 */
async function measurePan(page: import('@playwright/test').Page, ms: number): Promise<FrameStats> {
  return await page.evaluate(async (duration: number) => {
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    if (viewport === null) throw new Error('no viewport');
    const original = viewport.style.transform;
    const deltas: number[] = [];
    await new Promise<void>((resolve) => {
      let previous = performance.now();
      const stop = previous + duration;
      let i = 0;
      const tick = (t: number): void => {
        deltas.push(t - previous);
        previous = t;
        i += 1;
        viewport.style.transform = `translate(${((i % 40) - 20) * 9}px, ${
          ((i % 30) - 15) * 7
        }px) scale(0.42)`;
        if (t < stop) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    viewport.style.transform = original;
    // Drop the first two: the first interval is the scheduling gap, the
    // second is the first real paint after a style change.
    const sorted = deltas.slice(2).sort((a, b) => a - b);
    const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    return {
      frames: sorted.length,
      medianMs: at(0.5),
      p95Ms: at(0.95),
      worstMs: sorted[sorted.length - 1] ?? 0,
      longFrames: sorted.filter((d) => d > 50).length,
    };
  }, ms);
}

test('a card arriving animates in from its caller', async ({ page }) => {
  await openFixtureRun(page);

  // The vector is computed at layout time and written onto the React Flow
  // wrapper; the keyframe reads it. A tool's caller is above it, so the
  // offset points upwards.
  const enter = await nodeCard(page, FIXTURE_NODES.flights).evaluate((el) => {
    const style = getComputedStyle(el);
    const card = el.querySelector('.gm-node');
    return {
      x: style.getPropertyValue('--gm-in-x').trim(),
      y: style.getPropertyValue('--gm-in-y').trim(),
      animation: card === null ? '' : getComputedStyle(card).animationName,
    };
  });
  expect(enter.animation).toBe('gm-node-in');
  expect(enter.y).not.toBe('');
  expect(Number.parseFloat(enter.y)).toBeLessThan(0);
});

test('a finishing node gets exactly one state-change cue, then goes quiet', async ({ page }) => {
  await openFixtureRun(page);

  // The cue lives for ~620ms, so polling for it from the test side is a race.
  // Watch for it from inside the page instead, and read the pseudo-element's
  // animation while the class is actually on.
  const cue = await page.evaluate(
    async (nodeId: string) => {
      const wrapper = await new Promise<Element>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no card')), 30_000);
        const find = (): boolean => {
          const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
          if (el === null) return false;
          clearTimeout(timer);
          resolve(el);
          return true;
        };
        if (!find()) {
          const observer = new MutationObserver(() => {
            if (find()) observer.disconnect();
          });
          observer.observe(document.body, { subtree: true, childList: true });
        }
      });

      return await new Promise<{ cues: string[]; ring: string }>((resolve, reject) => {
        const cues: string[] = [];
        const timer = setTimeout(() => reject(new Error('no state-change cue seen')), 30_000);
        const observer = new MutationObserver(() => {
          const card = wrapper.querySelector('.gm-node');
          if (card === null) return;
          const settled = card.classList.contains('gm-node--settled');
          if (!settled) return;
          cues.push('settled');
          const ring = getComputedStyle(card, '::after').animationName;
          clearTimeout(timer);
          observer.disconnect();
          resolve({ cues, ring });
        });
        observer.observe(wrapper, { subtree: true, attributes: true, attributeFilter: ['class'] });
      });
    },
    FIXTURE_NODES.flights,
  );

  expect(cue.cues).toEqual(['settled']);
  expect(cue.ring).toBe('gm-ring-in');

  // …and it is genuinely one-shot: the card is quiet again shortly after.
  await expect(nodeCard(page, FIXTURE_NODES.flights).locator('.gm-node--settled')).toHaveCount(0, {
    timeout: 5_000,
  });
});

test('prefers-reduced-motion switches every keyframe off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFixtureRun(page);
  await expect(nodeCard(page, FIXTURE_NODES.llm)).toBeVisible();

  const running = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => (a as unknown as { animationName?: string }).animationName ?? 'unnamed'),
  );
  expect(running, `animations still running under reduced motion: ${running.join(', ')}`).toEqual(
    [],
  );

  // The two *states* that are ongoing must still be visible standing still.
  await expect(nodeCard(page, FIXTURE_NODES.llm).locator('.gm-node--running')).toBeVisible();
  const ringOpacity = await nodeCard(page, FIXTURE_NODES.llm)
    .locator('.gm-node')
    .evaluate((el) => getComputedStyle(el, '::before').opacity);
  expect(Number.parseFloat(ringOpacity)).toBeGreaterThan(0.3);
});

test('a held gate is put on screen, clear of the inspector that explains it', async ({ page }) => {
  await openFixtureRun(page);
  const banner = nodeCard(page, FIXTURE_NODES.currency).locator('.gm-pause-banner');
  await expect(banner).toBeVisible({ timeout: 45_000 });

  const inspector = page.getByRole('complementary', { name: 'Node inspector' });
  await expect(inspector).toBeVisible();

  // Give the camera its hold animation plus the re-frame the inspector
  // opening provokes.
  await page.waitForTimeout(1_600);

  const geometry = await page.evaluate(() => {
    const card = document.querySelector('.react-flow__node[data-id="tool:currencyConvert"]');
    const panel = document.querySelector('.gm-inspector');
    const canvas = document.querySelector('.gm-canvas');
    if (card === null || panel === null || canvas === null) return null;
    return {
      card: card.getBoundingClientRect(),
      panel: panel.getBoundingClientRect(),
      canvas: canvas.getBoundingClientRect(),
    };
  });
  expect(geometry).not.toBeNull();
  if (geometry === null) return;

  // Entirely inside the canvas…
  expect(geometry.card.top).toBeGreaterThanOrEqual(geometry.canvas.top - 1);
  expect(geometry.card.bottom).toBeLessThanOrEqual(geometry.canvas.bottom + 1);
  expect(geometry.card.left).toBeGreaterThanOrEqual(geometry.canvas.left - 1);
  // …and not underneath the inspector.
  expect(geometry.card.right).toBeLessThanOrEqual(geometry.panel.left);

  // Which means the action row is clickable where it is.
  await banner.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(banner).toBeHidden();
});

test('a 300-node graph still paints at speed while panning', async ({ page }, testInfo) => {
  await openViewer(page, { query: 'stress=300&pace=0' });
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => (window as unknown as Record<string, unknown>)['__graphmindStress'] !== undefined,
        ),
      { message: 'the stress run should finish ingesting', timeout: 60_000 },
    )
    .toBe(true);

  // Unfold everything, then frame the whole run so React Flow's virtualizer
  // actually mounts it. Panning a canvas with fifteen cards on it proves
  // nothing; the number that matters is what happens with hundreds.
  await page.getByRole('button', { name: /folded$/ }).click();
  await expect(page.getByRole('button', { name: 'Collapse', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fit view' }).click();
  await expect
    .poll(async () => await page.locator('.react-flow__node').count(), {
      message: 'a big slice of the graph should be mounted before measuring',
      timeout: 20_000,
    })
    .toBeGreaterThan(90);
  await page.waitForTimeout(400);

  const mounted = await page.locator('.react-flow__node').count();
  const stats = await measurePan(page, 2_500);
  await testInfo.attach('pan-frames.json', {
    body: JSON.stringify({ ...stats, mounted }, null, 2),
    contentType: 'application/json',
  });
  expect(mounted).toBeGreaterThan(90);

  // A headless CI runner is not a 120Hz laptop, so this is a "did we make it
  // pathological?" floor rather than a frame-rate promise: a median frame
  // budget of two 60Hz frames, and essentially no stalls.
  expect(stats.frames).toBeGreaterThan(30);
  expect(stats.medianMs, `median frame ${stats.medianMs.toFixed(1)}ms`).toBeLessThan(34);
  expect(stats.longFrames, `${stats.longFrames} frames over 50ms`).toBeLessThan(
    Math.ceil(stats.frames * 0.1),
  );
});

test('the flourishes switch themselves off on a graph too big to afford them', async ({ page }) => {
  await openViewer(page, { query: 'stress=300&pace=0' });
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => (window as unknown as Record<string, unknown>)['__graphmindStress'] !== undefined,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  await page.getByRole('button', { name: /folded$/ }).click();
  await page.waitForTimeout(600);

  await expect(page.locator('.gm-canvas--big')).toBeVisible();
  const animation = await page
    .locator('.react-flow__node .gm-node')
    .first()
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(animation).toBe('none');
});
