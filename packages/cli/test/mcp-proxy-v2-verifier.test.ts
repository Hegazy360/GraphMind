/**
 * Adversarial verification of `graphmind mcp-proxy` on the v2 SDK family —
 * the invariants mcp-proxy-v2.test.ts does not exercise, on the era where the
 * wire differs most (2026-07-28 through `serveStdio`):
 *
 *  - FAIL OPEN: a debugger that dies while a `tools/call` is held at the
 *    before gate releases it, the 2026 client gets the real answer, and the
 *    session keeps working detached;
 *  - a 1 MB argument is relayed intact in both directions;
 *  - ten concurrent v2 calls keep their identities apart on the graph.
 *
 * Same rig as mcp-proxy-v2.test.ts (real session, real viewer double, real
 * child process, the v2 client's own framing over streams the test owns).
 */
import { Client as ClientV2, ReadBuffer, serializeMessage, type Transport } from '@modelcontextprotocol/client';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import type { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { BreakpointMatcher } from '@graphmind-ai/schema';
import { FakeViewer, ProxyRig, tick, waitUntil, type ReceivedFrame } from './mcp-proxy-harness.js';

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
  isError?: boolean;
}

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
    sessionOptions: { connectTimeoutMs: 2_000, retryIntervalMs: 200 },
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { rig, viewer };
}

async function connectV2(r: ProxyRig, options?: ConstructorParameters<typeof ClientV2>[1]): Promise<ClientV2> {
  const client = new ClientV2({ name: 'graphmind-v2-verifier', version: '1.0.0' }, options);
  closers.push(() => client.close());
  await client.connect(new StreamClientTransport(r.clientIn, r.clientOut));
  return client;
}

const PIN_2026 = { versionNegotiation: { mode: { pin: '2026-07-28' } } } as const;
const text = (result: unknown): string | undefined =>
  (result as ToolResult).content?.find((c) => c.type === 'text')?.text;
const startsOf = (v: FakeViewer, nodeId: string): ReceivedFrame[] =>
  v.ofType('node.started').filter((f) => f.payload['nodeId'] === nodeId);
const finishesOf = (v: FakeViewer, nodeId: string): ReceivedFrame[] =>
  v.ofType('node.finished').filter((f) => f.payload['nodeId'] === nodeId);

describe('mcp-proxy verifier: the 2026-07-28 era under stress', () => {
  it('FAILS OPEN: a debugger that dies while a modern-era tools/call is held releases it; the session keeps working', async () => {
    const { rig: r, viewer: v } = await proxied('serve-stdio.mjs', [{ kind: 'tool', name: 'echo', point: 'before' }]);
    const client = await connectV2(r, PIN_2026);
    expect(client.getProtocolEra()).toBe('modern');

    const pending = client.callTool({ name: 'echo', arguments: { text: 'rescued' } });
    await v.waitForPause('tool:echo', 'before');
    v.killAbruptly();
    viewer = undefined;

    // No resume ever arrives: the frame must be forwarded verbatim and the
    // 2026 client must accept the server's own (resultType-stamped) answer.
    expect(text(await pending)).toBe(JSON.stringify({ text: 'rescued' }));
    await waitUntil(() => r.handle.session.attached === false, 'the proxy to notice the viewer is gone');

    // Detached now: nothing holds, the pipe is healthy.
    const t0 = performance.now();
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'after' } }))).toBe(JSON.stringify({ text: 'after' }));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect((await client.readResource({ uri: 'v2://greeting' })).contents[0]).toMatchObject({
      text: 'hello from the v2 resource',
    });
  });

  it('a 1 MB argument is relayed intact in both directions and recorded without breaking the session', async () => {
    const { rig: r, viewer: v } = await proxied('serve-stdio.mjs');
    const client = await connectV2(r, PIN_2026);

    const big = 'y'.repeat(1_000_000);
    const result = (await client.callTool({ name: 'echo', arguments: { text: big } })) as ToolResult;
    expect((JSON.parse(text(result) ?? '{}') as { text?: string }).text?.length).toBe(1_000_000);
    expect(result.isError).toBeFalsy();

    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:echo');
    expect(finishesOf(v, 'tool:echo')[0]?.payload['status']).toBe('ok');
    expect(r.handle.session.attached).toBe(true);
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'small' } }))).toBe(JSON.stringify({ text: 'small' }));
  });

  it('ten concurrent modern-era calls: every answer matches its request and every execution is distinct on the graph', async () => {
    const { rig: r, viewer: v } = await proxied('serve-stdio.mjs');
    const client = await connectV2(r, PIN_2026);

    const n = 10;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => client.callTool({ name: 'echo', arguments: { text: `call-${i}` } })),
    );
    results.forEach((result, i) => expect(text(result)).toBe(JSON.stringify({ text: `call-${i}` })));

    await waitUntil(() => finishesOf(v, 'tool:echo').length === n, `${n} finishes`);
    const starts = startsOf(v, 'tool:echo');
    expect(starts).toHaveLength(n);
    expect(new Set(starts.map((f) => f.payload['instanceId'])).size).toBe(n);
    for (const start of starts) {
      const asked = (start.payload['input'] as { arguments: { text: string } }).arguments.text;
      const finish = finishesOf(v, 'tool:echo').find((f) => f.payload['instanceId'] === start.payload['instanceId']);
      expect(finish, `finish for ${asked}`).toBeDefined();
      expect(text(finish?.payload['output'])).toBe(JSON.stringify({ text: asked }));
      expect(finish?.payload['status']).toBe('ok');
    }
    // One run for the whole session (the proxy's scoping rule), all work directly under it.
    expect(new Set(starts.map((f) => f.runId)).size).toBe(1);
    expect(starts.every((f) => f.payload['parentId'] === 'mcp:session')).toBe(true);
  });
});
