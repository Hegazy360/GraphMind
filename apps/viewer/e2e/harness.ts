/**
 * Shared harness for the browser suite.
 *
 * Two jobs:
 *  1. an auto-fixture that fails any test which logged a console error or
 *     threw an uncaught exception — the class of bug that never shows up in
 *     a node-environment unit test but greets every real user;
 *  2. loaders that put the viewer into a known state with no server: the
 *     bundled fixture replay, the synthetic stress generator, or a run
 *     inlined as `window.__GRAPHMIND_RUN__` the way `graphmind record
 *     --html` does it.
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test';

/** The bundled demo recording (apps/viewer/src/fixtures/demo-run.json). */
export const FIXTURE_RUN_ID = 'run-lisbon-7f2e';

/** Logical node ids in the bundled fixture. */
export const FIXTURE_NODES = {
  agent: 'agent:trip-planner',
  llm: 'llm:step',
  flights: 'tool:searchFlights',
  hotels: 'tool:searchHotels',
  weather: 'tool:getWeather',
  webSearch: 'tool:webSearch',
  /** The planted failure: RateLimitError, holds an error gate. */
  currency: 'tool:currencyConvert',
} as const;

/**
 * Console noise that is not the viewer's fault. Kept deliberately tiny — a
 * long allowlist is how "no console errors" quietly stops meaning anything.
 */
const ALWAYS_ALLOWED: readonly RegExp[] = [
  // Chromium requests /favicon.ico for the tab on its own and logs the 404
  // as a console error. index.html ships no icon (neither does the exported
  // single-file run), so this is the harness's own footprint, not the app's.
  /favicon\.ico/i,
];

export class ConsoleGuard {
  readonly all: string[] = [];
  private readonly allowed: RegExp[] = [...ALWAYS_ALLOWED];

  /** Permit a known-benign message for this test only. Explain why at the call site. */
  allow(...patterns: RegExp[]): void {
    this.allowed.push(...patterns);
  }

  record(text: string): void {
    this.all.push(text);
  }

  unexpected(): string[] {
    return this.all.filter((text) => !this.allowed.some((pattern) => pattern.test(text)));
  }
}

export const test = base.extend<{ consoleGuard: ConsoleGuard }>({
  consoleGuard: [
    async ({ page }, use, testInfo) => {
      const guard = new ConsoleGuard();
      page.on('console', (message) => {
        if (message.type() === 'error') guard.record(`console.error: ${message.text()}`);
      });
      page.on('pageerror', (error) => guard.record(`pageerror: ${error.message}`));

      await use(guard);

      // Only assert on a test that otherwise passed: a real failure usually
      // produces its own console noise, and burying the actual assertion
      // under "unexpected console errors" helps nobody.
      if (testInfo.status === testInfo.expectedStatus) {
        expect(guard.unexpected(), 'unexpected console errors / page errors').toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };

export interface OpenOptions {
  /** Query string without the leading `?`, e.g. `fixture=1`. */
  query?: string;
  /** Hash including the leading `#`, e.g. `#/run/x/node/y`. */
  hash?: string;
  /** Seeds `localStorage['graphmind.theme']` before the app boots. */
  theme?: 'system' | 'dark' | 'light';
  /** Emulated OS preference — what `theme: 'system'` resolves against. */
  colorScheme?: 'dark' | 'light';
  /** Envelopes to inline as `window.__GRAPHMIND_RUN__` (exported-run mode). */
  embeddedRun?: unknown[];
}

/** Load the built viewer with a known pre-boot environment. */
export async function openViewer(page: Page, options: OpenOptions = {}): Promise<void> {
  const theme = options.theme;
  // 'system' is the default for a fresh context, so seeding it would be a
  // no-op — and an init script runs on *every* navigation, which would also
  // wipe a choice made during the test before a reload could restore it.
  if (theme === 'dark' || theme === 'light') {
    await page.addInitScript((choice: string) => {
      try {
        localStorage.setItem('graphmind.theme', choice);
      } catch {
        // storage blocked — the app falls back to 'system', which is fine
      }
    }, theme);
  }

  const embedded = options.embeddedRun;
  if (embedded !== undefined) {
    await page.addInitScript((run: unknown) => {
      (window as unknown as Record<string, unknown>)['__GRAPHMIND_RUN__'] = run;
    }, embedded);
  }

  if (options.colorScheme !== undefined) {
    await page.emulateMedia({ colorScheme: options.colorScheme });
  }

  const query = options.query === undefined || options.query === '' ? '' : `?${options.query}`;
  await page.goto(`/${query}${options.hash ?? ''}`);
}

/** Load the bundled fixture replay (`?fixture=1`) and wait for the first card. */
export async function openFixtureRun(
  page: Page,
  options: Omit<OpenOptions, 'query'> = {},
): Promise<void> {
  await openViewer(page, { ...options, query: 'fixture=1' });
  await expect(nodeCard(page, FIXTURE_NODES.agent)).toBeVisible();
}

/** One React Flow node wrapper, addressed by its logical nodeId. */
export function nodeCard(page: Page, nodeId: string): Locator {
  return page.locator(`.react-flow__node[data-id="${nodeId}"]`);
}

/**
 * The card *inside* the React Flow wrapper — this is what carries the
 * `gm-node--<status>` class the whole UI is colour-coded by.
 */
export function nodeBody(page: Page, nodeId: string): Locator {
  return nodeCard(page, nodeId).locator('.gm-node').first();
}

/** The edge whose target is `nodeId` (edge ids are `e:<source>-><target>`). */
export function edgeInto(page: Page, nodeId: string): Locator {
  return page.locator(`.react-flow__edge[data-id$="->${nodeId}"]`);
}

/** The run-status pill in the toolbar ("running" / "paused" / "done" / …). */
export function runStatusPill(page: Page): Locator {
  return page.locator('.gm-topbar-title .gm-pill').first();
}

/** The resume action row rendered inside a held node. */
export function pauseBanner(page: Page, nodeId: string): Locator {
  return nodeCard(page, nodeId).locator('.gm-pause-banner');
}

/**
 * Wait for the fixture's planted error gate to hold execution.
 *
 * The replay is wall-clock paced from the recording (~6.7s to the gate), so
 * this is a real wait, not a tick.
 */
export async function waitForPlantedPause(page: Page): Promise<Locator> {
  const banner = pauseBanner(page, FIXTURE_NODES.currency);
  await expect(banner).toBeVisible({ timeout: 45_000 });
  return banner;
}

/** Number of executions the store has recorded for a node, read off its card. */
export async function executionCount(page: Page, nodeId: string): Promise<number> {
  const badge = nodeCard(page, nodeId).locator('.gm-badge-count');
  if ((await badge.count()) === 0) return 1;
  const text = (await badge.first().innerText()).trim();
  const parsed = Number(text.replace(/^×/, ''));
  return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * Wait for every finite CSS animation/transition to finish.
 *
 * Overlays fade in (`gm-pop`, `gm-fade`), so anything that measures colour
 * has to wait or it will measure a half-transparent frame and report a
 * contrast failure that does not exist. Infinite animations — the marching
 * ants on a live edge, the running pulse — are excluded by design.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getAnimations().every((animation) => {
        const iterations = animation.effect?.getComputedTiming().iterations ?? 1;
        if (iterations === Infinity) return true;
        return animation.playState === 'finished' || animation.playState === 'idle';
      }),
    undefined,
    { timeout: 10_000 },
  );
}

/**
 * Frame the whole graph.
 *
 * The camera chases the active node, so a card that is not the current focus
 * can sit outside the canvas viewport (clipped behind the toolbar) and be
 * unclickable. Fitting first is what a user does too.
 */
export async function fitGraph(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Fit view' }).click();
  // frameNodes animates for 450ms; wait for the transform to settle.
  await page.waitForTimeout(700);
}

/** Platform-correct palette chord. */
export async function openPalette(page: Page): Promise<Locator> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  return palette;
}
