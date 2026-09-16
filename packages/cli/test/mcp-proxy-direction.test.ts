/**
 * Work methods are recognised in the direction the protocol sends them. A
 * `tools/call` travelling server->client (an echoing or hostile server) is
 * not the agent's tool call: recording it as `tool:<name>` double-counted it
 * on the graph and, since 0.5.0, handed the loop hold a repeat the agent
 * never made — which is how a two-call echo session ended up held.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_NODE_ID, SESSION_NODE_ID, isWorkMethod, mapMethod } from '../src/mcp-proxy/mapping.js';
import { FakeViewer, ProxyRig, tick, waitUntil } from './mcp-proxy-harness.js';

describe('mapping: work is directional', () => {
  it('client->server work maps to work nodes; the same names server->client are protocol', () => {
    expect(mapMethod('tools/call', { name: 'search' }, 'client-to-server')).toMatchObject({
      nodeId: 'tool:search',
      kind: 'tool',
      parentId: SESSION_NODE_ID,
    });
    expect(mapMethod('tools/call', { name: 'search' }, 'server-to-client')).toMatchObject({
      nodeId: 'mcp:tools/call',
      kind: 'custom',
      parentId: PROTOCOL_NODE_ID,
    });
    for (const method of ['resources/read', 'prompts/get', 'completion/complete']) {
      expect(mapMethod(method, {}, 'server-to-client').parentId).toBe(PROTOCOL_NODE_ID);
    }
  });

  it('sampling and elicitation are work only from the server', () => {
    expect(mapMethod('sampling/createMessage', {}, 'server-to-client')).toMatchObject({ nodeId: 'llm:sampling' });
    expect(mapMethod('sampling/createMessage', {}, 'client-to-server')).toMatchObject({
      nodeId: 'mcp:sampling/createMessage',
      parentId: PROTOCOL_NODE_ID,
    });
    expect(mapMethod('elicitation/create', {}, 'server-to-client').parentId).toBe(SESSION_NODE_ID);
    expect(mapMethod('elicitation/create', {}, 'client-to-server').parentId).toBe(PROTOCOL_NODE_ID);
  });

  it('without a direction the closed list is unchanged (compatibility)', () => {
    for (const m of ['tools/call', 'resources/read', 'prompts/get', 'sampling/createMessage', 'completion/complete', 'elicitation/x']) {
      expect(isWorkMethod(m)).toBe(true);
    }
    expect(isWorkMethod('tools/list')).toBe(false);
    expect(mapMethod('tools/call', { name: 'x' })).toMatchObject({ nodeId: 'tool:x' });
  });
});

describe('an echoing server', () => {
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

  it('a tools/call echoed back is protocol traffic, not a second tool call — and two calls never trip the loop hold', async () => {
    const v = await FakeViewer.start({ breakpoints: [] });
    viewer = v;
    const r = new ProxyRig({ server: 'echo-server.mjs', viewerUrl: v.url, waitForAttach: true });
    rig = r;
    await waitUntil(() => r.handle.session.attached, 'the proxy to attach');
    const call = (id: number): string =>
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search', arguments: { q: 'same' } } })}\n`;
    r.clientIn.write(call(1));
    r.clientIn.write(call(2));
    // Both echoes come back — nothing is held.
    await waitUntil(() => Buffer.concat(r.outChunks).length >= call(1).length + call(2).length, 'both echoes');
    await tick(300);
    const starts = v.ofType('node.started');
    expect(starts.filter((f) => f.payload['nodeId'] === 'tool:search')).toHaveLength(2);
    const echoed = starts.filter((f) => f.payload['nodeId'] === 'mcp:tools/call');
    expect(echoed).toHaveLength(2);
    expect(echoed[0]?.payload['parentId']).toBe(PROTOCOL_NODE_ID);
    expect(v.ofType('exec.paused')).toHaveLength(0);
  });
});
