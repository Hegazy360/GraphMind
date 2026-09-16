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

// ── canvas geometry, read off the real DOM ──────────────────────────────────

export interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomNodeBox {
  id: string;
  rect: DomRect;
  /** The 1px source (bottom) and target (top) handles, in client coordinates. */
  sourceHandle: DomRect | null;
  targetHandle: DomRect | null;
  /** Every `.gm-action` button rendered inside this card. */
  actions: DomRect[];
}

export interface DomEdgeSamples {
  id: string;
  source: string | null;
  target: string | null;
  /** Points along the rendered path, every `step` px plus the exact end. */
  samples: { x: number; y: number }[];
  /** Cumulative length of each sample (same index), so the ends can be inset. */
  lengths: number[];
  total: number;
}

export interface CanvasGeometry {
  nodes: DomNodeBox[];
  edges: DomEdgeSamples[];
  inspector: DomRect | null;
  canvas: DomRect | null;
}

/**
 * Read cards, handles, action buttons and the rendered edge paths as client
 * rectangles and points. The SVG path is sampled with `getPointAtLength` and
 * mapped through its screen CTM, so what comes back is the path as painted,
 * not the geometry the layout *intended*.
 */
export async function readCanvasGeometry(page: Page, step = 4): Promise<CanvasGeometry> {
  return await page.evaluate((stepPx: number) => {
    const box = (el: Element): DomRect => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    const nodes: DomNodeBox[] = [];
    const ids: string[] = [];
    for (const el of document.querySelectorAll('.react-flow__node')) {
      const id = el.getAttribute('data-id') ?? '';
      ids.push(id);
      const source = el.querySelector('.react-flow__handle.source');
      const target = el.querySelector('.react-flow__handle.target');
      nodes.push({
        id,
        rect: box(el),
        sourceHandle: source === null ? null : box(source),
        targetHandle: target === null ? null : box(target),
        actions: [...el.querySelectorAll('.gm-action')].map(box),
      });
    }
    // Edge ids are `e:<source>-><target>`; resolve against the node ids on
    // screen rather than splitting on '->' so an id containing an arrow
    // cannot fool the test.
    const endpoints = (edgeId: string): { source: string | null; target: string | null } => {
      for (const s of ids) {
        const prefix = `e:${s}->`;
        if (!edgeId.startsWith(prefix)) continue;
        const t = edgeId.slice(prefix.length);
        if (ids.includes(t)) return { source: s, target: t };
      }
      return { source: null, target: null };
    };
    const edges: DomEdgeSamples[] = [];
    for (const g of document.querySelectorAll('.react-flow__edge')) {
      const id = g.getAttribute('data-id') ?? '';
      const path = g.querySelector<SVGPathElement>('path.react-flow__edge-path');
      if (path === null) continue;
      const total = path.getTotalLength();
      const ctm = path.getScreenCTM();
      const samples: { x: number; y: number }[] = [];
      const lengths: number[] = [];
      const at = (length: number): void => {
        const p = path.getPointAtLength(length);
        const q = ctm === null ? p : new DOMPoint(p.x, p.y).matrixTransform(ctm);
        samples.push({ x: q.x, y: q.y });
        lengths.push(length);
      };
      for (let l = 0; l < total; l += stepPx) at(l);
      at(total);
      edges.push({ id, ...endpoints(id), samples, lengths, total });
    }
    const inspector = document.querySelector('.gm-inspector');
    const canvas = document.querySelector('.gm-canvas');
    return {
      nodes,
      edges,
      inspector: inspector === null ? null : box(inspector),
      canvas: canvas === null ? null : box(canvas),
    };
  }, step);
}

/** Strictly inside `rect` deflated by `inset` on every side. */
export function pointInside(p: { x: number; y: number }, rect: DomRect, inset = 0): boolean {
  return (
    p.x > rect.x + inset &&
    p.x < rect.x + rect.width - inset &&
    p.y > rect.y + inset &&
    p.y < rect.y + rect.height - inset
  );
}

/** Shortest distance from a point to a rectangle (0 when inside). */
export function distanceToRect(p: { x: number; y: number }, rect: DomRect): number {
  const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/** Is `inner` within `outer` (with `slack` px of tolerance)? */
export function rectWithin(inner: DomRect, outer: DomRect, slack = 1): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

/**
 * Wait until the cards have stopped moving: two reads `quietMs` apart agree
 * on every card's position. Layout moves animate for 420ms and the camera
 * for up to ~1s, and a path sampled mid-slide is a path to nowhere.
 */
export async function waitForCanvasStill(page: Page, quietMs = 300): Promise<CanvasGeometry> {
  let previous = await readCanvasGeometry(page);
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.waitForTimeout(quietMs);
    const next = await readCanvasGeometry(page);
    const same =
      next.nodes.length === previous.nodes.length &&
      next.nodes.every((node, i) => {
        const before = previous.nodes[i];
        return (
          before !== undefined &&
          before.id === node.id &&
          Math.abs(before.rect.x - node.rect.x) < 0.5 &&
          Math.abs(before.rect.y - node.rect.y) < 0.5 &&
          Math.abs(before.rect.height - node.rect.height) < 0.5
        );
      });
    if (same && next.nodes.length > 0) return next;
    previous = next;
  }
  throw new Error('canvas never came to rest');
}
