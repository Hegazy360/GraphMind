/**
 * Transport independence. The adapter wraps the SERVER, never the transport,
 * so a Streamable HTTP server gates exactly like a stdio one — and the
 * transport's session id shows up on the `server` node, which is what makes a
 * multi-session HTTP server readable in the viewer.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolText } from './helpers/mcp.js';
import { attach, makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

interface HttpHarness {
  client: Client;
  ran: () => number;
}

async function startHttpServer(wrap: <T extends object>(s: T) => T): Promise<HttpHarness> {
  let ran = 0;
  const raw = new McpServer({ name: 'http-server', version: '3.0.0' });
  const server = wrap(raw);
  server.registerTool(
    'echo',
    { description: 'Echo', inputSchema: { message: z.string() } },
    async ({ message }) => {
      ran += 1;
      return { content: [{ type: 'text' as const, text: message }] };
    },
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  // The SDK's concrete transports are not assignable to its own `Transport`
  // interface under exactOptionalPropertyTypes; that is an SDK typing quirk.
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

  const http: HttpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText.length > 0 ? (JSON.parse(bodyText) as unknown) : undefined;
      void transport.handleRequest(req, res, body);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  const client = new Client({ name: 'http-client', version: '1.0.0' });
  const clientTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );
  await client.connect(clientTransport as unknown as Parameters<typeof client.connect>[0]);

  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await raw.close().catch(() => undefined);
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { client, ran: () => ran };
}

describe('Streamable HTTP transport', () => {
  it('gates and injects over HTTP, and records the transport session id', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'echo' }],
    });
    await attach(gm);
    const h = await startHttpServer((s) => gm.wrapServer(s));

    const call = h.client.callTool({ name: 'echo', arguments: { message: 'over http' } });
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:echo',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'injected over http');

    expect(toolText(await call)).toBe('injected over http');
    expect(h.ran()).toBe(0);

    const serverStart = viewer.received.find(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'server:http-server',
    )!;
    const input = serverStart.payload['input'] as Record<string, unknown>;
    expect(input['method']).toBe('tools/call');
    expect(typeof input['sessionId']).toBe('string');
    expect((input['sessionId'] as string).length).toBeGreaterThan(8);
  });
});
