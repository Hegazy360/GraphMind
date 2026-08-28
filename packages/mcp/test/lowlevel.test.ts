/**
 * The low-level `Server` path: a server built by hand with
 * `setRequestHandler`, with no `McpServer` anywhere. Same gates, same events —
 * the only difference is that a resource has no registration to name it, so
 * its URI becomes the logical node.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { resourceText, tick, toolText } from './helpers/mcp.js';
import { attach, makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

interface LowLevel {
  client: Client;
  raw: Server;
  calls: string[];
}

async function makeLowLevelServer(
  wrap: <T extends object>(server: T) => T,
): Promise<LowLevel> {
  const calls: string[] = [];
  const raw = new Server(
    { name: 'hand-rolled', version: '0.4.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  const server = wrap(raw);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', inputSchema: { type: 'object' as const } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push('echo');
    const message = (request.params.arguments as { message?: string } | undefined)?.message ?? '';
    return { content: [{ type: 'text' as const, text: `echo: ${message}` }] };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    calls.push('read');
    return { contents: [{ uri: request.params.uri, text: 'raw contents' }] };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await raw.close().catch(() => undefined);
  });
  return { client, raw, calls };
}

describe('low-level Server', () => {
  it('instruments tools/call and resources/read registered by hand', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const ll = await makeLowLevelServer((s) => gm.wrapServer(s));

    expect(toolText(await ll.client.callTool({ name: 'echo', arguments: { message: 'hi' } }))).toBe(
      'echo: hi',
    );
    const toolStart = await viewer.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'tool:echo',
    );
    expect(toolStart.payload['parentId']).toBe('server:hand-rolled');
    expect(toolStart.payload['input']).toEqual({ message: 'hi' });

    const read = await ll.client.readResource({ uri: 'file:///notes.txt' });
    expect(resourceText(read)).toBe('raw contents');
    const resourceStart = await viewer.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'resource:file:///notes.txt',
    );
    expect(resourceStart.payload['kind']).toBe('resource');
  });

  it('gates a hand-rolled tool: inject reaches the client, handler never runs', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool' }] });
    await attach(gm);
    const ll = await makeLowLevelServer((s) => gm.wrapServer(s));

    const call = ll.client.callTool({ name: 'echo', arguments: { message: 'hi' } });
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:echo',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'substituted');

    expect(toolText(await call)).toBe('substituted');
    expect(ll.calls).toHaveLength(0);
  });

  it('leaves methods it does not model completely alone', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const ll = await makeLowLevelServer((s) => gm.wrapServer(s));

    // The connect-time hint proves the pipe is flowing before we assert on
    // the ABSENCE of anything else.
    await viewer.waitForType('graph.hint');

    // ping and tools/list are forwarded untouched: no nodes at all.
    await ll.client.ping();
    const tools = await ll.client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['echo']);

    await tick(150);
    expect(viewer.ofType('node.started')).toHaveLength(0);
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });
});
