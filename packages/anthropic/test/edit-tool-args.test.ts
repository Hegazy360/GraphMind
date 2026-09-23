/**
 * Edited tool arguments (0.6.0, contract C2 / W2) through the Anthropic tool
 * wrapper: `continue` + input at `before` and `retry` + input at `after` /
 * `error` call the REAL function with the edit merged into its argument; a
 * malformed edit is refused with the gate still held; the `after` gate hands
 * the result to the session's detectors; nothing changes under a 0.5
 * debugger, with edits disabled, or detached.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AfterGateContext, GateDetector, Session } from '@graphmind-ai/client';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions, type ReceivedFrame } from './helpers/fake-viewer.js';
import { FakeAnthropicTransport } from './helpers/fake-anthropic.js';
import { Marks, attach, makeScript, runScenario } from './helpers/scenario.js';

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

describe('continue + input at the before gate', () => {
  it('end to end: the real function runs with the merged input and its result reaches the next turn', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    const marks = new Marks();
    const transport = new FakeAnthropicTransport(makeScript({}));
    const promise = runScenario(gm, {}, marks, transport);

    const paused = await pausedAt(viewer, 'tool:searchFlights', 'before');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { to: 'OPO' } });

    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.text).toContain('OPO');
    // The next request carried the edited call's real output as its tool_result.
    expect(JSON.stringify(transport.requests[1]?.body)).toContain('\\"to\\":\\"OPO\\"');
    const started = viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:searchFlights');
    expect(started?.payload['input']).toEqual({ from: 'VIE', to: 'LIS' });
    expect((await resumedFor(viewer, pauseIdOf(paused))).payload['edited']).toEqual({ after: { from: 'VIE', to: 'OPO' } });
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights');
    expect(finished?.payload['output']).toEqual({ flights: [{ id: 'TP1234', from: 'VIE', to: 'OPO', priceEUR: 199 }] });
  });

  it('an edit that is not an object is refused (shape), the gate stays held, then a valid edit runs', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currency(calls) });
    const promise = tools.convertCurrency({ amount: 100, from: 'EUR', to: 'USD' });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'before'));

    viewer.resumeWith({ pauseId, action: 'continue', input: ['SECRET-VALUE-42'] });
    const refused = await refusal(viewer, pauseId);
    expect(refused.payload['code']).toBe('shape');
    expect(JSON.stringify(refused.payload)).not.toContain('SECRET-VALUE-42');
    expect(calls).toHaveLength(0);
    expect(await settledWithin(promise, 50)).toBe('pending');

    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 250 } });
    expect(await promise).toEqual({ converted: 225, currency: 'USD' });
    expect(calls).toEqual([{ amount: 250, from: 'EUR', to: 'USD' }]);
  });

  it('after a refused edit a plain continue runs the host arguments', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currency(calls) });
    const promise = tools.convertCurrency({ amount: 100, from: 'EUR', to: 'USD' });
    const pauseId = pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'before'));
    viewer.resumeWith({ pauseId, action: 'continue', input: '{"amount":1}' });
    await refusal(viewer, pauseId);
    viewer.resume(pauseId, 'continue');
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([{ amount: 100, from: 'EUR', to: 'USD' }]);
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
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:convertCurrency');
    expect(finished?.payload['status']).toBe('ok');
  });

  it('retry without input re-runs the same arguments, as before', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    const calls: unknown[] = [];
    let attempts = 0;
    const tools = gm.wrapTools({ convertCurrency: currency(calls, () => (attempts += 1) === 1) });
    const promise = tools.convertCurrency({ amount: 100, from: 'EUR', to: 'USD' });
    viewer.resume(pauseIdOf(await pausedAt(viewer, 'tool:convertCurrency', 'error')), 'retry');
    expect(await promise).toEqual({ converted: 90, currency: 'USD' });
    expect(calls).toEqual([
      { amount: 100, from: 'EUR', to: 'USD' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
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
    expect(paused.payload['editable']).toBe(true);
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
  it('a 0.5 debugger: no editable flag, the edit is refused (disabled), continue runs the host arguments', async () => {
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
    const { viewer, gm } = await setup({ breakpoints: BEFORE }, { env: { GRAPHMIND_DISABLE_EDIT_INPUT: '1' } });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currency(calls) });
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
    const calls: unknown[] = [];
    let attempts = 0;
    const tools = gm.wrapTools({ convertCurrency: currency(calls, () => (attempts += 1) === 1) });
    await expect(tools.convertCurrency({ amount: 1, from: 'EUR', to: 'USD' })).rejects.toThrow('HTTP 500');
    expect(await tools.convertCurrency({ amount: 1, from: 'EUR', to: 'USD' })).toEqual({ converted: 0.9, currency: 'USD' });
    expect(gate.mock.calls.map((call) => call[0])).toEqual(['before', 'error', 'before', 'after']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
  });

  it('LLM gates are not editable', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'llm' }] });
    const promise = runScenario(gm, {});
    const llm = await pausedAt(viewer, 'llm:step', 'before');
    expect(llm.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(llm), action: 'continue', input: { messages: [] } });
    expect((await refusal(viewer, pauseIdOf(llm))).payload['code']).toBe('unsupported');
    viewer.sendControl('breakpoint.clear', { matcher: { kind: 'llm' } });
    viewer.resume(pauseIdOf(llm), 'continue');
    expect((await promise).runError).toBeUndefined();
  });
});

describe('edge cases', () => {
  it('a string-input tool is not editable; continue still works', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({
      shout: async (text: string) => {
        calls.push(text);
        return text.toUpperCase();
      },
    });
    const promise = tools.shout('hello');
    const paused = await pausedAt(viewer, 'tool:shout', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { text: 'bye' } });
    expect((await refusal(viewer, pauseIdOf(paused))).payload['code']).toBe('unsupported');
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await promise).toBe('HELLO');
    expect(calls).toEqual(['hello']);
  });

  it('a multi-argument call is not editable', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const tools = gm.wrapTools({ add: async (a: { n: number }, b: { n: number }) => a.n + b.n });
    const promise = tools.add({ n: 1 }, { n: 2 });
    const paused = await pausedAt(viewer, 'tool:add', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await promise).toBe(3);
  });

  it('a call made with no argument object can be given one (merge onto nothing)', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({
      search: async (args?: { query?: string }) => {
        calls.push(args);
        return args?.query ?? 'nothing';
      },
    });
    const promise = tools.search(undefined);
    const paused = await pausedAt(viewer, 'tool:search', 'before');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { query: 'AMS' } });
    expect(await promise).toBe('AMS');
    expect(calls).toEqual([{ query: 'AMS' }]);
  });

  it('parallel calls: editing one of two held gates leaves the other on its own arguments', async () => {
    const { viewer, gm } = await setup({ breakpoints: BEFORE });
    const calls: unknown[] = [];
    const tools = gm.wrapTools({ convertCurrency: currency(calls) });
    const first = tools.convertCurrency({ amount: 10, from: 'EUR', to: 'USD' });
    const second = tools.convertCurrency({ amount: 20, from: 'EUR', to: 'GBP' });
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
