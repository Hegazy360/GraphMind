/**
 * Pass-through fidelity: whatever the SDK would have returned, the wrapped
 * client returns — same values, same `APIPromise` helpers, same stream
 * semantics — attached, detached, streaming and not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { graphmind } from '../src/index.js';
import {
  chatChunks,
  chatCompletion,
  chunked,
  FakeOpenAI,
  responseEvents,
  responseObject,
} from './helpers/fake-openai.js';
import { attach } from './helpers/scenario.js';
import { setup } from './helpers/setup.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const CHAT_BODY = {
  model: 'gpt-5.4',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('chat.completions', () => {
  it('returns the identical completion object the raw client would', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'json',
      body: chatCompletion({ text: 'hello world' }),
    }));
    const rig = await setup(server, {}, {}, cleanups);
    await attach(rig.gm);

    const wrapped = await rig.client.chat.completions.create(CHAT_BODY);
    const raw = await rig.raw.chat.completions.create(CHAT_BODY);
    expect(wrapped).toEqual(raw);
    expect(wrapped.choices[0]?.message.content).toBe('hello world');
  });

  it('keeps the APIPromise helpers working (asResponse / withResponse)', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'json',
      body: chatCompletion({ text: 'with headers' }),
    }));
    const rig = await setup(server, {}, {}, cleanups);
    await attach(rig.gm);

    const promise = rig.client.chat.completions.create(CHAT_BODY);
    expect(promise).toBeInstanceOf(Promise);
    const { data, response, request_id } = await promise.withResponse();
    expect(data.choices[0]?.message.content).toBe('with headers');
    expect(response.status).toBe(200);
    expect(request_id).toBe('req_fake');

    const bare = await rig.client.chat.completions.create(CHAT_BODY).asResponse();
    expect(bare.status).toBe(200);
  });

  it('streams the exact chunk sequence to the caller', async () => {
    const pieces = chunked('streamed answer that arrives in pieces', 4);
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'sse',
      events: chatChunks({ textChunks: pieces }),
    }));
    const rig = await setup(server, {}, {}, cleanups);
    await attach(rig.gm);

    const stream = await rig.client.chat.completions.create({ ...CHAT_BODY, stream: true });
    const seen: string[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;
      if (typeof delta === 'string' && delta.length > 0) seen.push(delta);
    }
    expect(seen).toEqual(pieces);
    expect(stream.controller).toBeInstanceOf(AbortController);
  });
});

describe('responses', () => {
  it('returns the identical response object the raw client would', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'json',
      body: responseObject({ text: 'responses answer' }),
    }));
    const rig = await setup(server, {}, {}, cleanups);
    await attach(rig.gm);

    const wrapped = await rig.client.responses.create({ model: 'gpt-5.4', input: 'hi' });
    const raw = await rig.raw.responses.create({ model: 'gpt-5.4', input: 'hi' });
    expect(wrapped).toEqual(raw);
    // `output_text` is added by the SDK's own `_thenUnwrap`, so this proves the
    // wrapper did not swallow the SDK's post-processing.
    expect(wrapped.output_text).toBe('responses answer');
  });

  it('responses.stream() emits the same events and final response', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'sse',
      events: responseEvents({ textChunks: chunked('streamed responses', 4) }),
    }));
    const rig = await setup(server, {}, {}, cleanups);
    await attach(rig.gm);

    const stream = rig.client.responses.stream({ model: 'gpt-5.4', input: 'hi' });
    let text = '';
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') text += event.delta;
    }
    const final = await stream.finalResponse();
    expect(text).toBe('streamed responses');
    expect(final.output_text).toBe('streamed responses');
  });
});

describe('detached', () => {
  it('behaves identically with no debugger listening', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'sse',
      events: chatChunks({ textChunks: chunked('nobody is watching', 5) }),
    }));
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const client = gm.wrapClient(new OpenAI({ apiKey: 'k', fetch: server.fetch }));

    const stream = await client.chat.completions.create({ ...CHAT_BODY, stream: true });
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
    expect(text).toBe('nobody is watching');
  });
});
