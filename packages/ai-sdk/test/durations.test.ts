/**
 * Durations through the real adapter: sub-millisecond, monotonic, and with
 * the debugger's hold time reported separately from the node's own time.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { graphmind, type Graphmind } from '../src/index.js';
import { FakeViewer, tick, type FakeViewerOptions, type ReceivedFrame } from './helpers/fake-viewer.js';
import { attach, runScenario, Marks } from './helpers/scenario.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(viewerOptions: FakeViewerOptions = {}): Promise<{ viewer: FakeViewer; gm: Graphmind }> {
  const viewer = await FakeViewer.start(viewerOptions);
  const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, logger: () => undefined });
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  await attach(gm);
  return { viewer, gm };
}

const decimals = (n: number): number => {
  const text = String(n);
  return text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
};

function finishedFrames(viewer: FakeViewer): ReceivedFrame[] {
  return viewer.ofType('node.finished');
}

describe('durationMs', () => {
  it('is a non-negative number with at most two decimals on every node.finished, and never a flat 0 for work that ran', async () => {
    const { viewer, gm } = await setup();
    const result = await runScenario(gm, {}, new Marks());
    expect(result.runError).toBeUndefined();
    await viewer.waitForType('run.finished');

    const frames = finishedFrames(viewer);
    expect(frames.length).toBeGreaterThanOrEqual(6); // 3 steps + 3 tools (+ agent)
    for (const frame of frames) {
      const duration = frame.payload['durationMs'];
      expect(typeof duration, JSON.stringify(frame.payload)).toBe('number');
      expect(duration as number).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(duration as number)).toBe(true);
      expect(decimals(duration as number)).toBeLessThanOrEqual(2);
    }
    // Tool bodies here take microseconds. Date.now() reported them as 0ms —
    // the "this debugger cannot measure" failure this file exists to catch.
    const tools = frames.filter((f) => String(f.payload['nodeId']).startsWith('tool:'));
    expect(tools.length).toBeGreaterThanOrEqual(3);
    for (const frame of tools) {
      expect(frame.payload['durationMs'] as number, `${frame.payload['nodeId']} measured 0`).toBeGreaterThan(0);
      // Nothing was held: heldMs is present and exactly 0 (measured, not missing).
      expect(frame.payload['heldMs']).toBe(0);
    }
  });

  it('keeps wall-clock semantics while heldMs carries the debugger\'s share', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    const promise = runScenario(gm, {}, new Marks());

    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    await tick(300);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const result = await promise;
    expect(result.runError).toBeUndefined();

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    const durationMs = finished.payload['durationMs'] as number;
    const heldMs = finished.payload['heldMs'] as number;
    // durationMs still includes the hold (stored runs and importers are unaffected)…
    expect(durationMs).toBeGreaterThanOrEqual(280);
    // …and heldMs says how much of it was the developer, not the tool.
    expect(heldMs).toBeGreaterThanOrEqual(280);
    expect(heldMs).toBeLessThanOrEqual(durationMs);
    expect(decimals(heldMs)).toBeLessThanOrEqual(2);
    // What actually ran is a few milliseconds, not 300.
    expect(durationMs - heldMs).toBeLessThan(200);

    // The other tools were not held and say so.
    for (const frame of finishedFrames(viewer)) {
      if (frame.payload['nodeId'] === 'tool:searchFlights') continue;
      if (!String(frame.payload['nodeId']).startsWith('tool:')) continue;
      expect(frame.payload['heldMs']).toBe(0);
    }
  });
});
