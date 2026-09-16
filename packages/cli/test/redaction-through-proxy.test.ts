/**
 * `graphmind mcp-proxy` inherits the kill switches through the client
 * session it reports with — no reporter change. GRAPHMIND_HIDE_TOOL_ARGS /
 * _TOOL_RESULTS hide what the debugger RECORDS about a tools/call; the bytes
 * relayed between the MCP client and server are untouched, because redaction
 * is about the recording, never about the conversation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED } from '../src/redact-secrets.js';
import { FakeViewer, ProxyRig, waitUntil, type ReceivedFrame } from './mcp-proxy-harness.js';

const ARG = 'ARG-CANARY-c4a7e1';

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

async function start(env: Record<string, string>): Promise<{ viewer: FakeViewer; rig: ProxyRig }> {
  viewer = await FakeViewer.start();
  rig = new ProxyRig({
    server: 'raw-server.mjs',
    viewerUrl: viewer.url,
    waitForAttach: true,
    sessionOptions: { env },
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { viewer, rig };
}

async function drive(r: ProxyRig): Promise<Record<string, unknown>> {
  r.request(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'redaction-test', version: '1' },
  });
  await r.response(1);
  r.notify('notifications/initialized');
  r.callTool(2, 'echo', { text: ARG });
  return r.response(2);
}

const payloadOf = (v: FakeViewer, type: string, nodeId: string): Record<string, unknown> | undefined =>
  v.ofType(type).find((f: ReceivedFrame) => f.payload['nodeId'] === nodeId)?.payload;

describe('mcp-proxy inherits the redaction switches through the client session', () => {
  it('HIDE_TOOL_ARGS + HIDE_TOOL_RESULTS: the tool node is recorded redacted, the MCP client still gets the real answer', async () => {
    const { viewer: v, rig: r } = await start({
      GRAPHMIND_HIDE_TOOL_ARGS: '1',
      GRAPHMIND_HIDE_TOOL_RESULTS: 'true',
    });
    const response = await drive(r);
    // The conversation is untouched: the echoed text reaches the client.
    expect(JSON.stringify(response)).toContain(ARG);
    expect(JSON.stringify(response)).not.toContain(REDACTED);

    r.endClient();
    await r.handle.done;
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    rig = undefined;

    const started = payloadOf(v, 'node.started', 'tool:echo');
    const finished = payloadOf(v, 'node.finished', 'tool:echo');
    expect(started).toMatchObject({
      kind: 'tool',
      name: 'echo',
      input: REDACTED,
      method: 'tools/call',
      redaction: { count: 1, keys: ['input'] },
    });
    expect(finished).toMatchObject({
      output: REDACTED,
      status: 'ok',
      method: 'tools/call',
      redaction: { count: 1, keys: ['output'] },
    });
    expect(typeof finished?.['durationMs']).toBe('number');
    // Protocol traffic is not a tool: initialize keeps its params under these two switches.
    const init = payloadOf(v, 'node.started', 'mcp:initialize');
    expect(init?.['kind']).not.toBe('tool');
    expect(JSON.stringify(init?.['input'])).toContain('redaction-test');
    // And the canary never reached the recording anywhere.
    expect(JSON.stringify(v.received)).not.toContain(ARG);
  });

  it('HIDE_INPUTS hides every node.started.input, protocol frames included; outputs stay', async () => {
    const { viewer: v, rig: r } = await start({ GRAPHMIND_HIDE_INPUTS: '1' });
    await drive(r);
    r.endClient();
    await r.handle.done;
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    rig = undefined;

    const startsWithInput = v.ofType('node.started').filter((f) => 'input' in f.payload);
    expect(startsWithInput.length).toBeGreaterThanOrEqual(3); // initialize, initialized, echo
    for (const f of startsWithInput) expect(f.payload['input'], String(f.payload['nodeId'])).toBe(REDACTED);
    expect(JSON.stringify(v.received)).not.toContain('redaction-test');
    // The echo RESULT is still recorded: only inputs are hidden by this switch.
    const finished = payloadOf(v, 'node.finished', 'tool:echo');
    expect(JSON.stringify(finished?.['output'])).toContain(ARG);
  });

  it('with no switch set the proxy records the arguments as before (the tests above are not vacuous)', async () => {
    const { viewer: v, rig: r } = await start({});
    await drive(r);
    r.endClient();
    await r.handle.done;
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    rig = undefined;
    expect(payloadOf(v, 'node.started', 'tool:echo')?.['input']).toEqual({ name: 'echo', arguments: { text: ARG } });
    expect(JSON.stringify(payloadOf(v, 'node.finished', 'tool:echo')?.['output'])).toContain(ARG);
  });
});
