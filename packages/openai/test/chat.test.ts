/**
 * Chat Completions observation: stream tee exactness, batching, usage
 * mapping, graph.hint, node identity, and the non-streaming summary.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  chatChunks,
  chatCompletion,
  chunked,
  FakeOpenAI,
} from './helpers/fake-openai.js';
import { waitUntil } from './helpers/fake-viewer.js';
import { attach, Marks, runChatScenario, scriptChatTurns } from './helpers/scenario.js';
import { framesFor, observedText, observedTextForInstance, setup } from './helpers/setup.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const EXPECTED_USAGE = {
  inputTokens: 20,
  outputTokens: 10,
  totalTokens: 30,
  cachedInputTokens: 4,
  reasoningTokens: 6,
};

describe('stream tee', () => {
  it('observed token deltas are byte-exact vs what the caller consumed', async () => {
    const marks = new Marks();
    const server = new FakeOpenAI().onChat(scriptChatTurns(marks, true));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    const result = await runChatScenario(gm, client, server, { stream: true }, marks);
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    expect(result.text).toContain('TP1234');

    await waitUntil(
      () => framesFor(viewer, 'node.finished', 'llm:step').length >= 3,
      5000,
      'three llm node.finished frames',
    );

    expect(observedText(viewer, 'llm:step', 'text')).toBe(result.turnTexts.join(''));

    // Batching: deltas arrive in node.token batches, not one frame per delta.
    const tokenFrames = framesFor(viewer, 'node.token', 'llm:step');
    const deltaCount = tokenFrames.reduce(
      (n, frame) => n + (frame.payload['deltas'] as unknown[]).length,
      0,
    );
    expect(deltaCount).toBeGreaterThan(tokenFrames.length);
  });

  it('streams tool-call argument deltas on the tool-args channel', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'sse',
      events: chatChunks({
        textChunks: chunked('calling a tool '),
        toolCalls: [{ id: 'call-1', name: 'searchFlights', args: { from: 'VIE', to: 'LIS' } }],
      }),
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    const stream = await client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'go' }],
      stream: true,
    });
    for await (const _ of stream) void _;

    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    expect(observedText(viewer, 'llm:step', 'tool-args')).toBe(
      JSON.stringify({ from: 'VIE', to: 'LIS' }),
    );

    const finished = framesFor(viewer, 'node.finished', 'llm:step')[0];
    const output = finished?.payload['output'] as { toolCalls?: { id: string; name: string }[] };
    expect(output.toolCalls?.[0]).toMatchObject({ id: 'call-1', name: 'searchFlights' });
    expect(finished?.payload['usage']).toEqual(EXPECTED_USAGE);
    expect(finished?.payload['streamed']).toBe(true);
  });

  it('streams reasoning deltas on the reasoning channel', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'sse',
      events: chatChunks({
        reasoningChunks: chunked('thinking about it', 4),
        textChunks: chunked('answer'),
      }),
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    const stream = await client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'go' }],
      stream: true,
    });
    for await (const _ of stream) void _;

    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    expect(observedText(viewer, 'llm:step', 'reasoning')).toBe('thinking about it');
    expect(observedText(viewer, 'llm:step', 'text')).toBe('answer');
  });
});

describe('concurrent executions of the same logical node', () => {
  it('keeps two in-flight streams from interleaving into one another', async () => {
    const alpha = 'AAAA-alpha-AAAA-alpha-AAAA';
    const beta = 'BBBB-beta-BBBB-beta-BBBB-beta';
    const server = new FakeOpenAI().onChat((_body, index) => ({
      kind: 'sse',
      events: chatChunks({ textChunks: chunked(index === 0 ? alpha : beta, 3) }),
      // Different pacing so the two streams genuinely overlap in time.
      chunkDelayMs: index === 0 ? 1 : 3,
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    const drain = async (prompt: string): Promise<string> => {
      const stream = await client.chat.completions.create({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      });
      let text = '';
      for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
      return text;
    };

    const [first, second] = await gm.run('concurrent', () =>
      Promise.all([drain('one'), drain('two')]),
    );
    expect(new Set([first, second])).toEqual(new Set([alpha, beta]));

    await waitUntil(
      () => framesFor(viewer, 'node.finished', 'llm:step').length === 2,
      5000,
      'both observers finished',
    );
    const instances = framesFor(viewer, 'node.started', 'llm:step').map(
      (frame) => frame.payload['instanceId'] as string,
    );
    expect(new Set(instances).size).toBe(2);

    // Every batch is attributed to exactly one execution, and each execution's
    // deltas reconstruct exactly one of the two answers.
    const perInstance = instances.map((id) => observedTextForInstance(viewer, 'llm:step', id, 'text'));
    expect(new Set(perInstance)).toEqual(new Set([alpha, beta]));

    // node.finished is attributed by instanceId too, not by arrival order.
    for (const frame of framesFor(viewer, 'node.finished', 'llm:step')) {
      const id = frame.payload['instanceId'] as string;
      const output = frame.payload['output'] as { text: string };
      expect(output.text).toBe(observedTextForInstance(viewer, 'llm:step', id, 'text'));
    }
  });
});

describe('non-streaming', () => {
  it('reports text, tool calls, finish reason and usage on node.finished', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'json',
      body: chatCompletion({
        text: 'here you go',
        toolCalls: [{ id: 'call-9', name: 'checkWeather', args: { city: 'Lisbon' } }],
      }),
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    await client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'go' }],
    });

    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    const finished = framesFor(viewer, 'node.finished', 'llm:step')[0];
    expect(finished?.payload['status']).toBe('ok');
    expect(finished?.payload['usage']).toEqual(EXPECTED_USAGE);
    expect(finished?.payload['api']).toBe('chat.completions');
    const output = finished?.payload['output'] as Record<string, unknown>;
    expect(output['text']).toBe('here you go');
    expect(output['finishReason']).toBe('tool_calls');
    expect(output['toolCalls']).toEqual([
      { id: 'call-9', name: 'checkWeather', arguments: { city: 'Lisbon' } },
    ]);
  });
});

describe('graph.hint and node identity', () => {
  it('emits the full node roster on an invocation first step', async () => {
    const marks = new Marks();
    const server = new FakeOpenAI().onChat(scriptChatTurns(marks, false));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    const result = await runChatScenario(gm, client, server, { runName: 'trip-run' }, marks);
    expect(result.runError).toBeUndefined();

    const hints = viewer.ofType('graph.hint');
    expect(hints.length).toBe(1); // one invocation -> one hint
    const nodes = hints[0]?.payload['nodes'] as { nodeId: string; kind: string; name: string }[];
    expect(nodes.map((n) => n.nodeId)).toEqual([
      'agent:trip-run',
      'llm:step',
      'tool:searchFlights',
      'tool:checkWeather',
      'tool:convertCurrency',
    ]);
    expect(nodes.every((n) => n.kind !== 'tool' || !('ungated' in n))).toBe(true);
  });

  it('keeps one logical llm node with a distinct instanceId per request', async () => {
    const marks = new Marks();
    const server = new FakeOpenAI().onChat(scriptChatTurns(marks, false));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);

    await runChatScenario(gm, client, server, {}, marks);
    await waitUntil(
      () => framesFor(viewer, 'node.finished', 'llm:step').length >= 3,
      5000,
      'three finishes',
    );

    const started = framesFor(viewer, 'node.started', 'llm:step');
    const instances = started.map((frame) => frame.payload['instanceId'] as string);
    expect(instances.length).toBe(3);
    expect(new Set(instances).size).toBe(3);
    // Same invocation, growing step index: the loop is ONE invocation.
    const invocation = instances[0]?.split(':')[0];
    expect(instances).toEqual([`${invocation}:s0`, `${invocation}:s1`, `${invocation}:s2`]);

    // node.finished carries the instanceId back (schema field, not a loose one).
    const finished = framesFor(viewer, 'node.finished', 'llm:step');
    expect(finished.map((frame) => frame.payload['instanceId'])).toEqual(instances);

    // Tool executions use the OpenAI tool-call id as their instanceId.
    const toolStarts = framesFor(viewer, 'node.started', 'tool:searchFlights');
    expect(toolStarts[0]?.payload['instanceId']).toBe('call-flights-1');
    expect(toolStarts[0]?.payload['parentId']).toBe('llm:step');
  });
});
