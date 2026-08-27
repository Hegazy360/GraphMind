/**
 * "live" has to mean live.
 *
 * The `/ws/ui` contract answers a `subscribe` with the run's stored history
 * (`replay.start {count}` → events → `replay.end`) before it tails. Under
 * ingest saturation the server services the subscribe late and a viewer
 * receives the *whole run* as catch-up: 0 live / 72,144 replayed, measured
 * across three viewers. Nothing errored, nothing warned, and the connection
 * dot stayed green — a live debugger silently demoted to a log viewer.
 *
 * These tests drive the real bundle against a scripted `/ws/ui` server
 * (Playwright's WebSocket routing — no GraphMind server involved) and hold
 * the run bar to the truth in each of the three states.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { auditPage } from './audit.js';
import { expect, openViewer, test } from './harness.js';

const RECORDED: { seq: number; ts: number; runId: string; type: string }[] = JSON.parse(
  readFileSync(new URL('../src/fixtures/demo-run.json', import.meta.url), 'utf8'),
) as { seq: number; ts: number; runId: string; type: string }[];

const RUN_ID = 'run-lisbon-7f2e';

/**
 * There is no server on the preview origin, so the first connect attempt
 * fails before routing takes over on retry; Chromium logs that.
 */
const WS_NOISE = /WebSocket connection to .* failed|ws:\/\/127\.0\.0\.1:\d+\/ws\/ui/;

function runInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    app: 'trip-planner',
    startedAt: Date.now() - 120_000,
    finishedAt: null,
    status: 'running',
    schemaVersion: 1,
    source: 'live',
    eventCount: 72_144,
    errorCount: 0,
    live: true,
    ...overrides,
  };
}

interface ServerScript {
  /** How many events `replay.start` claims are coming. */
  backlog: number;
  /** Send `replay.end` after the replayed slice (false = stay in catch-up). */
  finishReplay: boolean;
  /** Age of the events sent after `replay.end`, in ms. */
  tailAgeMs?: number;
}

/**
 * A scripted `/ws/ui` server: handshake, run list, a replay that can be left
 * deliberately unfinished, then a heartbeat tail whose event ages the test
 * chooses. Everything runs in the page, so there is nothing to tear down.
 */
async function serveScript(page: Page, script: ServerScript): Promise<void> {
  await page.routeWebSocket(/\/ws\/ui$/, (ws) => {
    const send = (frame: unknown): void => ws.send(JSON.stringify(frame));
    let tail: ReturnType<typeof setInterval> | undefined;

    ws.onMessage((raw) => {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      let message: { type?: string; runId?: string };
      try {
        message = JSON.parse(text) as { type?: string; runId?: string };
      } catch {
        return;
      }
      if (message.type !== 'subscribe') return;

      if (message.runId === '*') {
        send({ type: 'welcome', versions: { protocol: 1, server: 'e2e' }, breakpoints: [], mode: 'run' });
        send({ type: 'runs', runs: [runInfo()] });
        return;
      }
      if (message.runId !== RUN_ID) return;

      // The backlog the server claims, and a slice of it actually delivered.
      send({ type: 'replay.start', runId: RUN_ID, count: script.backlog });
      let index = 0;
      const drip = setInterval(() => {
        const envelope = RECORDED[index];
        index += 1;
        if (envelope === undefined) {
          clearInterval(drip);
          if (!script.finishReplay) return; // stuck in catch-up, on purpose
          send({ type: 'replay.end', runId: RUN_ID });
          // …then tail, with events of whatever age the test asked for.
          let seq = 90_000;
          tail = setInterval(() => {
            seq += 1;
            send({
              type: 'event',
              runId: RUN_ID,
              envelope: {
                gm: 1,
                seq,
                ts: Date.now() - (script.tailAgeMs ?? 0),
                runId: RUN_ID,
                type: 'node.token',
                payload: { nodeId: 'llm:step', deltas: [{ t: 'text', v: '.' }] },
              },
            });
          }, 250);
          return;
        }
        send({ type: 'event', runId: RUN_ID, envelope });
      }, 40);
    });

    ws.onClose(() => {
      if (tail !== undefined) clearInterval(tail);
    });
  });
}

const connLabel = (page: Page) => page.locator('.gm-conn-label');
const connGroup = (page: Page) => page.locator('.gm-conn-group');

test('a socket delivering a backlog says "catching up", not "live"', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_NOISE);
  await serveScript(page, { backlog: 72_144, finishReplay: false });
  await openViewer(page);

  // The run arrives and the canvas fills in — this is exactly the failure
  // mode: it *looks* like a live debugger.
  await expect(page.locator('.gm-topbar-title h1')).toHaveText('trip-planner', { timeout: 30_000 });

  // …and the run bar refuses to call it live.
  await expect(connLabel(page)).toHaveText(/^catching up [\d,]+\/72,144$/, { timeout: 30_000 });
  await expect(connGroup(page)).toHaveAttribute('data-phase', 'catchup');
  await expect(page.locator('.gm-conn')).toHaveClass(/gm-conn--catchup/);
  await expect(connGroup(page)).toHaveAttribute(
    'title',
    /replayed history, not the live tail/,
  );
});

test('catch-up progress advances as the backlog drains', async ({ page, consoleGuard }) => {
  consoleGuard.allow(WS_NOISE);
  await serveScript(page, { backlog: 72_144, finishReplay: false });
  await openViewer(page);

  await expect(connLabel(page)).toHaveText(/^catching up/, { timeout: 30_000 });
  const read = async (): Promise<number> => {
    const text = (await connLabel(page).innerText()).trim();
    return Number(/catching up ([\d,]+)/.exec(text)?.[1]?.replace(/,/g, '') ?? '0');
  };
  const first = await read();
  await expect
    .poll(read, { message: 'the applied count should climb', timeout: 20_000 })
    .toBeGreaterThan(first);
});

test('the indicator goes live once the replay ends and the tail is current', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_NOISE);
  await serveScript(page, { backlog: 40, finishReplay: true, tailAgeMs: 0 });
  await openViewer(page);

  await expect(connLabel(page)).toHaveText(/^catching up/, { timeout: 30_000 });
  await expect(connLabel(page)).toHaveText('live', { timeout: 40_000 });
  await expect(connGroup(page)).toHaveAttribute('data-phase', 'live');
});

test('a tail delivering stale events reports how far behind it is', async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(WS_NOISE);
  // Replay finishes, but every event that follows describes something that
  // happened 45 seconds ago: attached, tailing, and not remotely current.
  await serveScript(page, { backlog: 40, finishReplay: true, tailAgeMs: 45_000 });
  await openViewer(page);

  await expect(connLabel(page)).toHaveText(/^behind \d+s$/, { timeout: 40_000 });
  await expect(connGroup(page)).toHaveAttribute('data-phase', 'behind');
  await expect(connGroup(page)).toHaveAttribute('title', /not keeping up with the run/);
});

/**
 * "catching up 12,048/72,144" is the longest label this bar ever renders.
 * A truthful state that gets clipped into "catching up 12,0…" is not much
 * of an improvement, so measure it.
 */
for (const theme of ['dark', 'light'] as const) {
  test(`${theme} theme: the catch-up readout is legible, not clipped`, async ({
    page,
    consoleGuard,
  }, testInfo) => {
    consoleGuard.allow(WS_NOISE);
    await serveScript(page, { backlog: 72_144, finishReplay: false });
    await openViewer(page, { theme, colorScheme: theme });

    await expect(connLabel(page)).toHaveText(/^catching up [\d,]+\/72,144$/, { timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const report = await auditPage(page, {
      textSelectors: ['.gm-conn-label', '.gm-runbar-endpoint', '.gm-seg button', '.gm-toolbtn'],
      rowSelectors: ['.gm-runbar'],
      minRatio: 3,
    });
    await testInfo.attach(`catchup-runbar-${theme}.png`, {
      body: await page.locator('.gm-runbar').screenshot(),
      contentType: 'image/png',
    });
    expect(report.inspected).toBeGreaterThan(3);
    expect(report.clipped, 'the catch-up readout is cut off').toEqual([]);
    expect(report.overlapping, 'the readout collides with the controls').toEqual([]);
    expect(report.contrast, 'the catch-up readout is below 3:1').toEqual([]);
  });
}
