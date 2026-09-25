/**
 * Edited tool arguments (0.6.0, contract C2 / W2) through the OpenAI tool
 * wrapper: `continue` + input at `before` and `retry` + input at `after` /
 * `error` call the REAL function with the merged arguments (as an object, or
 * as JSON text when that is how they came); a tool object's own schema
 * (JSON Schema via the lite checker, or zod) refuses a bad edit with the gate
 * still held; the `after` gate hands the result to the session's detectors;
 * nothing changes under a 0.5 debugger, with edits disabled, or detached.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AfterGateContext, GateDetector, Session } from '@graphmind-ai/client';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeOpenAI } from './helpers/fake-openai.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions, type ReceivedFrame } from './helpers/fake-viewer.js';
import { attach, Marks, runChatScenario, scriptChatTurns } from './helpers/scenario.js';
import { setup as rigSetup } from './helpers/setup.js';

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

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

interface Currency {
  amount: number;
  from: string;
  to: string;
}

function currency(calls: unknown[], throwsFor?: (args: Currency) => boolean) {
  return async (args: Currency) => {
    calls.push(args);
    if (throwsFor?.(args) === true) throw new Error('FX rate service returned HTTP 500');
    return { converted: Math.round(args.amount * 0.9 * 100) / 100, currency: args.to };
  };
}

const CURRENCY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: 'number', maximum: 10_000 },
    from: { type: 'string', enum: ['EUR', 'USD', 'GBP'] },
    to: { type: 'string' },
  },
  required: ['amount', 'from', 'to'],
  additionalProperties: false,
};

describe('continue + input at the before gate', () => {
  it('end to end: the real function runs with the merged arguments and the next turn sees its output', async () => {
    const marks = new Marks();
    const server = new FakeOpenAI().onChat(scriptChatTurns(marks, false));
    const rig = await rigSetup(
      server,
      { hubCapabilities: EDIT_HUB, breakpoints: [{ kind: 'tool', name: 'searchFlights' }] },
      { env: {} },
      cleanups,
    );
    await attach(rig.gm);
    const promise = runChatScenario(rig.gm, rig.client, server, {}, marks);

    const paused = await pausedAt(rig.viewer, 'tool:searchFlights', 'before');
    expect(paused.payload['editable']).toBe(true);
    rig.viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { to: 'OPO' } });

    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.text).toContain('"to":"OPO"');
    const started = rig.viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:searchFlights');
    expect(started?.payload['input']).toEqual({ from: 'VIE', to: 'LIS' });
    expect((await resumedFor(rig.viewer, pauseIdOf(paused))).payload['edited']).toEqual({ after: { from: 'VIE', to: 'OPO' } });
  });

  it('arguments that came as JSON text are handed back as JSON text', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const received: unknown[] = [];
    const tools = gm.wrapTools({
      lookup: async (raw: string, call: unknown) => {
        received.push(raw, call);
        return JSON.parse(raw) as unknown;
      },
    });
    const call = { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"id":"a1","verbose":false}' } };
    const promise = tools.lookup(call.function.arguments, call);
    const paused = await pausedAt(viewer, 'tool:lookup', 'before');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { verbose: true } });
    expect(await promise).toEqual({ id: 'a1', verbose: true });
    expect(received).toEqual(['{"id":"a1","verbose":true}', call]);
  });

  it("a tool object's JSON Schema refuses a bad edit (code schema, no value quoted); the gate stays held", async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({
      convertCurrency: { type: 'function', parameters: CURRENCY_JSON_SCHEMA, execute: currency(calls) },
    });
    const promise = tools.convertCurrency.execute({ amount: 100, from: 'EUR', to: 'USD' });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'before'));

    const cases: [unknown, RegExp][] = [
      [{ amount: 'SECRET-VALUE-42' }, /field "amount" must be number, got string/],
      [{ from: 'SECRETCOIN' }, /field "from" is not one of the allowed values/],
      [{ amount: 123456 }, /field "amount" must be at most 10000/],
      [{ notes: 'SECRET-NOTE' }, /field "notes" is not a parameter of this tool/],
    ];
    for (const [index, [input, message]] of cases.entries()) {
      viewer.resumeWith({ pauseId, action: 'continue', input });
      const refused = await refusal(viewer, pauseId, index + 1);
      expect(refused.payload['code']).toBe('schema');
      expect(String(refused.payload['message'])).toMatch(message);
      expect(JSON.stringify(refused.payload)).not.toMatch(/SECRET|123456/);
    }
    expect(calls).toHaveLength(0);
    expect(await settledWithin(promise, 50)).toBe('pending');

    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 250, from: 'GBP' } });
    expect(await promise).toEqual({ converted: 225, currency: 'USD' });
    expect(calls).toEqual([{ amount: 250, from: 'GBP', to: 'USD' }]);
  });

  it("a tool object's zod parameters refuse a bad edit and accept a good one", async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({
      search: {
        parameters: z.object({ query: z.string().min(2), limit: z.number().int().default(5) }),
        execute: async (args: { query: string; limit: number }) => {
          calls.push(args);
          return 'ok';
        },
      },
    });
    const promise = tools.search.execute({ query: 'ams', limit: 5 });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:search', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 'x' } });
    const refused = await refusal(viewer, pauseId);
    expect(refused.payload['code']).toBe('schema');
    expect(String(refused.payload['message'])).toMatch(/field "query" is too short \(at least 2 characters\)/);
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 'lis' } });
    expect(await promise).toBe('ok');
    expect(calls).toEqual([{ query: 'lis', limit: 5 }]);
  });

  it("the function gets the MERGED arguments, never the schema's parsed output (a transform never runs twice)", async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    // dollars -> cents: NOT idempotent. The function parses what it is given
    // itself, as a loop's tool function does.
    const parameters = z.object({ dollars: z.number().transform((d) => d * 100), memo: z.string() });
    const tools = gm.wrapTools({
      charge: {
        parameters,
        execute: async (args: unknown) => {
          const parsed = parameters.parse(args);
          calls.push(parsed);
          return `charged ${parsed.dollars} cents`;
        },
      },
    });
    const promise = tools.charge.execute({ dollars: 5, memo: 'x' });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:charge', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { memo: 'fixed memo' } });
    expect(await promise).toBe('charged 500 cents');
    expect(calls).toEqual([{ dollars: 500, memo: 'fixed memo' }]);
    // The record shows what the function was handed.
    expect((await resumedFor(viewer, pauseId)).payload['edited']).toEqual({ after: { dollars: 5, memo: 'fixed memo' } });
  });
});

describe('retry + input at the error and after gates', () => {
  it('retry + input at the error gate fixes a throwing call', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currency(calls, (args) => args.from === 'XXX') });
    const promise = tools.convertCurrency({ amount: 100, from: 'XXX', to: 'USD' });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'error');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { from: 'EUR' } });
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([
      { amount: 100, from: 'XXX', to: 'USD' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
  });

  it('retry without input re-runs the same arguments, as before', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const calls: unknown[] = [];
    let attempts = 0;
    const tools = gm.wrapTools({ convertCurrency: currency(calls, () => (attempts += 1) === 1) });
    const promise = tools.convertCurrency({ amount: 100, from: 'EUR', to: 'USD' });
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
    const tools = gm.wrapTools({ convertCurrency: currency(calls) });
    const promise = tools.convertCurrency({ amount: 100, from: 'EUR', to: 'XXX' });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'after');
    expect(paused.payload['smart']).toEqual({ rule: 'error-result' });
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
  it('a 0.5 debugger: no editable flag, the edit is refused (disabled), continue runs the model arguments', async () => {
    const { viewer, gm } = await setup({ hubCapabilities: undefined, breakpoints: BEFORE });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currency(calls) });
    const promise = tools.convertCurrency({ amount: 100, from: 'EUR', to: 'USD' });
    const paused = await pausedAt(viewer, 'tool:convertCurrency', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { amount: 1 } });
    expect((await refusal(viewer, pauseIdOf(paused))).payload['code']).toBe('disabled');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([{ amount: 100, from: 'EUR', to: 'USD' }]);
  });

  it('GRAPHMIND_DISABLE_EDIT_INPUT: no editable flag, the edit is refused (disabled)', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE }, { env: { GRAPHMIND_DISABLE_EDIT_INPUT: 'on' } });
    const tools = gm.wrapTools({ convertCurrency: currency([]) });
    const promise = tools.convertCurrency({ amount: 100, from: 'EUR', to: 'USD' });
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
    const tools = gm.wrapTools({ convertCurrency: currency([], () => (attempts += 1) === 1) });
    await expect(tools.convertCurrency({ amount: 1, from: 'EUR', to: 'USD' })).rejects.toThrow('HTTP 500');
    expect(await tools.convertCurrency({ amount: 1, from: 'EUR', to: 'USD' })).toEqual({ converted: 0.9, currency: 'USD' });
    expect(gate.mock.calls.map((call) => call[0])).toEqual(['before', 'error', 'before', 'after']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
  });

  it('LLM gates are not editable', async () => {
    const marks = new Marks();
    const server = new FakeOpenAI().onChat(scriptChatTurns(marks, false));
    const rig = await rigSetup(server, { hubCapabilities: EDIT_HUB, breakpoints: [{ kind: 'llm' }] }, { env: {} }, cleanups);
    await attach(rig.gm);
    const promise = runChatScenario(rig.gm, rig.client, server, {}, marks);
    const llm = await pausedAt(rig.viewer, 'llm:step', 'before');
    expect(llm.payload['editable']).toBeUndefined();
    rig.viewer.resumeWith({ pauseId: pauseIdOf(llm), action: 'continue', input: { messages: [] } });
    expect((await refusal(rig.viewer, pauseIdOf(llm))).payload['code']).toBe('unsupported');
    rig.viewer.sendControl('breakpoint.clear', { matcher: { kind: 'llm' } });
    rig.viewer.resume(pauseIdOf(llm), 'continue');
    expect((await promise).runError).toBeUndefined();
  });
});

describe('edge cases', () => {
  it('text that is not a JSON object is not editable; continue still works', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const tools = gm.wrapTools({ shout: async (text: string) => text.toUpperCase() });
    const promise = tools.shout('hello');
    const paused = await pausedAt(viewer, 'tool:shout', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { text: 'bye' } });
    expect((await refusal(viewer, pauseIdOf(paused))).payload['code']).toBe('unsupported');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await promise).toBe('HELLO');
  });

  it('parallel calls: editing one of two held gates leaves the other on its own arguments', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currency(calls) });
    const first = tools.convertCurrency({ amount: 10, from: 'EUR', to: 'USD' });
    const second = tools.convertCurrency({ amount: 20, from: 'EUR', to: 'GBP' });
    const a = await pausedAt(viewer, 'tool:convertCurrency', 'before', 1);
    const b = await pausedAt(viewer, 'tool:convertCurrency', 'before', 2);
    // Each pause names its own call (exec.paused.instanceId, 0.6.0): parallel calls stay apart.
    const starts = viewer.ofType('node.started').filter((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect([a.payload['instanceId'], b.payload['instanceId']]).toEqual(starts.map((f) => f.payload['instanceId']));
    expect(new Set([a.payload['instanceId'], b.payload['instanceId']]).size).toBe(2);
    viewer.resumeWith({ pauseId: pauseIdOf(b), action: 'continue', input: { amount: 40 } });
    expect(await second).toEqual({ converted: 36, currency: 'GBP' });
    expect(await settledWithin(first, 50)).toBe('pending');
    viewer.resume(pauseIdOf(a), 'continue');
    expect(await first).toEqual({ converted: 9, currency: 'USD' });
    expect(calls).toEqual([
      { amount: 40, from: 'EUR', to: 'GBP' },
      { amount: 10, from: 'EUR', to: 'USD' },
    ]);
  });
});
