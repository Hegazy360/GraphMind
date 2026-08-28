/**
 * The debugger half: what the graph looks like, and what each gate action
 * actually does to the JSON-RPC conversation.
 *
 * A real `@graphmind-ai/client` session talks to a real WebSocket viewer
 * double, and a real child process plays the MCP server, so these assertions
 * cover the whole path: frame -> node -> pause -> resume -> frame.
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

async function attach(
  options: { breakpoints?: Parameters<FakeViewer['setBreakpoint']>[0][]; server?: string } = {},
): Promise<{ viewer: FakeViewer; rig: ProxyRig }> {
  viewer = await FakeViewer.start({ breakpoints: options.breakpoints ?? [] });
  rig = new ProxyRig({
    server: options.server ?? 'raw-server.mjs',
    viewerUrl: viewer.url,
    waitForAttach: true,
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { viewer, rig };
}

describe('mcp-proxy: the graph', () => {
  it('models the session, tools, resources, prompts and protocol chatter', async () => {
    const { viewer: v, rig: r } = await attach();
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    r.notify('notifications/initialized');
    r.callTool(2, 'echo', { text: 'graph' });
    r.request(3, 'resources/read', { uri: 'test://greeting' });
    r.request(4, 'prompts/get', { name: 'summarize' });
    await r.response(4);
    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'prompt:summarize');

    const started = v.ofType('node.started');
    const byId = (id: string) => started.find((f) => f.payload['nodeId'] === id);

    expect(byId('mcp:session')?.payload['kind']).toBe('server');
    expect(byId('mcp:initialize')?.payload['kind']).toBe('custom');
    expect(byId('mcp:notifications/initialized')?.payload['kind']).toBe('custom');
    expect(byId('tool:echo')?.payload).toMatchObject({ kind: 'tool', name: 'echo' });
    expect(byId('resource:test://greeting')?.payload['kind']).toBe('resource');
    expect(byId('prompt:summarize')?.payload).toMatchObject({ kind: 'prompt', name: 'summarize' });
    // Every request node hangs off the session node.
    expect(byId('tool:echo')?.payload['parentId']).toBe('mcp:session');
  });

  it('sets instanceId on node.started AND node.finished, per execution', async () => {
    const { viewer: v, rig: r } = await attach();
    r.callTool(1, 'echo', { text: 'one' });
    await r.response(1);
    r.callTool(2, 'echo', { text: 'two' });
    await r.response(2);
    await v.waitFor(
      (f) =>
        f.type === 'node.finished' &&
        f.payload['nodeId'] === 'tool:echo' &&
        v.ofType('node.finished').filter((x) => x.payload['nodeId'] === 'tool:echo').length === 2,
    );

    const events = v.forNode('tool:echo');
    const starts = events.filter((f) => f.type === 'node.started');
    const finishes = events.filter((f) => f.type === 'node.finished');
    expect(starts).toHaveLength(2);
    expect(finishes).toHaveLength(2);
    // One stable logical node, two distinct executions, both closed.
    const ids = [...starts, ...finishes].map((f) => f.payload['instanceId']);
    expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
    expect(new Set(starts.map((f) => f.payload['instanceId'])).size).toBe(2);
    expect(new Set(finishes.map((f) => f.payload['instanceId']))).toEqual(
      new Set(starts.map((f) => f.payload['instanceId'])),
    );
  });

  it('opens a run and closes it, and streams the server’s stderr onto the session node', async () => {
    const { viewer: v, rig: r } = await attach({ server: 'noisy-server.mjs' });
    r.request(1, 'ping');
    await r.response(1);
    const token = await v.waitFor(
      (f) => f.type === 'node.token' && f.payload['nodeId'] === 'mcp:session',
    );
    const deltas = token.payload['deltas'] as { t: string; v: string }[];
    expect(deltas.map((d) => d.v).join('')).toContain('noisy-server: booting');

    expect(v.ofType('run.started')).toHaveLength(1);
    expect(v.ofType('run.started')[0]?.payload['sdk']).toMatchObject({ name: 'mcp-proxy' });

    r.endClient();
    await r.handle.done;
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const sessionFinished = v
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'mcp:session');
    expect(sessionFinished?.payload['status']).toBe('ok');
    rig = undefined;
  });

  it('shows a request the server never answers as still running, then errors it on exit', async () => {
    const { viewer: v, rig: r } = await attach();
    r.callTool('lost', 'never');
    await v.waitFor((f) => f.type === 'node.started' && f.payload['nodeId'] === 'tool:never');
    await tick(150);
    expect(v.forNode('tool:never').filter((f) => f.type === 'node.finished')).toHaveLength(0);

    r.endClient();
    await r.handle.done;
    const errored = await v.waitFor(
      (f) => f.type === 'node.error' && f.payload['nodeId'] === 'tool:never',
    );
    expect((errored.payload['error'] as { message: string }).message).toContain('before answering');
    rig = undefined;
  });

  it('marks a JSON-RPC error and an isError tool result as node errors', async () => {
    const { viewer: v, rig: r } = await attach();
    r.callTool(1, 'boom');
    await r.response(1);
    r.callTool(2, 'softfail');
    await r.response(2);

    const boom = await v.waitFor((f) => f.type === 'node.error' && f.payload['nodeId'] === 'tool:boom');
    expect((boom.payload['error'] as { name: string }).name).toBe('JsonRpcError(-32603)');
    const soft = await v.waitFor(
      (f) => f.type === 'node.error' && f.payload['nodeId'] === 'tool:softfail',
    );
    expect((soft.payload['error'] as { name: string }).name).toBe('McpToolError');
  });
});

describe('mcp-proxy: gates', () => {
  it('holds a request before the server ever sees it, then forwards it on continue', async () => {
    const { viewer: v, rig: r } = await attach({
      server: 'noisy-server.mjs',
      breakpoints: [{ kind: 'tool', point: 'before' }],
    });
    r.callTool(1, 'echo', { text: 'held' });
    const paused = await v.waitForPause('tool:echo', 'before');
    await tick(80);
    // The proof it is really held: the server has not logged the call.
    expect(r.err.toString()).not.toContain('handling tools/call');

    // A hold looks exactly like a hung server from the client's side, so the
    // proxy has to say so on stderr — that is where MCP clients show logs.
    await waitUntil(
      () => r.logs.some((line) => line.includes('HOLDING tools/call')),
      'the hold notice',
    );
    expect(r.logs.join('\n')).toContain('resume it in');

    v.resume(paused.payload['pauseId'] as string, 'continue');
    const response = await r.response(1);
    expect(response).toMatchObject({ id: 1 });
    expect(r.err.toString()).toContain('handling tools/call');
    expect(r.logs.join('\n')).toContain('released tools/call #1 (continue)');
  });

  it('says nothing on stderr for a gate that is not actually held', async () => {
    const { rig: r } = await attach();
    r.callTool(1, 'echo', { text: 'fast' });
    await r.response(1);
    await tick(300);
    expect(r.logs.join('\n')).not.toContain('HOLDING');
  });

  it('queues the frames behind a held one instead of letting them overtake', async () => {
    const { viewer: v, rig: r } = await attach({
      server: 'noisy-server.mjs',
      breakpoints: [{ kind: 'tool', point: 'before' }],
    });
    r.callTool(1, 'echo', { text: 'first' });
    const paused = await v.waitForPause('tool:echo', 'before');
    r.request(2, 'ping');
    await tick(80);
    expect(r.err.toString()).not.toContain('handling ping');
    v.resume(paused.payload['pauseId'] as string, 'continue');
    await r.response(1);
    await r.response(2);
  });

  it('inject at a request gate answers the client and never troubles the server', async () => {
    const { viewer: v, rig: r } = await attach({
      server: 'noisy-server.mjs',
      breakpoints: [{ kind: 'tool', point: 'before' }],
    });
    r.callTool(1, 'echo', { text: 'never-reaches-the-server' });
    const paused = await v.waitForPause('tool:echo', 'before');
    v.resume(paused.payload['pauseId'] as string, 'inject', {
      content: [{ type: 'text', text: 'from the debugger' }],
    });
    const response = (await r.response(1)) as { result: { content: { text: string }[] } };
    expect(response.result.content[0]?.text).toBe('from the debugger');
    await tick(80);
    expect(r.err.toString()).not.toContain('handling tools/call');

    // The event stream is a separate socket from the JSON-RPC pipe, so wait
    // for it rather than assuming it landed before the client's response.
    const finished = await v.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:echo',
    );
    expect(finished.payload).toMatchObject({ injected: true, gatedAt: 'before' });
  });

  it('abort at a request gate returns a JSON-RPC error to the client', async () => {
    const { viewer: v, rig: r } = await attach({
      server: 'noisy-server.mjs',
      breakpoints: [{ kind: 'tool', point: 'before' }],
    });
    r.callTool(1, 'echo', { text: 'doomed' });
    const paused = await v.waitForPause('tool:echo', 'before');
    v.resume(paused.payload['pauseId'] as string, 'abort');
    const response = (await r.response(1)) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32099);
    expect(response.error.message).toContain('aborted by the GraphMind debugger');
    expect(r.err.toString()).not.toContain('handling tools/call');
  });

  it('inject at a response gate rewrites what the client receives', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'tool', point: 'after' }],
    });
    r.callTool(1, 'echo', { text: 'server-said-this' });
    const paused = await v.waitForPause('tool:echo', 'after');
    v.resume(paused.payload['pauseId'] as string, 'inject', {
      content: [{ type: 'text', text: 'debugger-said-this' }],
    });
    const response = (await r.response(1)) as { result: { content: { text: string }[] } };
    expect(response.result.content[0]?.text).toBe('debugger-said-this');
    expect(r.out.toString()).not.toContain('server-said-this');
  });

  it('inject can hand the client a raw JSON-RPC error frame', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'tool', point: 'after' }],
    });
    r.callTool(1, 'echo', { text: 'x' });
    const paused = await v.waitForPause('tool:echo', 'after');
    v.resume(paused.payload['pauseId'] as string, 'inject', {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'synthetic failure' },
    });
    const response = (await r.response(1)) as { error: { code: number } };
    expect(response.error.code).toBe(-32000);
  });

  it('an error response trips the error gate, and retry re-sends the request', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'tool', name: 'boom', point: 'error' }],
    });
    r.callTool(1, 'boom');
    const paused = await v.waitForPause('tool:boom', 'error');
    v.resume(paused.payload['pauseId'] as string, 'retry');

    // The server answers the re-sent request the same way; the second pause
    // proves the original bytes really went back out.
    const again = await v.waitFor(
      (f) =>
        f.type === 'exec.paused' &&
        f.payload['nodeId'] === 'tool:boom' &&
        f !== paused &&
        v.ofType('exec.paused').filter((x) => x.payload['nodeId'] === 'tool:boom').length >= 2,
    );
    v.resume(again.payload['pauseId'] as string, 'continue');
    const response = (await r.response(1)) as { error: { code: number } };
    expect(response.error.code).toBe(-32603);

    const finished = await v.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:boom',
    );
    expect(finished.payload['retries']).toBe(1);
    expect(finished.payload['status']).toBe('error');
  });

  it('an isError tool result trips the error gate too', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'tool', name: 'softfail', point: 'error' }],
    });
    r.callTool(1, 'softfail');
    const paused = await v.waitForPause('tool:softfail', 'error');
    v.resume(paused.payload['pauseId'] as string, 'inject', {
      content: [{ type: 'text', text: 'fixed by hand' }],
    });
    const response = (await r.response(1)) as { result: { content: { text: string }[] } };
    expect(response.result.content[0]?.text).toBe('fixed by hand');
  });

  it('gates a server-initiated sampling request as an llm node', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'llm', point: 'before' }],
    });
    r.callTool(1, 'sample');
    const paused = await v.waitForPause('llm:sampling', 'before');
    v.resume(paused.payload['pauseId'] as string, 'inject', { model: 'injected', content: 'hi' });
    const answer = (await r.response(1)) as { result: { content: { text: string }[] } };
    expect(answer.result.content[0]?.text).toContain('injected');
  });

  it('gates notifications, and abort swallows one', async () => {
    const { viewer: v, rig: r } = await attach({
      server: 'noisy-server.mjs',
      breakpoints: [{ kind: 'custom', name: 'notifications/initialized', point: 'before' }],
    });
    r.notify('notifications/initialized');
    const paused = await v.waitForPause('mcp:notifications/initialized', 'before');
    v.resume(paused.payload['pauseId'] as string, 'abort');
    r.request(1, 'ping');
    await r.response(1);
    expect(r.err.toString()).not.toContain('handling notifications/initialized');
    expect(r.err.toString()).toContain('handling ping');
  });

  it('relays a notification unchanged when the injected value cannot be a frame', async () => {
    const { viewer: v, rig: r } = await attach({
      server: 'noisy-server.mjs',
      breakpoints: [{ kind: 'custom', name: 'notifications/initialized', point: 'before' }],
    });
    r.notify('notifications/initialized');
    const paused = await v.waitForPause('mcp:notifications/initialized', 'before');
    v.resume(paused.payload['pauseId'] as string, 'inject', 'not-an-object');
    await waitUntil(
      () => r.err.toString().includes('handling notifications/initialized'),
      'the original notification to be relayed',
    );
    expect(r.logs.join('\n')).toContain('inject on a notification needs a JSON object');
  });

  it('FAILS OPEN: a debugger that disappears mid-hold releases the gate', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'tool', point: 'before' }],
    });
    r.callTool(1, 'echo', { text: 'rescued' });
    await v.waitForPause('tool:echo', 'before');
    v.killAbruptly();
    viewer = undefined;

    const response = (await r.response(1)) as { result: { content: { text: string }[] } };
    expect(response.result.content[0]?.text).toBe('rescued');
  });
});
