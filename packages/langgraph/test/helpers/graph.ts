/**
 * The agent under test: a REAL compiled LangGraph running a real chat model
 * (`FakeListChatModel` from @langchain/core) and real `tool()` instances, so
 * every assertion is about what LangChain actually does — no hand-rolled
 * callback invocations.
 *
 *   __start__ -> plan            (chat model call)
 *              -> gather         (two tools, run in PARALLEL branches)
 *              -> report         (joins the branch results)
 */
import { Annotation, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Graphmind } from '../../src/index.js';
import { tick, waitUntil } from './fake-viewer.js';

export interface Mark {
  name: string;
  at: number;
  data?: Record<string, unknown>;
}

export class Marks {
  readonly all: Mark[] = [];
  mark(name: string, data?: Record<string, unknown>): void {
    this.all.push({ name, at: Date.now(), ...(data !== undefined ? { data } : {}) });
  }
  first(name: string, pred?: (mark: Mark) => boolean): Mark | undefined {
    return this.all.find((m) => m.name === name && (pred === undefined || pred(m)));
  }
  count(name: string, pred?: (mark: Mark) => boolean): number {
    return this.all.filter((m) => m.name === name && (pred === undefined || pred(m))).length;
  }
}

export interface ScenarioFlags {
  /** convertCurrency throws on every attempt. */
  currencyThrows?: boolean;
  /** convertCurrency throws only on its first attempt. */
  currencyThrowsOnce?: boolean;
  /** Wrap the tools with gm.wrapStructuredTool (full gate set). */
  wrapTools?: boolean;
  /** Tool body duration (default 15ms). */
  toolDelayMs?: number;
  /** Stream the model's answer token by token instead of one-shot invoke. */
  stream?: boolean;
}

export const State = Annotation.Root({
  topic: Annotation<string>({ reducer: (a, b) => b ?? a, default: () => '' }),
  planText: Annotation<string>({ reducer: (a, b) => b ?? a, default: () => '' }),
  findings: Annotation<string[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  reportText: Annotation<string>({ reducer: (a, b) => b ?? a, default: () => '' }),
});

export function makeTools(marks: Marks, flags: ScenarioFlags) {
  let currencyAttempts = 0;

  const searchFlights = tool(
    async ({ from, to }: { from: string; to: string }) => {
      marks.mark('tool:body-start', { toolName: 'searchFlights' });
      await tick(flags.toolDelayMs ?? 15);
      marks.mark('tool:body-end', { toolName: 'searchFlights' });
      return JSON.stringify({ flight: 'TP1234', from, to, priceEUR: 199 });
    },
    {
      name: 'searchFlights',
      description: 'Search for flights between two airports',
      schema: z.object({ from: z.string(), to: z.string() }),
    },
  );

  const convertCurrency = tool(
    async ({ amount, to }: { amount: number; to: string }) => {
      currencyAttempts += 1;
      marks.mark('tool:body-start', { toolName: 'convertCurrency', attempt: currencyAttempts });
      if (
        flags.currencyThrows === true ||
        (flags.currencyThrowsOnce === true && currencyAttempts === 1)
      ) {
        marks.mark('tool:body-throw', { toolName: 'convertCurrency' });
        throw new Error('FX rate service returned HTTP 500');
      }
      await tick(flags.toolDelayMs ?? 15);
      marks.mark('tool:body-end', { toolName: 'convertCurrency' });
      return JSON.stringify({ converted: Math.round(amount * 0.913 * 100) / 100, currency: to });
    },
    {
      name: 'convertCurrency',
      description: 'Convert an amount between currencies',
      schema: z.object({ amount: z.number(), from: z.string(), to: z.string() }),
    },
  );

  return { searchFlights, convertCurrency };
}

export interface BuiltGraph {
  graph: ReturnType<ReturnType<typeof buildStateGraph>['compile']>;
  marks: Marks;
}

function buildStateGraph(
  marks: Marks,
  flags: ScenarioFlags,
  tools: { searchFlights: unknown; convertCurrency: unknown },
) {
  const model = new FakeListChatModel({
    responses: ['Plan: check the flight and the budget.'],
    ...(flags.stream === true ? { sleep: 1 } : {}),
  });

  const invokeTool = async (t: unknown, input: unknown): Promise<string> => {
    const out = await (t as { invoke: (i: unknown) => Promise<unknown> }).invoke(input);
    const content = (out as { content?: unknown })?.content;
    return String(content ?? out);
  };

  return new StateGraph(State)
    .addNode('plan', async (state) => {
      marks.mark('node:plan');
      if (flags.stream === true) {
        let text = '';
        for await (const chunk of await model.stream(`plan for ${state.topic}`)) {
          text += String(chunk.content);
        }
        return { planText: text };
      }
      const res = await model.invoke(`plan for ${state.topic}`);
      return { planText: String(res.content) };
    })
    .addNode('flights', async (state) => {
      marks.mark('node:flights');
      const out = await invokeTool(tools.searchFlights, { from: 'VIE', to: state.topic });
      return { findings: [out] };
    })
    .addNode('budget', async () => {
      marks.mark('node:budget');
      try {
        const out = await invokeTool(tools.convertCurrency, {
          amount: 100,
          from: 'EUR',
          to: 'USD',
        });
        return { findings: [out] };
      } catch (error) {
        marks.mark('node:budget-caught');
        return { findings: [`error:${(error as Error).message}`] };
      }
    })
    .addNode('report', async (state) => {
      marks.mark('node:report');
      return { reportText: `${state.planText} :: ${state.findings.join(' | ')}` };
    })
    .addEdge(START, 'plan')
    .addEdge('plan', 'flights')
    .addEdge('plan', 'budget')
    .addEdge('flights', 'report')
    .addEdge('budget', 'report')
    .addEdge('report', END);
}

export function buildGraph(gm: Graphmind, flags: ScenarioFlags = {}, marks = new Marks()) {
  const raw = makeTools(marks, flags);
  const tools =
    flags.wrapTools === true
      ? {
          searchFlights: gm.wrapStructuredTool(raw.searchFlights),
          convertCurrency: gm.wrapStructuredTool(raw.convertCurrency),
        }
      : raw;
  return { graph: buildStateGraph(marks, flags, tools).compile(), marks, tools };
}

/** Force the session to start its transport and wait until it is attached. */
export async function attach(gm: Graphmind): Promise<void> {
  await gm.ready({ timeoutMs: 8000 });
  await waitUntil(() => gm.session.attached, 8000, 'session attach');
}

/* -- the agent loop: conditional edges + a streaming tool-calling model ----- */

/**
 * A chat model that streams a scripted sequence of `AIMessageChunk`s per turn,
 * including tool-call argument deltas.
 *
 * `FakeStreamingChatModel` cannot be used for this: it rebuilds every chunk
 * from `content` / `tool_calls` / `additional_kwargs` only, so
 * `tool_call_chunks` never reach `handleLLMNewToken` — exactly the channel
 * under test. Everything else here is real LangChain: `.stream()` drives the
 * real callback manager, which invokes the handler the same way a provider
 * model does.
 */
export class ScriptedStreamingChatModel extends BaseChatModel {
  private turn = 0;

  constructor(private readonly turns: AIMessageChunk[][]) {
    super({});
  }

  _llmType(): string {
    return 'scripted-streaming';
  }

  async _generate(): Promise<ChatResult> {
    throw new Error('ScriptedStreamingChatModel is streaming-only');
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const script = this.turns[this.turn] ?? [];
    this.turn += 1;
    for (const message of script) {
      const text = typeof message.content === 'string' ? message.content : '';
      const chunk = new ChatGenerationChunk({ message, text });
      yield chunk;
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
        chunk,
      });
    }
  }
}

export const AGENT_LOOP_TOOL_ARGS: [string, string] = ['{"city":', '"Lisbon"}'];

/**
 * The classic LangGraph agent loop — `think` (streaming model) with a
 * conditional edge into a `ToolNode`, looping back. Its `think` node is the
 * shape that makes LangGraph wrap the node body in an inner run carrying the
 * node's own metadata (see `langgraphTaskKey`).
 */
export function buildAgentLoopGraph() {
  const model = new ScriptedStreamingChatModel([
    [
      new AIMessageChunk({ content: 'Checking the weather. ' }),
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { type: 'tool_call_chunk', id: 'call_1', name: 'getWeather', args: '', index: 0 },
        ],
      }),
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { type: 'tool_call_chunk', args: AGENT_LOOP_TOOL_ARGS[0], index: 0 },
        ],
      }),
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { type: 'tool_call_chunk', args: AGENT_LOOP_TOOL_ARGS[1], index: 0 },
        ],
      }),
    ],
    [new AIMessageChunk({ content: 'It is 31C in Lisbon.' })],
  ]);

  const getWeather = tool(
    async ({ city }: { city: string }) => JSON.stringify({ city, tempC: 31 }),
    {
      name: 'getWeather',
      description: 'Weather for a city',
      schema: z.object({ city: z.string() }),
    },
  );

  const graph = new StateGraph(MessagesAnnotation)
    .addNode('think', async (state) => {
      let accumulated: AIMessageChunk | undefined;
      for await (const chunk of await model.stream(state.messages)) {
        accumulated = accumulated === undefined ? chunk : accumulated.concat(chunk);
      }
      return { messages: accumulated === undefined ? [] : [accumulated] };
    })
    .addNode('tools', new ToolNode([getWeather]))
    .addEdge(START, 'think')
    .addConditionalEdges(
      'think',
      (state) => {
        const last = state.messages[state.messages.length - 1] as AIMessageChunk | undefined;
        return (last?.tool_calls?.length ?? 0) > 0 ? 'tools' : END;
      },
      { tools: 'tools', [END]: END },
    )
    .addEdge('tools', 'think')
    .compile();

  return { graph, getWeather };
}
