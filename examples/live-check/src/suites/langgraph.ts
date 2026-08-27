/**
 * @graphmind-ai/langgraph against a REAL LangGraph graph over a REAL
 * ChatOpenAI model.
 *
 * The graph is the standard agent loop — `think` (ChatOpenAI, streaming) with a
 * conditional edge into a `ToolNode`, looping back — driven through
 * `gm.config()`, which is the documented entry point.
 */
import { graphmind } from '@graphmind-ai/langgraph';
import { tool } from '@langchain/core/tools';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import {
  INJECTED_NEEDLE,
  INJECTED_RATE,
  LONG_PROMPT,
  PARALLEL_PROMPT,
  RATE_PROMPT,
  RATE_TOOL_DESCRIPTION,
  WEATHER_TOOL_DESCRIPTION,
  getRate,
  getWeather,
} from '../agents/tools.js';
import { delay, finished, recordRunUsage, started, tokenText, until } from '../harness/checks.js';
import { withHarness } from '../harness/harness.js';
import { clock, firstProviderCallSince, providerCallsBetween } from '../harness/probe.js';
import type { Report } from '../harness/report.js';

export const MODEL = 'gpt-4o-mini';
const LLM_NODE = `llm:${MODEL}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

function makeWeatherTool(gm: Any): Any {
  return gm.wrapStructuredTool(
    tool(
      async ({ city }: { city: string }) => JSON.stringify(getWeather({ city })),
      {
        name: 'getWeather',
        description: WEATHER_TOOL_DESCRIPTION,
        schema: z.object({ city: z.string() }),
      },
    ) as Any,
  );
}

function makeRateTool(gm: Any): Any {
  return gm.wrapStructuredTool(
    tool(
      async ({ from, to }: { from: string; to: string }) => JSON.stringify(getRate({ from, to })),
      {
        name: 'getRate',
        description: RATE_TOOL_DESCRIPTION,
        schema: z.object({ from: z.string(), to: z.string() }),
      },
    ) as Any,
  );
}

/** The classic LangGraph agent loop: think -> tools -> think -> end. */
function buildAgentGraph(tools: Any[]): Any {
  const model = new ChatOpenAI({ model: MODEL, streaming: true, streamUsage: true }).bindTools(
    tools,
  );
  return new StateGraph(MessagesAnnotation)
    .addNode('think', async (state: Any) => ({ messages: [await model.invoke(state.messages)] }))
    .addNode('tools', new ToolNode(tools) as Any)
    .addEdge(START, 'think' as Any)
    .addConditionalEdges(
      'think' as Any,
      (state: Any) => {
        const last = state.messages[state.messages.length - 1];
        return (last.tool_calls?.length ?? 0) > 0 ? 'tools' : END;
      },
      { tools: 'tools', [END]: END } as Any,
    )
    .addEdge('tools' as Any, 'think' as Any)
    .compile();
}

function aiText(result: Any): { all: string; final: string } {
  const messages: Any[] = result?.messages ?? [];
  let all = '';
  let final = '';
  for (const message of messages) {
    const type = typeof message?.getType === 'function' ? message.getType() : message?.role;
    if (type !== 'ai' && type !== 'assistant') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    all += content;
    if (content.length > 0) final = content;
  }
  return { all, final };
}

const HOLD_MS = 4000;

async function scenarioCore(report: Report): Promise<void> {
  report.scenarioStart('core: real LangGraph graph, streaming, real usage, a multi-second hold');
  await withHarness(async ({ dbg, url }) => {
    dbg.setBreakpoint({ kind: 'llm', point: 'before' });
    dbg.setBreakpoint({ kind: 'tool', point: 'before' });

    let holdFrom = 0;
    let holdTo = 0;
    let llmPauses = 0;
    const toolPauses: string[] = [];
    let toolsHeldTogether = false;

    dbg.onPaused(async (pause) => {
      if (pause.nodeId.startsWith('llm:')) {
        llmPauses += 1;
        if (llmPauses === 1) {
          holdFrom = pause.at;
          await delay(HOLD_MS);
          holdTo = clock();
        }
        dbg.resume(pause.runId, pause.pauseId, 'continue');
        return;
      }
      toolPauses.push(pause.pauseId);
      try {
        await until(() => toolPauses.length >= 2, 4000, 'a second tool gate');
        toolsHeldTogether = true;
      } catch {
        // reported below
      }
      dbg.resume(pause.runId, pause.pauseId, 'continue');
    });

    const gm = graphmind({ app: 'live-langgraph', url });
    report.check('gm.ready() attached to the real server', await gm.ready());
    const weather = makeWeatherTool(gm);
    const graph = buildAgentGraph([weather]);
    gm.hintGraph(graph);

    const runStart = clock();
    const result: Any = await graph.invoke(
      { messages: [{ role: 'user', content: PARALLEL_PROMPT }] },
      gm.config(),
    );
    await delay(500);
    await gm.dispose();

    // The graph's run is the one that carries the agent node — NOT necessarily
    // the first run.started (see the hintGraph note below).
    const runIds = dbg.events('run.started').map((e) => e.runId);
    const runId =
      runIds.find((id) => started(dbg, id).some((n) => n.kind === 'agent')) ?? runIds[0] ?? '';
    const starts = started(dbg, runId);
    const ends = finished(dbg, runId);
    const text = aiText(result);

    report.check(
      'run announced to the debugger (run.started + run.finished)',
      dbg.events('run.started', runId).length === 1 &&
        dbg.events('run.finished', runId).length === 1,
    );
    report.check(
      'gm.hintGraph() before invoke pre-announced the graph INTO the graph\'s own run',
      dbg
        .events('graph.hint', runId)
        .some((e) =>
          ((e.payload['nodes'] as { name: string }[]) ?? []).some((n) => n.name === 'think'),
        ),
      `${dbg.events('graph.hint', runId).length} graph.hint envelope(s) in the run`,
    );
    if (runIds.length > 1) {
      report.note(
        `gm.hintGraph() called before graph.invoke() (the documented order) also opens the ` +
          `session's implicit run, so the viewer's run list shows ${runIds.length} runs for one ` +
          `graph invocation — an empty placeholder plus the real one.`,
      );
    }

    const agent = starts.filter((n) => n.kind === 'agent');
    report.check(
      'the graph root became a single agent node',
      agent.length === 1 && agent[0]?.parentId === undefined,
      agent.map((n) => n.nodeId).join(', '),
    );
    const agentNodeId = agent[0]?.nodeId ?? '';

    const llm = starts.filter((n) => n.kind === 'llm');
    report.check(
      'the chat model ran twice as two executions of one logical llm node',
      llm.length === 2 && new Set(llm.map((n) => n.nodeId)).size === 1,
      llm.map((n) => n.nodeId).join(', '),
    );
    report.check(
      'llm executions have distinct instanceIds (LangChain run ids)',
      new Set(llm.map((n) => n.instanceId)).size === llm.length,
      llm.map((n) => n.instanceId.slice(0, 8)).join(', '),
    );
    report.check(
      'llm nodes are parented to their LangGraph node (agent -> chain -> llm)',
      llm.every((n) => n.parentId === 'chain:think') &&
        starts.some((n) => n.nodeId === 'chain:think' && n.parentId === agentNodeId),
      llm.map((n) => String(n.parentId)).join(', '),
    );

    const toolStarts = starts.filter((n) => n.kind === 'tool');
    report.check(
      'both real tool calls became executions of one logical tool node',
      toolStarts.length === 2 && new Set(toolStarts.map((n) => n.nodeId)).size === 1,
      toolStarts.map((n) => `${n.nodeId}/${n.instanceId}`).join(' '),
    );
    report.check(
      'tool instanceIds are the model\'s real tool_call ids',
      toolStarts.every((n) => n.instanceId.startsWith('call_')),
      toolStarts.map((n) => n.instanceId).join(', '),
    );
    report.check(
      'tool nodes are parented to the ToolNode chain',
      toolStarts.every((n) => n.parentId === 'chain:tools'),
      toolStarts.map((n) => String(n.parentId)).join(', '),
    );

    const open = starts.filter(
      (s) => !ends.some((e) => e.nodeId === s.nodeId && e.instanceId === s.instanceId),
    );
    report.check(
      'every node.started has a matching node.finished (same instanceId)',
      open.length === 0,
      open.map((n) => `${n.nodeId}/${n.instanceId}`).join(', '),
    );

    const streamed = tokenText(dbg, runId, LLM_NODE, 'text');
    report.check(
      'streamed deltas arrived and reconstruct exactly to the model\'s real text',
      streamed.length > 0 && streamed === text.all,
      streamed === text.all
        ? `${streamed.length} chars`
        : `graphmind=${JSON.stringify(streamed.slice(0, 80))} host=${JSON.stringify(
            text.all.slice(0, 80),
          )}`,
    );

    const llmEnds = ends.filter((e) => e.nodeId === LLM_NODE);
    const withUsage = llmEnds.filter(
      (e) => (e.usage?.inputTokens ?? 0) > 0 && (e.usage?.outputTokens ?? 0) > 0,
    );
    report.check(
      'every llm node.finished carries non-zero real input/output token usage',
      llmEnds.length === 2 && withUsage.length === llmEnds.length,
      llmEnds.map((e) => `${e.usage?.inputTokens ?? 'none'}/${e.usage?.outputTokens ?? 'none'}`).join(' '),
    );

    const during = providerCallsBetween(holdFrom, holdTo);
    report.check(
      'a held llm gate issued ZERO provider HTTP requests while holding',
      holdTo > 0 && during.length === 0,
      `${during.length} requests in a ${Math.round(holdTo - holdFrom)}ms hold`,
    );
    const firstCall = firstProviderCallSince(runStart);
    report.check(
      'the first provider request only started after the gate was released',
      firstCall !== undefined && firstCall.startedAt >= holdTo,
      firstCall === undefined ? 'none' : `+${Math.round(firstCall.startedAt - holdTo)}ms`,
    );
    report.check(
      'the provider did not time out across the hold — the graph completed',
      llmEnds.every((e) => e.status === 'ok') && text.final.length > 0,
      JSON.stringify(text.final.slice(0, 90)),
    );

    report.check(
      'parallel real tool calls held their gates independently and simultaneously',
      toolsHeldTogether,
      `${toolPauses.length} tool gates observed`,
    );
    report.check(
      'the model actually answered with both temperatures',
      /34/.test(text.final) && /21/.test(text.final),
      JSON.stringify(text.final.slice(0, 120)),
    );

    // Reality-gap observations worth surfacing even when everything passes.
    const selfParented = starts.filter((n) => n.parentId === n.nodeId);
    if (selfParented.length > 0) {
      report.note(
        `LangGraph wraps each node body in an inner run with the SAME langgraph_node ` +
          `metadata, so the default chains:'all' policy emits ${selfParented.length} chain ` +
          `node(s) parented to THEMSELVES (${[...new Set(selfParented.map((n) => n.nodeId))].join(
            ', ',
          )}). A viewer laying the graph out as a DAG gets a self-loop, and step mode ` +
          `pauses twice for one logical node.`,
      );
    }
    const toolArgs = tokenText(dbg, runId, LLM_NODE, 'tool-args');
    if (toolArgs.length === 0) {
      report.note(
        'the LangChain adapter emits only `text` token deltas — LangChain\'s ' +
          'handleLLMNewToken carries tool-call argument chunks in `fields.chunk`, which the ' +
          'handler does not map, so the tool-args channel is empty where the Anthropic / ' +
          'OpenAI / AI SDK adapters fill it.',
      );
    }
    recordRunUsage(report, dbg, runId, MODEL);
  });
}

async function scenarioErrorInject(report: Report): Promise<void> {
  report.scenarioStart('pause-on-error on a real failure, inject reaches the next real turn');
  await withHarness(async ({ dbg, url }) => {
    dbg.onPaused((pause) => {
      if (pause.point === 'error') dbg.resume(pause.runId, pause.pauseId, 'inject', INJECTED_RATE);
      else dbg.resume(pause.runId, pause.pauseId, 'continue');
    });

    const gm = graphmind({ app: 'live-langgraph', url });
    await gm.ready();
    const rate = makeRateTool(gm);
    const graph = buildAgentGraph([rate]);

    const result: Any = await graph.invoke(
      { messages: [{ role: 'user', content: RATE_PROMPT }] },
      gm.config(),
    );
    await delay(500);
    await gm.dispose();

    const runId = dbg.events('run.started')[0]?.runId ?? '';
    const errorPause = dbg.pauses.find((p) => p.point === 'error');
    report.check(
      'pause-on-error fired at the real failing tool',
      errorPause?.nodeId === 'tool:getRate',
      JSON.stringify(errorPause ?? null),
    );
    const toolEnd = finished(dbg, runId).find((n) => n.nodeId === 'tool:getRate');
    report.check(
      'the injected value became the tool result',
      toolEnd?.status === 'ok' && JSON.stringify(toolEnd.output).includes(INJECTED_NEEDLE),
      JSON.stringify(toolEnd?.output ?? null),
    );
    const llmStarts = started(dbg, runId).filter((n) => n.kind === 'llm');
    const lastInput = JSON.stringify(llmStarts[llmStarts.length - 1]?.input ?? '');
    report.check(
      'the injected value was in the messages of the NEXT real model step',
      llmStarts.length >= 2 && lastInput.includes(INJECTED_NEEDLE),
      `${llmStarts.length} llm steps`,
    );
    const text = aiText(result);
    report.check(
      'the model answered from the injected value',
      text.final.includes(INJECTED_NEEDLE),
      JSON.stringify(text.final.slice(0, 120)),
    );
    recordRunUsage(report, dbg, runId, MODEL);
  });
}

/**
 * A fan-out graph: one branch streams a long real completion while the other
 * holds a gated tool. Aborting at the tool gate must cancel the in-flight
 * provider request in the sibling branch.
 */
function buildFanOutGraph(gm: Any, holder: Any): Any {
  const model = new ChatOpenAI({ model: MODEL, streaming: true, streamUsage: true });
  const counters = { chars: 0, firstTokenAt: 0, completed: false };
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('writer', async () => {
      const stream = await model.stream(LONG_PROMPT);
      for await (const chunk of stream) {
        const piece = typeof chunk.content === 'string' ? chunk.content : '';
        if (piece.length > 0) {
          counters.chars += piece.length;
          if (counters.firstTokenAt === 0) counters.firstTokenAt = clock();
        }
      }
      counters.completed = true;
      return {};
    })
    .addNode('holder', async () => {
      // Wait until the sibling branch is genuinely mid-stream, so the abort
      // lands on an in-flight provider request rather than before one.
      await until(() => counters.firstTokenAt > 0, 30_000, 'the writer\'s first token');
      await holder();
      return {};
    })
    .addEdge(START, 'writer' as Any)
    .addEdge(START, 'holder' as Any)
    .addEdge('writer' as Any, END)
    .addEdge('holder' as Any, END)
    .compile();
  return { graph, counters };
}

async function scenarioAbort(report: Report): Promise<void> {
  report.scenarioStart('abort cancels a real in-flight streaming request (parallel branches)');
  await withHarness(async ({ dbg, url }) => {
    dbg.setBreakpoint({ kind: 'tool', name: 'pauseHere', point: 'before' });
    let abortSentAt = 0;
    dbg.onPaused((pause) => {
      if (pause.nodeId === 'tool:pauseHere') {
        abortSentAt = clock();
        dbg.resume(pause.runId, pause.pauseId, 'abort');
      } else {
        dbg.resume(pause.runId, pause.pauseId, 'continue');
      }
    });

    const gm = graphmind({ app: 'live-langgraph', url });
    await gm.ready();
    const holder = gm.tool('pauseHere', async () => 'never used');
    const { graph, counters } = buildFanOutGraph(gm, holder);

    let failure: unknown;
    let settledAt = 0;
    try {
      await graph.invoke({ messages: [] }, gm.config());
    } catch (error) {
      failure = error;
    }
    settledAt = clock();
    await delay(400);
    await gm.dispose();

    report.check(
      'the writer branch was genuinely mid-stream when abort was sent',
      counters.chars > 0 && abortSentAt > counters.firstTokenAt,
      `${counters.chars} chars before abort`,
    );
    report.check(
      'the debugger abort cancelled the in-flight request (stream cut off)',
      !counters.completed && counters.chars < 600,
      `${counters.chars} chars of a 250-word answer, completed=${counters.completed}`,
    );
    report.check(
      'the graph invocation ended with an abort, not a success',
      failure !== undefined && /abort/i.test(String(failure)),
      failure === undefined ? 'invoke resolved normally' : String(failure).slice(0, 120),
    );
    report.check(
      'cancellation landed promptly after the abort control',
      settledAt - abortSentAt < 3000,
      `${Math.round(settledAt - abortSentAt)}ms`,
    );
  });
}

async function scenarioDetachedOverhead(report: Report): Promise<void> {
  report.scenarioStart('detached mode adds no measurable overhead to a real call');
  const gm = graphmind({ app: 'live-langgraph-detached', url: 'ws://127.0.0.1:9/ingest' });
  const model = new ChatOpenAI({ model: MODEL, maxTokens: 8 });

  const measure = async (config: Any): Promise<number> => {
    const t0 = clock();
    await model.invoke('Reply with the single word: ok', config);
    const call = firstProviderCallSince(t0);
    return call === undefined ? Number.NaN : call.startedAt - t0;
  };
  const rawRuns: number[] = [];
  const wrappedRuns: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    rawRuns.push(await measure(undefined));
    wrappedRuns.push(await measure(gm.config()));
  }
  await gm.dispose();
  const median = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
  const rawDispatch = median(rawRuns);
  const wrappedDispatch = median(wrappedRuns);
  report.check(
    'a detached GraphMind callback handler adds <15ms before the real HTTP request goes out',
    wrappedDispatch - rawDispatch < 15,
    `raw ${rawDispatch.toFixed(2)}ms -> handler ${wrappedDispatch.toFixed(2)}ms (+${(
      wrappedDispatch - rawDispatch
    ).toFixed(2)}ms)`,
  );
  report.check('the detached session never attached', !gm.session.attached);
}

async function scenarioFailOpen(report: Report): Promise<void> {
  report.scenarioStart('fail-open: kill the debugger mid-hold, the real graph finishes anyway');
  const { startLiveServer } = await import('../harness/server.js');
  const { HeadlessDebugger } = await import('../harness/debugger.js');
  const server = await startLiveServer();
  const dbg = await HeadlessDebugger.connect(server.uiUrl);
  dbg.setBreakpoint({ kind: 'llm', point: 'before' });

  let killedAt = 0;
  dbg.onPaused(async () => {
    if (killedAt !== 0) return;
    killedAt = clock();
    dbg.close();
    await server.stop();
  });

  const gm = graphmind({ app: 'live-langgraph', url: server.ingestUrl });
  report.check('attached before the kill', await gm.ready());
  const weather = makeWeatherTool(gm);
  const graph = buildAgentGraph([weather]);

  let failure: unknown;
  let result: Any;
  try {
    result = await graph.invoke(
      { messages: [{ role: 'user', content: PARALLEL_PROMPT }] },
      gm.config(),
    );
  } catch (error) {
    failure = error;
  }
  await gm.dispose();

  const text = failure === undefined ? aiText(result) : { all: '', final: '' };
  report.check('the debugger was killed while a gate was held', killedAt > 0);
  report.check(
    'the real graph completed anyway after the debugger died',
    failure === undefined && text.final.length > 0,
    failure === undefined ? JSON.stringify(text.final.slice(0, 90)) : `threw: ${String(failure)}`,
  );
  report.check('the session reports itself detached afterwards', !gm.session.attached);
}

export async function runLangGraphSuite(report: Report): Promise<void> {
  report.suiteStart('@graphmind-ai/langgraph — real LangGraph over ChatOpenAI');
  await scenarioCore(report);
  await scenarioErrorInject(report);
  await scenarioAbort(report);
  await scenarioDetachedOverhead(report);
  await scenarioFailOpen(report);
}
