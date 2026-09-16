/**
 * Durations are monotonic, sub-millisecond, rounded to 0.01 ms and never
 * negative (shared contract, phase6 plan). Before this a 300 µs handler
 * reported `durationMs: 0`, which the viewer had to render as if nothing had
 * been measured.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { elapsedMs, now, roundDurationMs } from '../src/clock.js';
import { makeHarness } from './helpers/mcp.js';
import { attach, makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

const twoDecimals = (ms: number): boolean => Math.round(ms * 100) / 100 === ms;

describe('clock units', () => {
  it('rounds to 0.01 ms and clamps at zero', () => {
    expect(roundDurationMs(1.23456)).toBe(1.23);
    expect(roundDurationMs(0.005)).toBe(0.01);
    expect(roundDurationMs(0.004)).toBe(0);
    expect(roundDurationMs(-1)).toBe(0);
    expect(roundDurationMs(Number.NaN)).toBe(0);
    expect(roundDurationMs(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('is monotonic and fractional', () => {
    const a = now();
    const b = now();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(elapsedMs(a)).toBeGreaterThanOrEqual(0);
    // A reading taken "in the future" cannot produce a negative duration.
    expect(elapsedMs(now() + 1000)).toBe(0);
  });
});

describe('durations on the wire', () => {
  it('a 20 ms handler reports ~20 ms with 0.01 ms resolution; the server node wraps it', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm, { toolDelayMs: 20 });
    cleanups.push(h.close);

    await h.client.callTool({ name: 'searchFlights', arguments: { from: 'VIE', to: 'LIS' } });
    await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'server:trip-server',
    );

    const tool = viewer.received.find(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    const server = viewer.received.find(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'server:trip-server',
    );
    const toolMs = tool?.payload['durationMs'] as number;
    const serverMs = server?.payload['durationMs'] as number;
    expect(toolMs).toBeGreaterThanOrEqual(15);
    expect(toolMs).toBeLessThan(5_000);
    expect(twoDecimals(toolMs)).toBe(true);
    expect(twoDecimals(serverMs)).toBe(true);
    // The server node opened before the tool node and closed after it.
    expect(serverMs).toBeGreaterThanOrEqual(toolMs);
    // Envelope timestamps stay integer epoch ms.
    expect(Number.isInteger(tool?.ts)).toBe(true);
  });

  it('a sub-millisecond handler still reports a finite, non-negative, 0.01 ms-rounded duration', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm, { toolDelayMs: 0 });
    cleanups.push(h.close);

    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await h.client.callTool({ name: 'searchFlights', arguments: { from: 'VIE', to: 'LIS' } });
    }
    await viewer.waitFor(
      (f) =>
        f.type === 'node.finished' &&
        viewer.received.filter(
          (x) => x.type === 'node.finished' && x.payload['nodeId'] === 'tool:searchFlights',
        ).length >= 5,
    );
    for (const f of viewer.received) {
      if (f.type !== 'node.finished') continue;
      const ms = f.payload['durationMs'] as number;
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(twoDecimals(ms)).toBe(true);
      if (f.payload['nodeId'] === 'tool:searchFlights') samples.push(ms);
    }
    expect(samples).toHaveLength(5);
    // With a 0 ms delay the handler still awaits a timer, so at least one
    // sample carries fraction-of-a-millisecond information rather than
    // collapsing to an integer — the thing Date.now() could never show.
    expect(samples.some((ms) => !Number.isInteger(ms))).toBe(true);
  });
});
