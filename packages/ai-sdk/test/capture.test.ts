/**
 * Contract C1 on the AI SDK middleware: what an LLM step records.
 *   - node.started.input: prompt (bytes as placeholders), sampling options
 *     under the AI SDK's own names, tools as {name, schemaHash} with each
 *     definition sent once per run as toolSchemas — never providerOptions /
 *     headers;
 *   - node.finished: inclusive usage from the finish part (cache and
 *     reasoning only when reported), normalized finishReason + raw, toolCalls
 *     (including a call cut off mid-arguments);
 *   - every emitted envelope validates against the wire schema.
 */
import { simulateReadableStream } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { schemaHash } from '@graphmind-ai/client';
import { graphmind, type Graphmind } from '../src/index.js';
import { FakeViewer, type ReceivedFrame } from './helpers/fake-viewer.js';
import { attach } from './helpers/scenario.js';
import { MockLanguageModel, type CallOptions, type StreamPart } from './helpers/sdk-compat.js';

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

function llmFrames(viewer: FakeViewer, type: string): ReceivedFrame[] {
  return viewer.ofType(type).filter((f) => f.payload['nodeId'] === 'llm:step');
}

function expectAllValid(viewer: FakeViewer): void {
  for (const frame of viewer.received) {
    const parsed = parseEnvelope(frame);
    expect(parsed.kind, `${frame.type} ${JSON.stringify(parsed)}`).toBe('ok');
  }
}

async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

const searchTool = {
  type: 'function' as const,
  name: 'search',
  description: 'Search the web',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};
const fetchTool = {
  type: 'function' as const,
  name: 'fetch',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
};

describe('node.started.input', () => {
  it('records sampling options, tools by hash (definitions once per run), bytes as placeholders, never providerOptions or headers', async () => {
    const { viewer, gm } = await setup();
    const mock = new MockLanguageModel({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const model = gm.wrapModel(mock);
    const params = {
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this image' },
            { type: 'file', data: new Uint8Array(1024), mediaType: 'image/png' },
          ],
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 256,
      topP: 0.9,
      stopSequences: ['END'],
      seed: 7,
      toolChoice: { type: 'auto' },
      tools: [searchTool, fetchTool],
      headers: { authorization: 'Bearer SECRET-HEADER' },
      providerOptions: { gateway: { byok: { anthropic: [{ apiKey: 'SECRET-KEY' }] } } },
    } as unknown as CallOptions;

    await gm.run('capture', async () => {
      await model.doGenerate(params);
      // A second step of the same run: tools by reference only.
      await model.doGenerate({ ...params, prompt: [...(params.prompt as unknown[]), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] } as CallOptions);
    });
    await viewer.waitFor(() => llmFrames(viewer, 'node.finished').length >= 2, 5000);

    const [first, second] = llmFrames(viewer, 'node.started').map((f) => f.payload['input'] as Record<string, unknown>);
    const hashSearch = schemaHash(searchTool);
    const hashFetch = schemaHash(fetchTool);
    expect(first).toMatchObject({
      temperature: 0.3,
      maxOutputTokens: 256,
      topP: 0.9,
      stopSequences: ['END'],
      seed: 7,
      toolChoice: { type: 'auto' },
      tools: [
        { name: 'search', schemaHash: hashSearch },
        { name: 'fetch', schemaHash: hashFetch },
      ],
      toolSchemas: { [hashSearch]: searchTool, [hashFetch]: fetchTool },
    });
    const prompt = first?.['prompt'] as { content: unknown[] }[];
    expect(prompt[0]?.content[1]).toEqual({ type: 'file', data: { type: 'binary', bytes: 1024 }, mediaType: 'image/png' });
    expect(second?.['tools']).toEqual(first?.['tools']);
    expect(second).not.toHaveProperty('toolSchemas');
    const all = JSON.stringify(viewer.received);
    expect(all).not.toContain('SECRET-HEADER');
    expect(all).not.toContain('SECRET-KEY');
    expect(first).not.toHaveProperty('providerOptions');
    expect(first).not.toHaveProperty('headers');
    expectAllValid(viewer);

    // A new run is sent the definitions again.
    await gm.run('capture-2', async () => {
      await model.doGenerate(params);
    });
    await viewer.waitFor(() => llmFrames(viewer, 'node.finished').length >= 3, 5000);
    const third = llmFrames(viewer, 'node.started')[2]?.payload['input'] as Record<string, unknown>;
    expect(Object.keys(third['toolSchemas'] as object).sort()).toEqual([hashSearch, hashFetch].sort());
  });
});

describe('node.started.input: provider tools', () => {
  it('an openai.mcp provider tool (ai prepareTools shape): its authorization / headers args are never recorded', async () => {
    const { viewer, gm } = await setup();
    const mock = new MockLanguageModel({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const model = gm.wrapModel(mock);
    // What `ai` hands the model for `openai.tools.mcp({...})` (prepareTools).
    const mcpTool = {
      type: 'provider',
      id: 'openai.mcp',
      name: 'mcp',
      args: {
        serverLabel: 'stripe',
        serverUrl: 'https://mcp.stripe.com',
        authorization: 'sk_live_OAUTH_TOKEN_SECRET',
        headers: { Authorization: 'Bearer sk_live_HEADER_SECRET' },
      },
    };
    await gm.run('provider-tool', async () => {
      await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'refund' }] }], tools: [searchTool, mcpTool] } as unknown as CallOptions);
    });
    await viewer.waitFor(() => llmFrames(viewer, 'node.finished').length >= 1, 5000);
    const input = llmFrames(viewer, 'node.started')[0]?.payload['input'] as Record<string, unknown>;
    const recorded = { type: 'provider', id: 'openai.mcp', name: 'mcp', args: { serverLabel: 'stripe', serverUrl: 'https://mcp.stripe.com' } };
    expect(input['tools']).toEqual([
      { name: 'search', schemaHash: schemaHash(searchTool) },
      { name: 'mcp', schemaHash: schemaHash(recorded) },
    ]);
    expect(input['toolSchemas']).toEqual({ [schemaHash(searchTool)]: searchTool, [schemaHash(recorded)]: recorded });
    const all = JSON.stringify(viewer.received);
    expect(all).not.toContain('sk_live_OAUTH_TOKEN_SECRET');
    expect(all).not.toContain('sk_live_HEADER_SECRET');
    expectAllValid(viewer);
  });
});

describe('node.finished', () => {
  it('streaming: inclusive usage with cache and reasoning from the last (finish) part, finish reason, tool calls', async () => {
    const { viewer, gm } = await setup();
    const parts: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Looking.' },
      { type: 'text-end', id: 't1' },
      { type: 'tool-input-start', id: 'call-1', toolName: 'search' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"q":' },
      { type: 'tool-input-delta', id: 'call-1', delta: '"lisbon"}' },
      { type: 'tool-input-end', id: 'call-1' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: '{"q":"lisbon"}' },
      {
        type: 'finish',
        usage: {
          inputTokens: { total: 1250, noCache: 50, cacheRead: 1000, cacheWrite: 200 },
          outputTokens: { total: 80, text: 60, reasoning: 20 },
        },
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
      },
    ] as StreamPart[];
    const mock = new MockLanguageModel({
      doStream: async () => ({ stream: simulateReadableStream<StreamPart>({ chunks: parts }) }),
    });
    const res = await gm.wrapModel(mock).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [searchTool],
    } as CallOptions);
    await drain(res.stream);
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(finished.payload['usage']).toEqual({
      inputTokens: 1250,
      outputTokens: 80,
      inclusive: true,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      reasoningTokens: 20,
    });
    expect(finished.payload['output']).toEqual({
      text: 'Looking.',
      finishReason: 'tool-calls',
      rawFinishReason: 'tool_use',
      toolCalls: [{ id: 'call-1', name: 'search', input: { q: 'lisbon' } }],
    });
    expectAllValid(viewer);
  });

  it('streaming: a step with an error part keeps the usage and tool calls it reported', async () => {
    const { viewer, gm } = await setup();
    const parts = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: '{"q":"lisbon"}' },
      { type: 'error', error: new Error('overloaded') },
      {
        type: 'finish',
        usage: {
          inputTokens: { total: 90_050, noCache: 50, cacheRead: 90_000, cacheWrite: undefined },
          outputTokens: { total: 12, text: 12, reasoning: undefined },
        },
        finishReason: { unified: 'error', raw: 'error' },
      },
    ] as StreamPart[];
    const mock = new MockLanguageModel({
      doStream: async () => ({ stream: simulateReadableStream<StreamPart>({ chunks: parts }) }),
    });
    const res = await gm.wrapModel(mock).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    } as CallOptions);
    await drain(res.stream);
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(finished.payload['status']).toBe('error');
    expect(finished.payload['usage']).toEqual({ inputTokens: 90_050, outputTokens: 12, inclusive: true, cacheReadTokens: 90_000 });
    expect(finished.payload['output']).toEqual({ text: '', toolCalls: [{ id: 'call-1', name: 'search', input: { q: 'lisbon' } }] });
    expectAllValid(viewer);
  });

  it('streaming: a tool call cut off by the token limit is listed with its partial text', async () => {
    const { viewer, gm } = await setup();
    const parts = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-9', toolName: 'write' },
      { type: 'tool-input-delta', id: 'call-9', delta: '{"path":"a.txt","content":"hel' },
      {
        type: 'finish',
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 4096, text: 4096, reasoning: undefined },
        },
        finishReason: { unified: 'length', raw: 'max_tokens' },
      },
    ] as StreamPart[];
    const mock = new MockLanguageModel({
      doStream: async () => ({ stream: simulateReadableStream<StreamPart>({ chunks: parts }) }),
    });
    const res = await gm.wrapModel(mock).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
    } as CallOptions);
    const drained = drain(res.stream);
    // Attached, the cut-off call is a smart hold at the step's after gate
    // (smart-llm-after.test.ts covers it end to end); release it.
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step');
    expect(paused.payload['smart']).toMatchObject({ rule: 'truncated-tool-call' });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await drained;
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(finished.payload['output']).toEqual({
      text: '',
      finishReason: 'length',
      rawFinishReason: 'max_tokens',
      toolCalls: [{ id: 'call-9', name: 'write', input: null, inputText: '{"path":"a.txt","content":"hel' }],
    });
    expect(finished.payload['usage']).toEqual({ inputTokens: 10, outputTokens: 4096, inclusive: true });
    expectAllValid(viewer);
  });

  it('generate: tool calls from the content, provider-executed ones excluded, V2-style string finish reason', async () => {
    const { viewer, gm } = await setup();
    const mock = new MockLanguageModel({
      doGenerate: async () =>
        ({
          content: [
            { type: 'tool-call', toolCallId: 'p1', toolName: 'webSearch', input: '{"q":"x"}', providerExecuted: true },
            { type: 'tool-result', toolCallId: 'p1', toolName: 'webSearch', result: { hits: 1 } },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: '{"q":"y"}' },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'fetch', input: '' },
          ],
          finishReason: 'tool-calls',
          usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 100 },
          warnings: [],
        }) as never,
    });
    await gm.wrapModel(mock).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    } as CallOptions);
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(finished.payload['output']).toEqual({
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { id: 'c1', name: 'search', input: { q: 'y' } },
        { id: 'c2', name: 'fetch', input: {} },
      ],
    });
    expect(finished.payload['usage']).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      inclusive: true,
      cacheReadTokens: 100,
    });
    expectAllValid(viewer);
  });
});
