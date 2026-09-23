/**
 * Edited tool arguments (0.6.0, contract C2 / W2) through the LangGraph tool
 * wrappers (`wrapStructuredTool`, `gm.tool`): `continue` + input at `before`
 * and `retry` + input at `after` / `error` run the REAL function with the
 * merged input, checked by the tool's own zod `schema` when it has one (a
 * refusal keeps the gate held); a `ToolCall` handed to a class-based tool
 * keeps its id; the `after` gate hands the result to the session's detectors;
 * nothing changes under a 0.5 debugger, with edits disabled, or detached.
 */
import { StructuredTool, tool } from '@langchain/core/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AfterGateContext, GateDetector, Session } from '@graphmind-ai/client';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions, type ReceivedFrame } from './helpers/fake-viewer.js';
import { attach, buildGraph } from './helpers/graph.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const EDIT_HUB = ['edit-input'];
const BEFORE = [{ kind: 'tool' as const }];

async function setup(
  viewerOptions: FakeViewerOptions = {},
  gmOptions: Partial<GraphmindOptions> = {},
): Promise<{ viewer: FakeViewer; gm: Graphmind }> {
  const viewer = await FakeViewer.start({ hubCapabilities: EDIT_HUB, ...viewerOptions });
  const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {}, logger: () => {}, ...gmOptions });
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  await attach(gm);
  return { viewer, gm };
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

async function settledWithin<T>(promise: PromiseLike<T> | T, ms: number): Promise<T | 'pending'> {
  return await Promise.race([Promise.resolve(promise), tick(ms).then(() => 'pending' as const)]);
}

const content = (value: unknown): string => String((value as { content?: unknown } | null)?.content ?? value);

interface Currency {
  amount: number;
  from: string;
  to: string;
}

/** A LangChain `tool()` with a zod schema that records every input it ran with. */
function currencyTool(calls: unknown[], throwsFor?: (args: Currency) => boolean) {
  return tool(
    async (args: Currency) => {
      calls.push(args);
      if (throwsFor?.(args) === true) throw new Error('FX rate service returned HTTP 500');
      return JSON.stringify({ converted: Math.round(args.amount * 0.9 * 100) / 100, currency: args.to });
    },
    {
      name: 'convertCurrency',
      description: 'Convert an amount between currencies',
      schema: z.object({ amount: z.number().max(10_000), from: z.string().trim(), to: z.string() }),
    },
  );
}

/** A plain function for `gm.tool`. */
function currencyFn(calls: unknown[], throwsFor?: (args: Currency) => boolean) {
  return async (args: Currency) => {
    calls.push(args);
    if (throwsFor?.(args) === true) throw new Error('FX rate service returned HTTP 500');
    return { converted: Math.round(args.amount * 0.9 * 100) / 100, currency: args.to };
  };
}

describe('continue + input at the before gate', () => {
  it('end to end through a compiled graph (handler attached): the real tool runs with the merged input', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    const { graph } = buildGraph(gm, { wrapTools: true });
    const promise = graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler()] });

    const paused = await pausedAt(viewer, 'tool:searchFlights', 'before');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { to: 'OPO' } });

    const result = await promise;
    expect(result.findings.join()).toContain('"to":"OPO"');
    expect(result.findings.join()).not.toContain('"to":"LIS"');
    expect((await resumedFor(viewer, pauseIdOf(paused))).payload['edited']).toEqual({ after: { from: 'VIE', to: 'OPO' } });
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    const started = viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:searchFlights');
    expect(JSON.stringify(started?.payload['input'])).toContain('LIS');
  });

  it('the zod schema refuses a bad edit (code schema, no value quoted), the gate stays held, then parses a good one', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const wrapped = gm.wrapStructuredTool(currencyTool(calls));
    const promise = wrapped.invoke({ amount: 100, from: 'EUR', to: 'USD' });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'before'));

    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 'SECRET-VALUE-42' } });
    const refused = await refusal(viewer, pauseId);
    expect(refused.payload['code']).toBe('schema');
    expect(String(refused.payload['message'])).toMatch(/field "amount" must be number, got string/);
    expect(JSON.stringify(refused.payload)).not.toContain('SECRET-VALUE-42');
    expect(calls).toHaveLength(0);
    expect(await settledWithin(promise, 50)).toBe('pending');

    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 250, from: '  GBP  ' } });
    expect(content(await promise)).toBe('{"converted":225,"currency":"USD"}');
    // The schema's parsed value ran (trimmed), and is what the record shows.
    expect(calls).toEqual([{ amount: 250, from: 'GBP', to: 'USD' }]);
    expect((await resumedFor(viewer, pauseId)).payload['edited']).toEqual({ after: { amount: 250, from: 'GBP', to: 'USD' } });
  });

  it('a gm.tool function (no schema) runs the merged input as it is', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const fn = gm.tool('convertCurrency', currencyFn(calls));
    const promise = fn({ amount: 100, from: 'EUR', to: 'USD' });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { to: 'JPY', note: 'extra keys pass' } });
    expect(await promise).toEqual({ converted: 90, currency: 'JPY' });
    expect(calls).toEqual([{ amount: 100, from: 'EUR', to: 'JPY', note: 'extra keys pass' }]);
  });

  it('a class-based tool invoked with a ToolCall has its args edited and keeps the call id', async () => {
    const calls: unknown[] = [];
    class Lookup extends StructuredTool {
      name = 'lookup';
      description = 'look something up';
      schema = z.object({ id: z.string(), verbose: z.boolean().default(false) });
      async _call(args: { id: string; verbose: boolean }): Promise<string> {
        calls.push(args);
        return `found:${args.id}:${String(args.verbose)}`;
      }
    }
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const wrapped = gm.wrapStructuredTool(new Lookup());
    const call = { name: 'lookup', args: { id: 'a1' }, id: 'call_77', type: 'tool_call' as const };
    const promise = wrapped.invoke(call);
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:lookup', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { verbose: 'yes' } });
    expect((await refusal(viewer, pauseId)).payload['code']).toBe('schema');
    viewer.resumeWith({ pauseId, action: 'continue', input: { id: 'b2' } });
    const message = (await promise) as { content?: unknown; tool_call_id?: unknown };
    expect(message.content).toBe('found:b2:false');
    expect(message.tool_call_id).toBe('call_77');
    expect(calls).toEqual([{ id: 'b2', verbose: false }]);
  });
});

describe('retry + input at the error and after gates', () => {
  it('retry + input at the error gate fixes a throwing call', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const calls: unknown[] = [];
    const wrapped = gm.wrapStructuredTool(currencyTool(calls, (args) => args.from === 'XXX'));
    const promise = wrapped.invoke({ amount: 100, from: 'XXX', to: 'USD' });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'error');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { from: 'EUR' } });
    expect(content(await promise)).toBe('{"converted":90,"currency":"USD"}');
    expect(calls).toEqual([
      { amount: 100, from: 'XXX', to: 'USD' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
  });

  it('retry without input re-runs the same input, as before', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const calls: unknown[] = [];
    let attempts = 0;
    const fn = gm.tool('convertCurrency', currencyFn(calls, () => (attempts += 1) === 1));
    const promise = fn({ amount: 100, from: 'EUR', to: 'USD' });
    viewer.resume(pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'error')), 'retry');
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it('the after gate hands the result to the detectors; retry + input there re-runs with the edit', async () => {
    const { viewer, gm } = await setup();
    const seen: AfterGateContext[] = [];
    detectorsOf(gm.session).push((context) => {
      seen.push(context);
      return (context.result as { currency?: string }).currency === 'XXX' ? { rule: 'error-result' } : undefined;
    });
    const calls: unknown[] = [];
    const fn = gm.tool('convertCurrency', currencyFn(calls));
    const promise = fn({ amount: 100, from: 'EUR', to: 'XXX' });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'after');
    expect(paused.payload['smart']).toEqual({ rule: 'error-result' });
    expect(paused.payload['editable']).toBe(true);
    expect(seen[0]?.node).toEqual({ nodeId: 'tool:convertCurrency', kind: 'tool', name: 'convertCurrency' });
    expect(seen[0]?.result).toEqual({ converted: 90, currency: 'XXX' });
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { to: 'USD' } });
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([
      { amount: 100, from: 'EUR', to: 'XXX' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
  });
});

describe('nothing changes without edit support', () => {
  it('a 0.5 debugger: no editable flag, the edit is refused (disabled), continue runs the model input', async () => {
    const { viewer, gm } = await setup({ hubCapabilities: undefined, breakpoints: BEFORE });
    const calls: unknown[] = [];
    const wrapped = gm.wrapStructuredTool(currencyTool(calls));
    const promise = wrapped.invoke({ amount: 100, from: 'EUR', to: 'USD' });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { amount: 1 } });
    expect((await refusal(viewer, pauseIdOf(paused))).payload['code']).toBe('disabled');
    viewer.resume(pauseIdOf(paused), 'continue');
    await promise;
    expect(calls).toEqual([{ amount: 100, from: 'EUR', to: 'USD' }]);
  });

  it('GRAPHMIND_DISABLE_EDIT_INPUT: no editable flag, the edit is refused (disabled)', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE }, { env: { GRAPHMIND_DISABLE_EDIT_INPUT: 'true' } });
    const calls: unknown[] = [];
    const fn = gm.tool('convertCurrency', currencyFn(calls));
    const promise = fn({ amount: 100, from: 'EUR', to: 'USD' });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { amount: 1 } });
    expect((await refusal(viewer, pauseIdOf(paused))).payload['code']).toBe('disabled');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
  });

  it('detached: every gate is called exactly as in 0.5 (no options)', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, env: {}, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const gate = vi.spyOn(gm.session, 'gate');
    let attempts = 0;
    const fn = gm.tool('convertCurrency', currencyFn([], () => (attempts += 1) === 1));
    await expect(fn({ amount: 1, from: 'EUR', to: 'USD' })).rejects.toThrow('HTTP 500');
    expect(await fn({ amount: 1, from: 'EUR', to: 'USD' })).toEqual({ converted: 0.9, currency: 'USD' });
    expect(gate.mock.calls.map((call) => call[0])).toEqual(['before', 'error', 'before', 'after']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
  });
});

describe('edge cases', () => {
  it('a string-input tool is not editable; continue still works', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const fn = gm.tool('shout', async (text: string) => text.toUpperCase());
    const promise = fn('hello');
    const paused = await pausedAt(viewer, 'tool:shout', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { text: 'bye' } });
    expect((await refusal(viewer, pauseIdOf(paused))).payload['code']).toBe('unsupported');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await promise).toBe('HELLO');
  });

  it('parallel calls: editing one of two held gates leaves the other on its own input', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const fn = gm.tool('convertCurrency', currencyFn(calls));
    const first = fn({ amount: 10, from: 'EUR', to: 'USD' });
    const second = fn({ amount: 20, from: 'EUR', to: 'GBP' });
    const a = await pausedAt(viewer, 'tool:convertCurrency', 'before', 1);
    const b = await pausedAt(viewer, 'tool:convertCurrency', 'before', 2);
    viewer.resumeWith({ pauseId: pauseIdOf(a), action: 'continue', input: { to: 'JPY' } });
    expect(await first).toEqual({ converted: 9, currency: 'JPY' });
    expect(await settledWithin(second, 50)).toBe('pending');
    viewer.resume(pauseIdOf(b), 'continue');
    expect(await second).toEqual({ converted: 18, currency: 'GBP' });
    expect(calls).toEqual([
      { amount: 10, from: 'EUR', to: 'JPY' },
      { amount: 20, from: 'EUR', to: 'GBP' },
    ]);
  });
});
