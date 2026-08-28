/**
 * The whole product, end to end: a real `@modelcontextprotocol/sdk` server as
 * a child process, the proxy in the middle, and the REAL GraphMind server
 * (`startServer` — same code path as `graphmind serve`) receiving the run.
 *
 * The two things worth proving here and nowhere else:
 *  - the envelopes the proxy emits are accepted, stored, and readable back
 *    over the public REST API;
 *  - `graphmind serve`'s DEFAULT pause-on-error breakpoint catches an MCP
 *    server error with no configuration at all, and a viewer can release it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeUI, fetchJson, startTestServer, type TestServer } from './helpers.js';
import { ProxyRig, tick, waitUntil } from './mcp-proxy-harness.js';

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

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const ts = await startTestServer(options);
  cleanups.push(() => ts.cleanup());
  return ts;
}

function proxied(port: number): ProxyRig {
  const rig = new ProxyRig({
    server: 'sdk-server.mjs',
    viewerUrl: `ws://127.0.0.1:${port}/ingest`,
    waitForAttach: true,
  });
  cleanups.push(async () => {
    rig.endClient();
    await Promise.race([rig.handle.done, tick(4000)]);
    rig.handle.stop('SIGKILL');
  });
  return rig;
}

async function connectClient(rig: ProxyRig, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  cleanups.push(async () => void (await client.close().catch(() => {})));
  await client.connect(new StreamClientTransport(rig.clientIn, rig.clientOut));
  return client;
}

describe('graphmind mcp-proxy against a real GraphMind server', () => {
  it('stores the MCP conversation as a run readable over the REST API', async () => {
    const { port } = await boot();
    const rig = proxied(port);
    await waitUntil(() => rig.handle.session.attached, 'the proxy to attach');
    const client = await connectClient(rig, 'e2e');

    const sum = (await client.callTool({ name: 'add', arguments: { a: 19, b: 23 } })) as {
      content: { text: string }[];
    };
    expect(sum.content[0]?.text).toBe('42');
    await client.readResource({ uri: 'test://greeting' });
    await client.getPrompt({ name: 'summarize', arguments: { topic: 'proxies' } });

    await waitUntil(async () => {
      const { body } = await fetchJson(port, '/api/runs');
      return body.runs.length === 1;
    }, 'the run to be stored');

    const { body: runsBody } = await fetchJson(port, '/api/runs');
    const run = runsBody.runs[0] as { id: string; app: string };
    expect(run.app).toContain('sdk-server.mjs');

    await waitUntil(async () => {
      const { body } = await fetchJson(port, `/api/runs/${run.id}/events`);
      return body.events.some(
        (e: { type: string; payload: Record<string, unknown> }) =>
          e.type === 'node.finished' && e.payload['nodeId'] === 'prompt:summarize',
      );
    }, 'the prompt node to finish');

    const { body } = await fetchJson(port, `/api/runs/${run.id}/events`);
    const events = body.events as { type: string; payload: Record<string, unknown> }[];
    const started = events.filter((e) => e.type === 'node.started');
    const nodeIds = new Set(started.map((e) => e.payload['nodeId']));
    expect(nodeIds).toContain('mcp:session');
    expect(nodeIds).toContain('mcp:initialize');
    expect(nodeIds).toContain('tool:add');
    expect(nodeIds).toContain('resource:test://greeting');
    expect(nodeIds).toContain('prompt:summarize');
    // Kinds survived the round trip through the schema and SQLite.
    expect(started.find((e) => e.payload['nodeId'] === 'mcp:session')?.payload['kind']).toBe(
      'server',
    );
    expect(started.find((e) => e.payload['nodeId'] === 'resource:test://greeting')?.payload['kind']).toBe(
      'resource',
    );
  });

  it('pauses on an MCP server error with zero configuration, and a viewer resumes it', async () => {
    // No breakpoints are set by this test: `graphmind serve` arms
    // {point:'error'} on its own (internal/decisions.md #8). This is the
    // headline claim for `mcp-proxy` — point a client at it, break a server,
    // and the debugger catches it without any setup.
    const { port } = await boot();
    const ui = await FakeUI.connect(port);
    cleanups.push(() => ui.close());
    expect(ui.welcome?.breakpoints).toEqual([{ point: 'error' }]);

    const rig = proxied(port);
    await waitUntil(() => rig.handle.session.attached, 'the proxy to attach');
    const client = await connectClient(rig, 'e2e-error');

    // Find the run the proxy just opened, then tail it the way the viewer does.
    let runId = '';
    await waitUntil(async () => {
      const { body } = await fetchJson(port, '/api/runs');
      runId = body.runs[0]?.id ?? '';
      return runId !== '';
    }, 'the run to appear');
    ui.subscribe(runId);
    await ui.next((m) => m.type === 'replay.end', 'replay.end');

    const pending = client.callTool({ name: 'explode' }).catch((error: Error) => error);

    const paused = (await ui.next(
      (m) => m.type === 'event' && m.envelope.type === 'exec.paused',
      'exec.paused',
    )) as { type: 'event'; runId: string; envelope: { payload: Record<string, string> } };
    expect(paused.envelope.payload['nodeId']).toBe('tool:explode');
    expect(paused.envelope.payload['point']).toBe('error');

    ui.control('exec.resume', paused.runId, {
      pauseId: paused.envelope.payload['pauseId'] as string,
      action: 'inject',
      output: { content: [{ type: 'text', text: 'patched live' }] },
    });

    const result = (await pending) as { content: { text: string }[] };
    expect(result.content?.[0]?.text).toBe('patched live');
  });
});
