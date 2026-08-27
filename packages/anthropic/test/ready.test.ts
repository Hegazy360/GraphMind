/**
 * The attach guarantee: `gm.ready()` and the `waitForAttach` option, plus its
 * fail-open behavior when no debugger is listening.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { graphmind, type Graphmind } from '../src/index.js';
import { FakeViewer, tick } from './helpers/fake-viewer.js';
import { FakeAnthropicTransport } from './helpers/fake-anthropic.js';
import { Marks, makeScript, runScenario } from './helpers/scenario.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('waitForAttach', () => {
  it('holds the very first request until the handshake armed the breakpoints', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'llm' }] });
    const gm = graphmind({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 60_000,
      waitForAttach: 2000,
    });
    cleanups.push(async () => {
      await gm.dispose();
      await viewer.close();
    });

    // NOTE: no explicit attach() — the adapter must do the waiting itself.
    const transport = new FakeAnthropicTransport(makeScript());
    const promise = runScenario(gm, {}, new Marks(), transport);

    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
    );
    expect(transport.requests).toHaveLength(0);
    expect(gm.session.attached).toBe(true);

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    for (let turn = 2; turn <= 3; turn += 1) {
      const next = await viewer.waitForNth(
        (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
        turn,
      );
      viewer.resume(next.payload['pauseId'] as string, 'continue');
    }
    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
  });

  it('waits at most once: later calls are never delayed', async () => {
    const viewer = await FakeViewer.start();
    const gm = graphmind({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 60_000,
      waitForAttach: true,
    });
    cleanups.push(async () => {
      await gm.dispose();
      await viewer.close();
    });

    const result = await runScenario(gm, { mode: 'stream-helper' });
    expect(result.runError).toBeUndefined();
    expect(result.requestCount).toBe(3);
    expect(gm.session.attached).toBe(true);
    expect(viewer.connectionCount).toBe(1);
  });
});

describe('ready()', () => {
  it('resolves true once attached and false when nothing is listening', async () => {
    const viewer = await FakeViewer.start();
    const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(async () => {
      await gm.dispose();
      await viewer.close();
    });
    expect(await gm.ready({ timeoutMs: 3000 })).toBe(true);
    expect(await gm.ready({ timeoutMs: 10 })).toBe(true); // instant when attached

    const orphan = graphmind({
      url: 'ws://127.0.0.1:1/ingest',
      enabled: true,
      connectTimeoutMs: 50,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    cleanups.push(() => orphan.dispose());
    expect(await orphan.ready({ timeoutMs: 400 })).toBe(false);

    // Fail-open: `false` is "carry on detached", not an error.
    const result = await runScenario(orphan);
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
  });

  it('resolves false for a disabled session without touching the network', async () => {
    const gm = graphmind({ enabled: false });
    cleanups.push(() => gm.dispose());
    expect(await gm.ready()).toBe(false);
    await tick(5);
    expect(gm.session.stats().seq).toBe(0);
  });
});

describe('gm.run', () => {
  it('emits an agent node and propagates host errors untouched', async () => {
    const viewer = await FakeViewer.start();
    const gm: Graphmind = graphmind({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 60_000,
    });
    cleanups.push(async () => {
      await gm.dispose();
      await viewer.close();
    });
    expect(await gm.ready({ timeoutMs: 3000 })).toBe(true);

    await gm.run('ok-run', () => Promise.resolve(1));
    const started = await viewer.waitForType('run.started');
    expect(started.payload['app']).toBe('anthropic-app');
    const sdk = started.payload['sdk'] as { name: string; version: string };
    expect(sdk.name).toBe('@anthropic-ai/sdk');
    expect(sdk.version).toMatch(/^\d+\.\d+\.\d+/); // detected from the install

    const failure = new Error('host blew up');
    await expect(
      gm.run('failing-run', () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'agent:failing-run',
    );
    expect(finished.payload['status']).toBe('error');
    const errored = viewer
      .ofType('node.error')
      .find((f) => f.payload['nodeId'] === 'agent:failing-run');
    expect(errored).toBeDefined();
    const runFinished = await viewer.waitFor(
      (f) => f.type === 'run.finished' && f.payload['status'] === 'error',
    );
    expect(runFinished).toBeDefined();
  });
});
