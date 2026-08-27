/**
 * Browser coverage for the viewer.
 *
 * The unit suite (`pnpm --filter viewer test`) proves the reducer, the
 * layout and the stores. It cannot prove that a user sees anything: the
 * canvas, the pause banner, the inspector, the palette and the timeline all
 * live in the DOM, and until now they were verified by a human squinting at
 * a screenshot.
 *
 * These tests drive the *built* viewer — the exact bundle `pnpm build:viewer`
 * ships inside the CLI — served statically by `vite preview`. No GraphMind
 * server is involved: every run comes from the bundled fixture replay
 * (`?fixture=1`), the synthetic stress generator (`?stress=…`), or an
 * exported run inlined as `window.__GRAPHMIND_RUN__`, exactly the way
 * `graphmind record --html` does it.
 *
 * One command, headless: `pnpm --filter viewer test:e2e`.
 */
import process from 'node:process';
import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

const HOST = '127.0.0.1';
const PORT = Number(process.env['GM_E2E_PORT'] ?? 5288);
const BASE_URL = `http://${HOST}:${PORT}`;
const isCI = process.env['CI'] !== undefined;

// On CI also write the HTML report, so a failure ships the trace viewer plus
// the screenshots and audit JSON attached to the failing test — not just a log.
const reporters: ReporterDescription[] = isCI
  ? [['github'], ['list'], ['html', { open: 'never' }]]
  : [['list']];

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // Every spec drives its own page against a static server; nothing is shared.
  fullyParallel: true,
  forbidOnly: isCI,
  // The fixture replay is wall-clock paced, so a loaded runner can lose a
  // race the code did not. Retries on CI only — locally a failure is a
  // failure, first time (same policy as vitest.config.ts).
  retries: isCI ? 2 : 0,
  // Locally: Playwright's default (half the cores). On CI, pin it — hosted
  // runners are small and a paced replay competing with three siblings is
  // how a wall-clock assertion turns into a flake.
  ...(isCI ? { workers: 2 } : {}),
  reporter: reporters,
  timeout: 90_000,
  expect: { timeout: 20_000 },

  // Note: `reducedMotion` is deliberately left at the browser default. The
  // marching-ants animation on a live edge is one of the things under test,
  // and index.css switches it off under `prefers-reduced-motion: reduce`.
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Wide enough that the toolbar keeps its optional stats and the
        // canvas frames a seven-node graph without collapsing to dots.
        viewport: { width: 1440, height: 900 },
      },
    },
  ],

  webServer: {
    // Build first: these tests are about the artifact we ship, not about
    // whatever the dev server happens to transform today.
    command: `pnpm run build && pnpm exec vite preview --host ${HOST} --port ${PORT} --strictPort`,
    url: `${BASE_URL}/`,
    // Always a fresh build — reusing a stale preview server is how a green
    // suite starts lying about code that changed.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
