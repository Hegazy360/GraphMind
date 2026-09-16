/**
 * The loop hold reaches `graphmind mcp-proxy` with no proxy code change.
 *
 * Detection lives in @graphmind-ai/client's session — the proxy only emits
 * `node.started` (input = the tools/call params) and awaits gate('before')
 * like every adapter — so an MCP client that asks the server for the same
 * tool with the same arguments again and again is held on the third call,
 * in the real child-process pipe, and every resume action still means what
 * it means at the protocol boundary.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeViewer, ProxyRig, tick, waitUntil } from './mcp-proxy-harness.js';

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

/** Env the session sees: nothing from the machine, so the defaults are under test. */
const CLEAN_ENV = {};

async function attach(sessionOptions: Record<string, unknown> = {}): Promise<{ viewer: FakeViewer; rig: ProxyRig }> {
  viewer = await FakeViewer.start({ breakpoints: [] });
  rig = new ProxyRig({
    server: 'raw-server.mjs',
    viewerUrl: viewer.url,
    waitForAttach: true,
    sessionOptions: { env: CLEAN_ENV, ...sessionOptions },
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { viewer, rig };
}

function answered(r: ProxyRig, id: number): boolean {
  return r.out.toString('utf8').includes(`"id":${id}`);
}

const SAME = { text: 'same' };

describe('mcp-proxy inherits the loop hold', () => {
  it('holds the third identical tools/call with reason loop; continue lets it through', async () => {
    const { viewer: v, rig: r } = await attach();
    r.callTool(1, 'echo', SAME);
    await r.response(1);
    r.callTool(2, 'echo', SAME);
    await r.response(2);
    expect(v.ofType('exec.paused')).toHaveLength(0);

    r.callTool(3, 'echo', SAME);
    const paused = await v.waitForPause('tool:echo', 'before');
    expect(paused.payload).toMatchObject({
      reason: 'loop',
      loop: { repeats: 3 },
    });
    const starts = v.forNode('tool:echo').filter((f) => f.type === 'node.started').map((f) => f.seq);
    const loop = paused.payload['loop'] as { firstSeq: number; lastSeq: number; fingerprint: string };
    expect(starts).toHaveLength(3);
    expect(loop.firstSeq).toBe(starts[0]);
    expect(loop.lastSeq).toBe(starts[2]);
    expect(loop.fingerprint).toMatch(/^[0-9a-f]{32}$/);

    // Held for real: the server has not been asked, the client has no answer.
    await tick(200);
    expect(answered(r, 3)).toBe(false);
    expect(r.handle.session.stats().heldGates).toBe(1);

    v.resume(paused.payload['pauseId'] as string, 'continue');
    const response = await r.response(3);
    expect(JSON.stringify(response)).toContain('same');
    expect(r.handle.session.stats().heldGates).toBe(0);

    // A different argument is a different call: answered, not held...
    r.callTool(4, 'echo', { text: 'different' });
    await r.response(4);
    // ...and it reset the streak, so the next "same" is a fresh count of one.
    r.callTool(5, 'echo', SAME);
    await r.response(5);
    expect(v.ofType('exec.paused')).toHaveLength(1);
  });

  it('abort at the loop hold answers the client with the GraphMind abort error and never forwards', async () => {
    const { viewer: v, rig: r } = await attach();
    for (const id of [1, 2]) {
      r.callTool(id, 'echo', SAME);
      await r.response(id);
    }
    r.callTool(3, 'echo', SAME);
    const paused = await v.waitForPause('tool:echo', 'before');
    v.resume(paused.payload['pauseId'] as string, 'abort');
    const response = await r.response(3);
    const error = response['error'] as { code: number; message: string };
    expect(error.code).toBe(-32099);
    expect(error.message).toContain('aborted by the GraphMind debugger');
    await v.waitFor((f) => f.type === 'node.finished' && f.payload['status'] === 'aborted');
    const finished = v
      .forNode('tool:echo')
      .filter((f) => f.type === 'node.finished')
      .map((f) => f.payload['status']);
    expect(finished).toEqual(['ok', 'ok', 'aborted']);
  });

  it('inject at the loop hold hands the client a coerced tool result and the server never sees the call', async () => {
    const { viewer: v, rig: r } = await attach();
    for (const id of [1, 2]) {
      r.callTool(id, 'echo', SAME);
      await r.response(id);
    }
    r.callTool(3, 'echo', SAME);
    const paused = await v.waitForPause('tool:echo', 'before');
    v.resume(paused.payload['pauseId'] as string, 'inject', 'try something else');
    const response = await r.response(3);
    const result = response['result'] as { content: { type: string; text: string }[] };
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'try something else' });
    const third = await v.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:echo' && f.payload['injected'] === true,
    );
    expect(third.payload).toMatchObject({ status: 'ok', injected: true });
  });

  it('a fourth identical call is held again (repeats 4); an allow-listed tool never is', async () => {
    const { viewer: v, rig: r } = await attach();
    for (const id of [1, 2]) {
      r.callTool(id, 'echo', SAME);
      await r.response(id);
    }
    r.callTool(3, 'echo', SAME);
    const third = await v.waitForPause('tool:echo', 'before');
    v.resume(third.payload['pauseId'] as string, 'continue');
    await r.response(3);
    r.callTool(4, 'echo', SAME);
    const fourth = await v.waitFor(
      (f) => f.type === 'exec.paused' && (f.payload['loop'] as { repeats: number } | undefined)?.repeats === 4,
    );
    v.resume(fourth.payload['pauseId'] as string, 'continue');
    await r.response(4);

    rig = undefined;
    r.endClient();
    await r.handle.done;
    await v.close();

    const allow = await attach({ loopGuard: { allowNodes: ['echo'] } });
    for (const id of [1, 2, 3, 4, 5]) {
      allow.rig.callTool(id, 'echo', SAME);
      await allow.rig.response(id);
    }
    expect(allow.viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('FAIL OPEN: with no debugger the identical calls all go through, with one warning', async () => {
    const warnings: string[] = [];
    rig = new ProxyRig({
      server: 'raw-server.mjs',
      sessionOptions: { env: CLEAN_ENV, logger: (message: string) => warnings.push(message) },
    });
    for (const id of [1, 2, 3, 4, 5, 6]) {
      rig.callTool(id, 'echo', SAME);
      const response = await rig.response(id);
      expect(JSON.stringify(response)).toContain('same');
    }
    const loopWarnings = warnings.filter((w) => w.includes('possible loop'));
    expect(loopWarnings).toHaveLength(1);
    expect(loopWarnings[0]).toContain('tool:echo');
    expect(loopWarnings[0]).toContain('no debugger is attached');
  });

  it('GRAPHMIND_ON_LOOP=off (env) and GRAPHMIND_LOOP_THRESHOLD=5 (env) are honoured by the proxy session', async () => {
    const off = await attach({ env: { GRAPHMIND_ON_LOOP: 'off' } });
    for (const id of [1, 2, 3, 4, 5]) {
      off.rig.callTool(id, 'echo', SAME);
      await off.rig.response(id);
    }
    expect(off.viewer.ofType('exec.paused')).toHaveLength(0);
    rig = undefined;
    off.rig.endClient();
    await off.rig.handle.done;
    await off.viewer.close();

    const five = await attach({ env: { GRAPHMIND_LOOP_THRESHOLD: '5' } });
    for (const id of [1, 2, 3, 4]) {
      five.rig.callTool(id, 'echo', SAME);
      await five.rig.response(id);
    }
    expect(five.viewer.ofType('exec.paused')).toHaveLength(0);
    five.rig.callTool(5, 'echo', SAME);
    const paused = await five.viewer.waitForPause('tool:echo', 'before');
    expect((paused.payload['loop'] as { repeats: number }).repeats).toBe(5);
    five.viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await five.rig.response(5);
  });

  // Verifier pass (2026-09-14). An MCP client with progress enabled — the
  // official SDK's Client whenever `onprogress` is set — stamps a unique
  // `_meta.progressToken` on every tools/call. The proxy's tool input is the
  // whole params object, so before `_meta` was ignored the same tool with the
  // same arguments never fingerprinted identically and the proxy never held.
  it('a client that sends a fresh _meta.progressToken on every call is still held on the third identical call', async () => {
    const { viewer: v, rig: r } = await attach();
    const params = (id: number) => ({
      name: 'echo',
      arguments: SAME,
      _meta: { progressToken: id },
    });
    for (const id of [1, 2]) {
      r.request(id, 'tools/call', params(id));
      await r.response(id);
    }
    expect(v.ofType('exec.paused')).toHaveLength(0);
    r.request(3, 'tools/call', params(3));
    const paused = await v.waitForPause('tool:echo', 'before');
    expect(paused.payload).toMatchObject({ reason: 'loop', loop: { repeats: 3 } });
    await tick(150);
    expect(answered(r, 3)).toBe(false);
    v.resume(paused.payload['pauseId'] as string, 'continue');
    expect(JSON.stringify(await r.response(3))).toContain('same');
  });

  it('paging through a listing (a different cursor each call) is not a loop and is never held', async () => {
    const { viewer: v, rig: r } = await attach();
    for (const id of [1, 2, 3, 4, 5]) {
      r.callTool(id, 'echo', { text: 'same', cursor: `page-${id}` });
      const response = await r.response(id);
      expect(JSON.stringify(response)).toContain('same');
    }
    expect(v.ofType('exec.paused')).toHaveLength(0);
  });

  it('a debugger that disconnects mid-hold releases the loop hold (the client gets its answer)', async () => {
    const { viewer: v, rig: r } = await attach();
    for (const id of [1, 2]) {
      r.callTool(id, 'echo', SAME);
      await r.response(id);
    }
    r.callTool(3, 'echo', SAME);
    await v.waitForPause('tool:echo', 'before');
    v.killAbruptly();
    viewer = undefined;
    const response = await r.response(3);
    expect(JSON.stringify(response)).toContain('same');
  });
});

describe('GRAPHMIND_LOOP_ALLOW through the proxy', () => {
  it('a tool named in GRAPHMIND_LOOP_ALLOW is never held, however often it repeats', async () => {
    const { viewer: v, rig: r } = await attach({ env: { GRAPHMIND_LOOP_ALLOW: 'echo' } });
    for (let id = 1; id <= 5; id += 1) {
      r.callTool(id, 'echo', SAME);
      await r.response(id);
    }
    expect(v.forNode('tool:echo').filter((f) => f.type === 'node.started')).toHaveLength(5);
    expect(v.ofType('exec.paused')).toHaveLength(0);
  });
});

// Loop hold v3 (decisions.md "a loop is the same call BACK-TO-BACK"). The whole
// MCP host conversation is ONE run through the proxy, so under v2 an agent that
// called `echo({text: 'same'})` three times across a long session — other tools
// between — had the third call held. Fails on the v2 per-node rule.
describe('mcp-proxy loop hold v3 — back-to-back only', () => {
  it('3 identical echo calls separated by other tool calls are never held; 3 back-to-back ones are', async () => {
    const { viewer: v, rig: r } = await attach();
    let id = 0;
    const others = async (round: number) => {
      r.callTool((id += 1), 'slow', { ms: 1 });
      await r.response(id);
      r.callTool((id += 1), 'big', { size: 16 + round });
      await r.response(id);
      r.callTool((id += 1), 'notify', {});
      await r.response(id);
    };
    for (let round = 0; round < 4; round += 1) {
      r.callTool((id += 1), 'echo', SAME);
      const response = await r.response(id);
      expect(JSON.stringify(response), `echo #${round + 1} answered`).toContain('same');
      await others(round);
    }
    await waitUntil(
      () => v.forNode('tool:echo').filter((f) => f.type === 'node.finished').length === 4,
      'four echo calls finished on the wire',
    );
    expect(v.forNode('tool:echo').filter((f) => f.type === 'node.started')).toHaveLength(4);
    expect(v.ofType('exec.paused')).toHaveLength(0);

    // Back-to-back: the third identical call is held at the protocol boundary.
    for (let n = 0; n < 2; n += 1) {
      r.callTool((id += 1), 'echo', SAME);
      await r.response(id);
    }
    const heldId = (id += 1);
    r.callTool(heldId, 'echo', SAME);
    const paused = await v.waitForPause('tool:echo', 'before');
    expect(paused.payload).toMatchObject({ reason: 'loop', loop: { repeats: 3 } });
    await tick(150);
    expect(answered(r, heldId)).toBe(false);
    const starts = v.forNode('tool:echo').filter((f) => f.type === 'node.started').map((f) => f.seq);
    expect((paused.payload['loop'] as { firstSeq: number }).firstSeq).toBe(starts.at(-3));
    v.resume(paused.payload['pauseId'] as string, 'continue');
    expect(JSON.stringify(await r.response(heldId))).toContain('same');
  });
});
