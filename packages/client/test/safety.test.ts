/**
 * Host-crash immunity: no matter how broken the transport is, the public
 * API never throws into the host app; failures degrade to no-ops plus
 * rate-limited console warnings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/index.js';
import { RateLimitedWarner } from '../src/safe.js';
import type { WebSocketConstructor, WebSocketLike } from '../src/transport.js';
import { tick } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

class ThrowingConstructorWS {
  constructor() {
    throw new Error('constructor exploded');
  }
}

/** "Connects", then explodes on send (hello) — and close() throws too. */
class ExplodingSendWS implements WebSocketLike {
  readonly readyState = 1;
  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  constructor(_url: string) {
    queueMicrotask(() => {
      for (const listener of this.listeners.get('open') ?? []) listener(undefined as never);
    });
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  send(): void {
    throw new Error('send exploded');
  }
  close(): void {
    throw new Error('close exploded');
  }
}

describe('host-crash immunity', () => {
  it('a WebSocket constructor that throws cannot crash the host', async () => {
    const warnings: string[] = [];
    const session = createSession({
      enabled: true,
      webSocket: ThrowingConstructorWS as unknown as WebSocketConstructor,
      retryIntervalMs: 60_000,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => session.dispose());

    const result = await session.run('protected', async (ctx) => {
      session.emit('node.token', { nodeId: 'n', deltas: [] });
      expect(await session.gate('before', { nodeId: 'n', kind: 'tool', name: 'x' })).toEqual({
        action: 'continue',
      });
      expect(ctx.signal.aborted).toBe(false);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(session.attached).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('a socket whose send() and close() throw cannot crash the host', async () => {
    const warnings: string[] = [];
    const session = createSession({
      enabled: true,
      webSocket: ExplodingSendWS as unknown as WebSocketConstructor,
      retryIntervalMs: 60_000,
      logger: (message) => warnings.push(message),
    });

    session.emit('graph.hint', { nodes: [] });
    await tick(50);
    expect(session.attached).toBe(false);
    session.emit('node.token', { nodeId: 'n', deltas: [] });
    expect(await session.gate('before', { nodeId: 'n', kind: 'tool', name: 'x' })).toEqual({
      action: 'continue',
    });
    await session.dispose(); // close() throws internally; dispose still succeeds
    expect(warnings.some((w) => w.includes('handshake'))).toBe(true);
  });

  it('a missing WebSocket implementation degrades to detached with one warning', async () => {
    const warnings: string[] = [];
    const session = createSession({
      enabled: true,
      webSocket: undefined, // explicit undefined = "no implementation"
      retryIntervalMs: 60_000,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => session.dispose());

    session.emit('graph.hint', { nodes: [] });
    session.emit('node.token', { nodeId: 'n', deltas: [] });
    expect(await session.gate('before', { nodeId: 'n', kind: 'tool', name: 'x' })).toEqual({
      action: 'continue',
    });
    await tick(20);
    expect(session.attached).toBe(false);
    expect(warnings.filter((w) => w.includes('no WebSocket implementation'))).toHaveLength(1);
  });

  it('warnings are rate-limited per key', () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn();
      const warner = new RateLimitedWarner(60_000, sink);
      for (let i = 0; i < 50; i += 1) warner.warn('k1', 'same failure');
      expect(sink).toHaveBeenCalledTimes(1);

      warner.warn('k2', 'different key');
      expect(sink).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(61_000);
      warner.warn('k1', 'same failure, later');
      expect(sink).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing warn sink is itself swallowed', () => {
    const warner = new RateLimitedWarner(1000, () => {
      throw new Error('logger exploded');
    });
    expect(() => warner.warn('k', 'message')).not.toThrow();
  });

  it('50 emits through a broken transport warn at most a handful of times', async () => {
    const warnings: string[] = [];
    const session = createSession({
      enabled: true,
      webSocket: ThrowingConstructorWS as unknown as WebSocketConstructor,
      retryIntervalMs: 60_000,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => session.dispose());

    for (let i = 0; i < 50; i += 1) {
      session.emit('node.token', { nodeId: 'n', deltas: [{ t: 'text', v: `t${i}` }] });
    }
    await tick(20);
    expect(warnings.length).toBeLessThanOrEqual(3); // rate-limited, not 50 lines
  });
});
