/**
 * The v2 twin of helpers/mcp.ts: a REAL `@modelcontextprotocol/server` 2.0.0
 * `McpServer` driven by a REAL `@modelcontextprotocol/client` 2.0.0 `Client`
 * over the v2 in-memory transport pair. Same surface, same marks, so the v2
 * suites can assert the same things the 1.x suites do.
 *
 * What changed in v2 and is exercised here on purpose:
 *  - handlers receive a CONTEXT (`ctx.mcpReq.{id, method, signal, send, ...}`)
 *    as their last argument instead of the 1.x `RequestHandlerExtra`
 *    (`{requestId, signal, sendRequest, ...}`);
 *  - sampling from inside a handler goes through `ctx.mcpReq.requestSampling`
 *    or `ctx.mcpReq.send({ method: 'sampling/createMessage' })`;
 *  - the low-level `Server.setRequestHandler` takes a METHOD STRING (2-arg) or
 *    `(method, { params }, handler)` (3-arg), no zod request schema;
 *  - the 2026-07-28 era is only served through `serveStdio(factory)`, which
 *    accepts a bring-your-own transport (used with the in-memory pair here).
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, ResourceTemplate, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import type { Graphmind } from '../../src/index.js';
import { Marks, tick } from './mcp.js';

export { resourceText, resourceUri, toolText } from './mcp.js';

export interface HarnessV2Options {
  flakyFailures?: number;
  toolDelayMs?: number;
  samplingAnswer?: string;
  /**
   * Serve the 2026-07-28 era through `serveStdio` and pin the client to it.
   * Default: the plain `connect()` / legacy `initialize` handshake.
   */
  modern?: boolean;
}

export interface HarnessV2 {
  server: McpServer;
  raw: McpServer;
  client: Client;
  marks: Marks;
  attempts: Map<string, number>;
  close(): Promise<void>;
}

/** Register the shared surface on `server` (the instrumented view). */
export function registerSurface(
  server: McpServer,
  marks: Marks,
  attempts: Map<string, number>,
  options: HarnessV2Options = {},
): void {
  const bump = (name: string): number => {
    const next = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, next);
    return next;
  };
  const delayMs = options.toolDelayMs ?? 20;
  const flakyFailures = options.flakyFailures ?? 1;

  server.registerTool(
    'searchFlights',
    {
      description: 'Search for flights between two airports',
      inputSchema: { from: z.string(), to: z.string() },
    },
    async ({ from, to }) => {
      marks.mark('tool:body-start', { toolName: 'searchFlights' });
      bump('searchFlights');
      await tick(delayMs);
      marks.mark('tool:body-end', { toolName: 'searchFlights' });
      return {
        content: [{ type: 'text', text: JSON.stringify({ flights: [{ id: 'TP1234', from, to }] }) }],
      };
    },
  );

  server.registerTool(
    'flaky',
    { description: 'Fails a few times, then works', inputSchema: { n: z.number() } },
    async ({ n }) => {
      const attempt = bump('flaky');
      marks.mark('tool:body-start', { toolName: 'flaky', attempt });
      if (attempt <= flakyFailures) {
        marks.mark('tool:body-throw', { toolName: 'flaky', attempt });
        throw new Error(`FX rate service returned HTTP 500 (attempt ${attempt})`);
      }
      return { content: [{ type: 'text', text: `ok after ${attempt} attempts: ${n}` }] };
    },
  );

  // No inputSchema: v2 calls this callback as `(ctx)`, not `(args, ctx)`.
  server.registerTool('ping', { description: 'Zero-argument tool' }, async (ctx) => {
    bump('ping');
    marks.mark('tool:body-start', { toolName: 'ping', requestId: ctx.mcpReq.id });
    return { content: [{ type: 'text', text: 'pong' }] };
  });

  server.registerTool(
    'quote',
    {
      description: 'Structured output tool',
      inputSchema: { symbol: z.string() },
      outputSchema: { symbol: z.string(), price: z.number() },
    },
    async ({ symbol }) => {
      bump('quote');
      const structuredContent = { symbol, price: 100 };
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    },
  );

  // A handler that observes its own signal: reports whether it was aborted.
  server.registerTool(
    'slow',
    { description: 'Waits, watching ctx.mcpReq.signal', inputSchema: { ms: z.number() } },
    async ({ ms }, ctx) => {
      bump('slow');
      const signal = ctx.mcpReq.signal;
      marks.mark('tool:body-start', { toolName: 'slow', abortedAtStart: signal.aborted });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          marks.mark('tool:signal-aborted', { toolName: 'slow' });
          resolve();
        });
      });
      return { content: [{ type: 'text', text: signal.aborted ? 'aborted' : 'slept' }] };
    },
  );

  // Sampling through the v2 context (the 1.x `extra.sendRequest` is gone).
  server.registerTool(
    'summarize',
    { description: 'Asks the client LLM via ctx.mcpReq.requestSampling', inputSchema: { text: z.string() } },
    async ({ text }, ctx) => {
      marks.mark('tool:body-start', { toolName: 'summarize' });
      bump('summarize');
      const message = await ctx.mcpReq.requestSampling({
        messages: [{ role: 'user', content: { type: 'text', text } }],
        maxTokens: 64,
      });
      const content = message.content as { type: string; text?: string };
      return { content: [{ type: 'text', text: `summary: ${content.text ?? ''}` }] };
    },
  );

  // Same as `summarize`, but survives an abort and REPORTS what its signal
  // said — the observable proof that `ctx.mcpReq.signal` is the chained one.
  server.registerTool(
    'summarizeGuarded',
    { description: 'Asks the client LLM, reports signal state on failure', inputSchema: { text: z.string() } },
    async ({ text }, ctx) => {
      bump('summarizeGuarded');
      try {
        const message = await ctx.mcpReq.requestSampling({
          messages: [{ role: 'user', content: { type: 'text', text } }],
          maxTokens: 64,
        });
        const content = message.content as { type: string; text?: string };
        return { content: [{ type: 'text', text: `summary: ${content.text ?? ''}` }] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `failed: aborted=${String(ctx.mcpReq.signal.aborted)} name=${(error as Error).name}`,
            },
          ],
        };
      }
    },
  );

  // The 2026-07-28 way to ask the client's LLM: answer `input_required`, get
  // retried with the response in `ctx.mcpReq.inputResponses`.
  server.registerTool(
    'askModel',
    { description: 'Multi-round-trip sampling (input_required)', inputSchema: { text: z.string() } },
    async ({ text }, ctx) => {
      bump('askModel');
      // A sampling answer is read through `inputResponse` (kind 'sampling');
      // `acceptedContent` is the elicitation accessor.
      const answer = inputResponse(ctx.mcpReq.inputResponses, 'answer');
      if (answer.kind !== 'sampling') {
        return inputRequired({
          inputRequests: {
            answer: inputRequired.createMessage({
              messages: [{ role: 'user', content: { type: 'text', text } }],
              maxTokens: 64,
            }),
          },
        });
      }
      const content = answer.result.content as { type: string; text?: string };
      return { content: [{ type: 'text', text: `model said: ${content.text ?? ''}` }] };
    },
  );

  server.registerTool(
    'summarizeViaSend',
    { description: 'Asks the client LLM via ctx.mcpReq.send', inputSchema: { text: z.string() } },
    async ({ text }, ctx) => {
      bump('summarizeViaSend');
      const message = await ctx.mcpReq.send({
        method: 'sampling/createMessage',
        params: { messages: [{ role: 'user', content: { type: 'text', text } }], maxTokens: 64 },
      });
      const content = message.content as { type: string; text?: string };
      return { content: [{ type: 'text', text: `summary: ${content.text ?? ''}` }] };
    },
  );

  server.registerTool(
    'summarizeViaServer',
    { description: 'Asks the client LLM via server.createMessage', inputSchema: { text: z.string() } },
    async ({ text }) => {
      bump('summarizeViaServer');
      const message = await server.server.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text } }],
        maxTokens: 64,
      });
      const content = message.content as { type: string; text?: string };
      return { content: [{ type: 'text', text: `summary: ${content.text ?? ''}` }] };
    },
  );

  server.registerResource(
    'appConfig',
    'config://app',
    { description: 'Static app configuration', mimeType: 'application/json' },
    async (uri) => {
      marks.mark('resource:body-start', { name: 'appConfig' });
      bump('appConfig');
      return { contents: [{ uri: uri.toString(), text: JSON.stringify({ theme: 'dark' }) }] };
    },
  );

  server.registerResource(
    'userProfile',
    new ResourceTemplate('users://{id}/profile', { list: undefined }),
    { description: 'A user profile' },
    async (uri, variables) => {
      bump('userProfile');
      return { contents: [{ uri: uri.toString(), text: JSON.stringify({ id: variables['id'] }) }] };
    },
  );

  server.registerResource('brokenResource', 'broken://thing', { description: 'Always throws' }, async () => {
    bump('brokenResource');
    throw new Error('resource backend unavailable');
  });

  server.registerPrompt(
    'greet',
    { description: 'Greeting prompt', argsSchema: { name: z.string() } },
    ({ name }) => {
      marks.mark('prompt:body-start', { name: 'greet' });
      bump('greet');
      return { messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${name}` } }] };
    },
  );
}

export function makeClient(samplingAnswer = 'sampled answer'): Client {
  const client = new Client({ name: 'test-client-v2', version: '1.0.0' }, { capabilities: { sampling: {} } });
  client.setRequestHandler('sampling/createMessage', async () => ({
    model: 'test-model',
    role: 'assistant',
    content: { type: 'text', text: samplingAnswer },
  }));
  return client;
}

/**
 * Build the v2 server through `gm.wrapServer(...)` and connect a real v2
 * client. `gm === undefined` measures the uninstrumented baseline.
 */
export async function makeHarnessV2(gm: Graphmind | undefined, options: HarnessV2Options = {}): Promise<HarnessV2> {
  const marks = new Marks();
  const attempts = new Map<string, number>();
  const raw = new McpServer({ name: 'trip-server-v2', version: '2.1.0' });
  const server = gm === undefined ? raw : gm.wrapServer(raw);
  registerSurface(server, marks, attempts, options);

  const client = makeClient(options.samplingAnswer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let handle: StdioServerHandle | undefined;
  if (options.modern === true) {
    // The 2026-07-28 era is only served by the era-owning entry; the client
    // pins the revision so there is no probe-and-fallback ambiguity.
    handle = serveStdio(() => server, { transport: serverTransport });
    const pinned = new Client(
      { name: 'test-client-v2', version: '1.0.0' },
      { capabilities: { sampling: {} }, versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    // On 2026-07-28 the same handler fulfils `input_required` sampling
    // requests (the client retries the tool call with the answer attached).
    pinned.setRequestHandler('sampling/createMessage', async () => ({
      model: 'test-model',
      role: 'assistant',
      content: { type: 'text', text: options.samplingAnswer ?? 'sampled answer' },
    }));
    await pinned.connect(clientTransport);
    return {
      server,
      raw,
      client: pinned,
      marks,
      attempts,
      close: async () => {
        await pinned.close().catch(() => undefined);
        await handle?.close().catch(() => undefined);
        await raw.close().catch(() => undefined);
      },
    };
  }
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    server,
    raw,
    client,
    marks,
    attempts,
    close: async () => {
      await client.close().catch(() => undefined);
      await raw.close().catch(() => undefined);
    },
  };
}
