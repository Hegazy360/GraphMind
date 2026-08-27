/**
 * Gate semantics through the REAL public API (graphmind -> wrapClient /
 * wrapTools -> a raw Anthropic tool loop on the real @anthropic-ai/sdk client
 * with a scripted fetch) against a fake debugger WebSocket server.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions } from './helpers/fake-viewer.js';
import {
  FakeAnthropicTransport,
  assistantEvents,
  assistantMessage,
} from './helpers/fake-anthropic.js';
import {
  Marks,
  TOOL_USE_IDS,
  attach,
  makeScript,
  runScenario,
  type ScenarioFlags,
  type TransportMode,
} from './helpers/scenario.js';

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

function start(gm: Graphmind, flags: ScenarioFlags = {}) {
  const marks = new Marks();
  const transport = new FakeAnthropicTransport(makeScript(flags));
  const promise = runScenario(gm, flags, marks, transport);
  return { marks, transport, promise };
}

const MODES: TransportMode[] = ['create', 'create-stream', 'stream-helper'];

describe('LLM gate: nothing is in flight while held', () => {
  for (const mode of MODES) {
    it(`holds BEFORE the HTTP request (${mode})`, async () => {
      const { viewer, gm } = await setup({ breakpoints: [{ kind: 'llm' }] });
      await attach(gm);

      const { transport, promise } = start(gm, { mode });
      const paused = await viewer.waitFor(
        (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
      );
      expect(paused.payload['point']).toBe('before');

      await tick(400);
      // The core guarantee: no request was issued while the gate was held.
      expect(transport.requests).toHaveLength(0);

      viewer.resume(paused.payload['pauseId'] as string, 'continue');
      await waitUntil(() => transport.requests.length === 1, 5000, 'first request');

      for (let turn = 2; turn <= 3; turn += 1) {
        const next = await viewer.waitForNth(
          (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
          turn,
        );
        expect(transport.requests).toHaveLength(turn - 1);
        viewer.resume(next.payload['pauseId'] as string, 'continue');
      }

      const result = await promise;
      expect(result.runError).toBeUndefined();
      expect(result.turns).toBe(3);
      expect(result.requestCount).toBe(3);
      expect(result.text).toContain('TP1234');
    });
  }

  it('aborting the LLM gate issues no request at all', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'llm' }] });
    await attach(gm);

    const { transport, promise } = start(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'abort');

    const result = await promise;
    expect(transport.requests).toHaveLength(0);
    expect(result.runError).toBeDefined();
    const runFinished = await viewer.waitFor(
      (f) => f.type === 'run.finished' && f.payload['status'] === 'aborted',
    );
    expect(runFinished).toBeDefined();
  });
});

describe('client.beta.messages', () => {
  it('gates beta create and the beta stream helper before the request', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'llm' }] });
    await attach(gm);

    const transport = new FakeAnthropicTransport((_body, index) =>
      index === 0
        ? { message: assistantMessage('b0', 'beta ok') }
        : { events: assistantEvents('b1', 'beta streamed') },
    );
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const client = gm.wrapClient(
      new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch: transport.fetch }),
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    ) as any;
    const params = {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    };

    const pending = client.beta.messages.create(params);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
    );
    await tick(200);
    expect(transport.requests).toHaveLength(0);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect((await pending).content[0].text).toBe('beta ok');

    const helper = client.beta.messages.stream(params);
    const paused2 = await viewer.waitForNth(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
      2,
    );
    await tick(200);
    expect(transport.requests).toHaveLength(1); // the helper's request is held too
    viewer.resume(paused2.payload['pauseId'] as string, 'continue');
    const final = await helper.finalMessage();
    expect(final.content[0].text).toBe('beta streamed');
    expect(transport.requests).toHaveLength(2);
  });
});

describe('tool gate hold + resume', () => {
  it('holds a tool gate >= 1s until the viewer resumes, then completes', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);

    const { marks, promise } = start(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    const pausedAt = Date.now();
    await tick(1000);
    expect(bodyStart(marks, 'searchFlights')).toBeUndefined();

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const result = await promise;

    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    expect(result.text).toContain('TP1234');
    const started = bodyStart(marks, 'searchFlights');
    expect(started).toBeDefined();
    expect(started!.at - pausedAt).toBeGreaterThanOrEqual(950);
  });

  it('the tool node instanceId is the model tool_use id', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const result = await runScenario(gm);
    expect(result.runError).toBeUndefined();

    const started = viewer
      .ofType('node.started')
      .filter((f) => (f.payload['nodeId'] as string).startsWith('tool:'));
    const byNode = new Map(started.map((f) => [f.payload['nodeId'], f.payload['instanceId']]));
    expect(byNode.get('tool:searchFlights')).toBe(TOOL_USE_IDS.flights);
    expect(byNode.get('tool:checkWeather')).toBe(TOOL_USE_IDS.weather);
    expect(byNode.get('tool:convertCurrency')).toBe(TOOL_USE_IDS.currency);
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

    const { marks, promise } = start(gm);
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
      () =>
        marks.first('tool:body-end', (m) => m.data?.['toolName'] === 'checkWeather') !== undefined,
      5000,
      'checkWeather body',
    );
    await tick(200);
    expect(bodyStart(marks, 'convertCurrency')).toBeUndefined();
    expect(gm.session.stats().heldGates).toBe(1);

    viewer.resume(pausedCurrency.payload['pauseId'] as string, 'continue');
    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    expect(result.text).toContain('sunny');
    expect(result.text).toContain('91.3');
  });
});

describe('error gate', () => {
  it('inject swallows the error and the injected value reaches the next turn and the answer', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ name: 'convertCurrency', point: 'error' }],
    });
    await attach(gm);

    const { promise } = start(gm, { currencyThrows: true });
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
    expect(result.turns).toBe(3);
    // The error never reached the host loop...
    expect(result.toolErrors).toHaveLength(0);
    // ...and the injected payload reached the next request's messages (the
    // script's final turn echoes the tool_result payloads it received).
    expect(result.text).toContain('91.3');
    expect(result.text).toContain('INJECTED-BY-DEBUGGER');

    const finished = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect(finished?.payload['injected']).toBe(true);
    expect(finished?.payload['status']).toBe('ok');
    expect(finished?.payload['instanceId']).toBe(TOOL_USE_IDS.currency);
  });

  it('retry re-invokes the original function', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ name: 'convertCurrency', point: 'error' }],
    });
    await attach(gm);

    const { marks, promise } = start(gm, { currencyThrowsOnce: true });
    const paused = await viewer.waitFor(
      (f) =>
        f.type === 'exec.paused' &&
        f.payload['nodeId'] === 'tool:convertCurrency' &&
        f.payload['point'] === 'error',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'retry');

    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    expect(marks.count('tool:body-throw')).toBe(1);
    expect(
      marks.all.filter(
        (m) => m.name === 'tool:body-start' && m.data?.['toolName'] === 'convertCurrency',
      ),
    ).toHaveLength(2);
    expect(result.text).toContain('91.3');
    expect(viewer.ofType('node.error').length).toBeGreaterThanOrEqual(1);
  });

  it('continue rethrows: the host loop sees the original error', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ name: 'convertCurrency', point: 'error' }],
    });
    await attach(gm);

    const { promise } = start(gm, { currencyThrows: true });
    const paused = await viewer.waitFor(
      (f) =>
        f.type === 'exec.paused' &&
        f.payload['nodeId'] === 'tool:convertCurrency' &&
        f.payload['point'] === 'error',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'continue');

    const result = await promise;
    expect(result.turns).toBe(3);
    expect(result.toolErrors).toEqual(['FX rate service returned HTTP 500']);
    expect(result.text).toContain('FX rate service returned HTTP 500');
    const finished = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect(finished?.payload['status']).toBe('error');
  });
});

describe('abort action on a tool', () => {
  it('aborts the run: the tool body never runs and no further request is issued', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);

    const { marks, transport, promise } = start(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'abort');

    const result = await promise;
    expect(bodyStart(marks, 'searchFlights')).toBeUndefined();
    expect(transport.requests).toHaveLength(1); // turn 0 only
    expect(result.text).not.toContain('Trip report');

    const runFinished = await viewer.waitFor(
      (f) => f.type === 'run.finished' && f.payload['status'] === 'aborted',
    );
    expect(runFinished).toBeDefined();
    expect(
      viewer.ofType('exec.resumed').find((f) => f.payload['action'] === 'abort'),
    ).toBeDefined();
  });
});

describe('fail-open', () => {
  it('auto-continues a held tool gate when the viewer dies mid-hold', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);

    const { marks, promise } = start(gm);
    await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(bodyStart(marks, 'searchFlights')).toBeUndefined();

    const killedAt = Date.now();
    viewer.killAbruptly();
    const result = await promise;

    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    expect(bodyStart(marks, 'searchFlights')).toBeDefined();
    expect(Date.now() - killedAt).toBeLessThan(3000);
    expect(gm.session.stats().heldGates).toBe(0);
    expect(gm.session.attached).toBe(false);
  });

  it('auto-continues a held LLM gate and still issues the request', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'llm' }] });
    await attach(gm);

    const { transport, promise } = start(gm, { mode: 'stream-helper' });
    await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step',
    );
    expect(transport.requests).toHaveLength(0);

    viewer.killAbruptly();
    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.requestCount).toBe(3);
    expect(gm.session.stats().heldGates).toBe(0);
  });
});

describe('step mode', () => {
  it('pauses at every before gate, including the after gate on tools', async () => {
    const { viewer, gm } = await setup({ mode: 'step' });
    await attach(gm);

    const { promise } = start(gm, { runName: 'stepped' });
    // Drain every pause the debugger raises until the run finishes.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    const seen = new Set<string>();
    while (!settled) {
      for (const frame of viewer.ofType('exec.paused')) {
        const pauseId = frame.payload['pauseId'] as string;
        if (seen.has(pauseId)) continue;
        seen.add(pauseId);
        viewer.resume(pauseId, 'continue');
      }
      await tick(10);
    }
    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    // 3 llm steps + 3 tool calls, all gated at `before`.
    expect(seen.size).toBeGreaterThanOrEqual(6);
    const points = new Set(viewer.ofType('exec.paused').map((f) => f.payload['point']));
    expect(points.has('before')).toBe(true);
  });
});
