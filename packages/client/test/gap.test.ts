/**
 * Loss must be impossible to miss.
 *
 * The soak harness (examples/soak, `--scenario=reconnect`, case B) proved the
 * opposite: 3,000 events emitted while the debugger was unreachable with a
 * 500-event ring buffer stored 900 of 3,400, and *nothing* — not the stored
 * run, not the viewer, not the host's logs — said so. The only witness was
 * `session.stats().dropped`, which nothing emitted.
 *
 * These tests pin the three halves of the answer:
 *   1. the client remembers what it dropped (count + seq range, per run),
 *   2. it announces it on the next attach as a real, parseable envelope the
 *      server stores and a viewer can render,
 *   3. it tells the developer once, even if the debugger never comes back,
 * plus the "don't cry wolf" rule: an event that WAS delivered and then aged
 * out of the replay buffer is not loss and must not be marked as such.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { createSession } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface GapPayload {
  droppedCount: number;
  fromSeq: number;
  toSeq: number;
  reason: string;
}

/** The gap markers among what a viewer received, in arrival order. */
function gapMarkers(frames: ReceivedFrame[]): { frame: ReceivedFrame; gap: GapPayload }[] {
  return frames
    .filter((frame) => frame.type === 'graph.hint' && frame.payload['gap'] !== undefined)
    .map((frame) => ({ frame, gap: frame.payload['gap'] as GapPayload }));
}

function emitTokens(
  session: ReturnType<typeof createSession>,
  count: number,
  label = 'tok',
): void {
  for (let i = 0; i < count; i += 1) {
    session.emit('node.token', { nodeId: 'llm:step', deltas: [{ t: 'text', v: `${label}-${i}` }] });
  }
}

describe('dropping events while dark is remembered', () => {
  it('counts only events that never reached the debugger, with their seq range', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      bufferSize: 20,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());

    expect(await session.ready()).toBe(true);
    // Delivered while attached: these age out of the buffer later, but they
    // are NOT loss.
    emitTokens(session, 10, 'live');
    await waitUntil(() => viewer.ofType('node.token').length === 10, 3000, 'live tokens');
    expect(session.stats().lost).toBe(0);

    viewer.dropConnections();
    await waitUntil(() => !session.attached, 2000, 'detach');

    // 200 events into a 20-slot buffer: 180 can never be delivered.
    emitTokens(session, 200, 'dark');

    const stats = session.stats();
    expect(stats.lost).toBe(180);
    expect(stats.pendingGaps).toBe(1);
    // `dropped` is the older, blunter counter: it also counts the 10 already
    // delivered frames that aged out. That is exactly why `lost` exists.
    expect(stats.dropped).toBeGreaterThan(stats.lost);
  });

  it('an attached session that simply outruns its buffer reports no loss at all', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      bufferSize: 10,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());

    expect(await session.ready()).toBe(true);
    emitTokens(session, 100);
    await waitUntil(() => viewer.ofType('node.token').length === 100, 5000, 'all tokens');

    expect(session.stats().dropped).toBeGreaterThan(0); // the buffer wrapped 9x
    expect(session.stats().lost).toBe(0); // ...and nothing was lost
    expect(session.stats().pendingGaps).toBe(0);
    expect(gapMarkers(viewer.received)).toHaveLength(0);
  });
});

describe('the gap is announced on the wire', () => {
  it('emits a schema-valid gap marker on reattach, ahead of the replay', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      bufferSize: 20,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());

    expect(await session.ready()).toBe(true);
    let runId = '';
    await session.run('lossy', async (ctx) => {
      runId = ctx.runId;
      await viewer.waitForType('run.started');
      viewer.dropConnections();
      await waitUntil(() => !session.attached, 2000, 'detach');
      emitTokens(session, 200, 'dark');
      expect(await session.ready()).toBe(true);
      await tick(100);
    });

    const markers = gapMarkers(viewer.received);
    expect(markers).toHaveLength(1);
    const marker = markers[0];
    if (marker === undefined) throw new Error('no gap marker');

    // It belongs to the run that lost the events.
    expect(marker.frame.runId).toBe(runId);
    expect(marker.gap.droppedCount).toBe(180);
    expect(marker.gap.reason).toBe('buffer-overflow');
    expect(marker.gap.toSeq - marker.gap.fromSeq + 1).toBe(180);

    // It is a real envelope: the server parses it with parseEnvelope and
    // stores it like any other event (no unknown-type, no invalid payload).
    const parsed = parseEnvelope(marker.frame);
    expect(parsed.kind).toBe('ok');

    // The hole is contiguous and ends exactly where the replay picks up.
    const afterMarker = viewer.received.slice(viewer.received.indexOf(marker.frame) + 1);
    const firstReplayed = afterMarker.find((f) => f.type === 'node.token');
    expect(firstReplayed?.seq).toBe(marker.gap.toSeq + 1);
    // ...and the marker leads the replay rather than trailing it.
    expect(afterMarker.filter((f) => f.type === 'node.token')).toHaveLength(20);
  });

  it('marks each affected run separately', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      bufferSize: 10,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());

    expect(await session.ready()).toBe(true);
    viewer.dropConnections();
    await waitUntil(() => !session.attached, 2000, 'detach');

    const runIds: string[] = [];
    for (let r = 0; r < 2; r += 1) {
      await session.run(`dark-${r}`, async (ctx) => {
        runIds.push(ctx.runId);
        emitTokens(session, 50, `r${r}`);
      });
    }
    expect(await session.ready()).toBe(true);
    await tick(150);

    const markers = gapMarkers(viewer.received);
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.frame.runId).sort()).toEqual([...runIds].sort());
    for (const marker of markers) expect(marker.gap.droppedCount).toBeGreaterThan(0);
  });

  it('a gap that only the byte bound caused is announced the same way', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      bufferSize: 10_000, // never binds
      maxBufferBytes: 4096,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());

    expect(await session.ready()).toBe(true);
    viewer.dropConnections();
    await waitUntil(() => !session.attached, 2000, 'detach');

    const big = 'x'.repeat(1024);
    for (let i = 0; i < 20; i += 1) {
      session.emit('node.token', { nodeId: 'llm:step', deltas: [{ t: 'text', v: big }] });
    }
    expect(session.stats().buffered).toBeLessThan(20); // the byte bound bit
    expect(session.stats().lost).toBeGreaterThan(0);

    expect(await session.ready()).toBe(true);
    await tick(150);
    const markers = gapMarkers(viewer.received);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.gap.droppedCount).toBe(session.stats().lost);
  });
});

describe('the developer is told, even if the debugger never comes back', () => {
  it('warns once (rate-limited) naming the count and that the run is incomplete', async () => {
    const warnings: string[] = [];
    const session = createSession({
      enabled: true,
      url: 'ws://127.0.0.1:1/', // nothing listens: permanently dark
      connectTimeoutMs: 50,
      retryIntervalMs: 60_000,
      bufferSize: 5,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => session.dispose());

    emitTokens(session, 500);
    await tick(20);

    const lossWarnings = warnings.filter((w) => w.includes('the recorded run is incomplete'));
    expect(lossWarnings).toHaveLength(1); // 495 losses, one line
    expect(lossWarnings[0]).toMatch(/dropped \d+ events? while the debugger was unreachable/);
    expect(session.stats().lost).toBeGreaterThan(400);
  });

  it('never throws into the host, however much it drops', async () => {
    const session = createSession({
      enabled: true,
      url: 'ws://127.0.0.1:1/',
      connectTimeoutMs: 50,
      retryIntervalMs: 60_000,
      bufferSize: 2,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());

    const result = await session.run('host-is-safe', async () => {
      emitTokens(session, 1000);
      expect(await session.gate('before', { nodeId: 'n', kind: 'tool', name: 'x' })).toEqual({
        action: 'continue',
      });
      return 'ok';
    });
    expect(result).toBe('ok');
  });
});

describe('a blip costs a fraction of a second, not ten', () => {
  it('reconnects fast after losing an established attachment (default 10s interval)', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    // The SHIPPED steady-state interval. Before the fast-reconnect burst this
    // meant ~10s dark after any blip (soak reconnect case D measured 9.99s).
    const session = createSession({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 10_000,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());

    expect(await session.ready()).toBe(true);
    viewer.dropConnections();
    await waitUntil(() => !session.attached, 2000, 'detach');

    const darkFrom = Date.now();
    // No ready() call: a real agent just keeps working. Only the background
    // retry can save it.
    await waitUntil(() => session.attached, 3000, 'background reattach');
    const darkMs = Date.now() - darkFrom;
    expect(darkMs).toBeLessThan(1500);
    expect(viewer.connectionCount).toBe(2);
  });

  it('does not busy-retry a debugger that was never there', async () => {
    let attempts = 0;
    class NeverOpensWS {
      readonly readyState = 0;
      constructor(_url: string) {
        attempts += 1;
      }
      addEventListener(): void {}
      send(): void {}
      close(): void {}
    }

    const session = createSession({
      enabled: true,
      webSocket: NeverOpensWS as never,
      connectTimeoutMs: 50,
      retryIntervalMs: 1000,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());

    session.emit('graph.hint', { nodes: [] }); // lazy start
    await tick(700);
    // First attempt at t=0, it gives up at t=50, next attempt is due at
    // t=1050 — the fast burst is for blips, not for "no debugger running".
    expect(attempts).toBe(1);
  });
});
