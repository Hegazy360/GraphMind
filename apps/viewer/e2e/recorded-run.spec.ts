/**
 * A run exported by `graphmind record --html` is a frozen record: no
 * process, no server, nowhere for a control to go. The `FixtureConnection`
 * that backs such a page drops everything except `exec.resume`, so every
 * other debugger control was UI theatre — the Run/Step segments and "Break
 * everywhere" changed local state and broadcast into the void, and the
 * per-tool breakpoint dots lit up red for a breakpoint nothing would ever
 * honour.
 *
 * The rule this file holds: a control that cannot act is visibly dead and
 * says why. (The resume actions inside a held gate are covered in
 * deep-links.spec.ts — that page already offers none.)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditPage } from './audit.js';
import { FIXTURE_NODES, expect, nodeCard, openFixtureRun, openViewer, test } from './harness.js';

const EXPORTED_RUN: unknown[] = JSON.parse(
  readFileSync(new URL('../src/fixtures/demo-run.json', import.meta.url), 'utf8'),
) as unknown[];

/** Load the exported run and wait for its cards. */
async function openExported(page: import('@playwright/test').Page): Promise<void> {
  await openViewer(page, { embeddedRun: EXPORTED_RUN });
  await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 10_000 });
}

test('the run/step segments are disabled in an exported run, and say why', async ({ page }) => {
  await openExported(page);

  const run = page.getByRole('radio', { name: 'Run', exact: true });
  const step = page.getByRole('radio', { name: 'Step', exact: true });
  await expect(run).toBeDisabled();
  await expect(step).toBeDisabled();
  await expect(step).toHaveAttribute('title', /frozen record|Nothing is executing/);

  // And clicking gets you nowhere: the mode does not change.
  await step.click({ force: true }).catch(() => undefined);
  await expect(run).toHaveClass(/gm-seg--on/);
  await expect(step).not.toHaveClass(/gm-seg--on/);
});

test('"Break everywhere" is disabled in an exported run and adds no breakpoint', async ({
  page,
}) => {
  await openExported(page);

  const breakAll = page.getByRole('button', { name: /Break everywhere/ });
  await expect(breakAll).toBeDisabled();
  await expect(breakAll).toHaveAttribute('title', /frozen record|Nothing is executing/);

  await breakAll.click({ force: true }).catch(() => undefined);
  // No chip: nothing was armed, so nothing claims to be armed.
  await expect(page.locator('.gm-chip--bp')).toHaveCount(0);
});

test('per-tool breakpoint dots are inert in an exported run', async ({ page }) => {
  await openExported(page);

  const card = nodeCard(page, FIXTURE_NODES.flights);
  // The dot still reads as part of the card, but it is not a control.
  await expect(card.locator('.gm-bp--dead')).toHaveCount(1);
  await expect(card.locator('button.gm-bp')).toHaveCount(0);
  await expect(card.locator('.gm-bp--dead')).toHaveAttribute('title', /recorded run/);

  await card.locator('.gm-bp--dead').click();
  await expect(card.locator('.gm-bp--set')).toHaveCount(0);
  await expect(page.locator('.gm-chip--bp')).toHaveCount(0);
});

test('the run bar names what it is attached to: nothing', async ({ page }) => {
  await openExported(page);
  await expect(page.locator('.gm-runbar-endpoint')).toHaveText('recorded · no server');
  await expect(page.locator('.gm-conn-label')).toHaveText('replaying');
});

/**
 * The guard on the other side: a paced fixture replay is a *local* session
 * with a `FixtureConnection` that really does honour `exec.resume`, and the
 * viewer is authoritative for mode and breakpoints. Those controls stay
 * live — this fix disables what cannot act, not everything that is offline.
 */
test('a paced replay keeps its debugger controls', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/WebSocket connection to .* failed|ws:\/\/127\.0\.0\.1:\d+\/ws\/ui/);
  await openFixtureRun(page);

  await expect(page.getByRole('radio', { name: 'Step', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Break everywhere/ })).toBeEnabled();

  await page.getByRole('button', { name: /Break everywhere/ }).click();
  await expect(page.locator('.gm-chip--bp')).toHaveCount(1);
});

/**
 * Disabled must not mean unreadable. A control that has been switched off
 * still has to say what it is and why it is off, in both themes — greying it
 * into the background would trade one dishonesty for another.
 */
for (const theme of ['dark', 'light'] as const) {
  test(`${theme} theme: the disabled controls stay legible`, async ({ page }, testInfo) => {
    await openViewer(page, { embeddedRun: EXPORTED_RUN, theme, colorScheme: theme });
    await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 10_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const report = await auditPage(page, {
      textSelectors: ['.gm-seg button', '.gm-toolbtn', '.gm-conn-label', '.gm-runbar-endpoint'],
      rowSelectors: ['.gm-runbar', '.gm-seg'],
      minRatio: 3,
    });
    await testInfo.attach(`recorded-runbar-${theme}.png`, {
      body: await page.locator('.gm-runbar').screenshot(),
      contentType: 'image/png',
    });
    expect(report.inspected).toBeGreaterThan(3);
    expect(report.clipped, 'a disabled control with its label cut off').toEqual([]);
    expect(report.overlapping, 'run bar controls overlapping').toEqual([]);
    expect(report.contrast, 'a disabled control faded below 3:1').toEqual([]);
  });
}

// ── a REAL export: `graphmind record --html`'s own exporter ────────────────
//
// The viewer lazily imports its price table (`import("./data_slim-<hash>.js")`).
// Inlined into one file, that specifier resolves against the DOCUMENT: an
// export served from a folder fetched — and ran — whatever file sat next to
// it, in its origin, beside every envelope of the run; from disk it failed
// with CORS errors and no cost. The export now carries the table as data and
// forbids loading anything (CSP). Built here with the CLI's own buildRunHtml
// (what `record --html` calls) from the viewer this suite just built.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const EXPORTER = join(REPO, 'packages', 'cli', 'dist', 'export-html.js');
const VIEWER_DIST = join(REPO, 'apps', 'viewer', 'dist');

type BuildRunHtml = (options: {
  runId: string;
  app: string;
  events: { seq: number; ts: number; runId: string; type: string; nodeId: string | null; payload: unknown }[];
  schemaVersion: number;
  viewerDist: string;
  version: string;
}) => string;

async function realExport(): Promise<string> {
  const { buildRunHtml } = (await import(pathToFileURL(EXPORTER).href)) as { buildRunHtml: BuildRunHtml };
  const envelopes = EXPORTED_RUN as { seq: number; ts: number; runId: string; type: string; payload: Record<string, unknown> }[];
  return buildRunHtml({
    runId: envelopes[0]?.runId ?? 'run',
    app: 'trip-planner',
    events: envelopes.map((e) => ({
      seq: e.seq,
      ts: e.ts,
      runId: e.runId,
      type: e.type,
      nodeId: (e.payload['nodeId'] as string | undefined) ?? null,
      payload: e.payload,
    })),
    schemaVersion: 1,
    viewerDist: VIEWER_DIST,
    version: '0.6.0-e2e',
  });
}

/** Files planted beside the export: every lazy chunk name the viewer build has. */
function plantSiblings(folder: string): string[] {
  const names = readdirSync(join(VIEWER_DIST, 'assets')).filter((f) => f.endsWith('.js') && !f.startsWith('index-'));
  for (const name of names) {
    writeFileSync(
      join(folder, name),
      'window.__PLANTED__ = (Array.isArray(window.__GRAPHMIND_RUN__) ? window.__GRAPHMIND_RUN__.length : 0);\nexport default [];\n',
    );
  }
  return names;
}

test.describe('a real record --html export', () => {
  test.skip(!existsSync(EXPORTER), 'needs the workspace packages built: pnpm -r --filter ./packages/** run build');

  let root: string;
  let server: Server;
  let origin: string;
  const served: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'graphmind-export-e2e-'));
    mkdirSync(join(root, 'team'));
    writeFileSync(join(root, 'team', 'run.html'), await realExport());
    expect(plantSiblings(join(root, 'team')).some((n) => n.startsWith('data_slim-'))).toBe(true);
    server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      served.push(path);
      const file = normalize(join(root, path));
      if (!file.startsWith(root + sep) || !existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/javascript' }).end(readFileSync(file));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    rmSync(root, { recursive: true, force: true });
  });

  test('served from a folder, it loads nothing beside itself, runs nothing planted there, and still prices the run', async ({ page }) => {
    served.length = 0;
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    await page.goto(`${origin}/team/run.html`);
    await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 15_000 });
    // The demo's LLM steps report usage: the top bar prices them from the
    // table the file carries.
    await expect(page.locator('.gm-topbar-stats')).toContainText('est. cost');
    await expect(page.locator('.gm-topbar-stats')).toContainText('$0.024');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as { __PLANTED__?: unknown }).__PLANTED__)).toBeUndefined();
    expect(requested.filter((url) => !url.endsWith('/team/run.html') && !url.endsWith('/favicon.ico'))).toEqual([]);
    expect(served.filter((path) => path !== '/team/run.html' && path !== '/favicon.ico')).toEqual([]);
  });

  test('opened from disk, it prices the run with no request and no console error', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    await page.goto(pathToFileURL(join(root, 'team', 'run.html')).href);
    await expect(page.locator('.react-flow__node')).toHaveCount(7, { timeout: 15_000 });
    await expect(page.locator('.gm-topbar-stats')).toContainText('$0.024');
    await page.getByRole('button', { name: 'Fit view' }).click();
    await page.waitForTimeout(700);
    await nodeCard(page, FIXTURE_NODES.llm).locator('.gm-node-title').click();
    const ctx = page.getByRole('complementary', { name: 'Node inspector' }).getByTestId('context-cost');
    await expect(ctx).toContainText('≈ est. (prices as of');
    await expect(ctx).not.toContainText('Prices unavailable here');
    expect(requested.filter((url) => url.includes('data_slim') || url.includes('synthetic-'))).toEqual([]);
    // (The harness fails the test on any console error — a CSP refusal included.)
  });
});
