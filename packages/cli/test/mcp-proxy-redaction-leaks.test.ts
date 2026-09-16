/**
 * Two places `graphmind mcp-proxy` records data OUTSIDE a node payload, where
 * the client session's redaction cannot reach (found by the W7 verifier):
 *
 * 1. A failed tool result (`isError: true`) was quoted into `node.error.message`.
 *    The session never redacts `node.error`, and that text is the tool RESULT,
 *    so under GRAPHMIND_HIDE_TOOL_RESULTS / _OUTPUTS the quote is withheld.
 * 2. The proxied command line rides on `run.started.meta.args`. A secret passed
 *    as a server argument is an input, so under GRAPHMIND_HIDE_INPUTS it is not
 *    recorded there either (the session node's own `input` was already hidden).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeViewer, ProxyRig, waitUntil, type ReceivedFrame } from './mcp-proxy-harness.js';

const RESULT_TEXT = 'tool reported failure'; // what raw-server.mjs's `softfail` returns
const ARG_SECRET = 'sk-ARG-CANARY-9f31';

let viewer: FakeViewer | undefined;
let rig: ProxyRig | undefined;

afterEach(async () => {
  if (rig !== undefined) {
    rig.endClient();
    await Promise.race([rig.handle.done, new Promise((r) => setTimeout(r, 3000))]);
    rig.handle.stop('SIGKILL');
    rig = undefined;
  }
  if (viewer !== undefined) {
    await viewer.close();
    viewer = undefined;
  }
});

async function start(env: Record<string, string>, args: string[] = []): Promise<{ viewer: FakeViewer; rig: ProxyRig }> {
  viewer = await FakeViewer.start({ breakpoints: [] });
  rig = new ProxyRig({
    server: 'raw-server.mjs',
    ...(args.length > 0 ? { args: [new URL('./fixtures/mcp-proxy/raw-server.mjs', import.meta.url).pathname, ...args] } : {}),
    viewerUrl: viewer.url,
    waitForAttach: true,
    sessionOptions: { env },
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { viewer, rig };
}

async function softfail(v: FakeViewer, r: ProxyRig): Promise<string> {
  r.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await r.response(1);
  r.callTool(2, 'softfail', {});
  const answer = await r.response(2);
  // The MCP client always gets the real result: redaction is about the recording.
  expect(JSON.stringify(answer)).toContain(RESULT_TEXT);
  await waitUntil(
    () => v.ofType('node.error').some((f: ReceivedFrame) => f.payload['nodeId'] === 'tool:softfail'),
    'the tool error',
  );
  const error = v.ofType('node.error').find((f: ReceivedFrame) => f.payload['nodeId'] === 'tool:softfail');
  return (error?.payload['error'] as { message: string }).message;
}

describe('mcp-proxy: a failed tool result is not quoted into node.error when results are hidden', () => {
  it('no switch: the error quotes the result content (the useful default)', async () => {
    const { viewer: v, rig: r } = await start({});
    expect(await softfail(v, r)).toContain(RESULT_TEXT);
  });

  it('GRAPHMIND_HIDE_TOOL_RESULTS: the error says the call failed and that the content is hidden', async () => {
    const { viewer: v, rig: r } = await start({ GRAPHMIND_HIDE_TOOL_RESULTS: '1' });
    const message = await softfail(v, r);
    expect(message).not.toContain(RESULT_TEXT);
    expect(message).toContain('returned isError: true');
    expect(message).toContain('content hidden');
    // Nowhere in anything the debugger received — the tool's own output is hidden by the session.
    expect(JSON.stringify(v.received)).not.toContain(RESULT_TEXT);
  });

  it('GRAPHMIND_HIDE_OUTPUTS hides it too', async () => {
    const { viewer: v, rig: r } = await start({ GRAPHMIND_HIDE_OUTPUTS: 'true' });
    expect(await softfail(v, r)).not.toContain(RESULT_TEXT);
  });
});

describe('mcp-proxy: the proxied command line follows GRAPHMIND_HIDE_INPUTS', () => {
  const metaOf = (v: FakeViewer): Record<string, unknown> =>
    (v.ofType('run.started')[0]?.payload['meta'] ?? {}) as Record<string, unknown>;

  it('no switch: run metadata carries the args', async () => {
    const { viewer: v } = await start({}, ['--api-key', ARG_SECRET]);
    await waitUntil(() => v.ofType('run.started').length > 0, 'run.started');
    expect(JSON.stringify(metaOf(v)['args'])).toContain(ARG_SECRET);
  });

  it('GRAPHMIND_HIDE_INPUTS: neither the run metadata nor any frame carries the args', async () => {
    const { viewer: v } = await start({ GRAPHMIND_HIDE_INPUTS: '1' }, ['--api-key', ARG_SECRET]);
    await waitUntil(() => v.ofType('node.started').some((f) => f.payload['nodeId'] === 'mcp:session'), 'the session node');
    expect(metaOf(v)['args']).toBeUndefined();
    expect(metaOf(v)['command']).toBeDefined();
    for (const type of ['run.started', 'graph.hint', 'node.started']) {
      expect(JSON.stringify(v.ofType(type)), type).not.toContain(ARG_SECRET);
    }
  });
});

describe('commandLabel under HIDE_INPUTS keeps the server name and drops every value', () => {
  it('file-path basenames survive; flags, flag values, URLs, key=value and bare words do not', async () => {
    const { commandLabel } = await import('../src/mcp-proxy/mapping.js');
    expect(commandLabel('node', ['/srv/mcp/server.mjs', '--api-key', 'sk-live-1'], undefined, true)).toBe('node server.mjs');
    expect(commandLabel('npx', ['-y', '@modelcontextprotocol/server-github'], undefined, true)).toBe('npx server-github');
    expect(commandLabel('uvx', ['mcp-server-fetch', 'token123'], undefined, true)).toBe('uvx');
    expect(commandLabel('node', ['https://x.test/a?token=abc', 'KEY=v/1'], undefined, true)).toBe('node');
    // Unchanged without the switch.
    expect(commandLabel('node', ['/srv/mcp/server.mjs', '--api-key', 'sk-live-1'])).toBe('node server.mjs --api-key sk-live-1');
  });
});
