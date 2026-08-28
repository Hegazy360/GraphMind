/**
 * The declared peer range is `>=1.20.0 <2`, so the suite runs the whole gate
 * story against BOTH ends of it: 1.30.0 (every other file) and 1.20.0 here,
 * installed side by side under an npm alias.
 *
 * The adapter never imports the SDK — it duck-types the six registration
 * methods, `connect`, `.server`, `setRequestHandler` and `createMessage` — so
 * this is the test that keeps that claim honest. (1.20.0 also predates the
 * SDK's zod-v4 support, so its schemas come from an aliased zod v3; that is
 * the SDK's constraint, not the adapter's — GraphMind never touches zod.)
 */
import { Client } from 'mcp-sdk-1-20/client/index.js';
import { InMemoryTransport } from 'mcp-sdk-1-20/inMemory.js';
import { McpServer } from 'mcp-sdk-1-20/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
// 1.20.0 predates the SDK's zod-v4 support, so its schemas must be zod v3.
import { z } from 'zod-3';
import { toolText } from './helpers/mcp.js';
import { attach, makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

async function connectPair(server: McpServer, raw: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'compat-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await raw.close().catch(() => undefined);
  });
  return client;
}

describe('@modelcontextprotocol/sdk 1.20.0', () => {
  it('reports the older SDK, gates a tool, and injects a result', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'echo' }],
    });
    await attach(gm);

    const raw = new McpServer({ name: 'old-sdk', version: '0.9.0' });
    const server = gm.wrapServer(raw);
    let ran = 0;
    server.registerTool(
      'echo',
      { description: 'Echo', inputSchema: { message: z.string() } },
      async ({ message }) => {
        ran += 1;
        return { content: [{ type: 'text' as const, text: message }] };
      },
    );
    server.registerPrompt('greet', { argsSchema: { who: z.string() } }, ({ who }) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `hi ${who}` } }],
    }));

    const client = await connectPair(server, raw);

    const call = client.callTool({ name: 'echo', arguments: { message: 'hello' } });
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:echo',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'from the debugger');

    expect(toolText(await call)).toBe('from the debugger');
    expect(ran).toBe(0);

    const start = viewer.received.find(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'tool:echo',
    )!;
    expect(start.payload['parentId']).toBe('server:old-sdk');

    // Prompts work on this version too.
    const prompt = await client.getPrompt({ name: 'greet', arguments: { who: 'Ada' } });
    expect(JSON.stringify(prompt.messages)).toContain('hi Ada');
    await viewer.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'prompt:greet',
    );
  });
});
