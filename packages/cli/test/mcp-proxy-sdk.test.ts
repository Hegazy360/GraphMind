/**
 * End-to-end against the real thing: a real `@modelcontextprotocol/sdk`
 * Client on one side, a real SDK `Server` (spawned as a child process) on the
 * other, and the proxy in between.
 *
 * The client uses a stream-backed transport rather than `StdioClientTransport`
 * only so the test can own both ends of the pipe — the protocol layer,
 * schemas, correlation and validation are all the SDK's own.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeViewer, ProxyRig, tick, waitUntil } from './mcp-proxy-harness.js';

/** The SDK's stdio framing over a pair of streams we already own. */
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

let rig: ProxyRig | undefined;
let viewer: FakeViewer | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  if (rig !== undefined) {
    rig.endClient();
    await Promise.race([rig.handle.done, tick(4000)]);
    rig.handle.stop('SIGKILL');
    rig = undefined;
  }
  await viewer?.close();
  viewer = undefined;
});

async function connect(
  breakpoints: Parameters<FakeViewer['setBreakpoint']>[0][] = [],
): Promise<{ client: Client; rig: ProxyRig; viewer: FakeViewer }> {
  viewer = await FakeViewer.start({ breakpoints });
  rig = new ProxyRig({
    server: 'sdk-server.mjs',
    viewerUrl: viewer.url,
    waitForAttach: true,
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  client = new Client({ name: 'graphmind-proxy-test', version: '1.0.0' });
  await client.connect(new StreamClientTransport(rig.clientIn, rig.clientOut));
  return { client, rig, viewer };
}

describe('mcp-proxy: a real @modelcontextprotocol/sdk server', () => {
  it('completes the handshake and every listing through the proxy', async () => {
    const { client: c, viewer: v } = await connect();

    expect(c.getServerVersion()).toMatchObject({ name: 'graphmind-test-server' });

    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['add', 'explode']);

    const resources = await c.listResources();
    expect(resources.resources[0]?.uri).toBe('test://greeting');

    const prompts = await c.listPrompts();
    expect(prompts.prompts[0]?.name).toBe('summarize');

    // The proxy read the version the two peers actually agreed on.
    expect(rig?.handle.reporter.negotiatedProtocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await v.waitFor((f) => f.type === 'node.started' && f.payload['nodeId'] === 'mcp:initialize');
    const initFinished = await v.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'mcp:initialize',
    );
    expect(initFinished.payload['status']).toBe('ok');
  });

  it('maps a tool call, a resource read and a prompt onto their own node kinds', async () => {
    const { client: c, viewer: v } = await connect();

    const sum = (await c.callTool({ name: 'add', arguments: { a: 2, b: 40 } })) as {
      content: { text: string }[];
    };
    expect(sum.content[0]?.text).toBe('42');

    const resource = await c.readResource({ uri: 'test://greeting' });
    expect(resource.contents[0]).toMatchObject({ text: 'hello from the resource' });

    const prompt = await c.getPrompt({ name: 'summarize', arguments: { topic: 'otters' } });
    expect(prompt.messages[0]?.content).toMatchObject({ text: 'Summarize otters' });

    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'prompt:summarize');
    const started = v.ofType('node.started');
    const kindOf = (id: string) =>
      started.find((f) => f.payload['nodeId'] === id)?.payload['kind'];
    expect(kindOf('mcp:session')).toBe('server');
    expect(kindOf('tool:add')).toBe('tool');
    expect(kindOf('resource:test://greeting')).toBe('resource');
    expect(kindOf('prompt:summarize')).toBe('prompt');
  });

  it('surfaces a handler that throws as an error on the graph', async () => {
    const { client: c, viewer: v } = await connect();
    // The low-level SDK Server answers a throwing handler with a JSON-RPC
    // error, which the SDK client raises as an McpError.
    await expect(c.callTool({ name: 'explode' })).rejects.toThrow(/kaboom/);
    const errored = await v.waitFor(
      (f) => f.type === 'node.error' && f.payload['nodeId'] === 'tool:explode',
    );
    expect((errored.payload['error'] as { name: string }).name).toBe('JsonRpcError(-32603)');
    const finished = await v.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:explode',
    );
    expect(finished.payload['status']).toBe('error');
  });

  it('trips the error gate on a real SDK error response and can repair it', async () => {
    const { client: c, viewer: v } = await connect([
      { kind: 'tool', name: 'explode', point: 'error' },
    ]);
    const pending = c.callTool({ name: 'explode' });
    const paused = await v.waitForPause('tool:explode', 'error');
    v.resume(paused.payload['pauseId'] as string, 'inject', {
      content: [{ type: 'text', text: 'repaired by the debugger' }],
    });
    const result = (await pending) as { content: { text: string }[] };
    expect(result.content[0]?.text).toBe('repaired by the debugger');
  });

  it('lets the debugger inject a result the real server never produced', async () => {
    const { client: c, viewer: v } = await connect([{ kind: 'tool', name: 'add', point: 'after' }]);
    const pending = c.callTool({ name: 'add', arguments: { a: 1, b: 1 } });
    const paused = await v.waitForPause('tool:add', 'after');
    v.resume(paused.payload['pauseId'] as string, 'inject', {
      content: [{ type: 'text', text: 'injected: 9000' }],
    });
    const result = (await pending) as { content: { text: string }[] };
    // The SDK client validated and accepted the substituted frame.
    expect(result.content[0]?.text).toBe('injected: 9000');
  });

  it('holds a request before the real server sees it', async () => {
    const { client: c, viewer: v } = await connect([{ kind: 'tool', name: 'add', point: 'before' }]);
    const pending = c.callTool({ name: 'add', arguments: { a: 3, b: 4 } });
    const paused = await v.waitForPause('tool:add', 'before');
    const started = v.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:add');
    // The debugger can see exactly what the client sent, before it is sent on.
    expect(started?.payload['input']).toMatchObject({ name: 'add', arguments: { a: 3, b: 4 } });
    v.resume(paused.payload['pauseId'] as string, 'continue');
    const result = (await pending) as { content: { text: string }[] };
    expect(result.content[0]?.text).toBe('7');
  });

  it('is invisible when no debugger is running at all', async () => {
    rig = new ProxyRig({ server: 'sdk-server.mjs' });
    client = new Client({ name: 'detached', version: '1.0.0' });
    await client.connect(new StreamClientTransport(rig.clientIn, rig.clientOut));
    expect(rig.handle.session.attached).toBe(false);
    const result = (await client.callTool({ name: 'add', arguments: { a: 20, b: 22 } })) as {
      content: { text: string }[];
    };
    expect(result.content[0]?.text).toBe('42');
  });
});
