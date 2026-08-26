/**
 * Gate semantics through the REAL public API (graphmind -> wrapModel/
 * wrapTools -> streamText on ai@7 mock models) against a fake debugger
 * WebSocket server. Re-proves the spike's scenarios at this layer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions } from './helpers/fake-viewer.js';
import { attach, runScenario, Marks, type ScenarioFlags } from './helpers/scenario.js';

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
