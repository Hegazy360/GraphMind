/**
 * The attach-guarantee surface of the adapter: the `gm.ready()` passthrough
 * and the `waitForAttach` option (first `gm.run()` / first wrapped call
 * awaits the handshake, fail-open on timeout).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { graphmind } from '../src/index.js';
import { FakeViewer, tick } from './helpers/fake-viewer.js';
import { runScenario } from './helpers/scenario.js';
import { toolExecutionOptions } from './helpers/sdk-compat.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const DEAD_URL = 'ws://127.0.0.1:1/'; // nothing listens on port 1

describe('gm.ready()', () => {
  it('resolves true against a viewer (before any run) and instantly when re-called', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(() => gm.dispose());

    expect(gm.session.attached).toBe(false);
    expect(await gm.ready()).toBe(true);
    expect(gm.session.attached).toBe(true);

    const t0 = Date.now();
    expect(await gm.ready()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('resolves false on timeout with no viewer, and false when disabled', async () => {
    const detachedGm = graphmind({
      url: DEAD_URL,
      enabled: true,
      connectTimeoutMs: 100,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    cleanups.push(() => detachedGm.dispose());
    expect(await detachedGm.ready({ timeoutMs: 250 })).toBe(false);

    const disabledGm = graphmind({ url: DEAD_URL, enabled: false });
    cleanups.push(() => disabledGm.dispose());
    const t0 = Date.now();
    expect(await disabledGm.ready()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe('waitForAttach option', () => {
  it('waitForAttach: true gates the first gm.run() until the handshake lands', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const gm = graphmind({
      url: viewer.url,
      enabled: true,
      waitForAttach: true,
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => gm.dispose());

    // Without the gate the fn body would start before the (async) handshake.
    let attachedInsideRun = false;
    await gm.run('gated', async () => {
      attachedInsideRun = gm.session.attached;
    });
    expect(attachedInsideRun).toBe(true);

    // run.started must be observed by the viewer (it was attached in time).
    const started = await viewer.waitForType('run.started');
    expect(started.payload['meta']).toMatchObject({ name: 'gated' });
  });

  it('waitForAttach: <number> waits that long, then fail-opens detached (first run only)', async () => {
    const gm = graphmind({
      url: DEAD_URL,
      enabled: true,
      waitForAttach: 250,
      connectTimeoutMs: 100,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    cleanups.push(() => gm.dispose());

    const t0 = Date.now();
    const first = await gm.run('first', async () => 'ran-detached');
    const firstElapsed = Date.now() - t0;
    expect(first).toBe('ran-detached'); // fail-open: continue without a debugger
    expect(gm.session.attached).toBe(false);
    expect(firstElapsed).toBeGreaterThanOrEqual(200);

    const t1 = Date.now();
    await gm.run('second', async () => {});
    expect(Date.now() - t1).toBeLessThan(150); // one-shot: later runs never wait
  });

  it('gates the first wrapped tool call too (no gm.run needed)', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const gm = graphmind({
      url: viewer.url,
      enabled: true,
      waitForAttach: true,
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => gm.dispose());

    const tools = gm.wrapTools({
      probe: tool({
        description: 'reports whether the session was attached when it ran',
        inputSchema: z.object({}),
        execute: async () => ({ attached: gm.session.attached }),
      }),
    });
    const result = (await tools.probe.execute?.(
      {},
      toolExecutionOptions('call-probe-1'),
    )) as { attached: boolean };
    expect(result.attached).toBe(true);
  });

  it('gates the first wrapped model step in a full scenario', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const gm = graphmind({
      url: viewer.url,
      enabled: true,
      waitForAttach: true,
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => gm.dispose());

    // No explicit attach/warmup anywhere: the option must cover it.
    const outcome = await runScenario(gm, { noRun: true });
    expect(outcome.runError).toBeUndefined();
    expect(outcome.stepCount).toBe(3);

    // The very first llm node.started reached the viewer live or via replay;
    // being attached before step 1 means it is present.
    const nodeStarted = await viewer.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'llm:step',
    );
    expect(nodeStarted).toBeDefined();
    await tick(20);
  });
});
