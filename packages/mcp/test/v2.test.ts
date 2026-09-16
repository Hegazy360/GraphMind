/**
 * `@graphmind-ai/mcp` on the MCP SDK v2 family: `@modelcontextprotocol/server`
 * 2.0.0 driven by `@modelcontextprotocol/client` 2.0.0, legacy (2025-11-25)
 * era over the in-memory pair. The same public API (`gm.wrapServer`) and the
 * same events and gates as the 1.x suites — this file is what makes the
 * `>=2 <3` peer range a tested claim instead of a hopeful one.
 *
 * What is specifically v2 here: the trailing CONTEXT argument
 * (`ctx.mcpReq.{id, method, signal, send, requestSampling}`) that replaced the
 * 1.x `RequestHandlerExtra`, and the string-method `setRequestHandler`.
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, Server } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isHandlerContext, isHandlerExtra, requestContextOf } from '../src/sdk-types.js';
import { tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';
import { makeHarnessV2, resourceText, toolText } from './helpers/mcp-v2.js';
import { attach, makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

const starts = (frames: ReceivedFrame[], nodeId: string): ReceivedFrame[] =>
  frames.filter((f) => f.type === 'node.started' && f.payload['nodeId'] === nodeId);
const pausedOn =
  (nodeId: string, point = 'before') =>
  (f: ReceivedFrame): boolean =>
    f.type === 'exec.paused' && f.payload['nodeId'] === nodeId && f.payload['point'] === point;

describe('v2: the shape of a request', () => {
  it('a tool call is one run: server node + tool node, instanceId from the v2 ctx.mcpReq.id', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const result = await h.client.callTool({ name: 'searchFlights', arguments: { from: 'VIE', to: 'LIS' } });
    expect(toolText(result)).toContain('TP1234');
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights');

    const [toolStart] = starts(viewer.received, 'tool:searchFlights');
    expect(toolStart?.payload).toMatchObject({
      kind: 'tool',
      name: 'searchFlights',
      parentId: 'server:trip-server-v2',
      input: { from: 'VIE', to: 'LIS' },
    });
    const instanceId = toolStart?.payload['instanceId'] as string;
    // The JSON-RPC id, namespaced by the connection — not a random fallback.
    expect(instanceId).toMatch(/:\d+$/);
    const finished = viewer.received.find(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(finished?.payload['instanceId']).toBe(instanceId);
    expect(finished?.payload['status']).toBe('ok');

    const [serverStart] = starts(viewer.received, 'server:trip-server-v2');
    expect(serverStart?.payload).toMatchObject({ kind: 'server', name: 'trip-server-v2' });
    expect((serverStart?.payload['input'] as { version: string }).version).toBe('2.1.0');
    expect(serverStart?.payload['instanceId']).toBe(instanceId);
    expect(serverStart?.runId).toBe(toolStart?.runId);
  });

  it('a zero-argument tool reports an empty input, never the v2 context object', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    expect(toolText(await h.client.callTool({ name: 'ping' }))).toBe('pong');
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:ping');
    const [start] = starts(viewer.received, 'tool:ping');
    const input = start?.payload['input'];
    expect(input === undefined || (typeof input === 'object' && !('mcpReq' in (input as object)))).toBe(true);
    // The handler still received the real context (it read the request id).
    expect(h.marks.first('tool:body-start', (m) => m.data?.['toolName'] === 'ping')?.data?.['requestId']).toBeDefined();
  });

  it('a templated resource keeps its variables and never leaks the context as `variables`', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const result = await h.client.readResource({ uri: 'users://42/profile' });
    expect(resourceText(result)).toBe(JSON.stringify({ id: '42' }));
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'resource:userProfile');
    const [start] = starts(viewer.received, 'resource:userProfile');
    expect(start?.payload['kind']).toBe('resource');
    expect(start?.payload['input']).toEqual({ uri: 'users://42/profile', variables: { id: '42' } });

    const plain = await h.client.readResource({ uri: 'config://app' });
    expect(resourceText(plain)).toBe(JSON.stringify({ theme: 'dark' }));
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'resource:appConfig');
    expect(starts(viewer.received, 'resource:appConfig')[0]?.payload['input']).toEqual({ uri: 'config://app' });
  });

  it('prompts, graph.hint and the sdk badge', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const prompt = await h.client.getPrompt({ name: 'greet', arguments: { name: 'Ada' } });
    expect(JSON.stringify(prompt.messages)).toContain('Say hello to Ada');
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'prompt:greet');
    expect(starts(viewer.received, 'prompt:greet')[0]?.payload).toMatchObject({
      kind: 'prompt',
      input: { name: 'Ada' },
      parentId: 'server:trip-server-v2',
    });

    const hint = viewer.ofType('graph.hint')[0];
    const ids = new Map(
      (hint?.payload['nodes'] as { nodeId: string; kind: string }[]).map((n) => [n.nodeId, n.kind]),
    );
    expect(ids.get('server:trip-server-v2')).toBe('server');
    expect(ids.get('tool:searchFlights')).toBe('tool');
    expect(ids.get('resource:userProfile')).toBe('resource');
    expect(ids.get('prompt:greet')).toBe('prompt');

    // The hello frame names the SDK that is actually installed for v2.
    const hello = viewer.ofType('hello')[0];
    const sdk = hello?.payload['sdk'] as { name: string; version: string };
    expect(['@modelcontextprotocol/sdk', '@modelcontextprotocol/server']).toContain(sdk.name);
    expect(sdk.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('v2: gates', () => {
  it('before: holds the request — the handler body has not started while held', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'searchFlights', arguments: { from: 'VIE', to: 'LIS' } });
    const paused = await viewer.waitFor(pausedOn('tool:searchFlights'));
    await tick(400);
    expect(h.marks.first('tool:body-start')).toBeUndefined();
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(toolText(await call)).toContain('TP1234');
    expect(h.marks.first('tool:body-start')).toBeDefined();
  });

  it('before: inject substitutes the result the v2 client receives; the handler never runs', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'searchFlights', arguments: { from: 'VIE', to: 'LIS' } });
    const paused = await viewer.waitFor(pausedOn('tool:searchFlights'));
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'NO FLIGHTS AVAILABLE');
    const result = await call;
    expect(toolText(result)).toBe('NO FLIGHTS AVAILABLE');
    expect(h.attempts.get('searchFlights')).toBeUndefined();
    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(finished.payload).toMatchObject({ injected: true, injectedAt: 'before' });
  });

  it('before: an injected object satisfies a tool with an outputSchema (the v2 client validates it)', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool', name: 'quote' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'quote', arguments: { symbol: 'ACME' } });
    const paused = await viewer.waitFor(pausedOn('tool:quote'));
    viewer.resume(paused.payload['pauseId'] as string, 'inject', { symbol: 'ACME', price: 999 });
    const result = (await call) as { structuredContent?: unknown; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ symbol: 'ACME', price: 999 });
  });

  it('error: the gate fires before the SDK turns the throw into isError; retry re-runs the handler; inject repairs it', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ point: 'error' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm, { flakyFailures: 1 });
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'flaky', arguments: { n: 7 } });
    const paused = await viewer.waitFor(pausedOn('tool:flaky', 'error'));
    const errored = viewer.received.find((f) => f.type === 'node.error' && f.payload['nodeId'] === 'tool:flaky');
    expect((errored?.payload['error'] as { message: string }).message).toContain('HTTP 500');
    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    const result = (await call) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toBe('ok after 2 attempts: 7');
    expect(h.attempts.get('flaky')).toBe(2);

    // Same thing on a resource, repaired instead of retried.
    const read = h.client.readResource({ uri: 'broken://thing' });
    const p2 = await viewer.waitFor(pausedOn('resource:brokenResource', 'error'));
    viewer.resume(p2.payload['pauseId'] as string, 'inject', 'recovered contents');
    expect(resourceText(await read)).toBe('recovered contents');
  });

  it('error: `continue` lets the v2 SDK produce its usual isError result', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ point: 'error' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm, { flakyFailures: 5 });
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'flaky', arguments: { n: 1 } });
    const paused = await viewer.waitFor(pausedOn('tool:flaky', 'error'));
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const result = (await call) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('HTTP 500');
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:flaky');
    expect(finished.payload['status']).toBe('error');
  });

  it('after: fires post-handler, pre-return; inject replaces the real result', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'searchFlights', point: 'after' }],
    });
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'searchFlights', arguments: { from: 'A', to: 'B' } });
    const paused = await viewer.waitFor(pausedOn('tool:searchFlights', 'after'));
    expect(h.marks.first('tool:body-end')).toBeDefined();
    viewer.resume(paused.payload['pauseId'] as string, 'inject', { content: [{ type: 'text', text: 'after-injected' }] });
    expect(toolText(await call)).toBe('after-injected');
  });

  it('abort: the handler sees it through ctx.mcpReq.signal (chained, not replaced) and the request is terminal', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool', name: 'slow', point: 'after' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    // The handler runs (no before breakpoint), waits, and is aborted at the
    // after gate: the run's AbortController fires, and the signal the handler
    // was given is the CHAINED one, so an abort at the gate is visible to it —
    // that is what "abort" means for a handler mid-flight.
    const call = h.client.callTool({ name: 'slow', arguments: { ms: 50 } });
    const paused = await viewer.waitFor(pausedOn('tool:slow', 'after'));
    expect(h.marks.first('tool:body-start', (m) => m.data?.['toolName'] === 'slow')?.data?.['abortedAtStart']).toBe(false);
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    const result = (await call) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('GraphMind');
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:slow');
    expect(finished.payload['status']).toBe('aborted');
  });

  it('abort at a before gate: the client gets a terminal isError result and the handler never ran', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool', name: 'slow' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'slow', arguments: { ms: 5 } });
    const paused = await viewer.waitFor(pausedOn('tool:slow'));
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    const result = (await call) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(h.attempts.get('slow')).toBeUndefined();
  });
});

describe('v2: sampling from inside a handler', () => {
  it('ctx.mcpReq.requestSampling becomes a gated llm node nested under the tool, in the same run', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'llm' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm, { samplingAnswer: 'a short summary' });
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'summarize', arguments: { text: 'a long document' } });
    const paused = await viewer.waitFor(pausedOn('llm:sampling'));
    const sampling = starts(viewer.received, 'llm:sampling')[0];
    expect(sampling?.payload).toMatchObject({ kind: 'llm', parentId: 'tool:summarize' });
    expect(JSON.stringify(sampling?.payload['input'])).toContain('a long document');
    expect(sampling?.runId).toBe(starts(viewer.received, 'tool:summarize')[0]?.runId);
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'injected model answer');
    // The handler received the injected CreateMessageResult, not the client's.
    expect(toolText(await call)).toBe('summary: injected model answer');
  });

  it('abort at the sampling gate reaches the handler through the CHAINED ctx.mcpReq.signal', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'llm' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'summarizeGuarded', arguments: { text: 'doc' } });
    const paused = await viewer.waitFor(pausedOn('llm:sampling'));
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    // The handler caught the abort and read ITS signal: chained, so aborted.
    // Without chaining this would read `aborted=false`.
    expect(toolText(await call)).toBe('failed: aborted=true name=AbortError');
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:sampling');
    expect(finished.payload['status']).toBe('aborted');
  });

  it('ctx.mcpReq.send({ method: "sampling/createMessage" }) is gated the same way', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm, { samplingAnswer: 'via send' });
    cleanups.push(h.close);

    expect(toolText(await h.client.callTool({ name: 'summarizeViaSend', arguments: { text: 'doc' } }))).toBe(
      'summary: via send',
    );
    const sampling = await viewer.waitFor((f) => f.type === 'node.started' && f.payload['nodeId'] === 'llm:sampling');
    expect(sampling.payload['parentId']).toBe('tool:summarizeViaSend');
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:sampling');
    expect(JSON.stringify(finished.payload['output'])).toContain('via send');
  });

  it('server.createMessage through the wrapped `.server` view still works on v2', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm, { samplingAnswer: 'server-side' });
    cleanups.push(h.close);

    expect(toolText(await h.client.callTool({ name: 'summarizeViaServer', arguments: { text: 'doc' } }))).toBe(
      'summary: server-side',
    );
    const sampling = await viewer.waitFor((f) => f.type === 'node.started' && f.payload['nodeId'] === 'llm:sampling');
    expect(sampling.payload['parentId']).toBe('tool:summarizeViaServer');
  });
});

describe('v2: the low-level Server (string-method setRequestHandler)', () => {
  async function lowLevel(wrap: <T extends object>(s: T) => T, threeArg: boolean) {
    const calls: string[] = [];
    const raw = new Server({ name: 'hand-rolled-v2', version: '0.5.0' }, { capabilities: { tools: {}, resources: {} } });
    const server = wrap(raw);
    server.setRequestHandler('tools/list', async () => ({
      tools: [{ name: 'echo', inputSchema: { type: 'object' as const } }],
    }));
    if (threeArg) {
      // `(method, { params }, handler)`: the handler receives the PARSED PARAMS,
      // not the request — the method is only known from the registration.
      server.setRequestHandler(
        'tools/call',
        { params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }) },
        async (params) => {
          calls.push('echo');
          return { content: [{ type: 'text' as const, text: `echo: ${String(params.arguments?.['message'] ?? '')}` }] };
        },
      );
    } else {
      server.setRequestHandler('tools/call', async (request) => {
        calls.push('echo');
        const message = (request.params.arguments as { message?: string } | undefined)?.message ?? '';
        return { content: [{ type: 'text' as const, text: `echo: ${message}` }] };
      });
    }
    server.setRequestHandler('resources/read', async (request) => {
      calls.push('read');
      return { contents: [{ uri: request.params.uri, text: 'raw contents' }] };
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await raw.close().catch(() => undefined);
    });
    return { client, calls };
  }

  for (const threeArg of [false, true]) {
    it(`${threeArg ? '3-arg' : '2-arg'} form: tool + resource nodes, gated, under server:hand-rolled-v2`, async () => {
      const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool', name: 'echo' }] });
      await attach(gm);
      const { client, calls } = await lowLevel((s) => gm.wrapServer(s), threeArg);

      const call = client.callTool({ name: 'echo', arguments: { message: 'hi' } });
      const paused = await viewer.waitFor(pausedOn('tool:echo'));
      expect(calls).toEqual([]);
      expect(starts(viewer.received, 'tool:echo')[0]?.payload).toMatchObject({
        parentId: 'server:hand-rolled-v2',
        input: { message: 'hi' },
      });
      viewer.resume(paused.payload['pauseId'] as string, 'inject', 'substituted');
      expect(toolText(await call)).toBe('substituted');
      expect(calls).toEqual([]);

      expect(resourceText(await client.readResource({ uri: 'file:///x' }))).toBe('raw contents');
      await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'resource:file:///x');
      expect(starts(viewer.received, 'resource:file:///x')[0]?.payload['kind']).toBe('resource');
      // tools/list went through uninstrumented (no node, no run of its own).
      expect(starts(viewer.received, 'mcp:tools/list')).toHaveLength(0);
    });
  }
});

describe('v2: RegisteredTool.update and never-throw', () => {
  it('a callback swapped through update() stays instrumented', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool', name: 'swap' }] });
    await attach(gm);
    const raw = new McpServer({ name: 'u', version: '1' });
    const server = gm.wrapServer(raw);
    const reg = server.registerTool('swap', { inputSchema: { x: z.string() } }, async ({ x }) => ({
      content: [{ type: 'text', text: `v1:${x}` }],
    }));
    let ran = 0;
    reg.update({
      callback: async (args: unknown) => {
        ran += 1;
        return { content: [{ type: 'text', text: `v2:${(args as { x: string }).x}` }] };
      },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await raw.close().catch(() => undefined);
    });
    const call = client.callTool({ name: 'swap', arguments: { x: 'a' } });
    const paused = await viewer.waitFor(pausedOn('tool:swap'));
    expect(ran).toBe(0);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(toolText(await call)).toBe('v2:a');
    expect(ran).toBe(1);
  });

  it('wrapping writes nothing onto the real v2 server and forwards the rest', async () => {
    const { gm } = await setup(cleanups.push);
    const raw = new McpServer({ name: 'pristine', version: '1' });
    const before = Object.getOwnPropertyNames(raw).sort();
    const server = gm.wrapServer(raw);
    server.registerTool('t', {}, async () => ({ content: [] }));
    expect(Object.getOwnPropertyNames(raw).sort()).toEqual(before);
    expect(server.isConnected()).toBe(false);
    expect(server.server).not.toBe(raw.server); // the instrumented view
    expect(Object.getPrototypeOf(server)).toBe(McpServer.prototype);
    expect(server instanceof McpServer).toBe(true);
  });
});

describe('v2: the context guard', () => {
  it('recognises a v2 ctx and a 1.x extra, and nothing else', () => {
    const ctx = { sessionId: undefined, mcpReq: { id: 3, method: 'tools/call', signal: new AbortController().signal } };
    expect(isHandlerContext(ctx)).toBe(true);
    expect(isHandlerExtra(ctx)).toBe(false);
    const extra = { requestId: 3, signal: new AbortController().signal };
    expect(isHandlerExtra(extra)).toBe(true);
    expect(isHandlerContext(extra)).toBe(false);
    for (const junk of [undefined, null, 'x', 7, {}, { mcpReq: {} }, { mcpReq: { id: 1 } }, { mcpReq: 'nope' }]) {
      expect(isHandlerContext(junk)).toBe(false);
    }
    expect(requestContextOf(ctx)).toEqual({ requestId: 3, sessionId: undefined, signal: ctx.mcpReq.signal });
    expect(requestContextOf(extra)).toEqual({ requestId: 3, sessionId: undefined, signal: extra.signal });
    expect(requestContextOf({})).toBeUndefined();
  });
});

describe('v2: detached', () => {
  it('serves normally with no debugger and adds nothing measurable', async () => {
    const gm = (await setup(cleanups.push, {}, { url: 'ws://127.0.0.1:1/ingest', connectTimeoutMs: 50 })).gm;
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);
    await waitUntil(() => !gm.session.attached, 1000, 'detached');
    expect(toolText(await h.client.callTool({ name: 'ping' }))).toBe('pong');
    expect(resourceText(await h.client.readResource({ uri: 'users://7/profile' }))).toBe(JSON.stringify({ id: '7' }));
    expect(toolText(await h.client.callTool({ name: 'summarize', arguments: { text: 'x' } }))).toBe(
      'summary: sampled answer',
    );
  });
});
