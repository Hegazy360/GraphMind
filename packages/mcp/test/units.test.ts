/**
 * The invariants that are not about a specific gate: the disabled / detached
 * fast paths and their cost, proxy transparency, "never mutate, never throw",
 * and the inject coercion rules on their own.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coerceInjected } from '../src/coerce.js';
import { graphmind } from '../src/index.js';
import { makeHarness, toolText } from './helpers/mcp.js';
import { makeCleanups } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

const WRAPPED = Symbol.for('graphmind.mcp.wrapped');

describe('kill switches and the disabled path', () => {
  it('GRAPHMIND_DISABLED=1 makes wrapServer an identity function', async () => {
    const gm = graphmind({ env: { GRAPHMIND_DISABLED: '1' }, logger: () => {} });
    cleanups.push(() => gm.dispose());
    expect(gm.session.enabled).toBe(false);

    const raw = new McpServer({ name: 's', version: '1' });
    expect(gm.wrapServer(raw)).toBe(raw);

    const h = await makeHarness(gm);
    cleanups.push(h.close);
    expect(toolText(await h.client.callTool({ name: 'ping' }))).toBe('pong');
    expect(gm.session.stats().seq).toBe(0); // nothing emitted, nothing buffered
  });

  it('enabled: false is identity too', () => {
    const gm = graphmind({ enabled: false, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const raw = new McpServer({ name: 's', version: '1' });
    expect(gm.wrapServer(raw)).toBe(raw);
  });

  it('wrapping an already-wrapped server is a no-op (no double gates)', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const raw = new McpServer({ name: 's', version: '1' });
    const once = gm.wrapServer(raw);
    expect(gm.wrapServer(once)).toBe(once);
    expect(once).not.toBe(raw);
  });

  it('an object that is neither an McpServer nor a Server comes back untouched', () => {
    const warnings: string[] = [];
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: (m) => warnings.push(m) });
    cleanups.push(() => gm.dispose());
    const notAServer = { hello: 'world' };
    expect(gm.wrapServer(notAServer)).toBe(notAServer);
    expect(warnings.join('\n')).toContain('neither an McpServer nor a Server');
  });
});

describe('the host object is never mutated', () => {
  it('wrapping + registering writes nothing of ours onto the real server', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    expect((h.raw as unknown as Record<PropertyKey, unknown>)[WRAPPED]).toBeUndefined();
    expect(Object.getOwnPropertySymbols(h.raw)).toHaveLength(0);
    expect(Object.getOwnPropertySymbols(h.raw.server)).toHaveLength(0);
    // The registration went to the REAL server; the proxy only decorated it.
    expect(h.raw.isConnected()).toBe(true);
    expect(h.server).not.toBe(h.raw);
  });

  it('forwards ordinary methods and property writes to the real object', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    expect(h.server.isConnected()).toBe(true);
    const closed: string[] = [];
    h.server.server.onclose = () => closed.push('closed');
    expect(h.raw.server.onclose).toBeDefined();
    // A notification method still works through the proxy.
    expect(() => h.server.sendToolListChanged()).not.toThrow();
  });
});

describe('detached (enabled, no viewer)', () => {
  it('serves normally, buffers for replay, holds nothing', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    expect(toolText(await h.client.callTool({ name: 'ping' }))).toBe('pong');
    const stats = gm.session.stats();
    expect(stats.attached).toBe(false);
    expect(stats.heldGates).toBe(0);
    expect(stats.buffered).toBeGreaterThan(0); // ring buffer holds replay events
  });

  it('detached overhead per request stays in the noise', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());

    const plain = await makeHarness(undefined, { toolDelayMs: 0 });
    cleanups.push(plain.close);
    const wrapped = await makeHarness(gm, { toolDelayMs: 0 });
    cleanups.push(wrapped.close);

    const rounds = 200;
    const time = async (client: Client): Promise<number> => {
      const start = performance.now();
      for (let i = 0; i < rounds; i += 1) await client.callTool({ name: 'ping' });
      return performance.now() - start;
    };
    await time(plain.client); // warm both paths
    await time(wrapped.client);
    const baseline = await time(plain.client);
    const instrumented = await time(wrapped.client);

    const addedPerCall = (instrumented - baseline) / rounds;
    // Generous bound: the claim is "no measurable cost", not a benchmark.
    // A detached request adds 3 fast-path gates and 4 buffered events.
    expect(addedPerCall).toBeLessThan(2.5);
    expect(gm.session.stats().heldGates).toBe(0);
  });
});

describe('never throws into the host', () => {
  it('a throwing log sink cannot break a request', async () => {
    const gm = graphmind({
      enabled: true,
      webSocket: undefined,
      logger: () => {
        throw new Error('bad sink');
      },
    });
    cleanups.push(() => gm.dispose());
    const h = await makeHarness(gm);
    cleanups.push(h.close);
    expect(toolText(await h.client.callTool({ name: 'ping' }))).toBe('pong');
  });

  it('a handler that throws a non-Error still reports and still answers', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const raw = new McpServer({ name: 'odd', version: '1' });
    const server = gm.wrapServer(raw);
    server.registerTool('nope', { inputSchema: {} }, async () => {
      throw 'a bare string';
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close();
      await raw.close();
    });

    const result = (await client.callTool({ name: 'nope', arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('a bare string');
  });
});

describe('stdio safety', () => {
  it('writes nothing to stdout — on a stdio server, stdout IS the protocol', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const original = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      captured.push(String(chunk));
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      await h.client.callTool({ name: 'searchFlights', arguments: { from: 'A', to: 'B' } });
      await h.client.readResource({ uri: 'config://app' });
      await h.client.getPrompt({ name: 'greet', arguments: { name: 'Ada' } });
    } finally {
      process.stdout.write = original;
    }
    expect(captured).toEqual([]);
  });
});

describe('RegisteredTool.update', () => {
  it('a swapped callback stays instrumented', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const raw = new McpServer({ name: 'up', version: '1' });
    const server = gm.wrapServer(raw);
    const registered = server.registerTool(
      'greet',
      { inputSchema: { who: z.string() } },
      async ({ who }) => ({ content: [{ type: 'text' as const, text: `v1 ${who}` }] }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close();
      await raw.close();
    });

    expect(toolText(await client.callTool({ name: 'greet', arguments: { who: 'Ada' } }))).toBe(
      'v1 Ada',
    );

    const before = gm.session.stats().seq;
    registered.update({
      callback: async (args: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: `v2 ${String(args['who'])}` }],
      }),
    });
    expect(toolText(await client.callTool({ name: 'greet', arguments: { who: 'Ada' } }))).toBe(
      'v2 Ada',
    );
    // The replacement still emits (start + finish for both the server and the
    // tool node), i.e. instrumentation survived the swap.
    expect(gm.session.stats().seq).toBeGreaterThan(before + 3);
  });
});

describe('inject coercion', () => {
  it('passes a well-formed result through untouched', () => {
    const result = { content: [{ type: 'text', text: 'x' }], isError: true };
    expect(coerceInjected('tool', result)).toBe(result);
    const read = { contents: [{ uri: 'a://b', text: 'x' }] };
    expect(coerceInjected('resource', read, 'a://b')).toBe(read);
    const prompt = { messages: [] };
    expect(coerceInjected('prompt', prompt)).toBe(prompt);
  });

  it('lifts strings, objects and oddities into valid results', () => {
    expect(coerceInjected('tool', 'hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(coerceInjected('tool', { a: 1 })).toEqual({
      content: [{ type: 'text', text: '{"a":1}' }],
      structuredContent: { a: 1 },
    });
    // Arrays are not valid structuredContent, so they stay text-only.
    expect(coerceInjected('tool', [1, 2])).toEqual({
      content: [{ type: 'text', text: '[1,2]' }],
    });
    expect(coerceInjected('tool', undefined)).toEqual({ content: [] });
    expect(coerceInjected('resource', 'plain', 'a://b')).toEqual({
      contents: [{ uri: 'a://b', text: 'plain' }],
    });
    expect(coerceInjected('prompt', 'say hi')).toEqual({
      messages: [{ role: 'user', content: { type: 'text', text: 'say hi' } }],
    });
    expect(coerceInjected('sampling', 'answer')).toMatchObject({
      role: 'assistant',
      content: { type: 'text', text: 'answer' },
    });
  });

  it('survives values JSON cannot serialize', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const lifted = coerceInjected('tool', cyclic) as { structuredContent?: unknown };
    expect(lifted.structuredContent).toBe(cyclic);
    expect(() => coerceInjected('prompt', { big: 1n })).not.toThrow();
  });
});
