/**
 * The tool-wrapping path: the full gate set (inject / retry / abort), which
 * callbacks alone cannot provide. Driven through a real compiled LangGraph so
 * the wrapper and the callback handler have to agree about node identity.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions } from './helpers/fake-viewer.js';
import {
  attach,
  buildFailingGraph,
  buildGraph,
  Marks,
  type ScenarioFlags,
} from './helpers/graph.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(
  viewerOptions: FakeViewerOptions = {},
  gmOptions: Partial<GraphmindOptions> = {},
): Promise<{ viewer: FakeViewer; gm: Graphmind; warnings: string[] }> {
  const viewer = await FakeViewer.start(viewerOptions);
  const warnings: string[] = [];
  const gm = graphmind({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    logger: (message) => warnings.push(message),
    ...gmOptions,
  });
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  return { viewer, gm, warnings };
}

function run(gm: Graphmind, flags: ScenarioFlags = {}) {
  const { graph, marks } = buildGraph(gm, { wrapTools: true, ...flags });
  const promise = graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler()] });
  return { marks, promise };
}

function bodyCount(marks: Marks, toolName: string): number {
  return marks.count('tool:body-start', (m) => m.data?.['toolName'] === toolName);
}

describe('wrapStructuredTool', () => {
  it('keeps the tool a working LangChain tool (name, schema, prototype)', async () => {
    const { gm } = await setup();
    const original = tool(async ({ a }: { a: number }) => `got:${a}`, {
      name: 'adder',
      description: 'adds',
      schema: z.object({ a: z.number() }),
    });
    const wrapped = gm.wrapStructuredTool(original);

    expect(wrapped).not.toBe(original);
    expect(wrapped.name).toBe('adder');
    expect(Object.getPrototypeOf(wrapped)).toBe(Object.getPrototypeOf(original));
    expect((wrapped as unknown as { schema: unknown }).schema).toBe(
      (original as unknown as { schema: unknown }).schema,
    );
    const content = (value: unknown): string =>
      String((value as { content?: unknown } | null)?.content ?? value);
    expect(content(await wrapped.invoke({ a: 2 }))).toBe('got:2');
    // The original is untouched.
    expect(content(await original.invoke({ a: 3 }))).toBe('got:3');
  });

  it('injects a substitute result at the before gate', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    await attach(gm);

    const { marks, promise } = run(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'inject', '{"flight":"INJECTED"}');

    const result = await promise;
    // The injected value reached the graph state, and the body never ran.
    expect(result.findings.join()).toContain('INJECTED');
    expect(bodyCount(marks, 'searchFlights')).toBe(0);

    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    const finish = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'tool:searchFlights');
    expect(finish?.payload['injected']).toBe(true);
    expect(finish?.payload['status']).toBe('ok');
  });

  it('retries a failed tool at the error gate, then succeeds', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ point: 'error' }] });
    await attach(gm);

    const { marks, promise } = run(gm, { currencyThrowsOnce: true });
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:convertCurrency',
    );
    expect(paused.payload['point']).toBe('error');
    viewer.resume(paused.payload['pauseId'] as string, 'retry');

    const result = await promise;
    expect(bodyCount(marks, 'convertCurrency')).toBe(2); // failed once, then re-ran
    expect(result.findings.join()).toContain('converted');
    expect(marks.first('node:budget-caught')).toBeUndefined(); // the graph never saw a failure

    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    const finish = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect(finish?.payload['status']).toBe('ok');
    expect(finish?.payload['attempts']).toBe(2);
    // The swallowed first failure is still reported exactly once, so the
    // retry is visible on the canvas instead of silently disappearing.
    const errors = viewer
      .ofType('node.error')
      .filter((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect(errors.length).toBe(1);
    expect((errors[0]?.payload['error'] as { message: string }).message).toContain('HTTP 500');
  });

  it('injects a recovery value at the error gate', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ point: 'error' }] });
    await attach(gm);

    const { promise } = run(gm, { currencyThrows: true });
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'inject', '{"converted":42}');

    const result = await promise;
    expect(result.findings.join()).toContain('42');
    // The graph node never entered its catch branch: the error was swallowed.
    expect(result.findings.join()).not.toContain('HTTP 500');

    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    // Swallowed for the graph, but still visible in the debugger.
    expect(
      viewer.ofType('node.error').filter((f) => f.payload['nodeId'] === 'tool:convertCurrency')
        .length,
    ).toBe(1);
    const finish = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect(finish?.payload['recoveredFromError']).toBe(true);
  });

  it('substitutes a result at the after gate', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ kind: 'tool', name: 'searchFlights', point: 'after' }],
    });
    await attach(gm);

    const { marks, promise } = run(gm);
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    expect(paused.payload['point']).toBe('after');
    // The body DID run this time — `after` is post-execute, pre-return.
    expect(bodyCount(marks, 'searchFlights')).toBe(1);
    viewer.resume(paused.payload['pauseId'] as string, 'inject', '{"flight":"PATCHED"}');

    const result = await promise;
    expect(result.findings.join()).toContain('PATCHED');
  });

  it('aborts the graph from a wrapped tool gate', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    await attach(gm);

    const { marks, promise } = run(gm);
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'abort');

    await expect(promise).rejects.toThrow();
    expect(bodyCount(marks, 'searchFlights')).toBe(0);
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    expect(viewer.ofType('run.finished')[0]?.payload['status']).toBe('aborted');
  });

  it('pauses exactly once per wrapped tool call (the handler yields to it)', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    await attach(gm);

    const { promise } = run(gm);
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    await tick(300);
    expect(viewer.ofType('exec.paused').length).toBe(1);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await promise;

    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    // And exactly one node.started/node.finished pair for that tool.
    const started = viewer
      .ofType('node.started')
      .filter((f) => f.payload['nodeId'] === 'tool:searchFlights');
    const finished = viewer
      .ofType('node.finished')
      .filter((f) => f.payload['nodeId'] === 'tool:searchFlights');
    expect(started.length).toBe(1);
    expect(finished.length).toBe(1);
    expect(started[0]?.payload['gates']).toBe('full');
    expect(finished[0]?.payload['instanceId']).toBe(started[0]?.payload['instanceId']);
  });
});

describe('gm.tool / gm.wrapTools (plain functions)', () => {
  it('gates a plain function called inside a graph node', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'scoreLead' }] });
    await attach(gm);

    const calls: number[] = [];
    const scoreLead = gm.tool('scoreLead', async (n: number) => {
      calls.push(n);
      return n * 2;
    });

    const promise = gm.run('scoring', async () => scoreLead(21));
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    expect(paused.payload['nodeId']).toBe('tool:scoreLead');
    await tick(200);
    expect(calls.length).toBe(0); // held

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await promise).toBe(42);
    expect(calls).toEqual([21]);

    const started = viewer
      .ofType('node.started')
      .find((f) => f.payload['nodeId'] === 'tool:scoreLead');
    expect(started?.payload['kind']).toBe('tool');
    expect(started?.payload['input']).toBe(21);
  });

  it('injects into a plain wrapped function', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'lookup' }] });
    await attach(gm);

    const { lookup } = gm.wrapTools({ lookup: async (key: string) => `real:${key}` });
    const promise = gm.run('lookup-run', () => lookup('x'));
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'injected-value');
    expect(await promise).toBe('injected-value');
  });

  it('wrapTools handles a mixed record of functions and LangChain tools', async () => {
    const { gm } = await setup();
    const lcTool = tool(async () => 'lc', {
      name: 'lcTool',
      description: 'a langchain tool',
      schema: z.object({}),
    });
    const wrapped = gm.wrapTools({ plain: async () => 'plain', lcTool });
    expect(typeof wrapped.plain).toBe('function');
    expect(wrapped.lcTool).not.toBe(lcTool);
    expect(wrapped.lcTool.name).toBe('lcTool');
    expect(await wrapped.plain()).toBe('plain');
  });
});

describe('callback-only gate limits', () => {
  it('warns and continues when the debugger injects at a NON-wrapped tool', async () => {
    const { viewer, gm, warnings } = await setup({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);

    // wrapTools: false -> only the callback handler gates this tool.
    const { graph, marks } = buildGraph(gm, { wrapTools: false });
    const promise = graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler()] });
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'nope');

    const result = await promise;
    // Execution continued with the REAL result; nothing was substituted.
    expect(result.findings.join()).toContain('TP1234');
    expect(bodyCount(marks, 'searchFlights')).toBe(1);
    expect(warnings.some((w) => w.includes('no return channel'))).toBe(true);
    expect(warnings.some((w) => w.includes('wrapStructuredTool'))).toBe(true);
  });
});

/**
 * One failure, one pause.
 *
 * The docs-qa sample surfaced this: releasing the `tool:gradeChunks` error
 * gate stopped the user AGAIN at `chain:grade`, because the same error
 * re-fired the gate at every level it climbed. The second gate is a callback,
 * so it cannot inject or retry — it is a pause with nothing behind it.
 *
 * The gate that CAN do something is the innermost one (the wrapper is a real
 * position in the call stack), so it claims the error and every ancestor lets
 * that same failure past.
 */
describe('error cascade through the run tree', () => {
  function runFailing(gm: Graphmind, flags: Parameters<typeof buildFailingGraph>[1] = {}) {
    const { graph, marks, attempts } = buildFailingGraph(gm, flags);
    const promise = graph
      .invoke({ topic: 'team-plan' }, { callbacks: [gm.handler()] })
      .catch((error: unknown) => ({ failed: error }));
    return { marks, promise, attempts };
  }

  const errorPauses = (viewer: FakeViewer) =>
    viewer.ofType('exec.paused').filter((f) => f.payload['point'] === 'error');

  it('pauses ONCE at the wrapper, not again at every ancestor', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ point: 'error' }] });
    await attach(gm);
    // Release every gate the moment it opens, the way a user hammering
    // "Release this gate" would — so a cascade shows up as extra pauses
    // rather than as a hang.
    const released = viewer.releaseEveryPause('continue');

    const { promise } = runFailing(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:gradeChunks',
    );
    expect(paused.payload['point']).toBe('error');

    await promise;
    released.stop();
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    await tick(150); // any late ancestor gate would have landed by now

    expect(errorPauses(viewer).map((f) => f.payload['nodeId'])).toEqual(['tool:gradeChunks']);
    // The failure still reached the graph and the chain nodes still report it.
    const errored = viewer
      .ofType('node.finished')
      .filter((f) => f.payload['status'] === 'error')
      .map((f) => f.payload['nodeId']);
    expect(errored).toContain('chain:grade');
  });

  it('still pauses once per failure when the tool is only callback-gated', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ point: 'error' }] });
    await attach(gm);

    const released = viewer.releaseEveryPause('continue');
    const { promise } = runFailing(gm, { wrapTools: false });
    await viewer.waitFor((f) => f.type === 'exec.paused');

    await promise;
    released.stop();
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    await tick(150);

    expect(errorPauses(viewer).map((f) => f.payload['nodeId'])).toEqual(['tool:gradeChunks']);
  });

  it('re-arms the gate for each RETRY, even when the tool rethrows one Error object', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ point: 'error' }] });
    await attach(gm);

    // Attempts 1 and 2 throw the SAME Error instance; attempt 3 succeeds.
    const { promise, attempts } = runFailing(gm, { failures: 2, sameErrorObject: true });

    const first = await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.resume(first.payload['pauseId'] as string, 'retry');
    const second = await viewer.waitForNth((f) => f.type === 'exec.paused', 2);
    viewer.resume(second.payload['pauseId'] as string, 'retry');

    await promise;
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    expect(attempts()).toBe(3);
    // Two failures, two pauses — the claim from attempt 1 must not swallow
    // attempt 2's identical Error.
    expect(errorPauses(viewer).map((f) => f.payload['nodeId'])).toEqual([
      'tool:gradeChunks',
      'tool:gradeChunks',
    ]);
  });
});

/**
 * A callback-only gate cannot inject or retry. It has always said so at
 * `before` and `after`; at `error` — the gate a user is most likely to be
 * sitting at, since pause-on-error is armed by default — it said nothing and
 * simply continued, which reads as a broken button.
 */
describe('inject / retry at a callback-only ERROR gate', () => {
  it('warns and names the wrapper instead of silently continuing', async () => {
    const { viewer, gm, warnings } = await setup({ breakpoints: [{ point: 'error' }] });
    await attach(gm);

    // wrapTools: false -> only the callback handler gates this failure.
    const { graph } = buildFailingGraph(gm, { wrapTools: false });
    const promise = graph
      .invoke({ topic: 'team-plan' }, { callbacks: [gm.handler()] })
      .catch((error: unknown) => ({ failed: error }));

    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    expect(paused.payload['point']).toBe('error');
    viewer.resume(paused.payload['pauseId'] as string, 'inject', '{"verdict":"grounded"}');

    const result = (await promise) as { failed?: unknown };
    // Nothing was substituted: the error still propagated out of the graph.
    expect(result.failed).toBeInstanceOf(Error);
    expect((result.failed as Error).message).toContain('contradictory');

    const warning = warnings.find((w) => w.includes('error gate'));
    expect(warning).toBeDefined();
    expect(warning).toContain('no return channel');
    expect(warning).toContain('wrapStructuredTool');
    expect(warning).toContain('the error kept propagating');
  });

  it('warns for retry at an error gate too', async () => {
    const { viewer, gm, warnings } = await setup({ breakpoints: [{ point: 'error' }] });
    await attach(gm);

    const { graph, marks } = buildFailingGraph(gm, { wrapTools: false });
    const promise = graph
      .invoke({ topic: 'team-plan' }, { callbacks: [gm.handler()] })
      .catch(() => undefined);

    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    await promise;

    // The body ran once: a callback cannot re-run what it observed.
    expect(bodyCount(marks, 'gradeChunks')).toBe(1);
    expect(warnings.some((w) => w.includes('retry') && w.includes('error gate'))).toBe(true);
  });

  it('warns separately at the before gate and the error gate', async () => {
    const { viewer, gm, warnings } = await setup({
      breakpoints: [{ kind: 'tool', name: 'gradeChunks' }, { point: 'error' }],
    });
    await attach(gm);

    const { graph } = buildFailingGraph(gm, { wrapTools: false });
    const promise = graph
      .invoke({ topic: 'team-plan' }, { callbacks: [gm.handler()] })
      .catch(() => undefined);

    const before = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['point'] === 'before',
    );
    viewer.resume(before.payload['pauseId'] as string, 'inject', 'nope');
    const onError = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['point'] === 'error',
    );
    viewer.resume(onError.payload['pauseId'] as string, 'inject', 'nope');
    await promise;

    // An earlier `before` warning must not spend the error gate's budget:
    // they are different situations and the second is the one that matters.
    expect(warnings.filter((w) => w.includes('before gate')).length).toBe(1);
    expect(warnings.filter((w) => w.includes('error gate')).length).toBe(1);
  });
});
