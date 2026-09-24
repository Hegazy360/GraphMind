/**
 * Contract C1 on the Anthropic adapter, through the REAL SDK client:
 *   - node.started.input is the request as sent (messages/system in full, the
 *     sampling parameters under Anthropic's names, tools by schema hash with
 *     definitions once per run) and never the request options or fields that
 *     can carry credentials;
 *   - streamed usage arrives split across message_start / message_delta and is
 *     reported inclusive, with the 5m/1h cache-write split summed;
 *   - a tool call cut off by max_tokens is recorded with its partial text;
 *   - every envelope validates.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { schemaHash } from '@graphmind-ai/client';
import { graphmind, type Graphmind } from '../src/index.js';
import { FakeViewer, type ReceivedFrame } from './helpers/fake-viewer.js';
import { FakeAnthropicTransport, assistantMessage, type Script } from './helpers/fake-anthropic.js';
import { attach } from './helpers/scenario.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(): Promise<{ viewer: FakeViewer; gm: Graphmind }> {
  const viewer = await FakeViewer.start();
  const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, logger: () => {} });
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  await attach(gm);
  return { viewer, gm };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeClient(gm: Graphmind, script: Script) {
  const transport = new FakeAnthropicTransport(script);
  const raw = new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch: transport.fetch });
  return { client: gm.wrapClient(raw) as any, transport };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function llm(viewer: FakeViewer, type: string): ReceivedFrame[] {
  return viewer.ofType(type).filter((f) => f.payload['nodeId'] === 'llm:step');
}

function expectAllValid(viewer: FakeViewer): void {
  for (const frame of viewer.received) expect(parseEnvelope(frame).kind, frame.type).toBe('ok');
}

const weather = {
  name: 'get_weather',
  description: 'Weather for a city',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  cache_control: { type: 'ephemeral' },
};
const search = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 };

describe('node.started.input', () => {
  it('is the request as sent: full messages and system, sampling params, tools by hash (once per run); no options, no credentials', async () => {
    const { viewer, gm } = await setup();
    const { client } = makeClient(gm, () => ({ message: assistantMessage('m', 'ok') }));
    const longHistory = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i} ${'x'.repeat(3000)}`,
    }));
    const body = {
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['\n\nHuman:'],
      tool_choice: { type: 'auto' },
      thinking: { type: 'enabled', budget_tokens: 2048 },
      system: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }],
      metadata: { user_id: 'SECRET-USER' },
      mcp_servers: [{ type: 'url', url: 'https://mcp.example', name: 'x', authorization_token: 'SECRET-TOKEN' }],
      messages: longHistory,
      tools: [weather, search],
    };
    await gm.run('r1', async () => {
      await client.messages.create(body, { headers: { 'x-api-key': 'SECRET-HEADER' }, timeout: 5000 });
      await client.messages.create({ ...body, messages: [...longHistory, { role: 'user', content: 'again' }] });
    });
    await viewer.waitFor(() => llm(viewer, 'node.finished').length >= 2, 5000);

    const [first, second] = llm(viewer, 'node.started').map((f) => f.payload['input'] as Record<string, unknown>);
    const hWeather = schemaHash(weather);
    const hSearch = schemaHash(search);
    expect(first).toEqual({
      model: 'claude-sonnet-4-5',
      messages: longHistory,
      system: body.system,
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['\n\nHuman:'],
      tool_choice: { type: 'auto' },
      thinking: { type: 'enabled', budget_tokens: 2048 },
      tools: [
        { name: 'get_weather', schemaHash: hWeather },
        { name: 'web_search', schemaHash: hSearch },
      ],
      toolSchemas: { [hWeather]: weather, [hSearch]: search },
      stream: false,
    });
    expect((first?.['messages'] as unknown[]).length).toBe(40); // full history, no trimming
    expect(second?.['tools']).toEqual(first?.['tools']);
    expect(second).not.toHaveProperty('toolSchemas');
    const all = JSON.stringify(viewer.received);
    for (const secret of ['SECRET-USER', 'SECRET-TOKEN', 'SECRET-HEADER']) expect(all).not.toContain(secret);
    expectAllValid(viewer);
  });
});

describe('streamed usage and tool calls', () => {
  it('message_start + cumulative message_delta: inclusive total, 5m/1h split summed into cacheWriteTokens', async () => {
    const { viewer, gm } = await setup();
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_read_input_tokens: 4000,
            cache_creation_input_tokens: null,
            cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 },
          },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 57, input_tokens: null, cache_read_input_tokens: null },
      },
      { type: 'message_stop' },
    ];
    const { client } = makeClient(gm, () => ({ events }));
    const stream = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 100, messages: [], stream: true });
    for await (const _event of stream) {
      // consume
    }
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(finished.payload['usage']).toEqual({
      inputTokens: 12 + 4000 + 500,
      outputTokens: 57,
      inclusive: true,
      cacheReadTokens: 4000,
      cacheWriteTokens: 500,
      cacheCreationTokens: 500,
    });
    expect(finished.payload['output']).toEqual({
      text: 'Done.',
      finishReason: 'stop',
      rawFinishReason: 'end_turn',
      stopReason: 'end_turn',
      model: 'claude-sonnet-4-5',
    });
    expectAllValid(viewer);
  });

  it('a tool_use cut off by max_tokens is recorded with its partial arguments as inputText', async () => {
    const { viewer, gm } = await setup();
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'm2',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 30, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_ok', name: 'ls', input: {} } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_cut', name: 'write_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt",' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"content":"hel' } },
      // No content_block_stop: the model hit max_tokens mid-arguments.
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 64 } },
      { type: 'message_stop' },
    ];
    const { client } = makeClient(gm, () => ({ events }));
    const stream = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [], stream: true });
    const consumed = (async () => {
      for await (const _event of stream) {
        // consume
      }
    })();
    // Attached, the cut-off call is a smart hold before `message_stop`
    // (smart-llm-after.test.ts covers it end to end); release it.
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step');
    expect(paused.payload['smart']).toMatchObject({ rule: 'truncated-tool-call' });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await consumed;
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(finished.payload['output']).toMatchObject({
      finishReason: 'length',
      rawFinishReason: 'max_tokens',
      toolCalls: [
        { id: 'toolu_ok', name: 'ls', input: {} },
        { id: 'toolu_cut', name: 'write_file', input: null, inputText: '{"path":"a.txt","content":"hel' },
      ],
    });
    expect(finished.payload['usage']).toEqual({ inputTokens: 30, outputTokens: 64, inclusive: true });
    expectAllValid(viewer);
  });
});
