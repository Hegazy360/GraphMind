/**
 * Responses API observation: stream tee exactness across the event types that
 * matter (text / reasoning summaries / tool-call arguments), usage mapping,
 * provider-executed (built-in) tools as ungated nodes, and the `.stream()` /
 * `.parse()` helpers routing through the same gated `create`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chunked, FakeOpenAI, responseEvents, responseObject } from './helpers/fake-openai.js';
import { tick, waitUntil } from './helpers/fake-viewer.js';
import { attach } from './helpers/scenario.js';
import { framesFor, observedText, setup } from './helpers/setup.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const EXPECTED_USAGE = {
  inputTokens: 31,
  outputTokens: 12,
  totalTokens: 43,
  cachedInputTokens: 8,
  reasoningTokens: 5,
};

describe('responses.create', () => {
  it('summarizes a non-streaming response with usage and function calls', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'json',
      body: responseObject({
        text: 'Booked.',
        functionCalls: [
          { id: 'fc_1', callId: 'call_abc', name: 'searchFlights', args: { from: 'VIE', to: 'LIS' } },
        ],
      }),
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    const response = await client.responses.create({ model: 'gpt-5.4', input: 'plan it' });
    expect(response.output_text).toBe('Booked.');

    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    const finished = framesFor(viewer, 'node.finished', 'llm:step')[0];
    expect(finished?.payload['api']).toBe('responses');
    expect(finished?.payload['usage']).toEqual(EXPECTED_USAGE);
    const output = finished?.payload['output'] as Record<string, unknown>;
    expect(output['text']).toBe('Booked.');
    expect(output['toolCalls']).toEqual([
      { id: 'call_abc', name: 'searchFlights', arguments: { from: 'VIE', to: 'LIS' } },
    ]);
  });

  it('tees a streamed response: text, reasoning and tool-args channels', async () => {
    const text = 'Lisbon is sunny and the flight is 199 EUR.';
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'sse',
      events: responseEvents({
        textChunks: chunked(text, 6),
        reasoningChunks: chunked('weighing options', 5),
        functionCalls: [
          { id: 'fc_1', callId: 'call_abc', name: 'checkWeather', args: { city: 'Lisbon' } },
        ],
      }),
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    const stream = await client.responses.create({
      model: 'gpt-5.4',
      input: 'plan it',
      stream: true,
    });
    let consumed = '';
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') consumed += event.delta;
    }
    expect(consumed).toBe(text);

    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    expect(observedText(viewer, 'llm:step', 'text')).toBe(text);
    expect(observedText(viewer, 'llm:step', 'reasoning')).toBe('weighing options');
    expect(observedText(viewer, 'llm:step', 'tool-args')).toBe(JSON.stringify({ city: 'Lisbon' }));

    const finished = framesFor(viewer, 'node.finished', 'llm:step')[0];
    expect(finished?.payload['status']).toBe('ok');
    expect(finished?.payload['streamed']).toBe(true);
    expect(finished?.payload['usage']).toEqual(EXPECTED_USAGE);
  });
});

describe('provider-executed tools', () => {
  it('observes built-in tool calls as ungated nodes (streamed)', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'sse',
      events: responseEvents({
        providerCalls: [{ id: 'ws_1', type: 'web_search_call' }],
        textChunks: chunked('Found it.'),
      }),
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    const stream = await client.responses.create({
      model: 'gpt-5.4',
      input: 'search',
      tools: [{ type: 'web_search' }],
      stream: true,
    });
    for await (const _ of stream) void _;

    await waitUntil(
      () => framesFor(viewer, 'node.finished', 'tool:web_search').length === 1,
      5000,
      'provider tool finished',
    );
    const started = framesFor(viewer, 'node.started', 'tool:web_search')[0];
    expect(started?.payload['instanceId']).toBe('ws_1');
    expect(started?.payload['providerExecuted']).toBe(true);
    expect(started?.payload['ungated']).toBe(true);
    expect(started?.payload['parentId']).toBe('llm:step');

    // graph.hint marks built-ins as ungated too.
    const nodes = viewer.ofType('graph.hint')[0]?.payload['nodes'] as Record<string, unknown>[];
    const hint = nodes.find((node) => node['nodeId'] === 'tool:web_search');
    expect(hint?.['ungated']).toBe(true);
  });

  it('observes built-in tool calls from a non-streaming response', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'json',
      body: responseObject({
        providerCalls: [{ id: 'ci_1', type: 'code_interpreter_call', output: { logs: 'ok' } }],
        text: 'done',
      }),
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    await client.responses.create({ model: 'gpt-5.4', input: 'compute' });
    await waitUntil(
      () => framesFor(viewer, 'node.finished', 'tool:code_interpreter').length === 1,
      5000,
      'provider tool finished',
    );
    const finished = framesFor(viewer, 'node.finished', 'tool:code_interpreter')[0];
    expect(finished?.payload['instanceId']).toBe('ci_1');
    expect(finished?.payload['providerExecuted']).toBe(true);
    expect(finished?.payload['status']).toBe('ok');
  });
});

describe('SDK helpers route through the gated create', () => {
  it('responses.stream() holds BEFORE the HTTP request and then observes it', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'sse',
      events: responseEvents({ textChunks: chunked('helper stream') }),
    }));
    const { viewer, gm, client } = await setup(
      server,
      { breakpoints: [{ kind: 'llm' }] },
      {},
      cleanups,
    );
    await attach(gm);

    const stream = client.responses.stream({ model: 'gpt-5.4', input: 'hi' });
    const paused = await viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'llm:step',
    );
    await tick(300);
    expect(server.callCount).toBe(0); // nothing in flight while the gate is held

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const final = await stream.finalResponse();
    expect(final.output_text).toBe('helper stream');
    expect(server.callCount).toBe(1);

    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    expect(observedText(viewer, 'llm:step', 'text')).toBe('helper stream');
  });

  it('responses.parse() is instrumented and still returns the parsed result', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'json',
      body: responseObject({ text: '{"city":"Lisbon"}' }),
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    const parsed = await client.responses.parse({ model: 'gpt-5.4', input: 'where?' });
    expect(parsed.output_text).toBe('{"city":"Lisbon"}');

    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    expect(framesFor(viewer, 'node.started', 'llm:step').length).toBe(1);
  });
});

describe('invocation chaining', () => {
  it('chains steps through previous_response_id', async () => {
    let call = 0;
    const server = new FakeOpenAI().onResponses(() => {
      call += 1;
      return { kind: 'json', body: responseObject({ id: `resp_${call}`, text: `turn ${call}` }) };
    });
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    await gm.run('chained', async () => {
      const first = await client.responses.create({ model: 'gpt-5.4', input: 'one' });
      await client.responses.create({
        model: 'gpt-5.4',
        input: 'two',
        previous_response_id: first.id,
      });
    });

    await waitUntil(
      () => framesFor(viewer, 'node.finished', 'llm:step').length === 2,
      5000,
      'two finishes',
    );
    const instances = framesFor(viewer, 'node.started', 'llm:step').map(
      (frame) => frame.payload['instanceId'] as string,
    );
    const invocation = instances[0]?.split(':')[0];
    expect(instances).toEqual([`${invocation}:s0`, `${invocation}:s1`]);
    // One invocation -> exactly one graph.hint.
    expect(viewer.ofType('graph.hint').length).toBe(1);
  });
});
