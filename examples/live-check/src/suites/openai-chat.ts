/**
 * @graphmind-ai/openai against the real OpenAI Chat Completions API.
 */
import { graphmind, isAbortError } from '@graphmind-ai/openai';
import OpenAI from 'openai';
import {
  INJECTED_NEEDLE,
  INJECTED_RATE,
  LONG_PROMPT,
  PARALLEL_PROMPT,
  RATE_JSON_SCHEMA,
  RATE_PROMPT,
  RATE_TOOL_DESCRIPTION,
  WEATHER_JSON_SCHEMA,
  WEATHER_TOOL_DESCRIPTION,
  getRate,
  getWeather,
} from '../agents/tools.js';
import { checkRunGraph, delay, finished, recordRunUsage, started, until } from '../harness/checks.js';
import { withHarness } from '../harness/harness.js';
import {
  clock,
  firstProviderCallSince,
  providerCallsBetween,
  providerCallsSince,
} from '../harness/probe.js';
import type { Report } from '../harness/report.js';

export const MODEL = 'gpt-4o-mini';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const WEATHER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'getWeather',
    description: WEATHER_TOOL_DESCRIPTION,
    parameters: WEATHER_JSON_SCHEMA,
  },
};
const RATE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'getRate',
    description: RATE_TOOL_DESCRIPTION,
    parameters: RATE_JSON_SCHEMA,
  },
};

interface LoopResult {
  hostText: string;
  finalText: string;
  turns: number;
  toolCalls: { id: string; name: string; input: Any }[];
  lastRequestMessages: Any[];
}

async function runLoop(opts: {
  client: Any;
  tools: Record<string, (input: Any, call?: Any) => Promise<Any>>;
  toolSchemas: Any[];
  prompt: string;
  includeUsage?: boolean;
  requestOptions?: Record<string, unknown>;
  maxTurns?: number;
}): Promise<LoopResult> {
  const messages: Any[] = [{ role: 'user', content: opts.prompt }];
  const toolCalls: { id: string; name: string; input: Any }[] = [];
  let hostText = '';
  let finalText = '';
  let turns = 0;
  let lastRequestMessages: Any[] = [];

  for (let i = 0; i < (opts.maxTurns ?? 4); i += 1) {
    lastRequestMessages = JSON.parse(JSON.stringify(messages)) as Any[];
    turns += 1;
    const stream = (await opts.client.chat.completions.create(
      {
        model: MODEL,
        messages,
        tools: opts.toolSchemas,
        stream: true,
        ...(opts.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
      },
      opts.requestOptions,
    )) as AsyncIterable<Any>;

    let content = '';
    let finishReason: string | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (choice === undefined) continue;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string') content += delta.content;
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === 'number' ? call.index : 0;
        const slot = calls.get(index) ?? { id: '', name: '', args: '' };
        if (typeof call.id === 'string') slot.id = call.id;
        if (typeof call.function?.name === 'string') slot.name += call.function.name;
        if (typeof call.function?.arguments === 'string') slot.args += call.function.arguments;
        calls.set(index, slot);
      }
    }
    hostText += content;
    finalText = content;

    const wanted = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    messages.push({
      role: 'assistant',
      content: content.length > 0 ? content : null,
      ...(wanted.length > 0
        ? {
            tool_calls: wanted.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.args },
            })),
          }
        : {}),
    });
    if (finishReason !== 'tool_calls' || wanted.length === 0) break;

    const results = await Promise.all(
      wanted.map(async (call) => {
        const input = call.args.length > 0 ? (JSON.parse(call.args) as Any) : {};
        toolCalls.push({ id: call.id, name: call.name, input });
        const fn = opts.tools[call.name];
        const sdkCall = {
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.args },
        };
        const output =
          fn === undefined ? { error: `no tool ${call.name}` } : await fn(input, sdkCall);
        return { id: call.id, output };
      }),
    );
    for (const { id, output } of results) {
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(output) });
    }
  }
  return { hostText, finalText, turns, toolCalls, lastRequestMessages };
}

const HOLD_MS = 6000;
const REQUEST_TIMEOUT_MS = 5000;

async function scenarioCore(report: Report): Promise<void> {
  report.scenarioStart('core: graph, streaming, real usage, a 6s hold with a 5s SDK timeout');
  await withHarness(async ({ dbg, url }) => {
    dbg.setBreakpoint({ kind: 'llm', point: 'before' });
    dbg.setBreakpoint({ kind: 'tool', point: 'before' });

    let holdFrom = 0;
    let holdTo = 0;
    let llmPauses = 0;
    const toolPauses: string[] = [];
    let toolsHeldTogether = false;

    dbg.onPaused(async (pause) => {
      if (pause.nodeId === 'llm:step') {
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

    const gm = graphmind({ app: 'live-openai-chat', url });
    report.check('gm.ready() attached to the real server', await gm.ready());
    const client = gm.wrapClient(new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] }));
    const tools = gm.wrapTools({ getWeather });

    const runStart = clock();
    const result = await gm.run('weather-compare', () =>
      runLoop({
        client,
        tools: tools as Any,
        toolSchemas: [WEATHER_TOOL],
        prompt: PARALLEL_PROMPT,
        requestOptions: { timeout: REQUEST_TIMEOUT_MS },
      }),
    );
    await delay(400);
    await gm.dispose();

    const runId = dbg.events('run.started')[0]?.runId ?? '';
    checkRunGraph(report, dbg, runId, {
      agentNodeId: 'agent:weather-compare',
      llmNodeId: 'llm:step',
      llmSteps: result.turns,
      tools: [{ nodeId: 'tool:getWeather', instances: result.toolCalls.length }],
      hostText: result.hostText,
      toolCallIds: result.toolCalls.map((c) => c.id),
    });
    report.check(
      'the agent really made a multi-turn tool-calling run',
      result.turns >= 2 && result.toolCalls.length >= 1,
      `${result.turns} model turns, ${result.toolCalls.length} tool calls`,
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
    const llmEnds = finished(dbg, runId).filter(
      (n) => n.nodeId === 'llm:step' && n.status === 'ok',
    );
    report.check(
      `the provider did NOT time out across the hold (SDK timeout ${REQUEST_TIMEOUT_MS}ms < hold ${HOLD_MS}ms)`,
      llmEnds.length === result.turns,
      `${llmEnds.length}/${result.turns} llm steps ok`,
    );

    if (result.toolCalls.length >= 2) {
      report.check(
        'parallel real tool calls held their gates independently and simultaneously',
        toolsHeldTogether,
        `${toolPauses.length} tool gates observed`,
      );
      const starts = started(dbg, runId).filter((n) => n.nodeId === 'tool:getWeather');
      const providerPairs = new Map(
        result.toolCalls.map((c) => [c.id, JSON.stringify(c.input)] as const),
      );
      report.check(
        'each tool instanceId is paired with the right tool_call input',
        starts.every((n) => providerPairs.get(n.instanceId) === JSON.stringify(n.input)),
        starts.map((n) => `${n.instanceId}=${JSON.stringify(n.input)}`).join(' '),
      );
    } else {
      report.skip(
        'parallel real tool calls gate independently',
        `the model emitted ${result.toolCalls.length} tool call(s)`,
      );
    }

    report.check(
      'the model actually answered with both temperatures',
      /34/.test(result.finalText) && /21/.test(result.finalText),
      JSON.stringify(result.finalText.slice(0, 120)),
    );
    recordRunUsage(report, dbg, runId, MODEL);
  });
}

async function scenarioErrorInject(report: Report): Promise<void> {
  report.scenarioStart(
    'pause-on-error + inject (and: streaming usage WITHOUT stream_options.include_usage)',
  );
  await withHarness(async ({ dbg, url }) => {
    dbg.onPaused((pause) => {
      if (pause.point === 'error') dbg.resume(pause.runId, pause.pauseId, 'inject', INJECTED_RATE);
      else dbg.resume(pause.runId, pause.pauseId, 'continue');
    });

    const gm = graphmind({ app: 'live-openai-chat', url });
    await gm.ready();
    const client = gm.wrapClient(new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] }));
    const tools = gm.wrapTools({ getRate });

    const result = await gm.run('fx-quote', () =>
      runLoop({
        client,
        tools: tools as Any,
        toolSchemas: [RATE_TOOL],
        prompt: RATE_PROMPT,
        includeUsage: false,
      }),
    );
    await delay(400);
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
    report.check(
      'the injected value was in the messages of the NEXT real provider request',
      JSON.stringify(result.lastRequestMessages).includes(INJECTED_NEEDLE),
      `turns=${result.turns}`,
    );
    report.check(
      'the model answered from the injected value',
      result.finalText.includes(INJECTED_NEEDLE),
      JSON.stringify(result.finalText.slice(0, 120)),
    );

    const llmEnds = finished(dbg, runId).filter((n) => n.nodeId === 'llm:step');
    const anyUsage = llmEnds.some((n) => (n.usage?.inputTokens ?? 0) > 0);
    if (!anyUsage) {
      report.note(
        'Chat Completions streaming reports NO usage unless the request sets ' +
          'stream_options:{include_usage:true} — so node.finished carries no token counts. ' +
          "That is the API, not the adapter, but it is a silent hole in the viewer's cost view.",
      );
    } else {
      report.note('this OpenAI account returned streaming usage without include_usage');
    }
    recordRunUsage(report, dbg, runId, MODEL);
  });
}

async function scenarioAbort(report: Report): Promise<void> {
  report.scenarioStart('abort cancels a real in-flight streaming request');
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

    const gm = graphmind({ app: 'live-openai-chat', url });
    await gm.ready();
    const client = gm.wrapClient(new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] }));
    const tools = gm.wrapTools({ pauseHere: async () => 'never used' });

    let chars = 0;
    let firstTokenAt = 0;
    let sawFinish = false;
    let streamOutcome: unknown = 'completed';
    let streamSettledAt = 0;
    let runAborted = false;

    await gm.run('abort-inflight', async (ctx) => {
      const streamTask = (async () => {
        const stream = (await client.chat.completions.create({
          model: MODEL,
          max_tokens: 800,
          messages: [{ role: 'user', content: LONG_PROMPT }],
          stream: true,
        })) as AsyncIterable<Any>;
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason != null) sawFinish = true;
          const piece = choice?.delta?.content;
          if (typeof piece === 'string' && piece.length > 0) {
            chars += piece.length;
            if (firstTokenAt === 0) firstTokenAt = clock();
          }
        }
      })().then(
        () => {
          streamSettledAt = clock();
          return 'completed';
        },
        (error: unknown) => {
          streamSettledAt = clock();
          return error;
        },
      );

      await until(() => firstTokenAt > 0, 30_000, 'the first streamed token');
      const toolTask = (tools as Any).pauseHere({}).then(
        () => 'tool-returned',
        (error: unknown) => error,
      );
      streamOutcome = await streamTask;
      await toolTask;
      runAborted = ctx.signal.aborted;
    }).catch(() => undefined);

    await delay(300);
    await gm.dispose();

    report.check(
      'the request was genuinely mid-stream when abort was sent',
      chars > 0 && abortSentAt > firstTokenAt,
      `${chars} chars streamed before abort`,
    );
    report.check(
      'the debugger abort cancelled the in-flight request (stream cut off, no finish_reason)',
      !sawFinish && chars < 400,
      `${chars} chars of a 250-word answer, finish_reason seen=${sawFinish}`,
    );
    report.check("the run's AbortController really fired", runAborted, `aborted=${runAborted}`);
    report.check(
      'cancellation landed promptly after the abort control',
      streamSettledAt > 0 && streamSettledAt - abortSentAt < 2500,
      `${Math.round(streamSettledAt - abortSentAt)}ms`,
    );
    if (streamOutcome === 'completed') {
      report.note(
        'OpenAI SDK: aborting mid-stream ends the host iterator CLEANLY (no throw) — ' +
          'core/streaming.mjs swallows AbortError, same as the Anthropic SDK.',
      );
    } else {
      report.check(
        'the aborted stream surfaced an abort-shaped error',
        isAbortError(streamOutcome) || /abort/i.test(String(streamOutcome)),
        String(streamOutcome).slice(0, 120),
      );
    }
    const runId = dbg.events('run.started')[0]?.runId ?? '';
    const llmEnd = finished(dbg, runId).find((n) => n.nodeId === 'llm:step');
    report.check(
      'the aborted llm step is reported as aborted, not ok',
      llmEnd?.status === 'aborted',
      String(llmEnd?.status),
    );
    recordRunUsage(report, dbg, runId, MODEL);
  });
}

async function scenarioDetachedOverhead(report: Report): Promise<void> {
  report.scenarioStart('detached mode adds no measurable overhead to a real call');
  const apiKey = process.env['OPENAI_API_KEY'];
  const raw = new OpenAI({ apiKey });
  const gm = graphmind({ app: 'live-openai-detached', url: 'ws://127.0.0.1:9/ingest' });
  const wrapped = gm.wrapClient(new OpenAI({ apiKey }));
  const request = {
    model: MODEL,
    max_tokens: 8,
    messages: [{ role: 'user' as const, content: 'Reply with the single word: ok' }],
  };
  const measure = async (client: Any): Promise<{ dispatch: number; total: number }> => {
    const t0 = clock();
    await client.chat.completions.create(request);
    const total = clock() - t0;
    const call = providerCallsSince(t0)[0];
    return { dispatch: call === undefined ? Number.NaN : call.startedAt - t0, total };
  };
  const rawRuns: { dispatch: number; total: number }[] = [];
  const wrappedRuns: { dispatch: number; total: number }[] = [];
  for (let i = 0; i < 3; i += 1) {
    rawRuns.push(await measure(raw));
    wrappedRuns.push(await measure(wrapped));
  }
  await gm.dispose();
  const median = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
  const rawDispatch = median(rawRuns.map((r) => r.dispatch));
  const wrappedDispatch = median(wrappedRuns.map((r) => r.dispatch));
  report.check(
    'detached wrapping adds <15ms before the real HTTP request goes out',
    wrappedDispatch - rawDispatch < 15,
    `raw ${rawDispatch.toFixed(2)}ms -> wrapped ${wrappedDispatch.toFixed(2)}ms (+${(
      wrappedDispatch - rawDispatch
    ).toFixed(2)}ms)`,
  );
  report.check(
    'the detached session never attached',
    !gm.session.attached,
    `attached=${gm.session.attached}`,
  );
  report.note(
    `openai end-to-end median: raw ${median(rawRuns.map((r) => r.total)).toFixed(
      0,
    )}ms vs detached-wrapped ${median(wrappedRuns.map((r) => r.total)).toFixed(0)}ms`,
  );
}

async function scenarioFailOpen(report: Report): Promise<void> {
  report.scenarioStart('fail-open: kill the debugger mid-hold, the real agent finishes anyway');
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

  const gm = graphmind({ app: 'live-openai-chat', url: server.ingestUrl });
  report.check('attached before the kill', await gm.ready());
  const client = gm.wrapClient(new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] }));
  const tools = gm.wrapTools({ getWeather });

  let failure: unknown;
  let result: LoopResult | undefined;
  try {
    result = await gm.run('fail-open', () =>
      runLoop({ client, tools: tools as Any, toolSchemas: [WEATHER_TOOL], prompt: PARALLEL_PROMPT }),
    );
  } catch (error) {
    failure = error;
  }
  await gm.dispose();

  report.check('the debugger was killed while a gate was held', killedAt > 0);
  report.check(
    'the real agent completed anyway after the debugger died',
    failure === undefined && (result?.finalText.length ?? 0) > 0,
    failure === undefined
      ? JSON.stringify(result?.finalText.slice(0, 90))
      : `threw: ${String(failure)}`,
  );
  report.check(
    'the session reports itself detached afterwards',
    !gm.session.attached,
    `attached=${gm.session.attached}`,
  );
}

export async function runOpenAiChatSuite(report: Report): Promise<void> {
  report.suiteStart('@graphmind-ai/openai — chat.completions  (real OpenAI API)');
  await scenarioCore(report);
  await scenarioErrorInject(report);
  await scenarioAbort(report);
  await scenarioDetachedOverhead(report);
  await scenarioFailOpen(report);
}
