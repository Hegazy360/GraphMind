/**
 * Session/transport behavior: handshake, replay-on-attach, ring-buffer
 * bounds, fail-open on disconnect, version-mismatch detachment, connect
 * timeouts, run contexts, dispose.
 */
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_VERSION, createSession } from '../src/index.js';
import { FakeViewer, tick, waitUntil } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('handshake', () => {
  it('sends hello (versions + capabilities) and attaches on hello.ack', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      appName: 'trip-agent',
      sdk: { name: 'ai', version: '7.0.79' },
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => session.dispose());

    expect(session.attached).toBe(false);
    session.emit('graph.hint', { nodes: [] });
    const hello = await viewer.waitForType('hello');
    expect(hello.runId).toBe('*');
    expect(hello.payload['versions']).toEqual({ protocol: 1, client: CLIENT_VERSION });
    expect(hello.payload['capabilities']).toEqual(
      expect.arrayContaining(['pause', 'step', 'inject', 'retry', 'abort']),
    );
    expect(hello.payload['app']).toBe('trip-agent');
    expect(hello.payload['sdk']).toEqual({ name: 'ai', version: '7.0.79' });

    await waitUntil(() => session.attached, 3000, 'attach');
  });

  it('hello.ack with a different protocol major leaves the session detached', async () => {
    const viewer = await FakeViewer.start({ gm: 2 });
    cleanups.push(() => viewer.close());
    const warnings: string[] = [];
    const session = createSession({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 60_000,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => session.dispose());

    session.emit('graph.hint', { nodes: [] });
    await viewer.waitForType('hello');
    await tick(200);

    expect(session.attached).toBe(false);
    expect(warnings.some((w) => w.includes('protocol v2'))).toBe(true);
    // and gating degrades to pass-through
    expect(await session.gate('before', { nodeId: 'n', kind: 'tool', name: 'x' })).toEqual({
      action: 'continue',
    });
  });

  it('a viewer that accepts the socket but never acks leaves the session detached', async () => {
    const viewer = await FakeViewer.start({ autoAck: false });
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      handshakeTimeoutMs: 150,
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => session.dispose());

    session.emit('graph.hint', { nodes: [] });
    await viewer.waitForType('hello');
    await tick(400);
    expect(session.attached).toBe(false);
  });

  it('a server that never completes the WS upgrade trips the connect timeout', async () => {
    // Raw TCP server: accepts and stays silent, so the socket never opens.
    const sockets = new Set<import('node:net').Socket>();
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as { port: number }).port;

    const warnings: string[] = [];
    const session = createSession({
      url: `ws://127.0.0.1:${port}/ingest`,
      enabled: true,
      connectTimeoutMs: 150,
      retryIntervalMs: 60_000,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => session.dispose());

    session.emit('graph.hint', { nodes: [] });
    await tick(500);
    expect(session.attached).toBe(false);
    expect(warnings.some((w) => w.includes('did not accept the connection'))).toBe(true);
  });

  it('connects lazily: no socket until first use, retry attaches later', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 100 });
    cleanups.push(() => session.dispose());

    await tick(150);
    expect(viewer.connectionCount).toBe(0); // nothing used the session yet

    session.emit('graph.hint', { nodes: [] });
    await waitUntil(() => session.attached, 3000, 'attach');
    expect(viewer.connectionCount).toBe(1);
  });
});

describe('buffering and replay', () => {
  it('replays buffered events on attach, oldest first, keeping original seq', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    // Emit synchronously before the (async) attach can land: every event
    // below must be buffered and then replayed in order on attach.
    const session2 = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 50 });
    cleanups.push(() => session2.dispose());

    await session2.run('startup', async () => {
      session2.emit('node.started', {
        nodeId: 'n1',
        kind: 'llm',
        name: 'step',
        instanceId: 'i1',
        input: { prompt: 'hi' },
      });
      session2.emit('node.token', { nodeId: 'n1', deltas: [{ t: 'text', v: 'Hello' }] });
      session2.emit('node.finished', {
        nodeId: 'n1',
        output: 'Hello',
        durationMs: 3,
        status: 'ok',
      });
    });

    await waitUntil(() => session2.attached, 3000, 'attach');
    await viewer.waitForType('run.finished');

    const eventTypes = viewer.received
      .filter((f) => f.type !== 'hello')
      .map((f) => f.type);
    expect(eventTypes).toEqual([
      'run.started',
      'node.started',
      'node.token',
      'node.finished',
      'run.finished',
    ]);
    const seqs = viewer.received.filter((f) => f.type !== 'hello').map((f) => f.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // monotonically increasing
  });

  it('drops oldest events when the buffer overflows', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      bufferSize: 3,
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => session.dispose());

    // 1 implicit run.started + 5 tokens = 6 events into a 3-slot buffer.
    for (let i = 0; i < 5; i += 1) {
      session.emit('node.token', { nodeId: 'n1', deltas: [{ t: 'text', v: `tok-${i}` }] });
    }
    expect(session.stats().buffered).toBe(3);
    expect(session.stats().dropped).toBe(3);

    await waitUntil(() => session.attached, 3000, 'attach');
    await viewer.waitForType('node.token');
    await tick(100);

    // A gap marker leads the replay (the hole is older than what survived),
    // then the three surviving tokens.
    const replayed = viewer.received.filter((f) => f.type !== 'hello');
    expect(replayed.map((f) => f.type)).toEqual([
      'graph.hint',
      'node.token',
      'node.token',
      'node.token',
    ]);
    expect(replayed.slice(1).map((f) => (f.payload['deltas'] as { v: string }[])[0]?.v)).toEqual([
      'tok-2',
      'tok-3',
      'tok-4',
    ]);
  });
});

describe('fail-open on disconnect', () => {
  it('auto-continues held gates within 100ms of the viewer dying', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{}] });
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());

    session.emit('graph.hint', { nodes: [] });
    await waitUntil(() => session.attached, 3000, 'attach');

    const gatePromise = session.gate('before', { nodeId: 'n1', kind: 'tool', name: 'x' });
    await viewer.waitForType('exec.paused');
    expect(session.stats().heldGates).toBe(1);

    const killedAt = Date.now();
    viewer.killAbruptly();
    const decision = await gatePromise;
    const lagMs = Date.now() - killedAt;

    expect(decision).toEqual({ action: 'continue' });
    expect(lagMs).toBeLessThan(100);
    expect(session.attached).toBe(false);

    // breakpoints are forgotten: later gates pass through instantly
    expect(await session.gate('before', { nodeId: 'n2', kind: 'tool', name: 'x' })).toEqual({
      action: 'continue',
    });
  });

  it('re-attaches via retry and re-arms breakpoints from the new hello.ack', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ name: 'x' }] });
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 100,
      connectTimeoutMs: 200,
    });
    cleanups.push(() => session.dispose());

    session.emit('graph.hint', { nodes: [] });
    await waitUntil(() => session.attached, 3000, 'first attach');

    viewer.sendRaw('not json at all'); // invalid frames while attached are tolerated
    await tick(50);
    expect(session.attached).toBe(true);

    viewer.dropConnections(); // socket dies, server keeps listening
    await waitUntil(() => !session.attached, 1000, 'detach');
    await waitUntil(() => session.attached, 3000, 're-attach');
    expect(viewer.connectionCount).toBe(2);

    // breakpoints from the fresh hello.ack are armed again
    const gatePromise = session.gate('before', { nodeId: 'n1', kind: 'tool', name: 'x' });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await gatePromise).toEqual({ action: 'continue' });
  });
});

describe('run contexts', () => {
  it('run() wraps fn with run.started/run.finished and ALS context', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      appName: 'demo',
      meta: { env: 'test' },
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => session.dispose());

    const result = await session.run('book-trip', async (ctx) => {
      expect(session.currentRun()).toBe(ctx);
      expect(ctx.name).toBe('book-trip');
      expect(ctx.signal.aborted).toBe(false);
      session.emit('node.started', {
        nodeId: 'n1',
        kind: 'agent',
        name: 'book-trip',
        instanceId: 'i1',
        input: null,
      });
      return 42;
    });
    expect(result).toBe(42);
    expect(session.currentRun()).toBeUndefined();

    await waitUntil(() => session.attached, 3000, 'attach');
    const started = await viewer.waitForType('run.started');
    expect(started.payload['app']).toBe('demo');
    expect(started.payload['meta']).toMatchObject({ name: 'book-trip', env: 'test' });
    const nodeStarted = await viewer.waitForType('node.started');
    expect(nodeStarted.runId).toBe(started.runId);
    const finished = await viewer.waitForType('run.finished');
    expect(finished.payload['status']).toBe('ok');
    expect(finished.runId).toBe(started.runId);
  });

  it('host errors propagate and run.finished carries status error', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());

    await expect(
      session.run('exploding', () => {
        throw new Error('host bug');
      }),
    ).rejects.toThrow('host bug');

    await waitUntil(() => session.attached, 3000, 'attach');
    const finished = await viewer.waitForType('run.finished');
    expect(finished.payload['status']).toBe('error');
    expect(finished.payload['error']).toMatchObject({ name: 'Error', message: 'host bug' });
  });

  it('events outside any run share one implicit run', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());

    session.emit('node.token', { nodeId: 'n1', deltas: [] });
    session.emit('node.token', { nodeId: 'n2', deltas: [] });

    await waitUntil(() => session.attached, 3000, 'attach');
    const started = await viewer.waitForType('run.started');
    expect(started.payload['meta']).toMatchObject({ implicit: true });
    const tokens = viewer.ofType('node.token');
    await waitUntil(() => viewer.ofType('node.token').length === 2, 3000, 'tokens');
    for (const token of tokens) expect(token.runId).toBe(started.runId);
  });

  it('nested runs get their own ids; inner context wins inside', async () => {
    const session = createSession({ enabled: true, url: 'ws://127.0.0.1:1/', connectTimeoutMs: 50, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());

    await session.run('outer', async (outer) => {
      await session.run('inner', async (inner) => {
        expect(inner.runId).not.toBe(outer.runId);
        expect(session.currentRun()).toBe(inner);
      });
      expect(session.currentRun()).toBe(outer);
    });
  });
});

describe('dispose', () => {
  it('is clean and idempotent: releases gates, closes socket, stops timers', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{}] });
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });

    session.emit('graph.hint', { nodes: [] });
    await waitUntil(() => session.attached, 3000, 'attach');
    const gatePromise = session.gate('before', { nodeId: 'n1', kind: 'tool', name: 'x' });
    await viewer.waitForType('exec.paused');

    await session.dispose();
    expect(await gatePromise).toEqual({ action: 'continue' }); // fail-open on dispose
    expect(session.attached).toBe(false);

    await session.dispose(); // idempotent
    session.emit('node.token', { nodeId: 'n1', deltas: [] }); // no-op, no throw
    expect(await session.gate('before', { nodeId: 'n', kind: 'tool', name: 'x' })).toEqual({
      action: 'continue',
    });
  });
});
