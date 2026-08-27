/**
 * @graphmind-ai/sdk (the Vercel AI SDK adapter) driving a REAL provider —
 * `@ai-sdk/openai` against gpt-4o-mini — through `streamText` with real
 * multi-step tool calling.
 */
import { openai } from '@ai-sdk/openai';
import { graphmind } from '@graphmind-ai/sdk';
import { stepCountIs, streamText, tool } from 'ai';
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
import { checkRunGraph, delay, finished, recordRunUsage, started, until } from '../harness/checks.js';
import { withHarness } from '../harness/harness.js';
import { clock, firstProviderCallSince, providerCallsBetween } from '../harness/probe.js';
import type { Report } from '../harness/report.js';

export const MODEL = 'gpt-4o-mini';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const weatherTool = tool({
  description: WEATHER_TOOL_DESCRIPTION,
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }: { city: string }) => getWeather({ city }),
});

const rateTool = tool({
  description: RATE_TOOL_DESCRIPTION,
  inputSchema: z.object({ from: z.string(), to: z.string() }),
  // The declared return type keeps `never` (getRate always throws) from
  // collapsing the SDK's schema inference.
  execute: async ({ from, to }: { from: string; to: string }): Promise<{ rate: number }> =>
    getRate({ from, to }),
});

interface LoopResult {
  hostText: string;
  finalText: string;
  turns: number;
  toolCallIds: string[];
  toolInputs: Map<string, string>;
}

async function runAgent(model: Any, tools: Any, prompt: string): Promise<LoopResult> {
  const result = streamText({
    model,
    tools,
    prompt,
    stopWhen: stepCountIs(4),
    onError: () => {},
  });
  await result.consumeStream();
  const steps = await result.steps;
  const toolInputs = new Map<string, string>();
  const toolCallIds: string[] = [];
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      toolCallIds.push(call.toolCallId);
      toolInputs.set(call.toolCallId, JSON.stringify(call.input));
    }
  }
  return {
    hostText: steps.map((s: Any) => s.text ?? '').join(''),
    finalText: (steps[steps.length - 1] as Any)?.text ?? '',
    turns: steps.length,
    toolCallIds,
    toolInputs,
  };
}

const HOLD_MS = 4000;

async function scenarioCore(report: Report): Promise<void> {
  report.scenarioStart('core: graph, streaming, real usage, a multi-second hold');
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

    const gm = graphmind({ app: 'live-ai-sdk', url });
    report.check('gm.ready() attached to the real server', await gm.ready());
    const model = gm.wrapModel(openai(MODEL) as Any);
    const tools = gm.wrapTools({ getWeather: weatherTool } as Any);

    const runStart = clock();
    const result = await gm.run('weather-compare', () =>
      runAgent(model, tools, PARALLEL_PROMPT),
    );
    await delay(400);
    await gm.dispose();

    const runId = dbg.events('run.started')[0]?.runId ?? '';
    checkRunGraph(report, dbg, runId, {
      agentNodeId: 'agent:weather-compare',
      llmNodeId: 'llm:step',
      llmSteps: result.turns,
      tools: [{ nodeId: 'tool:getWeather', instances: result.toolCallIds.length }],
      hostText: result.hostText,
      toolCallIds: result.toolCallIds,
    });
    report.check(
      'the agent really made a multi-turn tool-calling run',
      result.turns >= 2 && result.toolCallIds.length >= 1,
      `${result.turns} model steps, ${result.toolCallIds.length} tool calls`,
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
      'the provider did not time out across the hold',
      llmEnds.length === result.turns,
      `${llmEnds.length}/${result.turns} llm steps ok`,
    );

    if (result.toolCallIds.length >= 2) {
      report.check(
        'parallel real tool calls held their gates independently and simultaneously',
        toolsHeldTogether,
        `${toolPauses.length} tool gates observed`,
      );
      const starts = started(dbg, runId).filter((n) => n.nodeId === 'tool:getWeather');
      report.check(
        'each tool instanceId is the SDK toolCallId, paired with the right input',
        starts.every((n) => result.toolInputs.get(n.instanceId) === JSON.stringify(n.input)),
        starts.map((n) => `${n.instanceId}=${JSON.stringify(n.input)}`).join(' '),
      );
    } else {
      report.skip(
        'parallel real tool calls gate independently',
        `the model emitted ${result.toolCallIds.length} tool call(s)`,
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
  report.scenarioStart('pause-on-error on a real failure, inject reaches the next real turn');
  await withHarness(async ({ dbg, url }) => {
    dbg.onPaused((pause) => {
      if (pause.point === 'error') dbg.resume(pause.runId, pause.pauseId, 'inject', INJECTED_RATE);
      else dbg.resume(pause.runId, pause.pauseId, 'continue');
    });

    const gm = graphmind({ app: 'live-ai-sdk', url });
    await gm.ready();
    const model = gm.wrapModel(openai(MODEL) as Any);
    const tools = gm.wrapTools({ getRate: rateTool } as Any);

    const result = await gm.run('fx-quote', () => runAgent(model, tools, RATE_PROMPT));
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
    // The AI SDK builds the next request itself; the injected value must be in
    // the prompt of the NEXT llm step that GraphMind observed.
    const llmStarts = started(dbg, runId).filter((n) => n.nodeId === 'llm:step');
    const lastPrompt = JSON.stringify((llmStarts[llmStarts.length - 1]?.input as Any)?.prompt ?? '');
    report.check(
      'the injected value was in the prompt of the NEXT real model step',
      llmStarts.length >= 2 && lastPrompt.includes(INJECTED_NEEDLE),
      `${llmStarts.length} llm steps`,
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

    const gm = graphmind({ app: 'live-ai-sdk', url });
    await gm.ready();
    const model = gm.wrapModel(openai(MODEL) as Any);
    const tools = gm.wrapTools({
      pauseHere: tool({
        description: 'a gate to hold',
        inputSchema: z.object({}),
        execute: async () => 'never used',
      }),
    } as Any);

    let chars = 0;
    let firstTokenAt = 0;
    let streamSettledAt = 0;
    let runAborted = false;
    let sawFinishStep = false;

    await gm.run('abort-inflight', async (ctx) => {
      const result = streamText({
        model,
        prompt: LONG_PROMPT,
        onError: () => {},
      });
      const streamTask = (async () => {
        for await (const part of result.fullStream) {
          if ((part as Any).type === 'finish-step') sawFinishStep = true;
          if ((part as Any).type === 'text-delta') {
            chars += String((part as Any).text ?? (part as Any).delta ?? '').length;
            if (firstTokenAt === 0) firstTokenAt = clock();
          }
        }
      })().then(
        () => {
          streamSettledAt = clock();
        },
        () => {
          streamSettledAt = clock();
        },
      );

      await until(() => firstTokenAt > 0, 30_000, 'the first streamed token');
      await (tools as Any).pauseHere
        .execute({}, { toolCallId: 'manual-gate', messages: [] })
        .catch(() => undefined);
      await streamTask;
      runAborted = ctx.signal.aborted;
    }).catch(() => undefined);

    await delay(400);
    await gm.dispose();

    report.check(
      'the request was genuinely mid-stream when abort was sent',
      chars > 0 && abortSentAt > firstTokenAt,
      `${chars} chars streamed before abort`,
    );
    report.check(
      'the debugger abort cancelled the in-flight request (stream cut off)',
      !sawFinishStep && chars < 400,
      `${chars} chars of a 250-word answer, finish-step seen=${sawFinishStep}`,
    );
    report.check("the run's AbortController really fired", runAborted, `aborted=${runAborted}`);
    report.check(
      'cancellation landed promptly after the abort control',
      streamSettledAt > 0 && streamSettledAt - abortSentAt < 2500,
      `${Math.round(streamSettledAt - abortSentAt)}ms`,
    );
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
  const gm = graphmind({ app: 'live-ai-sdk-detached', url: 'ws://127.0.0.1:9/ingest' });
  const rawModel = openai(MODEL) as Any;
  const wrappedModel = gm.wrapModel(rawModel);

  const measure = async (model: Any): Promise<number> => {
    const t0 = clock();
    const result = streamText({
      model,
      prompt: 'Reply with the single word: ok',
      onError: () => {},
    });
    await result.consumeStream();
    const call = firstProviderCallSince(t0);
    return call === undefined ? Number.NaN : call.startedAt - t0;
  };
  const rawRuns: number[] = [];
  const wrappedRuns: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    rawRuns.push(await measure(rawModel));
    wrappedRuns.push(await measure(wrappedModel));
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

  const gm = graphmind({ app: 'live-ai-sdk', url: server.ingestUrl });
  report.check('attached before the kill', await gm.ready());
  const model = gm.wrapModel(openai(MODEL) as Any);
  const tools = gm.wrapTools({ getWeather: weatherTool } as Any);

  let failure: unknown;
  let result: LoopResult | undefined;
  try {
    result = await gm.run('fail-open', () => runAgent(model, tools, PARALLEL_PROMPT));
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

export async function runAiSdkSuite(report: Report): Promise<void> {
  report.suiteStart('@graphmind-ai/sdk — Vercel AI SDK + @ai-sdk/openai  (real OpenAI API)');
  await scenarioCore(report);
  await scenarioErrorInject(report);
  await scenarioAbort(report);
  await scenarioDetachedOverhead(report);
  await scenarioFailOpen(report);
}
