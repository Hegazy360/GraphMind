/**
 * A REAL MCP server driven by a REAL MCP client over the SDK's in-memory
 * transport pair. No mocks of the protocol: every assertion in this suite is
 * about what a client actually received.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CreateMessageRequestSchema, CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Graphmind } from '../../src/index.js';

export interface Mark {
  name: string;
  at: number;
  data?: Record<string, unknown>;
}

export class Marks {
  readonly all: Mark[] = [];
  mark(name: string, data?: Record<string, unknown>): void {
    this.all.push({ name, at: Date.now(), ...(data !== undefined ? { data } : {}) });
  }
  first(name: string, pred?: (mark: Mark) => boolean): Mark | undefined {
    return this.all.find((m) => m.name === name && (pred === undefined || pred(m)));
  }
  count(name: string, pred?: (mark: Mark) => boolean): number {
    return this.all.filter((m) => m.name === name && (pred === undefined || pred(m))).length;
  }
}

export const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface HarnessOptions {
  /** `flaky` throws on this many attempts before succeeding. Default 1. */
  flakyFailures?: number;
  /** How long `searchFlights` takes. Default 20ms. */
  toolDelayMs?: number;
  /** Text the client's sampling handler answers with. Default 'sampled answer'. */
  samplingAnswer?: string;
}

export interface Harness {
  /** The instrumented view — what the host would build its server on. */
  server: McpServer;
  /** The untouched object handed to `wrapServer`. */
  raw: McpServer;
  client: Client;
  marks: Marks;
  /** Attempts made by `flaky`, per name. */
  attempts: Map<string, number>;
  close(): Promise<void>;
}

/**
 * Build the server through `gm.wrapServer(...)` and connect a real client.
 * `wrap` can be turned off to measure the uninstrumented baseline.
 */
export async function makeHarness(
  gm: Graphmind | undefined,
  options: HarnessOptions = {},
): Promise<Harness> {
  const marks = new Marks();
  const attempts = new Map<string, number>();
  const bump = (name: string): number => {
    const next = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, next);
    return next;
  };

  const raw = new McpServer({ name: 'trip-server', version: '2.1.0' });
  const server = gm === undefined ? raw : gm.wrapServer(raw);

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

  // No inputSchema: the SDK calls this callback as `(extra)`, not `(args, extra)`.
  server.registerTool('ping', { description: 'Zero-argument tool' }, async () => {
    bump('ping');
    marks.mark('tool:body-start', { toolName: 'ping' });
    return { content: [{ type: 'text', text: 'pong' }] };
  });

  // Declares an outputSchema, so any result MUST carry structuredContent.
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

  // Sampling from inside a handler, through the request-scoped `sendRequest`.
  server.registerTool(
    'summarize',
    { description: 'Asks the client LLM', inputSchema: { text: z.string() } },
    async ({ text }, extra) => {
      marks.mark('tool:body-start', { toolName: 'summarize' });
      bump('summarize');
      const message = await extra.sendRequest(
        {
          method: 'sampling/createMessage',
          params: {
            messages: [{ role: 'user', content: { type: 'text', text } }],
            maxTokens: 64,
          },
        },
        CreateMessageResultSchema,
      );
      const content = message.content as { type: string; text?: string };
      return { content: [{ type: 'text', text: `summary: ${content.text ?? ''}` }] };
    },
  );

  // Sampling through the low-level server view instead.
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
      return {
        contents: [{ uri: uri.toString(), text: JSON.stringify({ id: variables['id'] }) }],
      };
    },
  );

  server.registerResource(
    'brokenResource',
    'broken://thing',
    { description: 'Always throws' },
    async () => {
      bump('brokenResource');
      throw new Error('resource backend unavailable');
    },
  );

  server.registerPrompt(
    'greet',
    { description: 'Greeting prompt', argsSchema: { name: z.string() } },
    ({ name }) => {
      marks.mark('prompt:body-start', { name: 'greet' });
      bump('greet');
      return {
        messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${name}` } }],
      };
    },
  );

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: { sampling: {} } },
  );
  client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    model: 'test-model',
    role: 'assistant',
    content: { type: 'text', text: options.samplingAnswer ?? 'sampled answer' },
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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

/** The text of the `index`-th block of a ReadResourceResult. */
export function resourceText(result: unknown, index = 0): string {
  const contents = (result as { contents?: Record<string, unknown>[] }).contents ?? [];
  const value = contents[index]?.['text'];
  return typeof value === 'string' ? value : '';
}

/** The uri of the `index`-th block of a ReadResourceResult. */
export function resourceUri(result: unknown, index = 0): string {
  const contents = (result as { contents?: Record<string, unknown>[] }).contents ?? [];
  const value = contents[index]?.['uri'];
  return typeof value === 'string' ? value : '';
}

/** The text of the first text block of a CallToolResult. */
export function toolText(result: unknown): string {
  const content = (result as { content?: { type?: string; text?: string }[] }).content ?? [];
  const block = content.find((c) => c.type === 'text');
  return block?.text ?? '';
}
