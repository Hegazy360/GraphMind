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
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { FakeListChatModel } from '@langchain/core/utils/testing';
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
