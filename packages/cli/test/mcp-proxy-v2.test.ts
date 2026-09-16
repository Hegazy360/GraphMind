/**
 * `graphmind mcp-proxy` against the MCP SDK v2 family — `@modelcontextprotocol/server`
 * 2.0.0 (with `@modelcontextprotocol/core`) on the server side, driven by BOTH client
 * generations: `@modelcontextprotocol/client` 2.0.0 and `@modelcontextprotocol/sdk` 1.30.
 *
 * Why this file exists: the proxy is wire-level, so it "should not care" which SDK
 * produced the bytes — but v2 changed real things on the wire and a debugger that is
 * merely assumed to work is not one. What v2 actually does (read from the shipped
 * `.d.mts` and `.mjs`, and confirmed frame by frame against the fixtures here):
 *
 *  - The default client posture is still LEGACY: `connect()` runs the 2025-11-25
 *    `initialize` handshake, byte-identical to a 1.x client. Opting into
 *    `versionNegotiation: { mode: 'auto' | { pin: '2026-07-28' } }` sends a
 *    `server/discover` probe first (a method the proxy's mapping has never heard of).
 *  - A plain `McpServer.connect(new StdioServerTransport())` serves the legacy era
 *    ONLY: the SDK itself answers `server/discover` with -32601. Only
 *    `serveStdio(factory)` serves the 2026-07-28 era (fixtures/mcp-v2/serve-stdio.mjs).
 *  - On the modern era there is no `initialize` at all; every request carries a
 *    `params._meta` envelope, every result carries `resultType: 'complete'` plus
 *    `_meta['io.modelcontextprotocol/serverInfo']`, and cacheable results
 *    (`resources/read`, the listings, `server/discover`) carry `ttlMs`/`cacheScope`.
 *    The v2 client's 2026 `decodeResult` REJECTS a result with no `resultType`.
 *  - The v2 `McpServer` answers a THROWING tool handler with an in-band
 *    `isError: true` result (the 1.x low-level `Server` answered with a JSON-RPC
 *    error). Both must trip the proxy's error gate.
 *
 * Same rig as the other proxy suites: a real `@graphmind-ai/client` session, a real
 * WebSocket viewer double, a real child process. The clients use a stream-backed
 * transport only so the test owns both ends of the pipe; protocol, schemas,
 * correlation, validation and era negotiation are the SDKs' own.
 */
import { Client as ClientV2, ReadBuffer, serializeMessage, type Transport } from '@modelcontextprotocol/client';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { BreakpointMatcher } from '@graphmind-ai/schema';
import { FakeViewer, ProxyRig, tick, waitUntil, type ReceivedFrame } from './mcp-proxy-harness.js';

/** The SDK's stdio framing over a pair of streams the test already owns. */
class StreamClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly readBuffer = new ReadBuffer();

  constructor(
    private readonly outbound: Writable,
    private readonly inbound: Readable,
  ) {}

  async start(): Promise<void> {
    this.inbound.on('data', (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.readBuffer.readMessage();
        } catch (error) {
          this.onerror?.(error as Error);
          return;
        }
        if (message === null) return;
        this.onmessage?.(message);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.outbound.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

type V2Options = ConstructorParameters<typeof ClientV2>[1];

let rig: ProxyRig | undefined;
let viewer: FakeViewer | undefined;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.().catch(() => undefined);
  if (rig !== undefined) {
    rig.endClient();
    await Promise.race([rig.handle.done, tick(4000)]);
    rig.handle.stop('SIGKILL');
    rig = undefined;
  }
  await viewer?.close();
  viewer = undefined;
});

async function proxied(
  server: 'server.mjs' | 'serve-stdio.mjs',
  breakpoints: BreakpointMatcher[] = [],
): Promise<{ rig: ProxyRig; viewer: FakeViewer }> {
  viewer = await FakeViewer.start({ breakpoints });
  rig = new ProxyRig({
    command: process.execPath,
    args: [new URL(`./fixtures/mcp-v2/${server}`, import.meta.url).pathname],
    viewerUrl: viewer.url,
    waitForAttach: true,
    // A cold first test in a fresh worker can take more than the rig's 200 ms
    // to open the WebSocket; give it a real chance and retry quickly.
    sessionOptions: { connectTimeoutMs: 2_000, retryIntervalMs: 200 },
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { rig, viewer };
}

async function connectV2(r: ProxyRig, options?: V2Options): Promise<ClientV2> {
  const client = new ClientV2({ name: 'graphmind-v2-test', version: '1.0.0' }, options);
  closers.push(() => client.close());
  await client.connect(new StreamClientTransport(r.clientIn, r.clientOut));
  return client;
}

async function connectV1(r: ProxyRig): Promise<ClientV1> {
  const client = new ClientV1({ name: 'graphmind-v1-test', version: '1.0.0' });
  closers.push(() => client.close());
  // The 1.x Transport interface is structurally identical for what we use.
  await client.connect(new StreamClientTransport(r.clientIn, r.clientOut) as never);
  return client;
}

const startOf = (v: FakeViewer, nodeId: string): ReceivedFrame | undefined =>
  v.ofType('node.started').find((f) => f.payload['nodeId'] === nodeId);
const finishOf = (v: FakeViewer, nodeId: string): ReceivedFrame | undefined =>
  v.ofType('node.finished').find((f) => f.payload['nodeId'] === nodeId);
const errorOf = (v: FakeViewer, nodeId: string): ReceivedFrame | undefined =>
  v.ofType('node.error').find((f) => f.payload['nodeId'] === nodeId);
const text = (result: unknown): string | undefined =>
  (result as ToolResult).content?.find((c) => c.type === 'text')?.text;
/**
 * The client's promise settles the moment the answer frame is on the pipe; the
 * matching `node.finished` / `node.error` reaches the viewer over a separate
 * WebSocket a beat later. Await them instead of reading them.
 */
const finished = (v: FakeViewer, nodeId: string, nth = 1): Promise<ReceivedFrame> =>
  v
    .waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === nodeId &&
      v.ofType('node.finished').filter((x) => x.payload['nodeId'] === nodeId).length >= nth)
    .then(() => v.ofType('node.finished').filter((x) => x.payload['nodeId'] === nodeId)[nth - 1] as ReceivedFrame);
const errored = (v: FakeViewer, nodeId: string): Promise<ReceivedFrame> =>
  v.waitFor((f) => f.type === 'node.error' && f.payload['nodeId'] === nodeId);
/**
 * The n-th pause on a node. `FakeViewer.waitForPause` hands back the FIRST
 * matching frame ever received, so a test that gates the same node twice must
 * ask for the second one explicitly or it resumes a gate that is already gone.
 */
const nthPause = (v: FakeViewer, nodeId: string, point: string, n: number): Promise<ReceivedFrame> => {
  const match = (f: ReceivedFrame): boolean =>
    f.type === 'exec.paused' && f.payload['nodeId'] === nodeId && f.payload['point'] === point;
  return v
    .waitFor((f) => match(f) && v.received.filter(match).length >= n)
    .then(() => v.received.filter(match)[n - 1] as ReceivedFrame);
};

/** The W2a session shape, asserted the same way for every client/era combination. */
function expectSessionShape(v: FakeViewer, protocolMethods: string[], workNodes: string[]): void {
  expect(startOf(v, 'mcp:session')?.payload).toMatchObject({ kind: 'server', instanceId: 'mcp:session' });
  expect(startOf(v, 'mcp:protocol')?.payload).toMatchObject({
    kind: 'custom',
    name: 'protocol',
    parentId: 'mcp:session',
    instanceId: 'mcp:protocol',
    collapsed: true,
  });
  for (const method of protocolMethods) {
    const node = startOf(v, `mcp:${method}`);
    expect(node, `mcp:${method} was recorded`).toBeDefined();
    expect(node?.payload['parentId'], `${method} sits under mcp:protocol`).toBe('mcp:protocol');
    expect(node?.payload['kind']).toBe('custom');
  }
  for (const nodeId of workNodes) {
    const node = startOf(v, nodeId);
    expect(node, `${nodeId} was recorded`).toBeDefined();
    expect(node?.payload['parentId'], `${nodeId} sits directly under the session`).toBe('mcp:session');
  }
  // Only the two synthetic nodes are ever named 'mcp:…' under the session itself.
  for (const f of v.ofType('node.started')) {
    const id = f.payload['nodeId'] as string;
    if (id.startsWith('mcp:') && id !== 'mcp:session' && id !== 'mcp:protocol') {
      expect(f.payload['parentId'], `${id} is protocol traffic`).toBe('mcp:protocol');
    }
  }
}

// ── v2 client, default (legacy) posture ─────────────────────────────────────

describe('mcp-proxy: @modelcontextprotocol/server 2.0 driven by the v2 client (default posture)', () => {
  it('completes the 2025-11-25 handshake, folds protocol traffic, and records the negotiated version', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs');
    const client = await connectV2(r);

    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getServerVersion()).toMatchObject({ name: 'graphmind-v2-fixture', version: '2.0.0' });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    expect((await client.listResources()).resources[0]?.uri).toBe('v2://greeting');
    expect((await client.listPrompts()).prompts[0]?.name).toBe('summarize');

    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'mcp:prompts/list');
    expect(r.handle.reporter.negotiatedProtocolVersion).toBe('2025-11-25');
    expect(finishOf(v, 'mcp:initialize')?.payload['status']).toBe('ok');
    expect((finishOf(v, 'mcp:initialize')?.payload['output'] as { protocolVersion: string }).protocolVersion).toBe(
      '2025-11-25',
    );
    expectSessionShape(
      v,
      ['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list'],
      [],
    );
    // Nothing paused, nothing was rewritten: the handshake is the SDK's own.
    expect(v.ofType('exec.paused')).toHaveLength(0);
  });

  it('maps tools/call, resources/read and prompts/get onto work nodes with the v2 payloads intact', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs');
    const client = await connectV2(r);

    const echoed = (await client.callTool({ name: 'echo', arguments: { text: 'through the proxy' } })) as ToolResult;
    expect(JSON.parse(text(echoed) ?? '{}')).toEqual({ text: 'through the proxy' });
    expect(echoed.structuredContent).toEqual({ echoed: { text: 'through the proxy' } });

    const resource = await client.readResource({ uri: 'v2://greeting' });
    expect(resource.contents[0]).toMatchObject({ uri: 'v2://greeting', text: 'hello from the v2 resource' });

    const prompt = await client.getPrompt({ name: 'summarize', arguments: { topic: 'otters' } });
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text', text: 'Summarize otters' });

    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'prompt:summarize');
    expectSessionShape(v, ['initialize'], ['tool:echo', 'resource:v2://greeting', 'prompt:summarize']);

    const tool = startOf(v, 'tool:echo');
    expect(tool?.payload).toMatchObject({
      kind: 'tool',
      name: 'echo',
      method: 'tools/call',
      input: { name: 'echo', arguments: { text: 'through the proxy' } },
    });
    const toolDone = finishOf(v, 'tool:echo');
    expect(toolDone?.payload['instanceId']).toBe(tool?.payload['instanceId']);
    expect(toolDone?.payload['status']).toBe('ok');
    expect((toolDone?.payload['output'] as ToolResult).structuredContent).toEqual({
      echoed: { text: 'through the proxy' },
    });
    expect(typeof toolDone?.payload['durationMs']).toBe('number');
    expect(startOf(v, 'resource:v2://greeting')?.payload['kind']).toBe('resource');
    expect(startOf(v, 'prompt:summarize')?.payload['kind']).toBe('prompt');
  });

  it('holds a tools/call BEFORE the v2 server sees it, then lets it through', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ kind: 'tool', name: 'echo', point: 'before' }]);
    const client = await connectV2(r);

    const pending = client.callTool({ name: 'echo', arguments: { text: 'held' } });
    const paused = await v.waitForPause('tool:echo', 'before');
    expect(startOf(v, 'tool:echo')?.payload['input']).toMatchObject({ arguments: { text: 'held' } });
    // Held: the request has not been forwarded, so no answer can exist yet.
    await tick(150);
    expect(finishOf(v, 'tool:echo')).toBeUndefined();

    v.resume(paused.payload['pauseId'] as string, 'continue');
    expect(text(await pending)).toBe(JSON.stringify({ text: 'held' }));
    expect((await finished(v, 'tool:echo')).payload['status']).toBe('ok');
  });

  it('holds the answer AFTER the server produced it; a bare injected string is lifted into a CallToolResult the v2 client accepts', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ kind: 'tool', name: 'echo', point: 'after' }]);
    const client = await connectV2(r);

    const pending = client.callTool({ name: 'echo', arguments: { text: 'real' } });
    const paused = await v.waitForPause('tool:echo', 'after');
    v.resume(paused.payload['pauseId'] as string, 'inject', 'from the debugger');

    const result = (await pending) as ToolResult;
    // The v2 client validated the substituted frame and handed it to the host.
    expect(result.content).toEqual([{ type: 'text', text: 'from the debugger' }]);
    expect(result.isError).toBeFalsy();
    expect((await finished(v, 'tool:echo')).payload).toMatchObject({ injected: true, gatedAt: 'after', status: 'ok' });
  });

  it('a bare injected object also lands in structuredContent, and a full CallToolResult passes through untouched', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ kind: 'tool', name: 'echo', point: 'before' }]);
    const client = await connectV2(r);

    const first = client.callTool({ name: 'echo', arguments: { text: 'a' } });
    const p1 = await v.waitForPause('tool:echo', 'before');
    v.resume(p1.payload['pauseId'] as string, 'inject', { price: 42 });
    const r1 = (await first) as ToolResult;
    expect(r1.structuredContent).toEqual({ price: 42 });
    expect(text(r1)).toBe('{"price":42}');

    const second = client.callTool({ name: 'echo', arguments: { text: 'b' } });
    const p2 = await nthPause(v, 'tool:echo', 'before', 2);
    v.resume(p2.payload['pauseId'] as string, 'inject', {
      content: [{ type: 'text', text: 'verbatim' }],
      isError: true,
    });
    const r2 = (await second) as ToolResult;
    expect(r2).toMatchObject({ content: [{ type: 'text', text: 'verbatim' }], isError: true });
    // Two injects at the before gate: the server never saw either request.
    await finished(v, 'tool:echo', 2);
    expect(v.ofType('node.finished').filter((f) => f.payload['nodeId'] === 'tool:echo')).toHaveLength(2);
    for (const f of v.ofType('node.finished').filter((f) => f.payload['nodeId'] === 'tool:echo')) {
      expect(f.payload).toMatchObject({ injected: true, gatedAt: 'before' });
    }
  });

  it('inject at resources/read and prompts/get produces shapes the v2 client accepts', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [
      { kind: 'resource', point: 'after' },
      { kind: 'prompt', point: 'after' },
    ]);
    const client = await connectV2(r);

    const read = client.readResource({ uri: 'v2://greeting' });
    const p1 = await v.waitForPause('resource:v2://greeting', 'after');
    v.resume(p1.payload['pauseId'] as string, 'inject', 'substituted text');
    const resource = await read;
    expect(resource.contents).toEqual([{ uri: 'v2://greeting', text: 'substituted text' }]);

    const get = client.getPrompt({ name: 'summarize', arguments: { topic: 'x' } });
    const p2 = await v.waitForPause('prompt:summarize', 'after');
    v.resume(p2.payload['pauseId'] as string, 'inject', 'Say something else');
    const prompt = await get;
    expect(prompt.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Say something else' } }]);
  });

  it('a THROWING v2 handler arrives as isError:true — the error gate trips and the debugger can repair it', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ point: 'error' }]);
    const client = await connectV2(r);

    const pending = client.callTool({ name: 'echo', arguments: { text: 'boom', mode: 'throw' } });
    const paused = await v.waitForPause('tool:echo', 'error');
    const errored = errorOf(v, 'tool:echo');
    expect((errored?.payload['error'] as { name: string; message: string }).name).toBe('McpToolError');
    expect((errored?.payload['error'] as { message: string }).message).toContain('kaboom v2');

    v.resume(paused.payload['pauseId'] as string, 'inject', {
      content: [{ type: 'text', text: 'repaired by the debugger' }],
    });
    const result = (await pending) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe('repaired by the debugger');
    expect((await finished(v, 'tool:echo')).payload).toMatchObject({ injected: true, gatedAt: 'error', status: 'ok' });
  });

  it('an in-band isError:true result trips the same gate; `continue` hands the v2 client the original failure', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ point: 'error' }]);
    const client = await connectV2(r);

    const pending = client.callTool({ name: 'echo', arguments: { text: 'no', mode: 'isError' } });
    const paused = await v.waitForPause('tool:echo', 'error');
    v.resume(paused.payload['pauseId'] as string, 'continue');
    const result = (await pending) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('refused: no');
    expect((await finished(v, 'tool:echo')).payload['status']).toBe('error');
    expect((errorOf(v, 'tool:echo')?.payload['error'] as { message: string }).message).toContain('refused: no');
  });

  it('a JSON-RPC error from the v2 server (unknown tool) trips the error gate as JsonRpcError', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ point: 'error' }]);
    const client = await connectV2(r);

    const pending = client.callTool({ name: 'does-not-exist' });
    const paused = await v.waitForPause('tool:does-not-exist', 'error');
    const errored = errorOf(v, 'tool:does-not-exist');
    expect((errored?.payload['error'] as { name: string }).name).toMatch(/^JsonRpcError\(-\d+\)$/);
    v.resume(paused.payload['pauseId'] as string, 'continue');
    await expect(pending).rejects.toThrow(/does-not-exist/);
    expect((await finished(v, 'tool:does-not-exist')).payload['status']).toBe('error');
  });

  it('abort at the before gate answers the v2 client with -32099 and the server never sees the call', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ kind: 'tool', name: 'echo', point: 'before' }]);
    const client = await connectV2(r);

    const pending = client.callTool({ name: 'echo', arguments: { text: 'never' } });
    const paused = await v.waitForPause('tool:echo', 'before');
    v.resume(paused.payload['pauseId'] as string, 'abort');
    await expect(pending).rejects.toThrow(/aborted by the GraphMind debugger/);
    expect((await finished(v, 'tool:echo')).payload['status']).toBe('aborted');
    expect(((await errored(v, 'tool:echo')).payload['error'] as { name: string }).name).toBe('GraphMindAborted');
    // The session is still healthy afterwards (the before gate is still armed,
    // so the follow-up call pauses too and is let through).
    const next = client.callTool({ name: 'echo', arguments: { text: 'after abort' } });
    const p2 = await nthPause(v, 'tool:echo', 'before', 2);
    v.resume(p2.payload['pauseId'] as string, 'continue');
    expect(text(await next)).toBe(JSON.stringify({ text: 'after abort' }));
  });

  it('retry at the after gate re-sends the ORIGINAL request and the client sees exactly one answer', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ kind: 'tool', name: 'echo', point: 'after' }]);
    const client = await connectV2(r);

    const pending = client.callTool({ name: 'echo', arguments: { text: 'again' } });
    const first = await v.waitForPause('tool:echo', 'after');
    v.resume(first.payload['pauseId'] as string, 'retry');
    // The retried answer arrives at the same gate; let it through this time.
    const second = await nthPause(v, 'tool:echo', 'after', 2);
    v.resume(second.payload['pauseId'] as string, 'continue');
    expect(text(await pending)).toBe(JSON.stringify({ text: 'again' }));
    const done = await finished(v, 'tool:echo');
    await tick(100);
    expect(v.ofType('node.finished').filter((f) => f.payload['nodeId'] === 'tool:echo')).toHaveLength(1);
    expect(done.payload['retries']).toBe(1);
    // One logical execution: the same instanceId on start and finish.
    expect(done.payload['instanceId']).toBe(startOf(v, 'tool:echo')?.payload['instanceId']);
    expect(v.ofType('node.started').filter((f) => f.payload['nodeId'] === 'tool:echo')).toHaveLength(1);
  });

  it('is invisible to the v2 client when no debugger is running at all', async () => {
    rig = new ProxyRig({
      command: process.execPath,
      args: [new URL('./fixtures/mcp-v2/server.mjs', import.meta.url).pathname],
    });
    const client = await connectV2(rig);
    expect(rig.handle.session.attached).toBe(false);
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'detached' } }))).toBe(
      JSON.stringify({ text: 'detached' }),
    );
    expect((await client.readResource({ uri: 'v2://greeting' })).contents[0]).toMatchObject({
      text: 'hello from the v2 resource',
    });
  });
});

// ── v2 client, 2026-07-28 era ────────────────────────────────────────────────

describe('mcp-proxy: the 2026-07-28 era (server/discover, _meta envelope, resultType)', () => {
  it('auto negotiation against a legacy-only v2 server: the -32601 probe is a protocol node, the error gate holds it, and the session falls back to initialize', async () => {
    // `graphmind serve` arms `{point:'error'}` by default, so this is what a
    // user sees with zero configuration when a 2026 client meets a plain
    // `McpServer.connect(new StdioServerTransport())` server.
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ point: 'error' }]);
    const connecting = connectV2(r, { versionNegotiation: { mode: 'auto' } });

    const paused = await v.waitForPause('mcp:server/discover', 'error');
    const probe = startOf(v, 'mcp:server/discover');
    expect(probe?.payload).toMatchObject({ kind: 'custom', name: 'server/discover', parentId: 'mcp:protocol' });
    // The envelope the 2026 client sends rides on the node's input, untouched.
    expect(probe?.payload['input']).toMatchObject({
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    expect((errorOf(v, 'mcp:server/discover')?.payload['error'] as { name: string }).name).toBe(
      'JsonRpcError(-32601)',
    );
    v.resume(paused.payload['pauseId'] as string, 'continue');

    const client = await connecting;
    expect(client.getProtocolEra()).toBe('legacy');
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'fallback' } }))).toBe(
      JSON.stringify({ text: 'fallback' }),
    );
    await finished(v, 'tool:echo');
    expectSessionShape(v, ['server/discover', 'initialize', 'notifications/initialized'], ['tool:echo']);
    expect((await finished(v, 'mcp:server/discover')).payload['status']).toBe('error');
    expect(r.handle.reporter.negotiatedProtocolVersion).toBe('2025-11-25');
  });

  it('a pinned 2026-07-28 client through the proxy to serveStdio: no initialize, discover is protocol, tools/call is work, gates hold', async () => {
    const { rig: r, viewer: v } = await proxied('serve-stdio.mjs', [{ kind: 'tool', name: 'echo', point: 'before' }]);
    const client = await connectV2(r, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerVersion()).toMatchObject({ name: 'graphmind-v2-fixture' });

    const pending = client.callTool({ name: 'echo', arguments: { text: 'modern' } });
    const paused = await v.waitForPause('tool:echo', 'before');
    expect(startOf(v, 'tool:echo')?.payload['input']).toMatchObject({
      name: 'echo',
      arguments: { text: 'modern' },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    v.resume(paused.payload['pauseId'] as string, 'continue');
    const result = (await pending) as ToolResult;
    expect(text(result)).toBe(JSON.stringify({ text: 'modern' }));

    const resource = await client.readResource({ uri: 'v2://greeting' });
    expect(resource.contents[0]).toMatchObject({ text: 'hello from the v2 resource' });
    const prompt = await client.getPrompt({ name: 'summarize', arguments: { topic: 'eras' } });
    expect(prompt.messages[0]?.content).toMatchObject({ text: 'Summarize eras' });

    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'prompt:summarize');
    expectSessionShape(v, ['server/discover'], ['tool:echo', 'resource:v2://greeting', 'prompt:summarize']);
    expect(startOf(v, 'mcp:initialize')).toBeUndefined();
    expect(finishOf(v, 'mcp:server/discover')?.payload['status']).toBe('ok');
    // The wire result the proxy recorded is the 2026 shape, verbatim.
    expect(finishOf(v, 'tool:echo')?.payload['output']).toMatchObject({
      resultType: 'complete',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'graphmind-v2-fixture' } },
    });
    expect(finishOf(v, 'resource:v2://greeting')?.payload['output']).toMatchObject({
      resultType: 'complete',
      cacheScope: 'private',
    });
    // No `initialize` ever happened, so the proxy's initialize-based reading is
    // (honestly) empty — see the open issue on reading server/discover instead.
    expect(r.handle.reporter.negotiatedProtocolVersion).toBe('2026-07-28');
    expect(r.handle.reporter.protocolEra).toBe('modern');
  });

  it('on the 2026 era the error gate, abort and a whole-frame inject all work; a throwing handler is still isError', async () => {
    const { rig: r, viewer: v } = await proxied('serve-stdio.mjs', [
      { point: 'error' },
      { kind: 'prompt', point: 'before' },
      { kind: 'resource', point: 'after' },
    ]);
    const client = await connectV2(r, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

    // error gate on a throwing handler (isError on the wire), repaired with a
    // WHOLE JSON-RPC frame — the escape hatch that is byte-exact, so it can
    // carry the `resultType` the 2026 client insists on.
    const failing = client.callTool({ name: 'echo', arguments: { text: 'x', mode: 'throw' } });
    const p1 = await v.waitForPause('tool:echo', 'error');
    expect((errorOf(v, 'tool:echo')?.payload['error'] as { name: string }).name).toBe('McpToolError');
    v.resume(p1.payload['pauseId'] as string, 'inject', {
      jsonrpc: '2.0',
      result: { resultType: 'complete', content: [{ type: 'text', text: 'repaired on 2026' }] },
    });
    const repaired = (await failing) as ToolResult;
    expect(repaired.isError).toBeFalsy();
    expect(text(repaired)).toBe('repaired on 2026');

    // abort at a before gate: the 2026 client gets a JSON-RPC error and rejects.
    const aborted = client.getPrompt({ name: 'summarize', arguments: { topic: 'x' } });
    const p2 = await v.waitForPause('prompt:summarize', 'before');
    v.resume(p2.payload['pauseId'] as string, 'abort');
    await expect(aborted).rejects.toThrow(/aborted by the GraphMind debugger/);

    // continue at an after gate: the 2026 result (ttlMs/cacheScope and all) is relayed verbatim.
    const read = client.readResource({ uri: 'v2://greeting' });
    const p3 = await v.waitForPause('resource:v2://greeting', 'after');
    v.resume(p3.payload['pauseId'] as string, 'continue');
    expect((await read).contents[0]).toMatchObject({ text: 'hello from the v2 resource' });

    // The exact shape a 2026 client accepts for an injected resources/read —
    // resultType AND the cache fields, because ReadResourceResult is a
    // CacheableResult on this revision. This is what an era-aware coerce
    // would have to produce (open issue); today it takes the whole frame.
    const read2 = client.readResource({ uri: 'v2://greeting' });
    const p4 = await nthPause(v, 'resource:v2://greeting', 'after', 2);
    v.resume(p4.payload['pauseId'] as string, 'inject', {
      jsonrpc: '2.0',
      result: {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        contents: [{ uri: 'v2://greeting', text: 'injected on 2026' }],
      },
    });
    expect((await read2).contents[0]).toMatchObject({ text: 'injected on 2026' });
  });

  it('a bare inject at resources/read on the 2026 era is stamped with resultType and the cache fields', async () => {
    const { rig: r, viewer: v } = await proxied('serve-stdio.mjs', [{ kind: 'resource', point: 'after' }]);
    const client = await connectV2(r, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

    const read = client.readResource({ uri: 'v2://greeting' });
    const p = await v.waitForPause('resource:v2://greeting', 'after');
    v.resume(p.payload['pauseId'] as string, 'inject', 'bare on 2026');
    expect((await read).contents[0]).toMatchObject({ uri: 'v2://greeting', text: 'bare on 2026' });
    const done = (await finished(v, 'resource:v2://greeting')).payload;
    expect(done['output']).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
  });

  it('a bare inject on the 2026 era is stamped for that era and the v2 client accepts it', async () => {
    // Was the KNOWN GAP: the proxy's coercion was era-blind, so a bare inject
    // reached a 2026-07-28 client without `resultType` and was rejected with
    // INVALID_RESULT. The reporter now learns the era from a successful
    // `server/discover` and stamps `resultType: 'complete'` on injected values.
    const { rig: r, viewer: v } = await proxied('serve-stdio.mjs', [{ kind: 'tool', name: 'echo', point: 'before' }]);
    const client = await connectV2(r, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

    const pending = client.callTool({ name: 'echo', arguments: { text: 'x' } });
    const paused = await v.waitForPause('tool:echo', 'before');
    v.resume(paused.payload['pauseId'] as string, 'inject', 'bare string');
    expect(text(await pending)).toBe('bare string');
    expect(r.handle.reporter.protocolEra).toBe('modern');
    const done = (await finished(v, 'tool:echo')).payload;
    expect(done).toMatchObject({ injected: true, gatedAt: 'before' });
    expect(done['output']).toMatchObject({ resultType: 'complete' });
    // The pipe is healthy afterwards.
    const next = client.callTool({ name: 'echo', arguments: { text: 'still alive' } });
    const p2 = await nthPause(v, 'tool:echo', 'before', 2);
    v.resume(p2.payload['pauseId'] as string, 'continue');
    expect(text(await next)).toBe(JSON.stringify({ text: 'still alive' }));
  });
});

// ── the 1.x client against the v2 server ─────────────────────────────────────

describe('mcp-proxy: @modelcontextprotocol/server 2.0 driven by the 1.x client (@modelcontextprotocol/sdk 1.30)', () => {
  it('handshake, listings, work nodes, and the negotiated version', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs');
    const client = await connectV1(r);

    expect(client.getServerVersion()).toMatchObject({ name: 'graphmind-v2-fixture' });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    const echoed = (await client.callTool({ name: 'echo', arguments: { text: 'from 1.x' } })) as ToolResult;
    expect(echoed.structuredContent).toEqual({ echoed: { text: 'from 1.x' } });
    expect((await client.readResource({ uri: 'v2://greeting' })).contents[0]).toMatchObject({
      text: 'hello from the v2 resource',
    });
    expect((await client.getPrompt({ name: 'summarize', arguments: { topic: 'compat' } })).messages[0]?.content).toMatchObject(
      { text: 'Summarize compat' },
    );

    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'prompt:summarize');
    expect(r.handle.reporter.negotiatedProtocolVersion).toBe('2025-11-25');
    expectSessionShape(
      v,
      ['initialize', 'notifications/initialized', 'tools/list'],
      ['tool:echo', 'resource:v2://greeting', 'prompt:summarize'],
    );
  });

  it('inject (bare string) and error-gate repair produce results the 1.x client accepts from a v2 server', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [
      { kind: 'tool', name: 'echo', point: 'after' },
      { point: 'error' },
    ]);
    const client = await connectV1(r);

    const pending = client.callTool({ name: 'echo', arguments: { text: 'real' } });
    const p1 = await v.waitForPause('tool:echo', 'after');
    v.resume(p1.payload['pauseId'] as string, 'inject', 'injected for 1.x');
    expect(text(await pending)).toBe('injected for 1.x');

    const failing = client.callTool({ name: 'echo', arguments: { text: 'x', mode: 'throw' } });
    const p2 = await v.waitForPause('tool:echo', 'error');
    v.resume(p2.payload['pauseId'] as string, 'inject', { content: [{ type: 'text', text: 'repaired' }] });
    const repaired = (await failing) as ToolResult;
    expect(repaired.isError).toBeFalsy();
    expect(text(repaired)).toBe('repaired');
  });

  it('a method the mapping has never heard of is a protocol node, gated, and never crashes the relay', async () => {
    const { rig: r, viewer: v } = await proxied('server.mjs', [{ point: 'error' }]);
    const client = await connectV1(r);

    // The 1.x client will send anything with a result schema; the v2 server has
    // no handler for it and answers -32601.
    const pending = client.request({ method: 'graphmind/no-such-method' }, EmptyResultSchema);
    const paused = await v.waitForPause('mcp:graphmind/no-such-method', 'error');
    expect(startOf(v, 'mcp:graphmind/no-such-method')?.payload).toMatchObject({
      kind: 'custom',
      parentId: 'mcp:protocol',
    });
    v.resume(paused.payload['pauseId'] as string, 'continue');
    await expect(pending).rejects.toThrow(/Method not found/);
    expect((await finished(v, 'mcp:graphmind/no-such-method')).payload['status']).toBe('error');

    // The session is intact afterwards.
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'ok' } }))).toBe(JSON.stringify({ text: 'ok' }));
    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:echo');
    expect(startOf(v, 'tool:echo')?.payload['parentId']).toBe('mcp:session');
  });
});
