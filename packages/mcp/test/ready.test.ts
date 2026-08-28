/**
 * The attach guarantee. An MCP server usually starts before anyone opens the
 * debugger, so `waitForAttach` moves the handshake to `connect()` — the one
 * place a server has before it can be asked to do anything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { graphmind } from '../src/index.js';
import { makeHarness, toolText } from './helpers/mcp.js';
import { makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

describe('waitForAttach', () => {
  it('connect() waits for the handshake, so breakpoints are armed for request #1', async () => {
    const { viewer, gm } = await setup(
      cleanups.push,
      { breakpoints: [{ kind: 'tool' }] },
      { waitForAttach: 4000 },
    );
    // Deliberately NOT calling attach(): connect() must do it.
    const h = await makeHarness(gm);
    cleanups.push(h.close);
    expect(gm.session.attached).toBe(true);

    const call = h.client.callTool({ name: 'ping' });
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:ping',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(toolText(await call)).toBe('pong');
  });

  it('fails open: an unreachable debugger costs the timeout and nothing else', async () => {
    const gm = graphmind({
      enabled: true,
      // Port 1 is not listening: the connect attempt fails fast.
      url: 'ws://127.0.0.1:1/ingest',
      retryIntervalMs: 60_000,
      waitForAttach: 300,
      logger: () => {},
    });
    cleanups.push(() => gm.dispose());

    const startedAt = Date.now();
    const h = await makeHarness(gm);
    cleanups.push(h.close);
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(gm.session.attached).toBe(false);
    expect(toolText(await h.client.callTool({ name: 'ping' }))).toBe('pong');
  });

  it('ready() resolves false when GraphMind is disabled', async () => {
    const gm = graphmind({ enabled: false, logger: () => {} });
    cleanups.push(() => gm.dispose());
    expect(await gm.ready()).toBe(false);
  });

  it('ready() resolves true once the viewer has answered', async () => {
    const { gm } = await setup(cleanups.push);
    expect(await gm.ready({ timeoutMs: 4000 })).toBe(true);
    expect(gm.session.attached).toBe(true);
  });
});
