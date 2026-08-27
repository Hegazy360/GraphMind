/**
 * Observation-side behavior: stream tee byte-exactness, graph.hint, usage,
 * provider-executed tools, streaming tool executes, timeout neutralization,
 * and the detached / disabled fast paths.
 */
import { simulateReadableStream, tool } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { AdapterCore } from '../src/core.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions } from './helpers/fake-viewer.js';
import { attach, makeMockModel, makeTools, runScenario, Marks } from './helpers/scenario.js';
import {
  MockLanguageModel,
  aiVersion,
  supportsToolTimeout,
  type CallOptions,
  type StreamPart,
} from './helpers/sdk-compat.js';

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

describe('stream tee', () => {
  it('observed token deltas are byte-exact vs what the SDK consumed', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const result = await runScenario(gm);
    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);

    // Wait for the observer of the last step to finish reporting.
    await waitUntil(
      () =>
        viewer
          .ofType('node.finished')
          .filter((f) => f.payload['nodeId'] === 'llm:step').length >= 3,
      5000,
      'three llm node.finished frames',
    );

    const observed = viewer
      .ofType('node.token')
      .filter((f) => f.payload['nodeId'] === 'llm:step')
      .flatMap((f) => f.payload['deltas'] as { t: string; v: string }[])
      .filter((d) => d.t === 'text')
      .map((d) => d.v)
      .join('');
    expect(observed).toBe(result.stepTexts.join(''));
    expect(result.text.length).toBeGreaterThan(0);
    expect(observed.endsWith(result.text)).toBe(true);

    // node.finished carries mapped usage from the finish part.
    const llmFinished = viewer
      .ofType('node.finished')
      .filter((f) => f.payload['nodeId'] === 'llm:step');
    for (const frame of llmFinished) {
      expect(frame.payload['usage']).toEqual({ inputTokens: 20, outputTokens: 10 });
      expect(frame.payload['status']).toBe('ok');
    }
    // Batching: deltas arrive in node.token batches, not one frame per delta.
    const tokenFrames = viewer
      .ofType('node.token')
      .filter((f) => f.payload['nodeId'] === 'llm:step');
    const deltaCount = tokenFrames.reduce(
      (n, f) => n + (f.payload['deltas'] as unknown[]).length,
      0,
    );
    expect(deltaCount).toBeGreaterThan(tokenFrames.length);
  });
});

describe('graph.hint', () => {
  /**
   * The hint fires on each INVOCATION's first step, which is right — a second
   * `streamText` in the same run can bring new tools. What it must not do is
   * announce the same roster twice: the sibling OpenAI adapter did exactly
   * that for any run that used two APIs, and the duplicate is pure noise in
   * the run's event stream.
   */
  describe('a second invocation in the same run', () => {
    const roster = (viewer: FakeViewer, index: number): string[] =>
      (viewer.ofType('graph.hint')[index]?.payload['nodes'] as { nodeId: string }[]).map(
        (n) => n.nodeId,
      );

    const params = (...tools: string[]) => ({
      prompt: 'plan it',
      tools: tools.map((name) => ({ type: 'function', name })),
    });

    it('is silent when the roster adds nothing', async () => {
      const { viewer, gm } = await setup();
      await attach(gm);
      const core = new AdapterCore(gm.session);

      await gm.run('reconcile', async (ctx) => {
        core.emitGraphHint(params('searchFlights'), ctx); // invocation 1
        core.emitGraphHint(params('searchFlights'), ctx); // invocation 2, same tools
      });

      await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
      expect(viewer.ofType('graph.hint')).toHaveLength(1);
      expect(roster(viewer, 0)).toEqual(['agent:reconcile', 'llm:step', 'tool:searchFlights']);
    });

    it('speaks up when the roster gains a tool', async () => {
      const { viewer, gm } = await setup();
      await attach(gm);
      const core = new AdapterCore(gm.session);

      await gm.run('reconcile', async (ctx) => {
        core.emitGraphHint(params('searchFlights'), ctx);
        core.emitGraphHint(params('searchFlights', 'flagForApproval'), ctx);
      });

      await waitUntil(() => viewer.ofType('graph.hint').length === 2, 8000, 'second hint');
      expect(roster(viewer, 1)).toContain('tool:flagForApproval');
    });

    it('pre-renders every run from scratch', async () => {
      const { viewer, gm } = await setup();
      await attach(gm);
      const core = new AdapterCore(gm.session);

      for (const name of ['run-one', 'run-two']) {
        await gm.run(name, async (ctx) => core.emitGraphHint(params('searchFlights'), ctx));
      }

      await waitUntil(() => viewer.ofType('graph.hint').length === 2, 8000, 'one hint per run');
      expect(roster(viewer, 0)[0]).toBe('agent:run-one');
      expect(roster(viewer, 1)[0]).toBe('agent:run-two');
    });
  });

  it('emits the full node roster from params.tools on the first step', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const result = await runScenario(gm, { runName: 'trip-run' });
    expect(result.runError).toBeUndefined();

    const hints = viewer.ofType('graph.hint');
    expect(hints).toHaveLength(1); // 3 steps chain into ONE invocation
    const nodes = hints[0]!.payload['nodes'] as Record<string, unknown>[];
    const byId = new Map(nodes.map((n) => [n['nodeId'], n]));
    expect(byId.get('agent:trip-run')).toMatchObject({ kind: 'agent', name: 'trip-run' });
    expect(byId.get('llm:step')).toMatchObject({ kind: 'llm', parentId: 'agent:trip-run' });
    for (const name of ['searchFlights', 'checkWeather', 'convertCurrency']) {
      expect(byId.get(`tool:${name}`)).toMatchObject({
        kind: 'tool',
        name,
        parentId: 'llm:step',
      });
    }

    // The llm instances chain into one invocation: instanceIds share a prefix
    // and step indices increase.
    const llmStarts = viewer
      .ofType('node.started')
      .filter((f) => f.payload['nodeId'] === 'llm:step')
      .map((f) => f.payload['instanceId'] as string);
    expect(llmStarts).toHaveLength(3);
    const invocation = llmStarts[0]!.split(':s')[0]!;
    expect(llmStarts).toEqual([`${invocation}:s0`, `${invocation}:s1`, `${invocation}:s2`]);
  });
});

describe('provider-executed tools', () => {
  it('observes them from stream parts, marked and ungated', async () => {
    const { viewer, gm } = await setup({
      // A breakpoint on the provider tool must have no effect: it is never gated.
      breakpoints: [{ name: 'webSearch' }],
    });
    await attach(gm);

    const parts: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      {
        type: 'tool-call',
        toolCallId: 'call-web-1',
        toolName: 'webSearch',
        input: JSON.stringify({ q: 'lisbon' }),
        providerExecuted: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'call-web-1',
        toolName: 'webSearch',
        result: { hits: 3 },
      },
      {
        type: 'finish',
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        finishReason: { unified: 'stop', raw: 'stop' },
      },
    ];
    const mock = new MockLanguageModel({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({ chunks: parts }),
      }),
    });
    const model = gm.wrapModel(mock);
    const params: CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'search lisbon' }] }],
      tools: [
        { type: 'function', name: 'searchFlights', inputSchema: { type: 'object' } },
        { type: 'provider', id: 'test.webSearch', name: 'webSearch', args: {} },
      ],
    };
    const res = await model.doStream(params);
    const reader = res.stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:webSearch',
    );
    const started = viewer
      .ofType('node.started')
      .find((f) => f.payload['nodeId'] === 'tool:webSearch');
    expect(started?.payload['providerExecuted']).toBe(true);
    expect(started?.payload['ungated']).toBe(true);
    expect(started?.payload['input']).toEqual({ q: 'lisbon' });
    expect(started?.payload['instanceId']).toBe('call-web-1');
    expect(finished.payload['output']).toEqual({ hits: 3 });
    expect(finished.payload['providerExecuted']).toBe(true);
    expect(finished.payload['status']).toBe('ok');

    // Marked in the graph hint too.
    const hint = viewer.ofType('graph.hint')[0];
    const nodes = hint!.payload['nodes'] as Record<string, unknown>[];
    const webSearch = nodes.find((n) => n['nodeId'] === 'tool:webSearch');
    expect(webSearch?.['providerExecuted']).toBe(true);
    expect(webSearch?.['ungated']).toBe(true);

    // Despite the armed breakpoint, nothing ever paused (observe-only).
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });
});

describe('streaming tool execute (async function*)', () => {
  it('returns a synchronous AsyncIterable, gates before-start, observes chunks, never pauses mid-stream', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ name: 'progress' }] });
    await attach(gm);

    const order: string[] = [];
    const tools = gm.wrapTools({
      progress: tool({
        inputSchema: z.object({}),
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async function* () {
          order.push('body-start');
          yield { pct: 50 };
          yield { pct: 100, done: true };
        },
      }),
    });

    const execute = tools.progress.execute as (
      input: unknown,
      options: unknown,
    ) => AsyncIterable<unknown>;
    const iterable = execute({}, { toolCallId: 'call-progress-1', messages: [] });
    // NON-async delegate: the SDK sniffs the direct return value.
    expect(typeof (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');

    const iterator = iterable[Symbol.asyncIterator]();
    const firstPromise = iterator.next();

    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:progress',
    );
    await tick(150);
    expect(order).toHaveLength(0); // gate held before the body started
    viewer.resume(paused.payload['pauseId'] as string, 'continue');

    expect((await firstPromise).value).toEqual({ pct: 50 });
    expect((await iterator.next()).value).toEqual({ pct: 100, done: true });
    expect((await iterator.next()).done).toBe(true);

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:progress',
    );
    expect(finished.payload['status']).toBe('ok');
    expect(finished.payload['streaming']).toBe(true);
    expect(finished.payload['chunks']).toBe(2);
    expect(finished.payload['output']).toEqual({ pct: 100, done: true });
    // Exactly one pause: before-start only.
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
  });
});

describe('wrapGenerate (non-streaming)', () => {
  it('gates before doGenerate and reports the result with usage', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'llm' }] });
    await attach(gm);

    let generateCalls = 0;
    const mock = new MockLanguageModel({
      doGenerate: async () => {
        generateCalls += 1;
        return {
          content: [{ type: 'text' as const, text: 'forty-two' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const model = gm.wrapModel(mock);

    const resultPromise = model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'the answer?' }] }],
    });
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
    );
    await tick(150);
    expect(generateCalls).toBe(0); // held before the provider call
    viewer.resume(paused.payload['pauseId'] as string, 'continue');

    const result = await resultPromise;
    expect(generateCalls).toBe(1);
    expect(result.content).toEqual([{ type: 'text', text: 'forty-two' }]);

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step',
    );
    expect(finished.payload['status']).toBe('ok');
    expect(finished.payload['usage']).toEqual({ inputTokens: 8, outputTokens: 3 });
    expect(finished.payload['output']).toMatchObject({ text: 'forty-two', finishReason: 'stop' });
  });
});

/**
 * Both cases below drive the SDK's *per-tool* timeout (`timeout: {toolMs}`),
 * the only timeout that arms an abort around a tool body and therefore the
 * only one a held tool gate can burn. ai@6 has no per-tool timeout at all
 * (its `TimeoutConfiguration` is `{totalMs, stepMs, chunkMs}`), so on that
 * major there is no signal to neutralize and nothing to assert — the suite
 * skips rather than pretending. The neutralization primitive itself
 * (`isTimeoutAbortReason` / `chainAbortSignals`) is covered on every major by
 * the `signals` unit tests.
 */
describe.skipIf(!supportsToolTimeout)(
  `timeout neutralization (decisions.md #3)${
    supportsToolTimeout ? '' : ` [skipped: ai@${aiVersion} has no per-tool timeout]`
  }`,
  () => {
    it('attached: warns once and strips timeout aborts so a hold does not kill the run', async () => {
      const { viewer, gm, warnings } = await setup({
        breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
      });
      await attach(gm);

      const marks = new Marks();
      const promise = runScenario(
        gm,
        { timeout: { toolMs: 150 }, searchFlightsChecksSignal: true },
        marks,
      );
      const paused = await viewer.waitFor(
        (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
      );
      await tick(400); // burn far past toolMs while held
      viewer.resume(paused.payload['pauseId'] as string, 'continue');

      const result = await promise;
      expect(result.runError).toBeUndefined();
      expect(result.stepCount).toBe(3);
      expect(result.text).toContain('TP1234'); // the tool really ran
      const neutralized = warnings.filter((w) => w.includes('timeout abort was neutralized'));
      expect(neutralized).toHaveLength(1); // warned once, not per swallowed abort
    });

    it('detached: timeouts are untouched', async () => {
      const warnings: string[] = [];
      // Permanently detached session (no WebSocket implementation, no network).
      const gm = graphmind({
        enabled: true,
        webSocket: undefined,
        logger: (message) => warnings.push(message),
      });
      cleanups.push(() => gm.dispose());

      const result = await runScenario(gm, {
        timeout: { toolMs: 100 },
        searchFlightsChecksSignal: true,
        searchFlightsDelayMs: 300,
      });
      // The tool honoured the SDK's own timeout signal and threw; the SDK turned
      // it into an error-text tool result and the loop continued.
      expect(result.stepCount).toBe(3);
      expect(result.text.toLowerCase()).toContain('timeout');
      expect(warnings.filter((w) => w.includes('neutralized'))).toHaveLength(0);
    });
  },
);

describe('detached / disabled fast paths', () => {
  it('disabled: wrapModel and wrapTools are identity functions', async () => {
    const gm = graphmind({ enabled: false });
    cleanups.push(() => gm.dispose());
    const marks = new Marks();
    const mock = makeMockModel(marks);
    const tools = makeTools(marks, {});
    expect(gm.wrapModel(mock)).toBe(mock);
    expect(gm.wrapTools(tools)).toBe(tools);
    expect(gm.session.enabled).toBe(false);

    const result = await runScenario(gm);
    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);
    expect(gm.session.stats().seq).toBe(0); // nothing emitted, nothing buffered
  });

  it('enabled but detached: runs to completion with zero pauses and buffered events only', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined });
    cleanups.push(() => gm.dispose());

    const result = await runScenario(gm);
    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);
    expect(result.text).toContain('TP1234');
    const stats = gm.session.stats();
    expect(stats.attached).toBe(false);
    expect(stats.heldGates).toBe(0);
    expect(stats.buffered).toBeGreaterThan(0); // ring buffer holds replay events
  });

  it('the adapter never throws into the host app on unserializable payloads', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const tools = gm.wrapTools({
      weird: tool({
        inputSchema: z.object({}),
        execute: async () => cyclic, // JSON.stringify(cyclic) throws in emit
      }),
    });
    const execute = tools.weird.execute as (
      input: unknown,
      options: unknown,
    ) => Promise<unknown>;
    const result = await execute(cyclic, { toolCallId: 'call-weird-1', messages: [] });
    expect(result).toBe(cyclic); // host result untouched, no throw
  });
});
