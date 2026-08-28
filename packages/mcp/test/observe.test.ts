/**
 * What the viewer sees for an ordinary, un-gated server: one run per incoming
 * request, a `server` node for the session, and a tool / resource / prompt
 * node under it — with the JSON-RPC id as the execution id on BOTH ends of
 * each node's lifecycle.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { attach, makeCleanups, setup } from './helpers/setup.js';
import { makeHarness, resourceText, toolText } from './helpers/mcp.js';
import type { ReceivedFrame } from './helpers/fake-viewer.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

function nodeStarts(frames: ReceivedFrame[], nodeId: string): ReceivedFrame[] {
  return frames.filter((f) => f.type === 'node.started' && f.payload['nodeId'] === nodeId);
}

describe('tools', () => {
  it('a tool call is one run: server node + tool node, with matching instanceIds', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const result = await h.client.callTool({
      name: 'searchFlights',
      arguments: { from: 'VIE', to: 'LIS' },
    });
    expect(toolText(result)).toContain('TP1234');

    await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights',
    );

    const started = nodeStarts(viewer.received, 'tool:searchFlights');
    expect(started).toHaveLength(1);
    const toolStart = started[0]!;
    expect(toolStart.payload['kind']).toBe('tool');
    expect(toolStart.payload['name']).toBe('searchFlights');
    expect(toolStart.payload['parentId']).toBe('server:trip-server');
    expect(toolStart.payload['input']).toEqual({ from: 'VIE', to: 'LIS' });

    // instanceId is set on node.started AND node.finished (decisions.md #1).
    const instanceId = toolStart.payload['instanceId'] as string;
    expect(typeof instanceId).toBe('string');
    const finished = viewer.received.find(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights',
    )!;
    expect(finished.payload['instanceId']).toBe(instanceId);
    expect(finished.payload['status']).toBe('ok');

    // The server session node wraps it, with the same execution id.
    const serverStart = nodeStarts(viewer.received, 'server:trip-server')[0]!;
    expect(serverStart.payload['kind']).toBe('server');
    expect(serverStart.payload['instanceId']).toBe(instanceId);
    expect(serverStart.payload['input']).toMatchObject({ method: 'tools/call', version: '2.1.0' });

    // Everything above lives in one run named after the request.
    const runStarted = viewer.received.find(
      (f) => f.type === 'run.started' && f.runId === toolStart.runId,
    )!;
    expect((runStarted.payload['meta'] as Record<string, unknown>)['name']).toBe(
      'tools/call:searchFlights',
    );
  });

  it('pre-announces the whole registered surface with graph.hint', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    // The hint is sent at connect(), before any request.
    const hint = await viewer.waitForType('graph.hint');
    const nodes = hint.payload['nodes'] as { nodeId: string; kind: string; name: string }[];
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    expect(byId.get('server:trip-server')?.kind).toBe('server');
    expect(byId.get('tool:searchFlights')?.kind).toBe('tool');
    expect(byId.get('tool:ping')?.kind).toBe('tool');
    expect(byId.get('resource:appConfig')?.kind).toBe('resource');
    expect(byId.get('resource:userProfile')?.kind).toBe('resource');
    expect(byId.get('prompt:greet')?.kind).toBe('prompt');
    // Registered nodes hang off the server node.
    expect(byId.get('tool:searchFlights')?.['parentId' as never]).toBe('server:trip-server');
  });

  it('a zero-argument tool (called as `(extra)`) is instrumented too', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const result = await h.client.callTool({ name: 'ping' });
    expect(toolText(result)).toBe('pong');

    const start = await viewer.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'tool:ping',
    );
    expect(start.payload['input']).toBeUndefined();
    expect(h.attempts.get('ping')).toBe(1);
  });

  it('a throwing tool emits node.error and still returns the SDK error result', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm, { flakyFailures: 99 });
    cleanups.push(h.close);

    const result = (await h.client.callTool({ name: 'flaky', arguments: { n: 1 } })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('HTTP 500');

    const errored = await viewer.waitFor(
      (f) => f.type === 'node.error' && f.payload['nodeId'] === 'tool:flaky',
    );
    const error = errored.payload['error'] as { message: string };
    expect(error.message).toContain('HTTP 500');
    expect(typeof errored.payload['instanceId']).toBe('string');

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:flaky',
    );
    expect(finished.payload['status']).toBe('error');
  });
});

describe('resources and prompts', () => {
  it('a static resource read is a `resource` node named by its registration', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const result = await h.client.readResource({ uri: 'config://app' });
    expect(resourceText(result)).toContain('dark');

    const start = await viewer.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'resource:appConfig',
    );
    expect(start.payload['kind']).toBe('resource');
    // A URL object would serialize to `{}`; the adapter stringifies it.
    expect(start.payload['input']).toEqual({ uri: 'config://app' });
  });

  it('a templated resource stays ONE logical node, with the variables as input', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    await h.client.readResource({ uri: 'users://7/profile' });
    await h.client.readResource({ uri: 'users://8/profile' });

    await viewer.waitForNth(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'resource:userProfile',
      2,
    );
    const starts = nodeStarts(viewer.received, 'resource:userProfile');
    expect(starts).toHaveLength(2);
    expect(starts[0]!.payload['input']).toEqual({
      uri: 'users://7/profile',
      variables: { id: '7' },
    });
    // Two executions, two distinct instance ids, one node.
    expect(starts[0]!.payload['instanceId']).not.toBe(starts[1]!.payload['instanceId']);
  });

  it('a prompt fetch is a `prompt` node', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const result = await h.client.getPrompt({ name: 'greet', arguments: { name: 'Ada' } });
    expect(JSON.stringify(result.messages)).toContain('Ada');

    const start = await viewer.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'prompt:greet',
    );
    expect(start.payload['kind']).toBe('prompt');
    expect(start.payload['input']).toEqual({ name: 'Ada' });
  });

  it('a throwing resource surfaces a JSON-RPC error to the client', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    await expect(h.client.readResource({ uri: 'broken://thing' })).rejects.toThrow(
      /resource backend unavailable/,
    );
    const errored = await viewer.waitFor(
      (f) => f.type === 'node.error' && f.payload['nodeId'] === 'resource:brokenResource',
    );
    expect((errored.payload['error'] as { message: string }).message).toContain(
      'resource backend unavailable',
    );
  });
});
