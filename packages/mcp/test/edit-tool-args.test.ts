/**
 * Edited tool arguments (0.6.0, contract C2 / W2) through the in-process MCP
 * adapter: `continue` + input at `before` and `retry` + input at `after` /
 * `error` invoke the REAL handler with the merged arguments, re-validated by
 * the tool's own schema (the SDK validated the CLIENT's arguments before the
 * handler ran; an edit arrives after that) — 1.x zod, 2.x Standard Schema —
 * or, on the low-level `Server`, handed over in a copy of the request. A
 * refusal keeps the gate held; the `after` gate hands the CallToolResult to
 * the detectors; nothing changes under a 0.5 debugger, with edits disabled,
 * or detached. Proven with a real MCP client against a real MCP server.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client as ClientV2 } from '@modelcontextprotocol/client';
import { InMemoryTransport as InMemoryTransportV2, McpServer as McpServerV2 } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AfterGateContext, GateDetector, Session } from '@graphmind-ai/client';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { tick, waitUntil, type FakeViewerOptions, type ReceivedFrame, type FakeViewer } from './helpers/fake-viewer.js';
import { toolText } from './helpers/mcp.js';
import { attach, makeCleanups, setup as baseSetup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

const EDIT_HUB = ['edit-input'];
const BEFORE = [{ kind: 'tool' as const }];

async function setup(viewerOptions: FakeViewerOptions = {}, gmOptions: Partial<GraphmindOptions> = {}) {
  const rig = await baseSetup(cleanups.push, { hubCapabilities: EDIT_HUB, ...viewerOptions }, { env: {}, ...gmOptions });
  await attach(rig.gm);
  return rig;
}

function detectorsOf(session: Session): GateDetector[] {
  return (session as unknown as { detectors: GateDetector[] }).detectors;
}

function pausedAt(viewer: FakeViewer, nodeId: string, point: string, n = 1): Promise<ReceivedFrame> {
  const match = (f: ReceivedFrame): boolean =>
    f.type === 'exec.paused' && f.payload['nodeId'] === nodeId && f.payload['point'] === point;
  return waitUntil(() => viewer.received.filter(match).length >= n, 8000, `${nodeId} ${point} #${n}`).then(
    () => viewer.received.filter(match)[n - 1] as ReceivedFrame,
  );
}

const pauseIdOf = (frame: ReceivedFrame): string => frame.payload['pauseId'] as string;

async function refusal(viewer: FakeViewer, pauseId: string, n = 1): Promise<ReceivedFrame> {
  const match = (f: ReceivedFrame): boolean => f.type === 'exec.refused' && f.payload['pauseId'] === pauseId;
  await waitUntil(() => viewer.received.filter(match).length >= n, 8000, `refusal #${n}`);
  return viewer.received.filter(match)[n - 1] as ReceivedFrame;
}

function resumedFor(viewer: FakeViewer, pauseId: string): Promise<ReceivedFrame> {
  return viewer.waitFor((f) => f.type === 'exec.resumed' && f.payload['pauseId'] === pauseId);
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

interface Rig {
  client: Client;
  calls: { tool: string; args: unknown }[];
}

/** A 1.x McpServer with a zod-schema tool, a throwing tool and a zero-argument tool. */
async function makeServer(gm: Graphmind | undefined): Promise<Rig> {
  const calls: Rig['calls'] = [];
  const raw = new McpServer({ name: 'edit-server', version: '1.0.0' });
  const server = gm === undefined ? raw : gm.wrapServer(raw);
  server.registerTool(
    'convertCurrency',
    {
      description: 'Convert an amount between currencies',
      inputSchema: { amount: z.number().max(10_000), from: z.string().trim(), to: z.string() },
    },
    async (args) => {
      calls.push({ tool: 'convertCurrency', args });
      if (args.from === 'XXX') throw new Error('FX rate service returned HTTP 500');
      return { content: [{ type: 'text', text: `${Math.round(args.amount * 0.9 * 100) / 100} ${args.to}` }] };
    },
  );
  server.registerTool('ping', { description: 'Zero-argument tool' }, async () => {
    calls.push({ tool: 'ping', args: undefined });
    return { content: [{ type: 'text', text: 'pong' }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'edit-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await raw.close().catch(() => undefined);
  });
  return { client, calls };
}

describe('continue + input at the before gate (1.x McpServer)', () => {
  it('the real handler runs with the merged arguments; the client gets its result', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const { client, calls } = await makeServer(gm);
    const call = client.callTool({ name: 'convertCurrency', arguments: { amount: 100, from: 'EUR', to: 'USD' } });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'before');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { to: 'JPY' } });
    expect(toolText(await call)).toBe('90 JPY');
    expect(calls).toEqual([{ tool: 'convertCurrency', args: { amount: 100, from: 'EUR', to: 'JPY' } }]);
    const started = viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect(started?.payload['input']).toEqual({ amount: 100, from: 'EUR', to: 'USD' });
    expect((await resumedFor(viewer, pauseIdOf(paused))).payload['edited']).toEqual({
      after: { amount: 100, from: 'EUR', to: 'JPY' },
    });
  });

  it("the tool's zod schema refuses a bad edit (code schema, no value quoted), the gate stays held, then parses a good one", async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const { client, calls } = await makeServer(gm);
    const call = client.callTool({ name: 'convertCurrency', arguments: { amount: 100, from: 'EUR', to: 'USD' } });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'before'));

    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 'SECRET-VALUE-42' } });
    const first = await refusal(viewer, pauseId);
    expect(first.payload['code']).toBe('schema');
    expect(String(first.payload['message'])).toMatch(/field "amount" must be number, got string/);
    expect(JSON.stringify(first.payload)).not.toContain('SECRET-VALUE-42');
    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 99_999 } });
    expect(String((await refusal(viewer, pauseId, 2)).payload['message'])).toMatch(/amount.*at most 10000/);
    expect(calls).toHaveLength(0);
    expect(await settledWithin(call, 50)).toBe('pending');

    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 50, from: '  GBP ' } });
    expect(toolText(await call)).toBe('45 USD');
    expect(calls).toEqual([{ tool: 'convertCurrency', args: { amount: 50, from: 'GBP', to: 'USD' } }]);
  });

  it('a tool registered without an input schema (called as (extra)) is not editable', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const { client } = await makeServer(gm);
    const call = client.callTool({ name: 'ping' });
    const paused = await pausedAt(viewer, 'tool:ping', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { x: 1 } });
    expect((await refusal(viewer, pauseIdOf(paused))).payload['code']).toBe('unsupported');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(toolText(await call)).toBe('pong');
  });

  it('parallel calls: editing one of two held gates leaves the other on its own arguments', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const { client, calls } = await makeServer(gm);
    const first = client.callTool({ name: 'convertCurrency', arguments: { amount: 10, from: 'EUR', to: 'USD' } });
    const second = client.callTool({ name: 'convertCurrency', arguments: { amount: 20, from: 'EUR', to: 'GBP' } });
    const a = await pausedAt(viewer, 'tool:convertCurrency', 'before', 1);
    const b = await pausedAt(viewer, 'tool:convertCurrency', 'before', 2);
    viewer.resumeWith({ pauseId: pauseIdOf(b), action: 'continue', input: { amount: 40 } });
    expect(toolText(await second)).toBe('36 GBP');
    expect(await settledWithin(first, 50)).toBe('pending');
    viewer.resume(pauseIdOf(a), 'continue');
    expect(toolText(await first)).toBe('9 USD');
    expect(calls.map((c) => c.args)).toEqual([
      { amount: 40, from: 'EUR', to: 'GBP' },
      { amount: 10, from: 'EUR', to: 'USD' },
    ]);
  });
});

describe("an accepted edit never runs the schema's transforms twice (1.x McpServer)", () => {
  it("the handler gets the SDK's PARSED arguments: a partial edit of a transformed call is refused, a full one parses once", async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const raw = new McpServer({ name: 'charge-server', version: '1.0.0' });
    const server = gm.wrapServer(raw);
    server.registerTool(
      'charge',
      {
        description: 'Charge the customer',
        // dollars -> cents: NOT idempotent (applied twice = 100 times the charge).
        inputSchema: { dollars: z.number().transform((d) => d * 100), memo: z.string() },
      },
      async (args) => {
        calls.push(args);
        return { content: [{ type: 'text', text: `charged ${args.dollars} cents` }] };
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'charge-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await raw.close().catch(() => undefined);
    });

    const call = client.callTool({ name: 'charge', arguments: { dollars: 5, memo: 'x' } });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:charge', 'before'));
    // The live arguments are already {dollars: 500}: merging {memo} onto them
    // and parsing again would charge 50000 cents.
    viewer.resumeWith({ pauseId, action: 'continue', input: { memo: 'fixed memo' } });
    expect((await refusal(viewer, pauseId)).payload['code']).toBe('unsupported');
    expect(calls).toHaveLength(0);
    // Every argument given: parsed once, from what the user wrote.
    viewer.resumeWith({ pauseId, action: 'continue', input: { dollars: 7, memo: 'fixed memo' } });
    expect(toolText(await call)).toBe('charged 700 cents');
    expect(calls).toEqual([{ dollars: 700, memo: 'fixed memo' }]);
  });
});

describe('retry + input at the error and after gates', () => {
  it('retry + input at the error gate fixes a throwing handler', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const { client, calls } = await makeServer(gm);
    const call = client.callTool({ name: 'convertCurrency', arguments: { amount: 100, from: 'XXX', to: 'USD' } });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'error');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { from: 'EUR' } });
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(toolText(result)).toBe('90 USD');
    expect(calls.map((c) => c.args)).toEqual([
      { amount: 100, from: 'XXX', to: 'USD' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
  });

  it('retry without input re-runs the same arguments, as before', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const { client, calls } = await makeServer(gm);
    const call = client.callTool({ name: 'convertCurrency', arguments: { amount: 100, from: 'XXX', to: 'USD' } });
    viewer.resume(pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'error', 1)), 'retry');
    viewer.resume(pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'error', 2)), 'continue');
    const result = await call;
    expect(result.isError).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([
      { amount: 100, from: 'XXX', to: 'USD' },
      { amount: 100, from: 'XXX', to: 'USD' },
    ]);
  });

  it('the after gate hands the CallToolResult to the detectors; retry + input there re-runs with the edit', async () => {
    const { viewer, gm } = await setup();
    const seen: AfterGateContext[] = [];
    detectorsOf(gm.session).push((context) => {
      seen.push(context);
      return toolText(context.result as never).endsWith('XXX') ? { rule: 'error-result' } : undefined;
    });
    const { client, calls } = await makeServer(gm);
    const call = client.callTool({ name: 'convertCurrency', arguments: { amount: 100, from: 'EUR', to: 'XXX' } });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'after');
    expect(paused.payload['smart']).toEqual({ rule: 'error-result' });
    expect(paused.payload['editable']).toBe(true);
    expect(seen[0]?.node.kind).toBe('tool');
    expect(seen[0]?.result).toEqual({ content: [{ type: 'text', text: '90 XXX' }] });
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { to: 'USD' } });
    expect(toolText(await call)).toBe('90 USD');
    expect(calls.map((c) => c.args)).toEqual([
      { amount: 100, from: 'EUR', to: 'XXX' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
  });
});

describe('nothing changes without edit support', () => {
  it('a 0.5 debugger: no editable flag, the edit is refused (disabled), continue runs the client arguments', async () => {
    const { viewer, gm } = await setup({ hubCapabilities: undefined, breakpoints: BEFORE });
    const { client, calls } = await makeServer(gm);
    const call = client.callTool({ name: 'convertCurrency', arguments: { amount: 100, from: 'EUR', to: 'USD' } });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { amount: 1 } });
    expect((await refusal(viewer, pauseIdOf(paused))).payload['code']).toBe('disabled');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(toolText(await call)).toBe('90 USD');
    expect(calls.map((c) => c.args)).toEqual([{ amount: 100, from: 'EUR', to: 'USD' }]);
  });

  it('GRAPHMIND_DISABLE_EDIT_INPUT: no editable flag, the edit is refused (disabled)', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE }, { env: { GRAPHMIND_DISABLE_EDIT_INPUT: 'y' } });
    const { client } = await makeServer(gm);
    const call = client.callTool({ name: 'convertCurrency', arguments: { amount: 100, from: 'EUR', to: 'USD' } });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { amount: 1 } });
    expect((await refusal(viewer, pauseIdOf(paused))).payload['code']).toBe('disabled');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(toolText(await call)).toBe('90 USD');
  });

  it('detached: every gate is called exactly as in 0.5 (no options)', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, env: {}, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const gate = vi.spyOn(gm.session, 'gate');
    const { client } = await makeServer(gm);
    expect(toolText(await client.callTool({ name: 'convertCurrency', arguments: { amount: 1, from: 'EUR', to: 'USD' } }))).toBe(
      '0.9 USD',
    );
    const result = await client.callTool({ name: 'convertCurrency', arguments: { amount: 1, from: 'XXX', to: 'USD' } });
    expect(result.isError).toBe(true);
    expect(gate.mock.calls.map((call) => call[0])).toEqual(['before', 'after', 'before', 'error']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
  });

  it('resources are not editable', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'resource' }] });
    const raw = new McpServer({ name: 'r', version: '1.0.0' });
    const server = gm.wrapServer(raw);
    server.registerResource('cfg', 'config://app', {}, async (uri) => ({ contents: [{ uri: uri.toString(), text: 'x' }] }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
    });
    const read = client.readResource({ uri: 'config://app' });
    const paused = await pausedAt(viewer, 'resource:cfg', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resume(pauseIdOf(paused), 'continue');
    await read;
  });
});

describe('the low-level Server and the 2.x McpServer', () => {
  it('low-level tools/call: the handler gets a copy of the request with the edited arguments; name and _meta unchanged', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const seen: unknown[] = [];
    const raw = new Server({ name: 'hand-rolled', version: '0.4.0' }, { capabilities: { tools: {} } });
    const server = gm.wrapServer(raw);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', inputSchema: { type: 'object' as const } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      seen.push(request.params);
      const message = (request.params.arguments as { message?: string } | undefined)?.message ?? '';
      return { content: [{ type: 'text' as const, text: `echo: ${message}` }] };
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
    });

    const call = client.callTool({ name: 'echo', arguments: { message: 'hi', loud: false }, _meta: { trace: 't1' } });
    const paused = await pausedAt(viewer, 'tool:echo', 'before');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { message: 'edited' } });
    expect(toolText(await call)).toBe('echo: edited');
    expect(seen).toEqual([{ name: 'echo', arguments: { message: 'edited', loud: false }, _meta: { trace: 't1' } }]);
  });

  it("2.x McpServer: the registered schema (the SDK's Standard Schema record) refuses a bad edit, then runs a good one", async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const raw = new McpServerV2({ name: 'v2', version: '2.0.0' });
    const server = gm.wrapServer(raw);
    server.registerTool(
      'search',
      { description: 'search', inputSchema: z.object({ query: z.string().min(2), limit: z.number().int().default(5) }) },
      async (args) => {
        calls.push(args);
        return { content: [{ type: 'text', text: `${args.query}/${args.limit}` }] };
      },
    );
    const [ct, st] = InMemoryTransportV2.createLinkedPair();
    const client = new ClientV2({ name: 'c', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await raw.close().catch(() => undefined);
    });

    const call = client.callTool({ name: 'search', arguments: { query: 'ams' } });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:search', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 'x' } });
    const refused = await refusal(viewer, pauseId);
    expect(refused.payload['code']).toBe('schema');
    expect(String(refused.payload['message'])).toMatch(/field "query" is too short/);
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 'lis', limit: 2 } });
    const result = (await call) as { content: { type: string; text: string }[] };
    expect(result.content[0]?.text).toBe('lis/2');
    expect(calls).toEqual([{ query: 'lis', limit: 2 }]);
  });
});
