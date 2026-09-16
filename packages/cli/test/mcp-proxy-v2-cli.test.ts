/**
 * The real thing, end to end: the v2 client's own `StdioClientTransport` spawns the
 * BUILT `graphmind mcp-proxy` (dist/cli.js) exactly as an MCP host config would, the
 * proxy spawns the v2 fixture server, and a viewer double receives the run.
 *
 * Nothing here is in-process: three real processes, real pipes, real signals. It
 * proves the packaged command works with the v2 SDK, including the one v2 behaviour
 * that only shows up with the REAL stdio transport: in `versionNegotiation: 'auto'`
 * mode the base `StdioClientTransport` runs its `server/discover` probe on a
 * DISPOSABLE SIBLING PROCESS spawned from the same parameters — which, through a
 * proxy, means a second `graphmind mcp-proxy` and therefore a second run.
 *
 * Requires `pnpm --filter graphmind-ai build` (dist/cli.js) — the same precondition
 * as mcp-proxy-cli.test.ts.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './mcp-proxy-harness.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-v2/server.mjs', import.meta.url));
const built = existsSync(CLI);

let viewer: FakeViewer | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await viewer?.close();
  viewer = undefined;
});

function proxyTransport(port: number): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp-proxy', '--port', String(port), '--wait-for-attach', '--', process.execPath, FIXTURE],
    // The v2 transport hands the child a scrubbed environment; keep PATH and
    // make sure the CLI never touches telemetry from a test.
    env: { ...getDefaultEnvironment(), GRAPHMIND_TELEMETRY: '0' },
    stderr: 'pipe',
  });
}

async function connect(port: number, options?: ConstructorParameters<typeof Client>[1]): Promise<Client> {
  const client = new Client({ name: 'graphmind-v2-cli-test', version: '1.0.0' }, options);
  clients.push(client);
  await client.connect(proxyTransport(port));
  return client;
}

const text = (result: unknown): string | undefined =>
  (result as { content: { type: string; text?: string }[] }).content.find((c) => c.type === 'text')?.text;

describe.skipIf(!built)('graphmind mcp-proxy (built CLI) spawned by the v2 StdioClientTransport', () => {
  it('default posture: a full session through three real processes lands on the graph', async () => {
    viewer = await FakeViewer.start({ breakpoints: [{ point: 'error' }] });
    const client = await connect(viewer.port);

    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getServerVersion()).toMatchObject({ name: 'graphmind-v2-fixture' });
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'real cli' } }))).toBe(
      JSON.stringify({ text: 'real cli' }),
    );

    // The default error gate holds a failing v2 tool with zero configuration.
    const failing = client.callTool({ name: 'echo', arguments: { text: 'x', mode: 'throw' } });
    const paused = await viewer.waitForPause('tool:echo', 'error');
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'repaired through the CLI');
    expect(text(await failing)).toBe('repaired through the CLI');

    await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:echo' && f.payload['injected'] === true,
    );
    const started = viewer.ofType('node.started');
    const byId = (id: string): ReceivedFrame | undefined => started.find((f) => f.payload['nodeId'] === id);
    expect(byId('mcp:session')?.payload['kind']).toBe('server');
    expect(byId('mcp:protocol')?.payload).toMatchObject({ parentId: 'mcp:session', collapsed: true });
    expect(byId('mcp:initialize')?.payload['parentId']).toBe('mcp:protocol');
    expect(byId('tool:echo')?.payload['parentId']).toBe('mcp:session');
    expect(viewer.ofType('run.started')).toHaveLength(1);
    expect((viewer.ofType('run.started')[0]?.payload as { app?: string }).app ?? viewer.ofType('hello')[0]?.payload['app']).toContain(
      'server.mjs',
    );

    await client.close();
    // The proxy noticed the client hang up, the fixture exited, the run closed.
    await waitUntil(() => viewer?.ofType('run.finished').length === 1, 'run.finished', 10_000);
    const session = viewer.ofType('node.finished').find((f) => f.payload['nodeId'] === 'mcp:session');
    expect(session?.payload['status']).toBe('ok');
  });

  it("'auto' negotiation: the sibling probe becomes a SECOND proxied run and the real session still works", async () => {
    viewer = await FakeViewer.start({});
    const client = await connect(viewer.port, { versionNegotiation: { mode: 'auto' } });

    // A plain McpServer.connect() server is legacy-only, so the probe got
    // -32601 on its sibling and the client fell back to initialize.
    expect(client.getProtocolEra()).toBe('legacy');
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'auto' } }))).toBe(
      JSON.stringify({ text: 'auto' }),
    );
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:echo');

    // Two proxies attached: the disposable probe sibling and the session child.
    await waitUntil(() => viewer?.ofType('run.started').length === 2, 'two runs', 10_000);
    const runIds = new Set(viewer.ofType('run.started').map((f) => f.runId));
    expect(runIds.size).toBe(2);
    const discover = viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'mcp:server/discover');
    expect(discover, 'the probe was recorded').toBeDefined();
    expect(discover?.payload['parentId']).toBe('mcp:protocol');
    const toolRun = viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:echo')?.runId;
    // The probe and the work live in different runs, and the probe run has no work in it.
    expect(discover?.runId).not.toBe(toolRun);
    expect(
      viewer.ofType('node.started').filter((f) => f.runId === discover?.runId && f.payload['parentId'] === 'mcp:session'),
    ).toEqual(viewer.ofType('node.started').filter((f) => f.runId === discover?.runId && f.payload['nodeId'] === 'mcp:protocol'));

    await client.close();
    await waitUntil(() => viewer?.ofType('run.finished').length === 2, 'both runs finished', 10_000);
    await tick(50);
  });
});
