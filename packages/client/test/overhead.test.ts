/**
 * Detached-mode overhead: awaiting `gate()` with no viewer attached must
 * stay far under 1ms per gate (the spike measured ~0.03ms max). This is the
 * "instrumentation is free when you are not debugging" guarantee.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/index.js';
import type { WebSocketConstructor, WebSocketLike } from '../src/transport.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A WebSocket that never connects — keeps the measurement network-free. */
class NeverConnectsWS implements WebSocketLike {
  readonly readyState = 0;
  constructor(_url: string) {}
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

describe('detached overhead', () => {
  it('averages < 1ms per awaited gate over 2000 gates (and stays sync-fast)', async () => {
    const session = createSession({
      enabled: true,
      webSocket: NeverConnectsWS as unknown as WebSocketConstructor,
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => session.dispose());

    const node = { nodeId: 'n1', kind: 'tool', name: 'searchFlights' } as const;

    // warm-up (JIT, promise machinery, lazy connect path)
    for (let i = 0; i < 200; i += 1) await session.gate('before', node);

    const iterations = 2000;
    const samples: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      await session.gate('before', node);
      samples.push(performance.now() - t0);
    }

    const total = samples.reduce((a, b) => a + b, 0);
    const avg = total / iterations;
    const sorted = [...samples].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(iterations * 0.99)] ?? 0;

    // The hard requirement from the brief: average per-gate cost < 1ms.
    expect(avg).toBeLessThan(1);
    // And the typical case is orders of magnitude below that.
    expect(p99).toBeLessThan(1);
  });

  it('disabled sessions have the same fast path', async () => {
    const session = createSession({ env: { GRAPHMIND_DISABLED: '1' } });
    cleanups.push(() => session.dispose());
    const node = { nodeId: 'n1', kind: 'tool', name: 'x' } as const;

    for (let i = 0; i < 100; i += 1) await session.gate('before', node);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) await session.gate('before', node);
    const avg = (performance.now() - t0) / 1000;
    expect(avg).toBeLessThan(1);
  });
});
