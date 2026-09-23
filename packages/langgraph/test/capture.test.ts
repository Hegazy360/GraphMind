/**
 * Contract C1 through a real LangChain chat model run: node.started.input
 * carries every message whole (no 20,000-char preview), the invocation
 * params and bound tools by schema hash; node.finished carries inclusive
 * usage, the normalized finish reason and the requested tool calls
 * (including an invalid one), and every envelope validates.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { parseEnvelope } from '@graphmind-ai/schema';
import { schemaHash } from '@graphmind-ai/client';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { graphmind, type Graphmind } from '../src/index.js';
import { FakeViewer, waitUntil } from './helpers/fake-viewer.js';
import { attach } from './helpers/graph.js';

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

const WEATHER_TOOL = {
  type: 'function',
  function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
};

/** A chat model that answers with a scripted AIMessage and reports provider-shaped params. */
class ScriptedChatModel extends BaseChatModel {
  constructor(
    private readonly reply: () => AIMessage,
    fields: BaseChatModelParams = {},
  ) {
    super(fields);
  }

  _llmType(): string {
    return 'scripted';
  }

  override invocationParams(): Record<string, unknown> {
    return {
      model: 'scripted-1',
      temperature: 0.3,
      max_tokens: 256,
      tool_choice: 'auto',
      tools: [WEATHER_TOOL],
      apiKey: 'SECRET-KEY',
    };
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.reply();
    return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
  }
}

describe('LangChain chat model capture (C1)', () => {
  it('records the full prompt, params and tools; usage, finish reason and tool calls on finish', async () => {
    const { viewer, gm } = await setup();
    const model = new ScriptedChatModel(
      () =>
        new AIMessage({
          content: 'checking',
          tool_calls: [{ id: 'call_1', name: 'get_weather', args: { city: 'Lisbon' }, type: 'tool_call' }],
          invalid_tool_calls: [{ id: 'call_2', name: 'write', args: '{"path":"a', error: 'bad json', type: 'invalid_tool_call' }],
          usage_metadata: {
            input_tokens: 1350,
            output_tokens: 40,
            total_tokens: 1390,
            input_token_details: { cache_read: 1000, cache_creation: 300 },
            output_token_details: { reasoning: 12 },
          },
          response_metadata: { stop_reason: 'tool_use' },
          // The fields type narrows usage_metadata by message structure; the runtime takes it.
        } as never),
    );
    const long = 'q'.repeat(45_000);
    await model.invoke([new HumanMessage(long), new HumanMessage('and then?')], { callbacks: [gm.handler()] });
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    const started = viewer.ofType('node.started').find((f) => f.payload['kind'] === 'llm');
    const input = started?.payload['input'] as Record<string, unknown>;
    const messages = (input['messages'] as { role: string; content: string }[][])[0]!;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe(long); // whole: no 20,000-char preview
    const hash = schemaHash(WEATHER_TOOL);
    expect(input).toMatchObject({
      temperature: 0.3,
      max_tokens: 256,
      tool_choice: 'auto',
      tools: [{ name: 'get_weather', schemaHash: hash }],
      toolSchemas: { [hash]: WEATHER_TOOL },
    });
    expect(JSON.stringify(viewer.received)).not.toContain('SECRET-KEY');

    const finished = viewer.ofType('node.finished').find((f) => f.payload['nodeId'] === started?.payload['nodeId']);
    expect(finished?.payload['usage']).toEqual({
      inputTokens: 1350,
      outputTokens: 40,
      inclusive: true,
      cacheReadTokens: 1000,
      cacheWriteTokens: 300,
      reasoningTokens: 12,
    });
    expect(finished?.payload['output']).toEqual({
      text: 'checking',
      finishReason: 'tool-calls',
      rawFinishReason: 'tool_use',
      toolCalls: [
        { id: 'call_1', name: 'get_weather', input: { city: 'Lisbon' } },
        { id: 'call_2', name: 'write', input: null, inputText: '{"path":"a' },
      ],
    });
    for (const frame of viewer.received) expect(parseEnvelope(frame).kind, frame.type).toBe('ok');
  });

  it('graph state larger than the old 20,000-char preview reaches the wire whole', async () => {
    const { viewer, gm } = await setup();
    const State = Annotation.Root({
      blob: Annotation<string>({ reducer: (a, b) => b ?? a, default: () => '' }),
    });
    const graph = new StateGraph(State)
      .addNode('work', async () => ({ blob: 'y'.repeat(30_000) }))
      .addEdge(START, 'work')
      .addEdge('work', END)
      .compile();
    await graph.invoke({ blob: 'x'.repeat(30_000) }, { callbacks: [gm.handler()] });
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    const root = viewer.ofType('node.started').find((f) => f.payload['kind'] === 'agent');
    expect(root?.payload['input']).toEqual({ blob: 'x'.repeat(30_000) });
  });
});
