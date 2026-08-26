/**
 * The attach-guarantee API: session.ready() — force-connect + await the
 * handshake, resolve true/false (never throw), share concurrent attempts,
 * resolve instantly once attached, and re-arm after a disconnect.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/index.js';
import { FakeViewer, tick, waitUntil } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('session.ready()', () => {
  it('force-starts the lazy transport (before any emit) and resolves true on attach', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());

    // Nothing emitted yet: ready() itself must kick the connection.
    expect(session.attached).toBe(false);
    const ok = await session.ready();
    expect(ok).toBe(true);
    expect(session.attached).toBe(true);
    expect(viewer.connectionCount).toBe(1);
  });

  it('resolves false after timeoutMs when no viewer is reachable (and never throws)', async () => {
    const session = createSession({
      url: 'ws://127.0.0.1:1/', // nothing listens on port 1
      enabled: true,
      connectTimeoutMs: 100,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());

    const t0 = Date.now();
    const ok = await session.ready({ timeoutMs: 250 });
    const elapsed = Date.now() - t0;
    expect(ok).toBe(false);
    expect(session.attached).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2000); // the ready timeout, not the retry interval
  });

  it('resolves false immediately when the session is disabled (no network)', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: false });
    cleanups.push(() => session.dispose());

    const t0 = Date.now();
    expect(await session.ready()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(50);
    await tick(100);
    expect(viewer.connectionCount).toBe(0); // disabled sessions never touch the network
  });

  it('concurrent ready() calls share one connection attempt and all resolve true', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());

    const results = await Promise.all([
      session.ready(),
      session.ready({ timeoutMs: 5000 }),
      session.ready(),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(viewer.connectionCount).toBe(1);
  });

  it('resolves true instantly when already attached', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());

    expect(await session.ready()).toBe(true);
    const t0 = Date.now();
    expect(await session.ready({ timeoutMs: 1 })).toBe(true); // no timer involved
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('re-arms after a disconnect: a later ready() reconnects immediately', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    // retryIntervalMs is huge on purpose: only ready()'s kick can reconnect
    // inside the test budget.
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());

    expect(await session.ready()).toBe(true);
    viewer.dropConnections();
    await waitUntil(() => !session.attached, 2000, 'detach');

    expect(await session.ready()).toBe(true);
    expect(session.attached).toBe(true);
    expect(viewer.connectionCount).toBe(2);
  });

  it('a pending ready() resolves false when the session is disposed mid-wait', async () => {
    const session = createSession({
      url: 'ws://127.0.0.1:1/',
      enabled: true,
      connectTimeoutMs: 100,
      retryIntervalMs: 60_000,
      logger: () => {},
    });

    const pending = session.ready({ timeoutMs: 30_000 });
    await tick(20);
    const t0 = Date.now();
    await session.dispose();
    expect(await pending).toBe(false); // no 30s hang
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
