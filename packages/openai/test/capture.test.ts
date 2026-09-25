/**
 * Contract C1 on the OpenAI adapter, through the REAL SDK client:
 *   - usage mapping per the shared fixture (chat + responses), inclusive,
 *     cache read / write / reasoning only when reported, legacy extras kept;
 *   - streaming chat: usage from the LAST chunk (include_usage, empty
 *     choices), tool calls cut off by `length` recorded with `inputText`;
 *   - responses: `incomplete` with max_output_tokens -> finishReason length;
 *   - node.started.input: sampling params under the API's names, tools by
 *     schema hash once per run, never metadata/user or request options;
 *   - every envelope validates.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { schemaHash } from '@graphmind-ai/client';
import { mapChatUsage, mapResponsesUsage } from '../src/sdk-types.js';
import { FakeOpenAI, chatChunks, responseObject } from './helpers/fake-openai.js';
import type { FakeViewer } from './helpers/fake-viewer.js';
import { waitUntil } from './helpers/fake-viewer.js';
import { attach } from './helpers/scenario.js';
import { framesFor, setup } from './helpers/setup.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function usageCases(provider: string): [string, unknown, unknown][] {
  const fixture = JSON.parse(
    readFileSync(new URL('../../client/test/fixtures/llm.json', import.meta.url), 'utf8'),
  ) as { usage: { provider: string; name: string; raw: unknown; out: unknown }[] };
  return fixture.usage.filter((c) => c.provider === provider).map((c) => [c.name, c.raw, c.out]);
}

/** The fixture compares canonical fields; the 0.5 extras are checked separately. */
function canonical(usage: Record<string, unknown> | undefined): unknown {
  if (usage === undefined) return null;
  const { cachedInputTokens: _a, totalTokens: _b, ...rest } = usage;
  return rest;
}

function expectAllValid(viewer: FakeViewer): void {
  for (const frame of viewer.received) expect(parseEnvelope(frame).kind, frame.type).toBe('ok');
}

describe('usage mapping (shared fixture)', () => {
  it.each(usageCases('openai-chat'))('chat: %s', (_name, raw, expected) => {
    expect(canonical(mapChatUsage(raw as never))).toEqual(expected);
  });

  it.each(usageCases('openai-responses'))('responses: %s', (_name, raw, expected) => {
    expect(canonical(mapResponsesUsage(raw as never))).toEqual(expected);
  });

  it('keeps the 0.5 extras: totalTokens as reported, cachedInputTokens = cacheReadTokens', () => {
    for (const [, raw] of [...usageCases('openai-chat'), ...usageCases('openai-responses')]) {
      const usage = (mapChatUsage(raw as never) ?? mapResponsesUsage(raw as never)) as Record<string, unknown> | undefined;
      if (usage === undefined) continue;
      expect(usage['cachedInputTokens']).toBe(usage['cacheReadTokens']);
      const total = (raw as { total_tokens?: number }).total_tokens;
      expect(usage['totalTokens']).toBe(total);
    }
  });
});

describe('chat.completions', () => {
  it('node.started.input: sampling params, tools by hash once per run, no metadata/user/options', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'json',
      body: {
        id: 'c1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5.4',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      },
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);
    const weather = {
      type: 'function' as const,
      function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
    };
    const history = Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `m${i} ${'y'.repeat(2500)}` }));
    const body = {
      model: 'gpt-5.4',
      messages: history,
      temperature: 0.1,
      max_completion_tokens: 500,
      top_p: 0.5,
      stop: ['END'],
      seed: 3,
      tool_choice: 'auto' as const,
      parallel_tool_calls: false,
      reasoning_effort: 'low' as const,
      tools: [weather],
      metadata: { tenant: 'SECRET-META' },
      user: 'SECRET-USER',
    };
    await gm.run('chat-run', async () => {
      await client.chat.completions.create(body, { headers: { 'x-secret': 'SECRET-HEADER' } });
      await client.chat.completions.create({ ...body, messages: [...history, { role: 'user', content: 'more' }] });
    });
    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length >= 2, 5000, 'two finishes');
    const [first, second] = framesFor(viewer, 'node.started', 'llm:step').map(
      (f) => f.payload['input'] as Record<string, unknown>,
    );
    const hash = schemaHash(weather);
    expect(first).toMatchObject({
      api: 'chat.completions',
      model: 'gpt-5.4',
      messages: history,
      temperature: 0.1,
      max_completion_tokens: 500,
      top_p: 0.5,
      stop: ['END'],
      seed: 3,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning_effort: 'low',
      tools: [{ name: 'get_weather', schemaHash: hash }],
      toolSchemas: { [hash]: weather },
    });
    expect(second?.['tools']).toEqual([{ name: 'get_weather', schemaHash: hash }]);
    expect(second).not.toHaveProperty('toolSchemas');
    const all = JSON.stringify(viewer.received);
    for (const secret of ['SECRET-META', 'SECRET-USER', 'SECRET-HEADER']) expect(all).not.toContain(secret);
    expectAllValid(viewer);
  });

  it('streaming: usage from the last chunk (empty choices), a cut-off tool call keeps its text', async () => {
    const events = chatChunks({
      textChunks: ['partial '],
      toolCalls: [
        { id: 'call_ok', name: 'ls', args: {} },
        { id: 'call_cut', name: 'write', args: { path: 'a.txt', content: 'hello world' } },
      ],
      finishReason: 'length',
      includeUsage: false,
    }) as Record<string, unknown>[];
    // Truncate the second call's streamed arguments: drop its closing pieces.
    const cut = events.filter((e) => {
      const calls = ((e['choices'] as { delta?: { tool_calls?: { index?: number; function?: { arguments?: string } }[] } }[] | undefined)?.[0]?.delta?.tool_calls) ?? [];
      return !(calls[0]?.index === 1 && /rld|}/.test(calls[0].function?.arguments ?? ''));
    });
    cut.push({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5.4',
      choices: [],
      usage: {
        prompt_tokens: 2048,
        completion_tokens: 16,
        total_tokens: 2064,
        prompt_tokens_details: { cached_tokens: 1920, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    });
    const server = new FakeOpenAI().onChat(() => ({ kind: 'sse', events: cut }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);
    const stream = await client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'go' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const _chunk of stream) {
      // consume
    }
    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    const finished = framesFor(viewer, 'node.finished', 'llm:step')[0]!;
    expect(finished.payload['usage']).toEqual({
      inputTokens: 2048,
      outputTokens: 16,
      inclusive: true,
      cacheReadTokens: 1920,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 2064,
      cachedInputTokens: 1920,
    });
    const output = finished.payload['output'] as Record<string, unknown>;
    expect(output['finishReason']).toBe('length');
    expect(output['rawFinishReason']).toBe('length');
    const calls = output['toolCalls'] as Record<string, unknown>[];
    expect(calls[0]).toEqual({ id: 'call_ok', name: 'ls', input: {} });
    expect(calls[1]).toMatchObject({ id: 'call_cut', name: 'write', input: null });
    expect(typeof calls[1]?.['inputText']).toBe('string');
    expect(() => JSON.parse(calls[1]?.['inputText'] as string)).toThrow();
    expect(server.requestsFor('/chat/completions')[0]?.body['stream_options']).toEqual({ include_usage: true });
    expectAllValid(viewer);
  });
});

describe('responses', () => {
  it('incomplete (max_output_tokens) -> finishReason length, raw reason kept; cache_write_tokens mapped', async () => {
    const body = {
      ...responseObject({ text: 'cut', status: 'incomplete' }),
      incomplete_details: { reason: 'max_output_tokens' },
      usage: {
        input_tokens: 9000,
        output_tokens: 400,
        total_tokens: 9400,
        input_tokens_details: { cached_tokens: 8192, cache_write_tokens: 512 },
        output_tokens_details: { reasoning_tokens: 128 },
      },
    };
    const server = new FakeOpenAI().onResponses(() => ({ kind: 'json', body }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);
    await client.responses.create({
      model: 'gpt-5.4',
      input: 'long essay',
      max_output_tokens: 400,
      instructions: 'be brief',
      reasoning: { effort: 'high' },
    });
    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    const started = framesFor(viewer, 'node.started', 'llm:step')[0]!.payload['input'];
    expect(started).toMatchObject({
      api: 'responses',
      input: 'long essay',
      instructions: 'be brief',
      max_output_tokens: 400,
      reasoning: { effort: 'high' },
    });
    const finished = framesFor(viewer, 'node.finished', 'llm:step')[0]!;
    expect(finished.payload['output']).toMatchObject({
      text: 'cut',
      finishReason: 'length',
      rawFinishReason: 'max_output_tokens',
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
    });
    expect(finished.payload['usage']).toMatchObject({
      inputTokens: 9000,
      outputTokens: 400,
      inclusive: true,
      cacheReadTokens: 8192,
      cacheWriteTokens: 512,
      reasoningTokens: 128,
    });
    expectAllValid(viewer);
  });

  it('a completed response with function calls: tool-calls, raw status', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'json',
      body: responseObject({
        functionCalls: [{ id: 'fc', callId: 'call_1', name: 'search', args: { q: 'x' } }],
      }),
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);
    await client.responses.create({ model: 'gpt-5.4', input: 'go' });
    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    expect(framesFor(viewer, 'node.finished', 'llm:step')[0]!.payload['output']).toMatchObject({
      finishReason: 'tool-calls',
      rawFinishReason: 'completed',
      toolCalls: [{ id: 'call_1', name: 'search', input: { q: 'x' } }],
    });
    expectAllValid(viewer);
  });

  it('an mcp tool (documented Tool.Mcp shape): its authorization / headers never reach the wire', async () => {
    const OAUTH = 'sk_live_OAUTH_TOKEN_SECRET_2';
    const BEARER = 'Bearer sk_live_HEADER_SECRET_2';
    const stripeMcp = {
      type: 'mcp' as const,
      server_label: 'stripe',
      server_url: 'https://mcp.stripe.com',
      authorization: OAUTH,
      headers: { Authorization: BEARER },
      require_approval: 'never' as const,
    };
    const server = new FakeOpenAI().onResponses(() => ({ kind: 'json', body: responseObject({ text: 'ok' }) }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);
    await gm.run('mcp-run', async () => {
      await client.responses.create({ model: 'gpt-5.4', input: 'refund order 42', tools: [stripeMcp] });
    });
    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    const input = framesFor(viewer, 'node.started', 'llm:step')[0]!.payload['input'] as Record<string, unknown>;
    // The step is recorded (tools by hash, the definition once) ...
    const recorded = { type: 'mcp', server_label: 'stripe', server_url: 'https://mcp.stripe.com', require_approval: 'never' };
    expect(input['tools']).toEqual([{ name: 'mcp', schemaHash: schemaHash(recorded) }]);
    expect(input['toolSchemas']).toEqual({ [schemaHash(recorded)]: recorded });
    // ... but no frame the hub receives (storage, viewer, replay, `graphmind mcp` get_node) holds the token.
    const all = JSON.stringify(viewer.received);
    expect(all, 'mcp authorization recorded').not.toContain(OAUTH);
    expect(all, 'mcp headers.Authorization recorded').not.toContain('sk_live_HEADER_SECRET_2');
    expectAllValid(viewer);
  });
});

describe("refusals normalize like Anthropic's (content-filter), the raw value kept", () => {
  it('chat, non-streaming: stop + message.refusal -> content-filter', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'json',
      body: {
        id: 'chatcmpl-r',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' } }],
      },
    }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);
    await client.chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }] });
    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    expect(framesFor(viewer, 'node.finished', 'llm:step')[0]!.payload['output']).toMatchObject({
      refusal: 'I cannot help with that.',
      finishReason: 'content-filter',
      rawFinishReason: 'stop',
    });
    expectAllValid(viewer);
  });

  it('chat, streaming: refusal deltas -> content-filter', async () => {
    const base = { id: 'chatcmpl-r', object: 'chat.completion.chunk', created: 1, model: 'gpt-5' };
    const events = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', refusal: 'I cannot' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { refusal: ' help.' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    const server = new FakeOpenAI().onChat(() => ({ kind: 'sse', events }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);
    const stream = await client.chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }], stream: true });
    for await (const _chunk of stream) {
      // consume
    }
    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 1, 5000, 'finish');
    expect(framesFor(viewer, 'node.finished', 'llm:step')[0]!.payload['output']).toMatchObject({
      finishReason: 'content-filter',
      rawFinishReason: 'stop',
    });
  });

  it('responses: a completed response with a refusal part -> content-filter; a plain one stays stop', async () => {
    const refused = responseObject({ text: 'ignored' });
    (refused['output'] as { content: unknown[] }[])[0]!.content = [{ type: 'refusal', refusal: 'I cannot help with that.' }];
    let turn = 0;
    const server = new FakeOpenAI().onResponses(() => ({ kind: 'json', body: turn++ === 0 ? refused : responseObject({ text: 'ok' }) }));
    const { viewer, gm, client } = await setup(server, {}, {}, cleanups);
    await attach(gm);
    await client.responses.create({ model: 'gpt-5.4', input: 'x' });
    await client.responses.create({ model: 'gpt-5.4', input: 'y' });
    await waitUntil(() => framesFor(viewer, 'node.finished', 'llm:step').length === 2, 5000, 'finish');
    const [first, second] = framesFor(viewer, 'node.finished', 'llm:step').map((f) => f.payload['output']);
    expect(first).toMatchObject({ finishReason: 'content-filter', rawFinishReason: 'completed' });
    expect(second).toMatchObject({ finishReason: 'stop', rawFinishReason: 'completed' });
  });
});

