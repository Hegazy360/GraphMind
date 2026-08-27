/**
 * Gate semantics through the REAL public API (graphmind -> wrapClient /
 * wrapTools -> a hand-written OpenAI tool loop) against a fake debugger
 * WebSocket server and a scripted OpenAI HTTP endpoint.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chatCompletion, chunked, FakeOpenAI, responseEvents } from './helpers/fake-openai.js';
import { tick, waitUntil } from './helpers/fake-viewer.js';
import { attach, Marks, runChatScenario, scriptChatTurns, type ScenarioFlags } from './helpers/scenario.js';
import { framesFor, setup } from './helpers/setup.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function bodyStart(marks: Marks, toolName: string) {
  return marks.first('tool:body-start', (mark) => mark.data?.['toolName'] === toolName);
}

async function harness(
  viewerOptions: Parameters<typeof setup>[1] = {},
  flags: ScenarioFlags = {},
  gmOptions: Parameters<typeof setup>[2] = {},
) {
  const marks = new Marks();
  const server = new FakeOpenAI().onChat(scriptChatTurns(marks, flags.stream === true));
  const rig = await setup(server, viewerOptions, gmOptions, cleanups);
  await attach(rig.gm);
  return { ...rig, marks, flags };
}

describe('breakpoint hold + resume', () => {
  it('holds a model gate BEFORE the HTTP request goes out', async () => {
    const rig = await harness({ breakpoints: [{ kind: 'llm' }] });
    const promise = runChatScenario(rig.gm, rig.client, rig.server, {}, rig.marks);

    const paused = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'llm:step',
    );
    expect(paused.payload['point']).toBe('before');
    await tick(400);
    expect(rig.server.callCount).toBe(0); // nothing in flight while held

    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await waitUntil(() => rig.server.callCount === 1, 5000, 'first request');

    for (let step = 2; step <= 3; step += 1) {
      const next = await rig.viewer.waitForNth(
        (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'llm:step',
        step,
      );
      rig.viewer.resume(next.payload['pauseId'] as string, 'continue');
    }
    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    expect(result.text).toContain('TP1234');
  });

  it('holds a tool gate >= 2s until the viewer resumes, then completes', async () => {
    const rig = await harness({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    const promise = runChatScenario(rig.gm, rig.client, rig.server, {}, rig.marks);

    const paused = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'tool:searchFlights',
    );
    const pausedAt = Date.now();
    await tick(2000);
    expect(bodyStart(rig.marks, 'searchFlights')).toBeUndefined();

    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const result = await promise;

    expect(result.runError).toBeUndefined();
    expect(result.text).toContain('TP1234');
    const started = bodyStart(rig.marks, 'searchFlights');
    expect(started).toBeDefined();
    expect(started!.at - pausedAt).toBeGreaterThanOrEqual(1950);
    expect(rig.viewer.ofType('exec.resumed').length).toBeGreaterThanOrEqual(1);
  });
});

describe('parallel tool calls', () => {
  it('gates two parallel calls independently', async () => {
    const rig = await harness({
      breakpoints: [
        { kind: 'tool', name: 'checkWeather' },
        { kind: 'tool', name: 'convertCurrency' },
      ],
    });
    const promise = runChatScenario(rig.gm, rig.client, rig.server, {}, rig.marks);

    const weather = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'tool:checkWeather',
    );
    const currency = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'tool:convertCurrency',
    );

    expect(rig.gm.session.stats().heldGates).toBe(2);
    expect(bodyStart(rig.marks, 'checkWeather')).toBeUndefined();
    expect(bodyStart(rig.marks, 'convertCurrency')).toBeUndefined();

    rig.viewer.resume(weather.payload['pauseId'] as string, 'continue');
    await waitUntil(
      () => rig.marks.first('tool:body-end', (m) => m.data?.['toolName'] === 'checkWeather') !== undefined,
      5000,
      'checkWeather body',
    );
    await tick(250);
    expect(bodyStart(rig.marks, 'convertCurrency')).toBeUndefined();
    expect(rig.gm.session.stats().heldGates).toBe(1);

    rig.viewer.resume(currency.payload['pauseId'] as string, 'continue');
    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.text).toContain('sunny');
    expect(result.text).toContain('91.3');
  });
});

describe('error gate on tools', () => {
  it('inject substitutes the tool result and it reaches the next model turn', async () => {
    const rig = await harness({ breakpoints: [{ point: 'error' }] }, {});
    const promise = runChatScenario(
      rig.gm,
      rig.client,
      rig.server,
      { currencyThrows: true },
      rig.marks,
    );

    const paused = await rig.viewer.waitFor(
      (frame) =>
        frame.type === 'exec.paused' &&
        frame.payload['nodeId'] === 'tool:convertCurrency' &&
        frame.payload['point'] === 'error',
    );
    rig.viewer.resume(paused.payload['pauseId'] as string, 'inject', {
      amount: 100,
      converted: 42.42,
      currency: 'USD',
      injectedByDebugger: true,
    });

    const result = await promise;
    expect(result.runError).toBeUndefined();
    // The injected value travelled through the tool message into the answer.
    expect(result.text).toContain('42.42');
    expect(result.text).toContain('injectedByDebugger');

    const finished = framesFor(rig.viewer, 'node.finished', 'tool:convertCurrency')[0];
    expect(finished?.payload['injected']).toBe(true);
    expect(finished?.payload['status']).toBe('ok');
    expect(finished?.payload['instanceId']).toBe('call-currency-1');
  });

  it('retry re-runs the tool body; the second attempt succeeds', async () => {
    const rig = await harness({ breakpoints: [{ point: 'error' }] });
    const promise = runChatScenario(
      rig.gm,
      rig.client,
      rig.server,
      { currencyThrowsOnce: true },
      rig.marks,
    );

    const paused = await rig.viewer.waitFor(
      (frame) =>
        frame.type === 'exec.paused' && frame.payload['nodeId'] === 'tool:convertCurrency',
    );
    rig.viewer.resume(paused.payload['pauseId'] as string, 'retry');

    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(rig.marks.count('tool:body-start')).toBeGreaterThanOrEqual(4); // 3 tools + 1 retry
    expect(result.text).toContain('91.3');
  });

  it('continue rethrows the original error into the host loop', async () => {
    const rig = await harness({ breakpoints: [{ point: 'error' }] });
    const promise = runChatScenario(
      rig.gm,
      rig.client,
      rig.server,
      { currencyThrows: true },
      rig.marks,
    );

    const paused = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'tool:convertCurrency',
    );
    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');

    const result = await promise;
    expect((result.runError as Error).message).toContain('FX rate service');
    await waitUntil(
      () => framesFor(rig.viewer, 'node.finished', 'tool:convertCurrency').length > 0,
      5000,
      'tool finish frame',
    );
    const finished = framesFor(rig.viewer, 'node.finished', 'tool:convertCurrency')[0];
    expect(finished?.payload['status']).toBe('error');
  });

  it('abort aborts the run and surfaces an AbortError', async () => {
    const rig = await harness({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    const promise = runChatScenario(rig.gm, rig.client, rig.server, {}, rig.marks);

    const paused = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'tool:searchFlights',
    );
    rig.viewer.resume(paused.payload['pauseId'] as string, 'abort');

    const result = await promise;
    expect((result.runError as Error).name).toBe('AbortError');
    expect(bodyStart(rig.marks, 'searchFlights')).toBeUndefined();
    const runFinished = await rig.viewer.waitForType('run.finished');
    expect(runFinished.payload['status']).toBe('aborted');
  });
});

describe('error gate on model requests', () => {
  it('retry re-issues the request after an API error', async () => {
    let call = 0;
    const server = new FakeOpenAI().onChat(() => {
      call += 1;
      if (call === 1) return { kind: 'status', status: 500, body: { error: { message: 'upstream boom' } } };
      return { kind: 'json', body: chatCompletion({ text: 'recovered' }) };
    });
    const rig = await setup(server, { breakpoints: [{ point: 'error' }] }, {}, cleanups);
    await attach(rig.gm);

    const promise = rig.client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const paused = await rig.viewer.waitFor(
      (frame) =>
        frame.type === 'exec.paused' &&
        frame.payload['nodeId'] === 'llm:step' &&
        frame.payload['point'] === 'error',
    );
    rig.viewer.resume(paused.payload['pauseId'] as string, 'retry');

    const completion = await promise;
    expect(completion.choices[0]?.message.content).toBe('recovered');
    expect(server.callCount).toBe(2);
    expect(framesFor(rig.viewer, 'node.error', 'llm:step').length).toBe(1);

    await waitUntil(
      () => framesFor(rig.viewer, 'node.finished', 'llm:step').length > 0,
      5000,
      'llm finish frame',
    );
    // A retried request stays ONE execution of the node, with the attempt
    // count recorded — the viewer shows one node lighting up twice, not two.
    const started = framesFor(rig.viewer, 'node.started', 'llm:step');
    const finished = framesFor(rig.viewer, 'node.finished', 'llm:step');
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload['instanceId']).toBe(started[0]?.payload['instanceId']);
    expect(finished[0]?.payload['attempts']).toBe(2);
  });

  it('inject substitutes the completion returned by create()', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'status',
      status: 500,
      body: { error: { message: 'upstream boom' } },
    }));
    const rig = await setup(server, { breakpoints: [{ point: 'error' }] }, {}, cleanups);
    await attach(rig.gm);

    const promise = rig.client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const paused = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['point'] === 'error',
    );
    rig.viewer.resume(
      paused.payload['pauseId'] as string,
      'inject',
      chatCompletion({ text: 'substituted by the debugger' }),
    );

    const completion = (await promise) as { choices: { message: { content: string } }[] };
    expect(completion.choices[0]?.message.content).toBe('substituted by the debugger');
    await waitUntil(
      () => framesFor(rig.viewer, 'node.finished', 'llm:step').length > 0,
      5000,
      'llm finish frame',
    );
    const finished = framesFor(rig.viewer, 'node.finished', 'llm:step')[0];
    expect(finished?.payload['injected']).toBe(true);
  });

  it('continue rethrows the SDK error untouched', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'status',
      status: 500,
      body: { error: { message: 'upstream boom' } },
    }));
    const rig = await setup(server, { breakpoints: [{ point: 'error' }] }, {}, cleanups);
    await attach(rig.gm);

    const promise = rig.client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const paused = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['point'] === 'error',
    );
    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');

    await expect(promise).rejects.toThrow(/upstream boom/);
    await waitUntil(
      () => framesFor(rig.viewer, 'node.finished', 'llm:step').length > 0,
      5000,
      'llm finish frame',
    );
    const finished = framesFor(rig.viewer, 'node.finished', 'llm:step')[0];
    expect(finished?.payload['status']).toBe('error');
  });
});

describe('after gate', () => {
  it('substitutes a non-streaming completion in step mode', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'json',
      body: chatCompletion({ text: 'from the API' }),
    }));
    const rig = await setup(server, { breakpoints: [{ point: 'after', kind: 'llm' }] }, {}, cleanups);
    await attach(rig.gm);

    const promise = rig.client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const paused = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['point'] === 'after',
    );
    rig.viewer.resume(
      paused.payload['pauseId'] as string,
      'inject',
      chatCompletion({ text: 'rewritten after the fact' }),
    );

    const completion = (await promise) as { choices: { message: { content: string } }[] };
    expect(completion.choices[0]?.message.content).toBe('rewritten after the fact');
  });
});

describe('fail-open', () => {
  it('auto-continues every held gate when the debugger disconnects mid-hold', async () => {
    const rig = await harness({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    const promise = runChatScenario(rig.gm, rig.client, rig.server, {}, rig.marks);

    await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(rig.gm.session.stats().heldGates).toBe(1);

    rig.viewer.killAbruptly();

    const result = await promise;
    expect(result.runError).toBeUndefined();
    expect(result.text).toContain('TP1234');
    expect(rig.gm.session.stats().heldGates).toBe(0);
  });

  it('step mode pauses before every model request and tool call', async () => {
    const rig = await harness({ mode: 'step' });
    const promise = runChatScenario(rig.gm, rig.client, rig.server, {}, rig.marks);

    // Resume everything as it arrives.
    const seen = new Set<string>();
    const pump = setInterval(() => {
      for (const frame of rig.viewer.ofType('exec.paused')) {
        const pauseId = frame.payload['pauseId'] as string;
        if (seen.has(pauseId)) continue;
        seen.add(pauseId);
        rig.viewer.resume(pauseId, 'continue');
      }
    }, 10);
    const result = await promise;
    clearInterval(pump);

    expect(result.runError).toBeUndefined();
    // 3 model requests + 3 tool calls + the agent-node warm-up gate.
    expect(seen.size).toBeGreaterThanOrEqual(6);
    expect(result.text).toContain('TP1234');
  });
});

describe('responses API gating', () => {
  it('holds before a streamed responses.create and resumes into the tee', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'sse',
      events: responseEvents({ textChunks: chunked('gated responses stream') }),
    }));
    const rig = await setup(server, { breakpoints: [{ kind: 'llm' }] }, {}, cleanups);
    await attach(rig.gm);

    const promise = rig.client.responses.create({
      model: 'gpt-5.4',
      input: 'hello',
      stream: true,
    });
    const paused = await rig.viewer.waitFor((frame) => frame.type === 'exec.paused');
    await tick(250);
    expect(server.callCount).toBe(0);

    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const stream = await promise;
    let text = '';
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') text += event.delta;
    }
    expect(text).toBe('gated responses stream');
  });
});
