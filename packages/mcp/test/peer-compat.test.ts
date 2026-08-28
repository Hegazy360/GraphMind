/**
 * The declared peer range is `>=1.26.0 <2`, so the suite runs the whole gate
 * story against BOTH ends of it: 1.30.0 (every other file) and 1.26.0 here,
 * installed side by side under an npm alias.
 *
 * The adapter never imports the SDK — it duck-types the six registration
 * methods, `connect`, `.server`, `setRequestHandler` and `createMessage` — so
 * this is the test that keeps that claim honest.
 *
 * The floor is 1.26.0 rather than the 1.20.0 this adapter was first written
 * against, and that is a SECURITY floor, not a compatibility one: every
 * release below it carries at least one high advisory (cross-client data leak
 * through shared transport reuse up to 1.25.3, no DNS-rebinding protection by
 * default below 1.24.0, ReDoS below 1.25.2). The adapter would work fine on
 * 1.20; declaring support for it would tell users a vulnerable SDK is a
 * supported configuration, which is not something a debugger should say.
 */
import { Client } from 'mcp-sdk-floor/client/index.js';
import { InMemoryTransport } from 'mcp-sdk-floor/inMemory.js';
import { McpServer } from 'mcp-sdk-floor/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
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

describe('@modelcontextprotocol/sdk 1.26.0 (the declared floor)', () => {
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
