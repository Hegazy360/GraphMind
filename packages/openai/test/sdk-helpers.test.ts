/**
 * The SDK's own convenience helpers all build on `<resource>.create()`
 * internally. These prove the wrapper's `_client` redirect reaches them:
 * `chat.completions.stream()`, `.parse()` and `.runTools()` gate before the
 * request, stream through the tee, and report usage like a direct call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chatChunks, chatCompletion, chunked, FakeOpenAI } from './helpers/fake-openai.js';
import { tick, waitUntil } from './helpers/fake-viewer.js';
import { attach } from './helpers/scenario.js';
import { framesFor, observedText, setup } from './helpers/setup.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('chat.completions.stream()', () => {
  it('holds before the request, then observes the streamed content', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'sse',
      events: chatChunks({ textChunks: chunked('helper streamed text') }),
    }));
    const rig = await setup(server, { breakpoints: [{ kind: 'llm' }] }, {}, cleanups);
    await attach(rig.gm);

    const stream = rig.client.chat.completions.stream({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const paused = await rig.viewer.waitFor((frame) => frame.type === 'exec.paused');
    await tick(250);
    expect(server.callCount).toBe(0); // nothing in flight while held

    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const final = await stream.finalChatCompletion();
    expect(final.choices[0]?.message.content).toBe('helper streamed text');

    await waitUntil(
      () => framesFor(rig.viewer, 'node.finished', 'llm:step').length === 1,
      5000,
      'finish',
    );
    expect(observedText(rig.viewer, 'llm:step', 'text')).toBe('helper streamed text');
  });
});

describe('chat.completions.parse()', () => {
  it('is instrumented and still returns the parsed completion', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'json',
      body: chatCompletion({ text: '{"city":"Lisbon"}' }),
    }));
    const rig = await setup(server, {}, {}, cleanups);
    await attach(rig.gm);

    const completion = await rig.client.chat.completions.parse({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'where?' }],
    });
    expect(completion.choices[0]?.message.content).toBe('{"city":"Lisbon"}');

    await waitUntil(
      () => framesFor(rig.viewer, 'node.finished', 'llm:step').length === 1,
      5000,
      'finish',
    );
    const finished = framesFor(rig.viewer, 'node.finished', 'llm:step')[0];
    expect(finished?.payload['usage']).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });
});

describe('chat.completions.runTools()', () => {
  it('gates every model turn and the wrapped tool the runner calls', async () => {
    const server = new FakeOpenAI().onChat((_body, index) =>
      index === 0
        ? {
            kind: 'json',
            body: chatCompletion({
              toolCalls: [{ id: 'call-1', name: 'getWeather', args: { city: 'Lisbon' } }],
            }),
          }
        : { kind: 'json', body: chatCompletion({ text: 'It is sunny in Lisbon.' }) },
    );
    const rig = await setup(
      server,
      { breakpoints: [{ kind: 'tool', name: 'getWeather' }] },
      {},
      cleanups,
    );
    await attach(rig.gm);

    let bodyRan = false;
    const tools = rig.gm.wrapTools({
      getWeather: async (args: { city: string }) => {
        bodyRan = true;
        return { city: args.city, forecast: 'sunny' };
      },
    });

    const promise = rig.gm.run('runner', () =>
      rig.client.chat.completions
        .runTools({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'getWeather',
                description: 'Get the weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
                function: tools.getWeather as never,
                parse: JSON.parse,
              },
            },
          ],
        })
        .finalContent(),
    );

    const paused = await rig.viewer.waitFor(
      (frame) => frame.type === 'exec.paused' && frame.payload['nodeId'] === 'tool:getWeather',
    );
    await tick(200);
    expect(bodyRan).toBe(false); // the runner's tool call is held

    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await promise).toBe('It is sunny in Lisbon.');
    expect(bodyRan).toBe(true);

    await waitUntil(
      () => framesFor(rig.viewer, 'node.finished', 'llm:step').length === 2,
      5000,
      'both runner turns reported',
    );
    // Both model turns are steps of ONE invocation of the logical llm node.
    const instances = framesFor(rig.viewer, 'node.started', 'llm:step').map(
      (frame) => frame.payload['instanceId'] as string,
    );
    const invocation = instances[0]?.split(':')[0];
    expect(instances).toEqual([`${invocation}:s0`, `${invocation}:s1`]);
  });
});
