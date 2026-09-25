/**
 * Edited tool arguments (0.6.0, contract C2 / W2) through the AI SDK tool
 * wrapper: `continue` + input at `before` and `retry` + input at `after` /
 * `error` run the REAL execute with the merged, re-validated arguments; a
 * schema refusal keeps the gate held; the `after` gate hands the result to
 * the session's detectors; and nothing changes under a 0.5 debugger, with
 * edits disabled, or detached.
 */
import { jsonSchema, simulateReadableStream, stepCountIs, streamText, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AfterGateContext, GateDetector, Session } from '@graphmind-ai/client';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions, type ReceivedFrame } from './helpers/fake-viewer.js';
import { attach, runScenario, Marks } from './helpers/scenario.js';
import { MockLanguageModel, toolExecutionOptions, type StreamPart, type Usage } from './helpers/sdk-compat.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const EDIT_HUB = ['edit-input'];
const TOOL_EVERYWHERE = [
  { kind: 'tool' as const },
  { kind: 'tool' as const, point: 'after' as const },
  { kind: 'tool' as const, point: 'error' as const },
];

async function setup(
  viewerOptions: FakeViewerOptions = {},
  gmOptions: Partial<GraphmindOptions> = {},
): Promise<{ viewer: FakeViewer; gm: Graphmind; warnings: string[] }> {
  const viewer = await FakeViewer.start({ hubCapabilities: EDIT_HUB, ...viewerOptions });
  const warnings: string[] = [];
  const gm = graphmind({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    env: {},
    logger: (message) => warnings.push(message),
    ...gmOptions,
  });
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  await attach(gm);
  return { viewer, gm, warnings };
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

function refusalsFor(viewer: FakeViewer, pauseId: string): ReceivedFrame[] {
  return viewer.ofType('exec.refused').filter((f) => f.payload['pauseId'] === pauseId);
}

/** The exec.resumed that released `pauseId` (it may land after the tool's promise settles). */
function resumedFor(viewer: FakeViewer, pauseId: string): Promise<ReceivedFrame> {
  return viewer.waitFor((f) => f.type === 'exec.resumed' && f.payload['pauseId'] === pauseId);
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

/** A convertCurrency tool that records every argument object it ran with. */
function currencyTool(calls: unknown[], throwsFor?: (args: { amount: number; from: string; to: string }) => boolean) {
  return tool({
    description: 'Convert an amount between currencies',
    inputSchema: z.object({ amount: z.number().max(10_000), from: z.string(), to: z.string() }),
    execute: async (args) => {
      calls.push(args);
      if (throwsFor?.(args) === true) throw new Error('FX rate service returned HTTP 500');
      return { converted: Math.round(args.amount * 0.9 * 100) / 100, currency: args.to };
    },
  });
}

describe('continue + input at the before gate', () => {
  it('end to end: the real tool runs with the merged arguments and the next step sees its output', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    const marks = new Marks();
    const promise = runScenario(gm, {}, marks);

    const paused = await pausedAt(viewer, 'tool:searchFlights', 'before');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { to: 'OPO' }, requestId: 'r-1' });

    const result = await promise;
    expect(result.runError).toBeUndefined();
    // The next model step received the edited call's real output.
    expect(result.text).toContain('"to":"OPO"');
    expect(result.text).not.toContain('"to":"LIS"');

    // The model's request stays on node.started; what ran is on exec.resumed.
    const started = viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:searchFlights');
    expect(started?.payload['input']).toEqual({ from: 'VIE', to: 'LIS' });
    const resumed = await resumedFor(viewer, pauseIdOf(paused));
    expect(resumed?.payload['edited']).toEqual({ after: { from: 'VIE', to: 'OPO' } });
    expect(resumed?.payload['requestId']).toBe('r-1');
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights');
    expect(finished?.payload['status']).toBe('ok');
    expect(finished?.payload['output']).toEqual({ flights: [{ id: 'TP1234', from: 'VIE', to: 'OPO', priceEUR: 199 }] });
  });

  it('a schema-invalid edit is refused (code schema, no value quoted), the gate stays held, then a valid edit runs', async () => {
    const { viewer, gm } = await setup({ breakpoints: TOOL_EVERYWHERE.slice(0, 1) });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls) });
    const promise = tools.convertCurrency.execute?.({ amount: 100, from: 'EUR', to: 'USD' }, toolExecutionOptions('c1'));

    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'before');
    const pauseId = pauseIdOf(paused);
    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 'SECRET-VALUE-42' } });
    await waitUntil(() => refusalsFor(viewer, pauseId).length === 1, 8000, 'refusal 1');
    const refused = refusalsFor(viewer, pauseId)[0] as ReceivedFrame;
    expect(refused.payload['code']).toBe('schema');
    expect(String(refused.payload['message'])).toContain('amount');
    expect(JSON.stringify(refused.payload)).not.toContain('SECRET-VALUE-42');

    // A bound the schema sets is named, the value is not.
    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 987654 } });
    await waitUntil(() => refusalsFor(viewer, pauseId).length === 2, 8000, 'refusal 2');
    const second = refusalsFor(viewer, pauseId)[1] as ReceivedFrame;
    expect(second.payload['code']).toBe('schema');
    expect(String(second.payload['message'])).toMatch(/amount.*10000/);
    expect(JSON.stringify(second.payload)).not.toContain('987654');

    expect(calls).toHaveLength(0);
    expect(await settledWithin(promise as Promise<unknown>, 50)).toBe('pending');

    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 250 } });
    expect(await promise).toEqual({ converted: 225, currency: 'USD' });
    expect(calls).toEqual([{ amount: 250, from: 'EUR', to: 'USD' }]);
    expect(viewer.ofType('exec.paused').filter((f) => f.payload['nodeId'] === 'tool:convertCurrency')).toHaveLength(1);
  });

  it('after a refused edit a plain continue runs the model arguments', async () => {
    const { viewer, gm } = await setup({ breakpoints: TOOL_EVERYWHERE.slice(0, 1) });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls) });
    const promise = tools.convertCurrency.execute?.({ amount: 100, from: 'EUR', to: 'USD' }, toolExecutionOptions('c1'));

    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { to: 7 } });
    await waitUntil(() => refusalsFor(viewer, pauseId).length === 1, 8000, 'refusal');
    viewer.resume(pauseId, 'continue');
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([{ amount: 100, from: 'EUR', to: 'USD' }]);
    expect((await resumedFor(viewer, pauseId)).payload['edited']).toBeUndefined();
  });

  it('the schema PARSES the edit: the tool receives the parsed value, unmentioned keys keep their live values', async () => {
    const { viewer, gm } = await setup({ breakpoints: TOOL_EVERYWHERE.slice(0, 1) });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({
      search: tool({
        description: 'search',
        inputSchema: z.object({ query: z.string().trim(), limit: z.number(), page: z.number().default(1) }),
        execute: async (args) => {
          calls.push(args);
          return 'ok';
        },
      }),
    });
    const promise = tools.search.execute?.({ query: 'a', limit: 3, page: 1 }, toolExecutionOptions('c1'));
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:search', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: '  b  ' } });
    expect(await promise).toBe('ok');
    expect(calls).toEqual([{ query: 'b', limit: 3, page: 1 }]);
    // The record shows what ran: the parsed value.
    expect((await resumedFor(viewer, pauseId)).payload['edited']).toEqual({ after: { query: 'b', limit: 3, page: 1 } });
  });
});

describe('retry + input at the error and after gates', () => {
  it('retry + input at the error gate re-runs the real tool with the fixed arguments', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls, (args) => args.from === 'XXX') });
    const promise = tools.convertCurrency.execute?.({ amount: 100, from: 'XXX', to: 'USD' }, toolExecutionOptions('c1'));

    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'error');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { from: 'EUR' } });
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([
      { amount: 100, from: 'XXX', to: 'USD' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
    expect((await resumedFor(viewer, pauseIdOf(paused))).payload['edited']).toEqual({
      after: { amount: 100, from: 'EUR', to: 'USD' },
    });
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:convertCurrency');
    expect(finished?.payload['status']).toBe('ok');
    expect(finished?.payload['output']).toEqual({ converted: 90, currency: 'USD' });
    expect(viewer.ofType('node.started').filter((f) => f.payload['nodeId'] === 'tool:convertCurrency')).toHaveLength(1);
  });

  it('continue + input at the error gate is refused (shape): the gate stays held', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls, (args) => args.from === 'XXX') });
    const promise = tools.convertCurrency.execute?.({ amount: 100, from: 'XXX', to: 'USD' }, toolExecutionOptions('c1'));
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'error'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { from: 'EUR' } });
    await waitUntil(() => refusalsFor(viewer, pauseId).length === 1, 8000, 'refusal');
    expect(refusalsFor(viewer, pauseId)[0]?.payload['code']).toBe('shape');
    viewer.resume(pauseId, 'continue');
    await expect(promise).rejects.toThrow('HTTP 500');
    expect(calls).toHaveLength(1);
  });

  it('retry without input behaves as before: the same arguments run again', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const calls: unknown[] = [];
    let attempts = 0;
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls, () => (attempts += 1) === 1) });
    const promise = tools.convertCurrency.execute?.({ amount: 100, from: 'EUR', to: 'USD' }, toolExecutionOptions('c1'));
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'error');
    viewer.resume(pauseIdOf(paused), 'retry');
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([
      { amount: 100, from: 'EUR', to: 'USD' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
    expect((await resumedFor(viewer, pauseIdOf(paused))).payload['edited']).toBeUndefined();
  });

  it('the after gate hands the result to the detectors; retry + input there re-runs with the edit', async () => {
    const { viewer, gm } = await setup();
    const seen: AfterGateContext[] = [];
    detectorsOf(gm.session).push((context) => {
      seen.push(context);
      const result = context.result as { currency?: string };
      return result.currency === 'XXX' ? { rule: 'error-result', detail: 'unknown currency' } : undefined;
    });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls) });
    const promise = tools.convertCurrency.execute?.({ amount: 100, from: 'EUR', to: 'XXX' }, toolExecutionOptions('c1'));

    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'after');
    expect(paused.payload['reason']).toBe('breakpoint');
    expect(paused.payload['smart']).toEqual({ rule: 'error-result', detail: 'unknown currency' });
    expect(paused.payload['editable']).toBe(true);
    expect(seen[0]?.node).toEqual({ nodeId: 'tool:convertCurrency', kind: 'tool', name: 'convertCurrency' });
    expect(seen[0]?.result).toEqual({ converted: 90, currency: 'XXX' });

    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { to: 'USD' } });
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([
      { amount: 100, from: 'EUR', to: 'XXX' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
    expect(seen.map((context) => context.result)).toEqual([
      { converted: 90, currency: 'XXX' },
      { converted: 90, currency: 'USD' },
    ]);
  });
});

describe('nothing changes without edit support', () => {
  it('a 0.5 debugger (no hubCapabilities): no editable flag, an edit is refused, continue runs the model arguments', async () => {
    const { viewer, gm } = await setup({ hubCapabilities: undefined, breakpoints: TOOL_EVERYWHERE.slice(0, 1) });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls) });
    const promise = tools.convertCurrency.execute?.({ amount: 100, from: 'EUR', to: 'USD' }, toolExecutionOptions('c1'));
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'before');
    // No `editable`; `reason` is on every hold since 0.6.0 (a 0.5 hub accepts all four values).
    expect(paused.payload).toEqual({
      pauseId: pauseIdOf(paused),
      nodeId: 'tool:convertCurrency',
      point: 'before',
      reason: 'breakpoint',
    });
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { amount: 5 } });
    await waitUntil(() => refusalsFor(viewer, pauseIdOf(paused)).length === 1, 8000, 'refusal');
    expect(refusalsFor(viewer, pauseIdOf(paused))[0]?.payload['code']).toBe('disabled');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([{ amount: 100, from: 'EUR', to: 'USD' }]);
  });

  it('GRAPHMIND_DISABLE_EDIT_INPUT: no editable flag, an edit is refused (disabled)', async () => {
    const { viewer, gm } = await setup(
      { breakpoints: TOOL_EVERYWHERE.slice(0, 1) },
      { env: { GRAPHMIND_DISABLE_EDIT_INPUT: 'yes' } },
    );
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls) });
    const promise = tools.convertCurrency.execute?.({ amount: 100, from: 'EUR', to: 'USD' }, toolExecutionOptions('c1'));
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { amount: 5 } });
    await waitUntil(() => refusalsFor(viewer, pauseIdOf(paused)).length === 1, 8000, 'refusal');
    expect(refusalsFor(viewer, pauseIdOf(paused))[0]?.payload['code']).toBe('disabled');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([{ amount: 100, from: 'EUR', to: 'USD' }]);
  });

  it('detached: every gate is called exactly as in 0.5 (no options) and the tool runs the model arguments', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, env: {}, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const gate = vi.spyOn(gm.session, 'gate');
    const calls: unknown[] = [];
    let attempts = 0;
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls, () => (attempts += 1) === 1) });
    // First call throws (error gate), second succeeds (before + after gates).
    await expect(
      tools.convertCurrency.execute?.({ amount: 1, from: 'EUR', to: 'USD' }, toolExecutionOptions('c1')),
    ).rejects.toThrow('HTTP 500');
    expect(await tools.convertCurrency.execute?.({ amount: 1, from: 'EUR', to: 'USD' }, toolExecutionOptions('c2'))).toEqual({
      converted: 0.9,
      currency: 'USD',
    });
    expect(gm.session.attached).toBe(false);
    expect(gate.mock.calls.map((call) => call[0])).toEqual(['before', 'error', 'before', 'after']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
    expect(calls).toEqual([
      { amount: 1, from: 'EUR', to: 'USD' },
      { amount: 1, from: 'EUR', to: 'USD' },
    ]);
  });

  it('LLM gates are not editable', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'llm' }] });
    const promise = runScenario(gm);
    const llm = await pausedAt(viewer, 'llm:step', 'before');
    expect(llm.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(llm), action: 'continue', input: { prompt: [] } });
    await waitUntil(() => refusalsFor(viewer, pauseIdOf(llm)).length === 1, 8000, 'refusal');
    expect(refusalsFor(viewer, pauseIdOf(llm))[0]?.payload['code']).toBe('unsupported');
    viewer.sendControl('breakpoint.clear', { matcher: { kind: 'llm' } });
    viewer.resume(pauseIdOf(llm), 'continue');
    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);
  });
});

describe('edge cases', () => {
  it('a tool whose arguments are not an object is not editable; continue still works', async () => {
    const { viewer, gm } = await setup({ breakpoints: TOOL_EVERYWHERE.slice(0, 1) });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({
      echo: tool({
        description: 'echo',
        inputSchema: z.string(),
        execute: async (text) => {
          calls.push(text);
          return text.toUpperCase();
        },
      }),
    });
    const promise = tools.echo.execute?.('hello', toolExecutionOptions('c1'));
    const paused = await pausedAt(viewer, 'tool:echo', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { text: 'bye' } });
    await waitUntil(() => refusalsFor(viewer, pauseIdOf(paused)).length === 1, 8000, 'refusal');
    expect(refusalsFor(viewer, pauseIdOf(paused))[0]?.payload['code']).toBe('unsupported');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await promise).toBe('HELLO');
    expect(calls).toEqual(['hello']);
  });

  it('a JSON-schema tool without a validator accepts the merged edit as it is, and says so once', async () => {
    const { viewer, gm, warnings } = await setup({ breakpoints: TOOL_EVERYWHERE.slice(0, 1) });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({
      lookup: tool({
        description: 'lookup',
        inputSchema: jsonSchema<{ id: string; verbose?: boolean }>({
          type: 'object',
          properties: { id: { type: 'string' }, verbose: { type: 'boolean' } },
          required: ['id'],
        }),
        execute: async (args) => {
          calls.push(args);
          return 'found';
        },
      }),
    });
    const promise = tools.lookup.execute?.({ id: 'a1' }, toolExecutionOptions('c1'));
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:lookup', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { verbose: 'very' } });
    expect(await promise).toBe('found');
    expect(calls).toEqual([{ id: 'a1', verbose: 'very' }]);
    expect(warnings.filter((w) => w.includes('without a schema check'))).toHaveLength(1);
  });

  it('parallel calls: editing one of two held gates leaves the other on its own arguments', async () => {
    const { viewer, gm } = await setup({ breakpoints: TOOL_EVERYWHERE.slice(0, 1) });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currencyTool(calls) });
    const first = tools.convertCurrency.execute?.({ amount: 10, from: 'EUR', to: 'USD' }, toolExecutionOptions('c1'));
    const second = tools.convertCurrency.execute?.({ amount: 20, from: 'EUR', to: 'GBP' }, toolExecutionOptions('c2'));
    const a = await pausedAt(viewer, 'tool:convertCurrency', 'before', 1);
    const b = await pausedAt(viewer, 'tool:convertCurrency', 'before', 2);
    viewer.resumeWith({ pauseId: pauseIdOf(b), action: 'continue', input: { to: 'JPY' } });
    expect(await second).toEqual({ converted: 18, currency: 'JPY' });
    expect(await settledWithin(first as Promise<unknown>, 50)).toBe('pending');
    viewer.resume(pauseIdOf(a), 'continue');
    expect(await first).toEqual({ converted: 9, currency: 'USD' });
    expect(calls).toEqual([
      { amount: 20, from: 'EUR', to: 'JPY' },
      { amount: 10, from: 'EUR', to: 'USD' },
    ]);
  });

  it('a streaming tool can be edited at its before gate', async () => {
    const { viewer, gm } = await setup({ breakpoints: TOOL_EVERYWHERE.slice(0, 1) });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({
      count: tool({
        description: 'count up',
        inputSchema: z.object({ to: z.number().int().min(1) }),
        async *execute({ to }) {
          calls.push({ to });
          for (let i = 1; i <= to; i += 1) yield i;
        },
      }),
    });
    const iterable = tools.count.execute?.({ to: 2 }, toolExecutionOptions('c1')) as unknown as AsyncIterable<number>;
    const collected: number[] = [];
    const drained = (async () => {
      for await (const value of iterable) collected.push(value);
    })();
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:count', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { to: 0 } });
    await waitUntil(() => refusalsFor(viewer, pauseId).length === 1, 8000, 'refusal');
    expect(refusalsFor(viewer, pauseId)[0]?.payload['code']).toBe('schema');
    viewer.resumeWith({ pauseId, action: 'continue', input: { to: 3 } });
    await drained;
    expect(collected).toEqual([1, 2, 3]);
    expect(calls).toEqual([{ to: 3 }]);
  });
});

describe("an accepted edit never runs the schema's transforms twice", () => {
  const usage: Usage = {
    inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 10, text: 10, reasoning: undefined },
  };

  /** Step 0 calls `toolName` with `input`; step 1 answers with plain text. */
  function mockModel(toolName: string, input: unknown): InstanceType<typeof MockLanguageModel> {
    let call = 0;
    return new MockLanguageModel({
      doStream: async () => {
        const index = call++;
        const parts: StreamPart[] =
          index === 0
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
                { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: 'done' },
                { type: 'text-end', id: 't' },
                { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
              ];
        return { stream: simulateReadableStream<StreamPart>({ chunks: parts, initialDelayInMs: 1, chunkDelayInMs: 1 }) };
      },
    }) as InstanceType<typeof MockLanguageModel>;
  }

  async function run(gm: Graphmind, tools: Parameters<Graphmind['wrapTools']>[0], toolName: string, input: unknown) {
    const result = streamText({
      model: gm.wrapModel(mockModel(toolName, input)),
      tools: gm.wrapTools(tools),
      prompt: 'charge the customer',
      stopWhen: stepCountIs(3),
    });
    await result.consumeStream();
  }

  /** dollars -> cents: NOT idempotent (applying it twice multiplies by 10 000). */
  function chargeTool(calls: unknown[]) {
    return tool({
      description: 'Charge the customer',
      inputSchema: z.object({ dollars: z.number().transform((d) => d * 100), memo: z.string() }),
      execute: async (args) => {
        calls.push(args);
        return { chargedCents: args.dollars };
      },
    });
  }

  it('baseline (no hold): execute receives the transform applied once', async () => {
    const { gm } = await setup();
    const calls: unknown[] = [];
    await gm.run('baseline', () => run(gm, { charge: chargeTool(calls) }, 'charge', { dollars: 5, memo: 'x' }));
    expect(calls).toEqual([{ dollars: 500, memo: 'x' }]);
  });

  it('continue + input {memo} leaves dollars at 500 cents (the model sent 5 dollars)', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool' }] });
    const calls: unknown[] = [];
    const done = gm.run('edited', () => run(gm, { charge: chargeTool(calls) }, 'charge', { dollars: 5, memo: 'x' }));
    const paused = await pausedAt(viewer, 'tool:charge', 'before');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { memo: 'fixed memo' } });
    await done;
    // The user only changed `memo`: `dollars` is what it is with no edit.
    expect(calls).toEqual([{ dollars: 500, memo: 'fixed memo' }]);
    expect((await resumedFor(viewer, pauseIdOf(paused))).payload['edited']).toEqual({
      after: { dollars: 500, memo: 'fixed memo' },
    });
  });

  it('a type-changing transform: editing an untouched sibling key is not refused', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool' }] });
    const calls: unknown[] = [];
    const tools = {
      lookup: tool({
        description: 'Look up an order',
        // string -> number: the parsed value no longer satisfies the INPUT schema.
        inputSchema: z.object({ orderId: z.string().transform((s) => Number.parseInt(s, 10)), note: z.string() }),
        execute: async (args) => {
          calls.push(args);
          return 'ok';
        },
      }),
    };
    const done = gm.run('typed', () => run(gm, tools, 'lookup', { orderId: '42', note: 'a' }));
    const paused = await pausedAt(viewer, 'tool:lookup', 'before');
    const pauseId = pauseIdOf(paused);
    viewer.resumeWith({ pauseId, action: 'continue', input: { note: 'b' } });
    await viewer.waitFor((f) => (f.type === 'exec.refused' || f.type === 'exec.resumed') && f.payload['pauseId'] === pauseId);
    const refusals = refusalsFor(viewer, pauseId);
    if (refusals.length > 0) viewer.resume(pauseId, 'continue'); // unblock the run either way
    await done;
    expect(refusals.map((f) => f.payload['code'])).toEqual([]);
    expect(calls).toEqual([{ orderId: 42, note: 'b' }]);
  });

  it('a retry after an accepted edit merges into the edited arguments, still parsing once', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool' }, { kind: 'tool', point: 'after' }] });
    const calls: unknown[] = [];
    const done = gm.run('twice', () => run(gm, { charge: chargeTool(calls) }, 'charge', { dollars: 5, memo: 'x' }));
    viewer.resumeWith({ pauseId: pauseIdOf(await pausedAt(viewer, 'tool:charge', 'before')), action: 'continue', input: { memo: 'm1' } });
    viewer.resumeWith({ pauseId: pauseIdOf(await pausedAt(viewer, 'tool:charge', 'after')), action: 'retry', input: { memo: 'm2' } });
    viewer.resume(pauseIdOf(await pausedAt(viewer, 'tool:charge', 'before', 2)), 'continue');
    viewer.resume(pauseIdOf(await pausedAt(viewer, 'tool:charge', 'after', 2)), 'continue');
    await done;
    expect(calls).toEqual([
      { dollars: 500, memo: 'm1' },
      { dollars: 500, memo: 'm2' },
    ]);
  });

  it("without the model's own arguments (tools wrapped alone) a partial edit of a transformed call is refused, a full one runs", async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool' }] });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ charge: chargeTool(calls) });
    // What the SDK hands execute: the PARSED arguments (5 dollars -> 500).
    const promise = tools.charge.execute?.({ dollars: 500, memo: 'x' } as never, toolExecutionOptions('c1'));
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:charge', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { memo: 'y' } });
    await waitUntil(() => refusalsFor(viewer, pauseId).length === 1, 8000, 'refusal');
    expect(refusalsFor(viewer, pauseId)[0]?.payload).toMatchObject({ code: 'unsupported' });
    // Every argument given: parsed once, from what the user wrote.
    viewer.resumeWith({ pauseId, action: 'continue', input: { dollars: 7, memo: 'y' } });
    await promise;
    expect(calls).toEqual([{ dollars: 700, memo: 'y' }]);
  });
});

