/**
 * Adversarial verification of the v2 port — the invariants the happy-path
 * suites (v2.test.ts, v2-modern.test.ts) do not exercise:
 *
 *  - FAIL OPEN: a debugger that dies mid-hold releases the v2 request;
 *  - N concurrent v2 requests keep their identities apart;
 *  - an argument past the client's 512 KB payload guard passes through
 *    intact and the session survives;
 *  - a CLIENT-side cancellation still reaches the handler through the
 *    CHAINED `ctx.mcpReq.signal` (the chain must add the debugger, never
 *    hide the client), attached and detached;
 *  - the shallow context copy loses nothing the SDK put on `ctx` /
 *    `ctx.mcpReq` (keys and types identical to the uninstrumented context);
 *  - a non-Error throw and a synchronous throw are reported and answered;
 *  - wrapping twice never double-gates;
 *  - the detached cost per request stays in the noise (same bound as 1.x).
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { graphmind, type Graphmind } from '../src/index.js';
import { waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';
import { makeHarnessV2, toolText } from './helpers/mcp-v2.js';
import { attach, makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

const pausedOn =
  (nodeId: string, point = 'before') =>
  (f: ReceivedFrame): boolean =>
    f.type === 'exec.paused' && f.payload['nodeId'] === nodeId && f.payload['point'] === point;
const startsOf = (frames: ReceivedFrame[], nodeId: string): ReceivedFrame[] =>
  frames.filter((f) => f.type === 'node.started' && f.payload['nodeId'] === nodeId);
const finishesOf = (frames: ReceivedFrame[], nodeId: string): ReceivedFrame[] =>
  frames.filter((f) => f.type === 'node.finished' && f.payload['nodeId'] === nodeId);

/** The `from` a searchFlights CallToolResult echoes (the text block is JSON). */
function echoedFrom(result: unknown): string | undefined {
  const parsed = JSON.parse(toolText(result)) as { flights?: { from?: string }[] };
  return parsed.flights?.[0]?.from;
}

describe('v2 verifier: fail-open', () => {
  it('a viewer that dies mid-hold releases the v2 request; the next request is served detached', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool' }] });
    await attach(gm);
    const h = await makeHarnessV2(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'searchFlights', arguments: { from: 'VIE', to: 'LIS' } });
    await viewer.waitFor(pausedOn('tool:searchFlights'));
    expect(gm.session.stats().heldGates).toBe(1);
    expect(h.marks.first('tool:body-start')).toBeUndefined();

    viewer.killAbruptly();

    // No resume will ever arrive; the request must still complete, for real.
    expect(toolText(await call)).toContain('TP1234');
    expect(h.attempts.get('searchFlights')).toBe(1);
    expect(gm.session.stats().heldGates).toBe(0);
    expect(gm.session.attached).toBe(false);

    const t0 = performance.now();
    expect(toolText(await h.client.callTool({ name: 'ping' }))).toBe('pong');
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('v2 verifier: concurrency and size', () => {
  it('20 concurrent calls: 20 runs, 20 distinct instanceIds, every finish pairs with its own start', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm, { toolDelayMs: 5 });
    cleanups.push(h.close);

    const n = 20;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        h.client.callTool({ name: 'searchFlights', arguments: { from: `F${i}`, to: `T${i}` } }),
      ),
    );
    results.forEach((result, i) => expect(echoedFrom(result)).toBe(`F${i}`));

    await waitUntil(() => finishesOf(viewer.received, 'tool:searchFlights').length === n, 8000, `${n} finishes`);
    const starts = startsOf(viewer.received, 'tool:searchFlights');
    expect(starts).toHaveLength(n);
    expect(new Set(starts.map((f) => f.payload['instanceId'])).size).toBe(n);
    expect(new Set(starts.map((f) => f.runId)).size).toBe(n);
    for (const start of starts) {
      const input = start.payload['input'] as { from: string };
      const finish = finishesOf(viewer.received, 'tool:searchFlights').find(
        (f) => f.payload['instanceId'] === start.payload['instanceId'],
      );
      expect(finish, `finish for ${input.from}`).toBeDefined();
      expect(finish?.runId).toBe(start.runId);
      expect(echoedFrom(finish?.payload['output'])).toBe(input.from);
    }
    expect(gm.session.stats().heldGates).toBe(0);
  });

  it('a 1.5 MB argument passes through intact; both events still arrive and the session survives', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm, { toolDelayMs: 0 });
    cleanups.push(h.close);

    const big = 'x'.repeat(1_500_000);
    const result = await h.client.callTool({ name: 'searchFlights', arguments: { from: big, to: 'LIS' } });
    expect(echoedFrom(result)?.length).toBe(1_500_000);

    // The 512 KB budget is applied by the hub's storage (packages/cli
    // storage.ts), not by the adapter: the adapter's job is to deliver both
    // events for the execution and stay attached, whatever the size.
    const start = await viewer.waitFor((f) => f.type === 'node.started' && f.payload['nodeId'] === 'tool:searchFlights');
    const finish = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights');
    expect(finish.payload['instanceId']).toBe(start.payload['instanceId']);
    expect(finish.payload['status']).toBe('ok');
    expect(gm.session.attached).toBe(true);
    expect(toolText(await h.client.callTool({ name: 'ping' }))).toBe('pong');
  });
});

describe('v2 verifier: the chained signal never hides the client', () => {
  for (const attached of [true, false]) {
    it(`${attached ? 'ATTACHED' : 'DETACHED'}: a client-side cancellation reaches the handler through ctx.mcpReq.signal`, async () => {
      const { gm } = attached
        ? await setup(cleanups.push)
        : await setup(cleanups.push, {}, { url: 'ws://127.0.0.1:1/ingest', connectTimeoutMs: 50 });
      if (attached) await attach(gm);
      const h = await makeHarnessV2(gm);
      cleanups.push(h.close);
      if (!attached) await waitUntil(() => !gm.session.attached, 1000, 'detached');

      const controller = new AbortController();
      const call = h.client.callTool({ name: 'slow', arguments: { ms: 5000 } }, { signal: controller.signal });
      await waitUntil(
        () => h.marks.first('tool:body-start', (m) => m.data?.['toolName'] === 'slow') !== undefined,
        4000,
        'handler started',
      );
      controller.abort();
      await expect(call).rejects.toBeDefined();
      // The handler was given a signal that observed the CLIENT's cancellation.
      await waitUntil(() => h.marks.first('tool:signal-aborted') !== undefined, 4000, 'handler saw the abort');
      expect(gm.session.attached).toBe(attached);
    });
  }
});

describe('v2 verifier: the context copy', () => {
  interface Shape {
    ctxKeys: string[];
    reqKeys: string[];
    reqTypes: Record<string, string>;
    logOutcome: string;
  }

  async function observeShape(gm: Graphmind | undefined): Promise<Shape> {
    let seen: Shape | undefined;
    const raw = new McpServer({ name: 'shape', version: '1' });
    const server = gm === undefined ? raw : gm.wrapServer(raw);
    server.registerTool('inspect', { inputSchema: { x: z.string() } }, async (_args, ctx) => {
      const req = ctx.mcpReq as unknown as Record<string, unknown>;
      let logOutcome = 'ok';
      try {
        const log = req['log'] as ((...args: unknown[]) => Promise<void>) | undefined;
        await log?.call(req, 'info', 'hello from the handler');
      } catch (error) {
        logOutcome = `threw:${(error as Error).name}`;
      }
      const reqKeys = Object.keys(req).sort();
      seen = {
        ctxKeys: Object.keys(ctx).sort(),
        reqKeys,
        reqTypes: Object.fromEntries(reqKeys.map((k) => [k, typeof req[k]])),
        logOutcome,
      };
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await raw.close().catch(() => undefined);
    });
    await client.callTool({ name: 'inspect', arguments: { x: '1' } });
    if (seen === undefined) throw new Error('handler did not run');
    return seen;
  }

  it('exposes every key the SDK put on ctx and ctx.mcpReq, with the same types, attached', async () => {
    const { gm } = await setup(cleanups.push);
    await attach(gm);
    const plain = await observeShape(undefined);
    const wrapped = await observeShape(gm);
    expect(wrapped.ctxKeys).toEqual(plain.ctxKeys);
    expect(wrapped.reqKeys).toEqual(plain.reqKeys);
    expect(wrapped.reqTypes).toEqual(plain.reqTypes);
    expect(wrapped.logOutcome).toBe(plain.logOutcome);
    // And the SDK really did put the v2 surface there (so the comparison is not vacuous).
    expect(plain.reqKeys).toEqual(
      expect.arrayContaining(['id', 'method', 'signal', 'send', 'notify', 'requestSampling', 'elicitInput', 'log']),
    );
  });
});

describe('v2 verifier: never throws into the host', () => {
  it('a non-Error throw and a synchronous throw are both reported and answered as isError', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const raw = new McpServer({ name: 'odd-v2', version: '1' });
    const server = gm.wrapServer(raw);
    server.registerTool('bareString', { inputSchema: {} }, async () => {
      throw 'a bare string';
    });
    server.registerTool('syncBoom', { inputSchema: {} }, (() => {
      throw new Error('sync boom');
    }) as unknown as () => Promise<never>);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await raw.close().catch(() => undefined);
    });

    const bare = (await client.callTool({ name: 'bareString', arguments: {} })) as { isError?: boolean };
    expect(bare.isError).toBe(true);
    expect(toolText(bare)).toContain('a bare string');
    const sync = (await client.callTool({ name: 'syncBoom', arguments: {} })) as { isError?: boolean };
    expect(sync.isError).toBe(true);
    expect(toolText(sync)).toContain('sync boom');

    const bareError = await viewer.waitFor((f) => f.type === 'node.error' && f.payload['nodeId'] === 'tool:bareString');
    expect(JSON.stringify(bareError.payload['error'])).toContain('a bare string');
    const syncError = await viewer.waitFor((f) => f.type === 'node.error' && f.payload['nodeId'] === 'tool:syncBoom');
    expect((syncError.payload['error'] as { message: string }).message).toContain('sync boom');
  });

  it('wrapping a v2 server twice gates once', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool', name: 'echo' }] });
    await attach(gm);
    const raw = new McpServer({ name: 'twice', version: '1' });
    const server = gm.wrapServer(gm.wrapServer(raw));
    expect(server).toBe(gm.wrapServer(server));
    server.registerTool('echo', { inputSchema: { x: z.string() } }, async ({ x }) => ({
      content: [{ type: 'text', text: x }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await raw.close().catch(() => undefined);
    });

    const call = client.callTool({ name: 'echo', arguments: { x: 'once' } });
    const paused = await viewer.waitFor(pausedOn('tool:echo'));
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(toolText(await call)).toBe('once');
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:echo');
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
    expect(startsOf(viewer.received, 'tool:echo')).toHaveLength(1);
  });
});

describe('v2 verifier: detached cost', () => {
  it('detached overhead per v2 request stays in the noise (same bound as the 1.x suite)', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const plain = await makeHarnessV2(undefined, { toolDelayMs: 0 });
    cleanups.push(plain.close);
    const wrapped = await makeHarnessV2(gm, { toolDelayMs: 0 });
    cleanups.push(wrapped.close);

    const rounds = 200;
    const time = async (client: Client): Promise<number> => {
      const start = performance.now();
      for (let i = 0; i < rounds; i += 1) await client.callTool({ name: 'ping' });
      return performance.now() - start;
    };
    await time(plain.client);
    await time(wrapped.client);
    const baseline = await time(plain.client);
    const instrumented = await time(wrapped.client);
    expect((instrumented - baseline) / rounds).toBeLessThan(2.5);
    expect(gm.session.stats().heldGates).toBe(0);
  });
});
