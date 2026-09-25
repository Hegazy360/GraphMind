/**
 * Gate semantics through the REAL public API (graphmind -> wrapModel/
 * wrapTools -> streamText on ai@7 mock models) against a fake debugger
 * WebSocket server. Re-proves the spike's scenarios at this layer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { simulateReadableStream, stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions, type ReceivedFrame } from './helpers/fake-viewer.js';
import { attach, runScenario, Marks, type ScenarioFlags } from './helpers/scenario.js';
import { MockLanguageModel, type StreamPart, type Usage } from './helpers/sdk-compat.js';

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

function bodyStart(marks: Marks, toolName: string) {
  return marks.first('tool:body-start', (m) => m.data?.['toolName'] === toolName);
}

async function startScenario(gm: Graphmind, flags: ScenarioFlags = {}) {
  const marks = new Marks();
  const promise = runScenario(gm, flags, marks);
  return { marks, promise };
}

describe('breakpoint hold + resume', () => {
  it('holds a tool gate >= 2s until the viewer resumes, then completes', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);

    const { marks, promise } = await startScenario(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(paused.payload['point']).toBe('before');
    const pausedAt = Date.now();

    await tick(2000);
    // The tool body did not start while the gate was held.
    expect(bodyStart(marks, 'searchFlights')).toBeUndefined();

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const result = await promise;

    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);
    expect(result.text).toContain('TP1234');
    const started = bodyStart(marks, 'searchFlights');
    expect(started).toBeDefined();
    expect(started!.at - pausedAt).toBeGreaterThanOrEqual(1950);
    expect(viewer.ofType('exec.resumed').length).toBeGreaterThanOrEqual(1);
  });
});

describe('model-step gate', () => {
  it('holds BEFORE doStream: nothing is in flight while the gate is held', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'llm' }] });
    await attach(gm);

    const { marks, promise } = await startScenario(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
    );
    await tick(500);
    // The provider was never invoked during the hold.
    expect(marks.count('mock:doStream')).toBe(0);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await waitUntil(() => marks.count('mock:doStream') === 1, 5000, 'doStream after resume');

    // Resume the remaining step gates (one per model step).
    for (let step = 2; step <= 3; step += 1) {
      const next = await viewer.waitForNth(
        (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
        step,
      );
      viewer.resume(next.payload['pauseId'] as string, 'continue');
    }
    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);
    expect(result.text).toContain('TP1234');
  });
});

describe('parallel tool calls', () => {
  it('gates two parallel calls independently', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [
        { kind: 'tool', name: 'checkWeather' },
        { kind: 'tool', name: 'convertCurrency' },
      ],
    });
    await attach(gm);

    const { marks, promise } = await startScenario(gm);
    const pausedWeather = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:checkWeather',
    );
    const pausedCurrency = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:convertCurrency',
    );

    // Both held simultaneously, neither body started.
    expect(gm.session.stats().heldGates).toBe(2);
    expect(bodyStart(marks, 'checkWeather')).toBeUndefined();
    expect(bodyStart(marks, 'convertCurrency')).toBeUndefined();

    // Resume one; the other stays held.
    viewer.resume(pausedWeather.payload['pauseId'] as string, 'continue');
    await waitUntil(
      () => marks.first('tool:body-end', (m) => m.data?.['toolName'] === 'checkWeather') !== undefined,
      5000,
      'checkWeather body',
    );
    await tick(300);
    expect(bodyStart(marks, 'convertCurrency')).toBeUndefined();
    expect(gm.session.stats().heldGates).toBe(1);

    viewer.resume(pausedCurrency.payload['pauseId'] as string, 'continue');
    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);
    expect(result.text).toContain('sunny');
    expect(result.text).toContain('91.3');
  });
});

/*
 * The AI SDK runs every tool call of one step at the same time. A failing
 * call's node.error must name that call: without an instanceId the loop guard
 * pins every error on the node's newest open call, the others finish as
 * failures with no error digest, and error-repeat (C4: the same tool failed
 * 3 times in a row with one error -> hold before the 4th call) never fires.
 */
describe('parallel tool failures', () => {
  const usage: Usage = {
    inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 10, text: 10, reasoning: undefined },
  };

  const fetchCall = (id: string, path: string): StreamPart => ({
    type: 'tool-call',
    toolCallId: id,
    toolName: 'fetchUrl',
    input: JSON.stringify({ url: `https://api.example.test/${path}` }),
  });

  /** One entry per model step: the tool calls that step requests ([] = final text). */
  function scriptedModel(steps: StreamPart[][]) {
    let index = 0;
    return new MockLanguageModel({
      doStream: async () => {
        const calls = steps[index++] ?? [];
        const parts: StreamPart[] =
          calls.length > 0
            ? [
                { type: 'stream-start', warnings: [] },
                ...calls,
                { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: 'giving up' },
                { type: 'text-end', id: 't' },
                { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
              ];
        return {
          stream: simulateReadableStream<StreamPart>({ chunks: parts, initialDelayInMs: 2, chunkDelayInMs: 2 }),
        };
      },
    });
  }

  /** Run the agent, continuing every hold; returns every exec.paused seen. */
  async function runFailingAgent(viewer: FakeViewer, gm: Graphmind, steps: StreamPart[][]): Promise<ReceivedFrame[]> {
    const tools = gm.wrapTools({
      fetchUrl: tool({
        description: 'GET a URL',
        inputSchema: z.object({ url: z.string() }),
        // The 404 takes a moment, so the calls of one step overlap.
        execute: async (): Promise<string> => {
          await tick(30);
          throw new Error('HTTP 404 Not Found');
        },
      }),
    });
    let done = false;
    const run = gm
      .run('parallel-failures', async () => {
        const result = streamText({
          model: gm.wrapModel(scriptedModel(steps)),
          tools,
          prompt: 'fetch the thing',
          stopWhen: stepCountIs(steps.length + 1),
          onError: () => {},
        });
        await result.consumeStream();
      })
      .finally(() => {
        done = true;
      });
    const resumed = new Set<string>();
    while (!done) {
      for (const frame of viewer.ofType('exec.paused')) {
        const pauseId = frame.payload['pauseId'] as string;
        if (resumed.has(pauseId)) continue;
        resumed.add(pauseId);
        viewer.resume(pauseId, 'continue');
      }
      await tick(5);
    }
    await run;
    await tick(50);
    return viewer.ofType('exec.paused');
  }

  const errorRepeatHolds = (paused: ReceivedFrame[]): ReceivedFrame[] =>
    paused.filter(
      (f) =>
        f.payload['nodeId'] === 'tool:fetchUrl' &&
        f.payload['reason'] === 'loop' &&
        (f.payload['loop'] as { kind?: string } | undefined)?.kind === 'error-repeat',
    );

  it('three failures one after another hold the 4th call (error-repeat)', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);
    const paused = await runFailingAgent(viewer, gm, [
      [fetchCall('c1', 'a')],
      [fetchCall('c2', 'b')],
      [fetchCall('c3', 'c')],
      [fetchCall('c4', 'd')],
      [],
    ]);
    const holds = errorRepeatHolds(paused);
    expect(holds).toHaveLength(1);
    expect(holds[0]?.payload['instanceId']).toBe('c4');
    expect(holds[0]?.payload['point']).toBe('before');
  });

  it('three failures fanned out in one step hold the 4th call too, and each node.error names its call', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);
    const paused = await runFailingAgent(viewer, gm, [
      [fetchCall('c1', 'a'), fetchCall('c2', 'b'), fetchCall('c3', 'c')],
      [fetchCall('c4', 'd')],
      [],
    ]);

    // c1..c3 really ran at once (the first finish comes after c3 started).
    const started = viewer.ofType('node.started').filter((f) => f.payload['nodeId'] === 'tool:fetchUrl');
    expect(started.map((f) => f.payload['instanceId'])).toEqual(['c1', 'c2', 'c3', 'c4']);
    const finished = viewer.ofType('node.finished').filter((f) => f.payload['nodeId'] === 'tool:fetchUrl');
    expect(finished[0]!.seq).toBeGreaterThan(started[2]!.seq);
    expect(finished.map((f) => f.payload['status'])).toEqual(['error', 'error', 'error', 'error']);

    const errors = viewer.ofType('node.error').filter((f) => f.payload['nodeId'] === 'tool:fetchUrl');
    expect(errors.map((f) => f.payload['instanceId'])).toEqual(['c1', 'c2', 'c3', 'c4']);

    const holds = errorRepeatHolds(paused);
    expect(holds).toHaveLength(1);
    expect(holds[0]?.payload['instanceId']).toBe('c4');
    expect(holds[0]?.payload['point']).toBe('before');
  });
});

describe('fail-open', () => {
  it('auto-continues a held gate when the viewer dies mid-hold', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);

    const { marks, promise } = await startScenario(gm);
    await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(bodyStart(marks, 'searchFlights')).toBeUndefined();

    const killedAt = Date.now();
    viewer.killAbruptly();
    const result = await promise;

    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);
    expect(bodyStart(marks, 'searchFlights')).toBeDefined();
    // Auto-continue is fast: the whole rest of the run finishes well within budget.
    expect(Date.now() - killedAt).toBeLessThan(3000);
    expect(gm.session.stats().heldGates).toBe(0);
    expect(gm.session.attached).toBe(false);
  });
});

describe('error gate', () => {
  it('inject swallows the error and the injected value reaches the next step and the answer', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ name: 'convertCurrency', point: 'error' }],
    });
    await attach(gm);

    const { promise } = await startScenario(gm, { currencyThrows: true });
    const paused = await viewer.waitFor(
      (f) =>
        f.type === 'exec.paused' &&
        f.payload['nodeId'] === 'tool:convertCurrency' &&
        f.payload['point'] === 'error',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'inject', {
      amount: 100,
      converted: 91.3,
      currency: 'USD',
      marker: 'INJECTED-BY-DEBUGGER',
    });

    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);
    // The error never reached the SDK...
    expect(result.onErrorErrors).toHaveLength(0);
    // ...and the injected payload reached the next step's params (the mock's
    // final answer echoes the tool results found in its incoming prompt).
    expect(result.text).toContain('91.3');
    expect(result.text).toContain('INJECTED-BY-DEBUGGER');
    expect(result.finalFinishReason).toContain('stop');

    const finished = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect(finished?.payload['injected']).toBe(true);
    expect(finished?.payload['status']).toBe('ok');
  });

  it('retry re-invokes the original execute', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ name: 'convertCurrency', point: 'error' }],
    });
    await attach(gm);

    const { marks, promise } = await startScenario(gm, { currencyThrowsOnce: true });
    const paused = await viewer.waitFor(
      (f) =>
        f.type === 'exec.paused' &&
        f.payload['nodeId'] === 'tool:convertCurrency' &&
        f.payload['point'] === 'error',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'retry');

    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.stepCount).toBe(3);
    expect(marks.count('tool:body-throw')).toBe(1);
    expect(
      marks.all.filter(
        (m) => m.name === 'tool:body-start' && m.data?.['toolName'] === 'convertCurrency',
      ),
    ).toHaveLength(2);
    // Second attempt succeeded with the real value.
    expect(result.text).toContain('91.3');
    expect(viewer.ofType('node.error').length).toBeGreaterThanOrEqual(1);
  });

  it('continue rethrows: the SDK turns the error into an error-text tool result and keeps looping', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ name: 'convertCurrency', point: 'error' }],
    });
    await attach(gm);

    const { promise } = await startScenario(gm, { currencyThrows: true });
    const paused = await viewer.waitFor(
      (f) =>
        f.type === 'exec.paused' &&
        f.payload['nodeId'] === 'tool:convertCurrency' &&
        f.payload['point'] === 'error',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'continue');

    const result = await promise;
    expect(result.stepCount).toBe(3);
    // The mock's final answer echoes the error-text tool result.
    expect(result.text).toContain('FX rate service returned HTTP 500');
    const finished = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect(finished?.payload['status']).toBe('error');
  });
});

describe('abort action', () => {
  it('aborts via the run AbortController: terminal, no retry storm, no final answer', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);

    const { marks, promise } = await startScenario(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'abort');

    const result = await promise;
    // The tool body never ran and the loop never reached the final answer.
    expect(bodyStart(marks, 'searchFlights')).toBeUndefined();
    expect(result.doStreamCalls).toBeLessThanOrEqual(2);
    expect(result.text).not.toContain('Trip report');

    const runFinished = await viewer.waitFor(
      (f) => f.type === 'run.finished' && f.payload['status'] === 'aborted',
    );
    expect(runFinished).toBeDefined();
    const resumed = viewer
      .ofType('exec.resumed')
      .find((f) => f.payload['action'] === 'abort');
    expect(resumed).toBeDefined();
  });
});
