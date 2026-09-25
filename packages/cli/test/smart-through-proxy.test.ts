/**
 * The 0.6.0 detectors reach `graphmind mcp-proxy` through the real child
 * process pipe (contract C4 / W4), with no proxy-specific detector code: the
 * proxy keeps gating an `isError: true` tool result at its `error` point and
 * hands the gate the result, and the client session does the rest.
 *
 *   - error-result: ONE isError result is ONE hold — at the error gate,
 *     `reason: 'breakpoint'` + `smart.rule: 'error-result'`, whether or not
 *     the pause-on-error breakpoint is armed; a JSON-RPC error stays an
 *     ordinary error hold (`reason: 'error'`, no smart).
 *   - error-repeat: three identical isError results of one tool (arguments
 *     varying) and the 4th call is held at its `before` gate with `reason:
 *     'loop'`, `loop.kind: 'error-repeat'`, the four legacy fields filled —
 *     firstSeq the first failure's start, lastSeq the held call's start.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeViewer, ProxyRig, tick, waitUntil, type ReceivedFrame } from './mcp-proxy-harness.js';

let viewer: FakeViewer | undefined;
let rig: ProxyRig | undefined;

afterEach(async () => {
  if (rig !== undefined) {
    rig.endClient();
    await Promise.race([rig.handle.done, tick(3000)]);
    rig.handle.stop('SIGKILL');
    rig = undefined;
  }
  if (viewer !== undefined) {
    await viewer.close();
    viewer = undefined;
  }
});

async function attach(
  env: Record<string, string> = {},
  breakpoints: { kind?: 'tool'; point?: 'error' }[] = [],
): Promise<{ viewer: FakeViewer; rig: ProxyRig }> {
  viewer = await FakeViewer.start({ breakpoints });
  rig = new ProxyRig({
    server: 'raw-server.mjs',
    viewerUrl: viewer.url,
    waitForAttach: true,
    sessionOptions: { env },
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { viewer, rig };
}

const RESULT_TEXT = 'tool reported failure'; // what raw-server.mjs's `softfail` returns

function pauses(v: FakeViewer): ReceivedFrame[] {
  return v.ofType('exec.paused');
}

/** Wait for the Nth exec.paused (1-based). */
function nthPause(v: FakeViewer, n: number): Promise<ReceivedFrame> {
  return waitUntil(() => pauses(v).length >= n, `pause #${n}`).then(() => pauses(v)[n - 1] as ReceivedFrame);
}

describe('error-result through the proxy: one isError result, one hold', () => {
  it('held at the error gate with the smart rule; nothing reaches the client until continue', async () => {
    const { viewer: v, rig: r } = await attach();
    r.callTool(1, 'softfail', { n: 1 });
    const paused = await v.waitForPause('tool:softfail', 'error');
    const call = v.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:softfail');
    expect(paused.payload).toEqual({
      pauseId: paused.payload['pauseId'],
      nodeId: 'tool:softfail',
      point: 'error',
      reason: 'breakpoint',
      smart: { rule: 'error-result', detail: 'the tool returned a result with isError: true' },
      // The pause names the call it holds (exec.paused.instanceId, 0.6.0).
      instanceId: call?.payload['instanceId'],
    });
    await tick(200);
    expect(r.out.toString('utf8')).not.toContain('"id":1');
    v.resume(paused.payload['pauseId'] as string, 'continue');
    expect(JSON.stringify(await r.response(1))).toContain(RESULT_TEXT);
    expect(pauses(v)).toHaveLength(1);
  });

  it('with pause-on-error armed: still one hold (the smart rule); a JSON-RPC error is a plain error hold', async () => {
    const { viewer: v, rig: r } = await attach({}, [{ point: 'error' }]);
    r.callTool(1, 'softfail');
    const soft = await nthPause(v, 1);
    expect(soft.payload).toMatchObject({ point: 'error', reason: 'breakpoint', smart: { rule: 'error-result' } });
    v.resume(soft.payload['pauseId'] as string, 'continue');
    await r.response(1);
    await tick(100);
    expect(pauses(v)).toHaveLength(1);

    r.callTool(2, 'boom');
    const boom = await nthPause(v, 2);
    expect(boom.payload).toMatchObject({ nodeId: 'tool:boom', point: 'error', reason: 'error' });
    expect(boom.payload).not.toHaveProperty('smart');
    v.resume(boom.payload['pauseId'] as string, 'continue');
    await r.response(2);
  });

  it('GRAPHMIND_BREAK_ON_ERROR_RESULT=off: an isError result is not held (no breakpoint armed)', async () => {
    const { viewer: v, rig: r } = await attach({ GRAPHMIND_BREAK_ON_ERROR_RESULT: 'off' });
    r.callTool(1, 'softfail');
    expect(JSON.stringify(await r.response(1))).toContain(RESULT_TEXT);
    expect(pauses(v)).toHaveLength(0);
  });
});

describe('error-repeat through the proxy', () => {
  it('three identical isError results (arguments varying): the 4th call is held before it reaches the server', async () => {
    const { viewer: v, rig: r } = await attach();
    // Each failure is also an error-result smart hold: continue through them.
    for (const id of [1, 2, 3]) {
      r.callTool(id, 'softfail', { attempt: id });
      const smart = await nthPause(v, id);
      expect(smart.payload).toMatchObject({ point: 'error', smart: { rule: 'error-result' } });
      v.resume(smart.payload['pauseId'] as string, 'continue');
      await r.response(id);
    }
    r.callTool(4, 'softfail', { attempt: 4 });
    const held = await nthPause(v, 4);
    expect(held.payload).toMatchObject({ nodeId: 'tool:softfail', point: 'before', reason: 'loop' });
    const loop = held.payload['loop'] as Record<string, unknown>;
    const starts = v
      .forNode('tool:softfail')
      .filter((f) => f.type === 'node.started')
      .map((f) => f.seq);
    expect(starts).toHaveLength(4);
    expect(loop).toEqual({
      repeats: 3,
      firstSeq: starts[0],
      lastSeq: starts[3],
      fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
      kind: 'error-repeat',
    });
    expect(held.payload).not.toHaveProperty('smart');
    expect(JSON.stringify(held)).not.toContain(RESULT_TEXT);

    // Held for real: the server has not been asked.
    await tick(200);
    expect(r.out.toString('utf8')).not.toContain('"id":4');
    v.resume(held.payload['pauseId'] as string, 'continue');
    // It runs, fails again, and is the error-result hold once more.
    const again = await nthPause(v, 5);
    expect(again.payload).toMatchObject({ point: 'error', smart: { rule: 'error-result' } });
    v.resume(again.payload['pauseId'] as string, 'continue');
    await r.response(4);
  });

  it('with error-result off, only the error-repeat hold; other tools between the failures do not break it', async () => {
    const { viewer: v, rig: r } = await attach({ GRAPHMIND_BREAK_ON_ERROR_RESULT: '0' });
    for (const id of [1, 2]) {
      r.callTool(id, 'softfail', { attempt: id });
      await r.response(id);
    }
    // A different tool between failures does not break the node's streak...
    r.callTool(3, 'echo', { text: 'hi' });
    await r.response(3);
    r.callTool(4, 'softfail', { attempt: 4 });
    await r.response(4);
    expect(pauses(v)).toHaveLength(0);
    r.callTool(5, 'softfail', { attempt: 5 });
    const held = await nthPause(v, 1);
    expect(held.payload).toMatchObject({ reason: 'loop', loop: { kind: 'error-repeat', repeats: 3 } });
    v.resume(held.payload['pauseId'] as string, 'continue');
    await r.response(5);
  });

  it('under GRAPHMIND_HIDE_TOOL_RESULTS the error-repeat fingerprint is the placeholder', async () => {
    const { viewer: v, rig: r } = await attach({ GRAPHMIND_BREAK_ON_ERROR_RESULT: '0', GRAPHMIND_HIDE_TOOL_RESULTS: '1' });
    for (const id of [1, 2, 3]) {
      r.callTool(id, 'softfail', { attempt: id });
      await r.response(id);
    }
    r.callTool(4, 'softfail', { attempt: 4 });
    const held = await nthPause(v, 1);
    expect(held.payload['loop']).toMatchObject({ kind: 'error-repeat', repeats: 3, fingerprint: '__REDACTED__' });
    v.resume(held.payload['pauseId'] as string, 'continue');
    await r.response(4);
  });
});
