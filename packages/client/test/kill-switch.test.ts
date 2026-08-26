/**
 * Kill switches: GRAPHMIND_DISABLED=1 always wins; NODE_ENV=production
 * disables unless GRAPHMIND=1; a disabled session never touches the network
 * and every API is a no-op (while the host's own code still runs).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSession, resolveEnabled } from '../src/index.js';
import { FakeViewer, tick } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('resolveEnabled precedence', () => {
  it('GRAPHMIND_DISABLED=1 beats everything, even explicit enabled:true', () => {
    expect(resolveEnabled(true, { GRAPHMIND_DISABLED: '1' })).toBe(false);
    expect(resolveEnabled(undefined, { GRAPHMIND_DISABLED: '1', GRAPHMIND: '1' })).toBe(false);
  });

  it('explicit option beats NODE_ENV', () => {
    expect(resolveEnabled(true, { NODE_ENV: 'production' })).toBe(true);
    expect(resolveEnabled(false, {})).toBe(false);
  });

  it('production is off by default, on with GRAPHMIND=1', () => {
    expect(resolveEnabled(undefined, { NODE_ENV: 'production' })).toBe(false);
    expect(resolveEnabled(undefined, { NODE_ENV: 'production', GRAPHMIND: '1' })).toBe(true);
  });

  it('non-production defaults to enabled', () => {
    expect(resolveEnabled(undefined, {})).toBe(true);
    expect(resolveEnabled(undefined, { NODE_ENV: 'development' })).toBe(true);
  });
});

describe('disabled sessions no-op everything', () => {
  it('never opens a connection and buffers nothing', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      env: { GRAPHMIND_DISABLED: '1' },
      enabled: true, // still loses to the env kill switch
      retryIntervalMs: 50,
    });
    cleanups.push(() => session.dispose());

    expect(session.enabled).toBe(false);

    const result = await session.run('still-runs', async (ctx) => {
      expect(ctx.runId).toBeTruthy(); // host still gets a usable context
      expect(ctx.signal.aborted).toBe(false);
      session.emit('node.token', { nodeId: 'n1', deltas: [{ t: 'text', v: 'x' }] });
      const decision = await session.gate('before', { nodeId: 'n1', kind: 'tool', name: 'x' });
      expect(decision).toEqual({ action: 'continue' });
      return 'host-value';
    });
    expect(result).toBe('host-value');

    await tick(250);
    expect(viewer.connectionCount).toBe(0);
    expect(session.attached).toBe(false);
    expect(session.stats().buffered).toBe(0);
    expect(session.stats().seq).toBe(0);
  });

  it('NODE_ENV=production disables via env; GRAPHMIND=1 re-enables', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());

    const prodSession = createSession({
      url: viewer.url,
      env: { NODE_ENV: 'production' },
      retryIntervalMs: 50,
    });
    cleanups.push(() => prodSession.dispose());
    expect(prodSession.enabled).toBe(false);
    prodSession.emit('graph.hint', { nodes: [] });
    await tick(200);
    expect(viewer.connectionCount).toBe(0);

    const optedIn = createSession({
      url: viewer.url,
      env: { NODE_ENV: 'production', GRAPHMIND: '1' },
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => optedIn.dispose());
    expect(optedIn.enabled).toBe(true);
    optedIn.emit('graph.hint', { nodes: [] });
    await viewer.waitForType('hello');
    expect(viewer.connectionCount).toBe(1);
  });

  it('host errors still propagate from run() when disabled', async () => {
    const session = createSession({ env: { GRAPHMIND_DISABLED: '1' } });
    cleanups.push(() => session.dispose());
    await expect(
      session.run('boom', () => {
        throw new Error('host bug');
      }),
    ).rejects.toThrow('host bug');
  });
});
