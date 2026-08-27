/**
 * @graphmind-ai/openai against the real OpenAI **Responses** API — a different
 * wire format, a different event vocabulary and a different usage shape from
 * chat.completions, mapped onto the SAME logical `llm:step` node.
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
  name: 'getWeather',
  description: WEATHER_TOOL_DESCRIPTION,
  parameters: WEATHER_JSON_SCHEMA,
  strict: false,
};
const RATE_TOOL = {
  type: 'function' as const,
  name: 'getRate',
  description: RATE_TOOL_DESCRIPTION,
  parameters: RATE_JSON_SCHEMA,
  strict: false,
};

interface LoopResult {
  hostText: string;
  finalText: string;
  turns: number;
  toolCalls: { id: string; name: string; input: Any }[];
  lastRequestInput: Any[];
}

async function runLoop(opts: {
  client: Any;
  tools: Record<string, (input: Any, call?: Any) => Promise<Any>>;
  toolSchemas: Any[];
  prompt: string;
  requestOptions?: Record<string, unknown>;
  maxTurns?: number;
}): Promise<LoopResult> {
  const input: Any[] = [{ role: 'user', content: opts.prompt }];
  const toolCalls: { id: string; name: string; input: Any }[] = [];
  let hostText = '';
  let finalText = '';
  let turns = 0;
  let lastRequestInput: Any[] = [];

  for (let i = 0; i < (opts.maxTurns ?? 4); i += 1) {
    lastRequestInput = JSON.parse(JSON.stringify(input)) as Any[];
    turns += 1;
    const stream = (await opts.client.responses.create(
      { model: MODEL, input, tools: opts.toolSchemas, stream: true },
      opts.requestOptions,
    )) as AsyncIterable<Any>;

    let text = '';
    let final: Any;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta;
      } else if (
        event.type === 'response.completed' ||
        event.type === 'response.incomplete' ||
        event.type === 'response.failed'
      ) {
        final = event.response;
      }
    }
    hostText += text;
    finalText = text;

    const outputs: Any[] = final?.output ?? [];
    const calls = outputs.filter((item) => item.type === 'function_call');
    input.push(...outputs);
    if (calls.length === 0) break;

    const results = await Promise.all(
      calls.map(async (call) => {
        const parsed = (call.arguments?.length ?? 0) > 0 ? (JSON.parse(call.arguments) as Any) : {};
        toolCalls.push({ id: call.call_id, name: call.name, input: parsed });
        const fn = opts.tools[call.name];
        const output =
          fn === undefined ? { error: `no tool ${call.name}` } : await fn(parsed, call);
        return { callId: call.call_id, output };
      }),
    );
    for (const { callId, output } of results) {
      input.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify(output) });
    }
  }
  return { hostText, finalText, turns, toolCalls, lastRequestInput };
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

    const gm = graphmind({ app: 'live-openai-responses', url });
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
      'the llm node records which OpenAI API produced it',
      finished(dbg, runId)
        .filter((n) => n.nodeId === 'llm:step')
        .every(
          (n) =>
            (dbg.events('node.finished', runId).find((e) => e.seq === n.seq)?.payload[
              'api'
            ] as string) === 'responses',
        ),
      'api=responses on node.finished',
    );
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
        'each tool instanceId is the Responses call_id, paired with the right input',
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
    report.note(
      'Responses API streaming reports usage on `response.completed` with no opt-in flag — ' +
        'unlike chat.completions, which needs stream_options:{include_usage:true}.',
    );
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

    const gm = graphmind({ app: 'live-openai-responses', url });
    await gm.ready();
    const client = gm.wrapClient(new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] }));
    const tools = gm.wrapTools({ getRate });

    const result = await gm.run('fx-quote', () =>
      runLoop({ client, tools: tools as Any, toolSchemas: [RATE_TOOL], prompt: RATE_PROMPT }),
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
      'the injected value was in the input of the NEXT real provider request',
      JSON.stringify(result.lastRequestInput).includes(INJECTED_NEEDLE),
      `turns=${result.turns}`,
    );
    report.check(
      'the model answered from the injected value',
      result.finalText.includes(INJECTED_NEEDLE),
      JSON.stringify(result.finalText.slice(0, 120)),
    );
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

    const gm = graphmind({ app: 'live-openai-responses', url });
    await gm.ready();
    const client = gm.wrapClient(new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] }));
    const tools = gm.wrapTools({ pauseHere: async () => 'never used' });

    let chars = 0;
    let firstTokenAt = 0;
    let sawCompleted = false;
    let streamOutcome: unknown = 'completed';
    let streamSettledAt = 0;
    let runAborted = false;

    await gm.run('abort-inflight', async (ctx) => {
      const streamTask = (async () => {
        const stream = (await client.responses.create({
          model: MODEL,
          max_output_tokens: 800,
          input: [{ role: 'user', content: LONG_PROMPT }],
          stream: true,
        })) as AsyncIterable<Any>;
        for await (const event of stream) {
          if (event.type === 'response.completed') sawCompleted = true;
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            chars += event.delta.length;
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
      'the debugger abort cancelled the in-flight request (no response.completed)',
      !sawCompleted && chars < 400,
      `${chars} chars, response.completed seen=${sawCompleted}`,
    );
    report.check("the run's AbortController really fired", runAborted, `aborted=${runAborted}`);
    report.check(
      'cancellation landed promptly after the abort control',
      streamSettledAt > 0 && streamSettledAt - abortSentAt < 2500,
      `${Math.round(streamSettledAt - abortSentAt)}ms`,
    );
    if (streamOutcome !== 'completed') {
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
  const gm = graphmind({ app: 'live-responses-detached', url: 'ws://127.0.0.1:9/ingest' });
  const wrapped = gm.wrapClient(new OpenAI({ apiKey }));
  const request = {
    model: MODEL,
    max_output_tokens: 16,
    input: [{ role: 'user' as const, content: 'Reply with the single word: ok' }],
  };
  const measure = async (client: Any): Promise<number> => {
    const t0 = clock();
    await client.responses.create(request);
    const call = providerCallsSince(t0)[0];
    return call === undefined ? Number.NaN : call.startedAt - t0;
  };
  const rawRuns: number[] = [];
  const wrappedRuns: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    rawRuns.push(await measure(raw));
    wrappedRuns.push(await measure(wrapped));
  }
  await gm.dispose();
  const median = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
  const rawDispatch = median(rawRuns);
  const wrappedDispatch = median(wrappedRuns);
  report.check(
    'detached wrapping adds <15ms before the real HTTP request goes out',
    wrappedDispatch - rawDispatch < 15,
    `raw ${rawDispatch.toFixed(2)}ms -> wrapped ${wrappedDispatch.toFixed(2)}ms (+${(
      wrappedDispatch - rawDispatch
    ).toFixed(2)}ms)`,
  );
  report.check('the detached session never attached', !gm.session.attached);
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

  const gm = graphmind({ app: 'live-openai-responses', url: server.ingestUrl });
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
  report.check('the session reports itself detached afterwards', !gm.session.attached);
}

export async function runOpenAiResponsesSuite(report: Report): Promise<void> {
  report.suiteStart('@graphmind-ai/openai — responses  (real OpenAI API)');
  await scenarioCore(report);
  await scenarioErrorInject(report);
  await scenarioAbort(report);
  await scenarioDetachedOverhead(report);
  await scenarioFailOpen(report);
}
