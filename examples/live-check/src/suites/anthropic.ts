/**
 * @graphmind-ai/anthropic against the real Anthropic API.
 *
 * The agent is a genuine multi-turn tool-calling loop written the way the
 * README tells you to write one: stream `messages.create`, dispatch the
 * `tool_use` blocks through `gm.wrapTools`, feed `tool_result` back, repeat.
 */
import Anthropic from '@anthropic-ai/sdk';
import { graphmind, isAbortError } from '@graphmind-ai/anthropic';
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

export const MODEL = 'claude-haiku-4-5-20251001';

const WEATHER_TOOL = {
  name: 'getWeather',
  description: WEATHER_TOOL_DESCRIPTION,
  input_schema: WEATHER_JSON_SCHEMA,
};
const RATE_TOOL = {
  name: 'getRate',
  description: RATE_TOOL_DESCRIPTION,
  input_schema: RATE_JSON_SCHEMA,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

interface AssistantTurn {
  text: string;
  toolUses: { id: string; name: string; input: Any }[];
  stopReason: string | undefined;
  content: Any[];
}

/** Consume a raw Anthropic event stream and rebuild the assistant turn. */
async function consumeStream(stream: AsyncIterable<Any>): Promise<AssistantTurn> {
  const blocks = new Map<number, Any>();
  const order: number[] = [];
  let stopReason: string | undefined;
  let text = '';
  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start': {
        blocks.set(event.index, { ...event.content_block, __json: '' });
        order.push(event.index);
        break;
      }
      case 'content_block_delta': {
        const block = blocks.get(event.index);
        if (block === undefined) break;
        if (event.delta?.type === 'text_delta') {
          block.text = (block.text ?? '') + event.delta.text;
          text += event.delta.text;
        } else if (event.delta?.type === 'input_json_delta') {
          block.__json += event.delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const block = blocks.get(event.index);
        if (block !== undefined && block.type === 'tool_use') {
          block.input = block.__json.length > 0 ? JSON.parse(block.__json) : {};
        }
        break;
      }
      case 'message_delta': {
        if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
        break;
      }
      default:
        break;
    }
  }
  const content = order.map((index) => {
    const { __json, ...rest } = blocks.get(index) as Any;
    void __json;
    return rest;
  });
  return {
    text,
    stopReason,
    content,
    toolUses: content
      .filter((b: Any) => b.type === 'tool_use')
      .map((b: Any) => ({ id: b.id, name: b.name, input: b.input })),
  };
}

interface LoopResult {
  /** Concatenated model text, in step order — what the deltas must rebuild. */
  hostText: string;
  finalText: string;
  turns: number;
  toolCalls: { id: string; name: string; input: Any }[];
  /** The messages array as it stood when the LAST model request was made. */
  lastRequestMessages: Any[];
}

async function runLoop(opts: {
  client: Any;
  tools: Record<string, (input: Any) => Promise<Any>>;
  toolSchemas: Any[];
  prompt: string;
  maxTurns?: number;
  requestOptions?: Record<string, unknown>;
}): Promise<LoopResult> {
  const messages: Any[] = [{ role: 'user', content: opts.prompt }];
  const toolCalls: { id: string; name: string; input: Any }[] = [];
  let hostText = '';
  let finalText = '';
  let turns = 0;
  let lastRequestMessages: Any[] = [];

  for (let i = 0; i < (opts.maxTurns ?? 4); i += 1) {
    lastRequestMessages = messages.map((m) => JSON.parse(JSON.stringify(m)) as Any);
    turns += 1;
    const stream = await opts.client.messages.create(
      {
        model: MODEL,
        max_tokens: 400,
        tools: opts.toolSchemas,
        messages,
        stream: true,
      },
      opts.requestOptions,
    );
    const turn = await consumeStream(stream as AsyncIterable<Any>);
    hostText += turn.text;
    finalText = turn.text;
    messages.push({ role: 'assistant', content: turn.content });
    if (turn.stopReason !== 'tool_use' || turn.toolUses.length === 0) break;

    const results = await Promise.all(
      turn.toolUses.map(async (use) => {
        toolCalls.push(use);
        const fn = opts.tools[use.name];
        const output = fn === undefined ? { error: `no tool ${use.name}` } : await fn(use.input);
        return {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: JSON.stringify(output),
        };
      }),
    );
    messages.push({ role: 'user', content: results });
  }
  return { hostText, finalText, turns, toolCalls, lastRequestMessages };
}

// ---------------------------------------------------------------------------

const HOLD_MS = 6000;
const REQUEST_TIMEOUT_MS = 5000;

async function scenarioCore(report: Report): Promise<void> {
  report.scenarioStart('core: graph, streaming, real usage, a 6s hold with a 5s SDK timeout');
  await withHarness(async ({ dbg, url }) => {
    // Arm before the app connects, so hello.ack carries them.
    dbg.setBreakpoint({ kind: 'llm', point: 'before' });
    dbg.setBreakpoint({ kind: 'tool', point: 'before' });

    let holdFrom = 0;
    let holdTo = 0;
    let llmPauses = 0;
    const toolPauses: { pauseId: string; at: number }[] = [];
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
      toolPauses.push({ pauseId: pause.pauseId, at: pause.at });
      // Hold this tool gate until its sibling also reports paused: that is
      // what "parallel tool calls gate independently" means.
      try {
        await until(() => toolPauses.length >= 2, 4000, 'a second tool gate');
        toolsHeldTogether = true;
      } catch {
        // one tool call only; reported below
      }
      dbg.resume(pause.runId, pause.pauseId, 'continue');
    });

    const gm = graphmind({ app: 'live-anthropic', url });
    const attached = await gm.ready();
    report.check('gm.ready() attached to the real server', attached);

    const client = gm.wrapClient(new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] }));
    const tools = gm.wrapTools({ getWeather });

    const runStart = clock();
    const result = await gm.run('weather-compare', () =>
      runLoop({
        client,
        tools: tools as Any,
        toolSchemas: [WEATHER_TOOL],
        prompt: PARALLEL_PROMPT,
        // Sharp test of decisions.md #3: a 5s per-request SDK timeout across a
        // 6s hold. If the timer started when create() was called, this fails.
        requestOptions: { timeout: REQUEST_TIMEOUT_MS },
      }),
    );
    await delay(400); // let the last envelopes flush
    await gm.dispose();

    const runId = dbg.events('run.started')[0]?.runId ?? '';
    report.check('the run reached the server', runId.length > 0);

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

    // -- the hold ----------------------------------------------------------
    const during = providerCallsBetween(holdFrom, holdTo);
    report.check(
      'a held llm gate issued ZERO provider HTTP requests while holding',
      holdTo > 0 && during.length === 0,
      `${during.length} requests in a ${Math.round(holdTo - holdFrom)}ms hold`,
    );
    report.check(
      'the hold really lasted multiple seconds',
      holdTo - holdFrom >= HOLD_MS,
      `${Math.round(holdTo - holdFrom)}ms`,
    );
    const firstCall = firstProviderCallSince(runStart);
    report.check(
      'the first provider request only started after the gate was released',
      firstCall !== undefined && firstCall.startedAt >= holdTo,
      firstCall === undefined
        ? 'no provider request seen'
        : `request at +${Math.round(firstCall.startedAt - holdTo)}ms after release`,
    );
    const llmEnds = finished(dbg, runId).filter(
      (n) => n.nodeId === 'llm:step' && n.status === 'ok',
    );
    report.check(
      `the provider did NOT time out across the hold (SDK timeout ${REQUEST_TIMEOUT_MS}ms < hold ${HOLD_MS}ms)`,
      llmEnds.length === result.turns,
      `${llmEnds.length}/${result.turns} llm steps finished ok`,
    );

    // -- parallel tool gates ------------------------------------------------
    if (result.toolCalls.length >= 2) {
      report.check(
        'parallel real tool calls held their gates independently and simultaneously',
        toolsHeldTogether,
        `${toolPauses.length} tool gates observed`,
      );
      // Pairing, not just set equality: instanceId <-> the input the model sent.
      const starts = started(dbg, runId).filter((n) => n.nodeId === 'tool:getWeather');
      const providerPairs = new Map(
        result.toolCalls.map((c) => [c.id, JSON.stringify(c.input)] as const),
      );
      const paired = starts.every(
        (n) => providerPairs.get(n.instanceId) === JSON.stringify(n.input),
      );
      report.check(
        'each tool instanceId is paired with the right tool_use input',
        paired,
        starts.map((n) => `${n.instanceId}=${JSON.stringify(n.input)}`).join(' '),
      );
    } else {
      report.skip(
        'parallel real tool calls gate independently',
        `the model emitted ${result.toolCalls.length} tool call(s) this run`,
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
    // {point:'error'} is armed by the server's default DebugState.
    dbg.onPaused((pause) => {
      if (pause.point === 'error') dbg.resume(pause.runId, pause.pauseId, 'inject', INJECTED_RATE);
      else dbg.resume(pause.runId, pause.pauseId, 'continue');
    });

    const gm = graphmind({ app: 'live-anthropic', url });
    await gm.ready();
    const client = gm.wrapClient(new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] }));
    const tools = gm.wrapTools({ getRate });

    const result = await gm.run('fx-quote', () =>
      runLoop({
        client,
        tools: tools as Any,
        toolSchemas: [RATE_TOOL],
        prompt: RATE_PROMPT,
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
    const nodeErrors = dbg.events('node.error', runId);
    report.check(
      'node.error carried the real thrown error',
      nodeErrors.length === 1 &&
        String((nodeErrors[0]?.payload['error'] as Any)?.message).includes('503'),
      String((nodeErrors[0]?.payload['error'] as Any)?.message ?? ''),
    );
    const toolEnd = finished(dbg, runId).find((n) => n.nodeId === 'tool:getRate');
    report.check(
      'the injected value became the tool result (status ok, injected flag)',
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
    recordRunUsage(report, dbg, runId, MODEL);
  });
}

const RETRY_RATE = 7.7777;

async function scenarioRetry(report: Report): Promise<void> {
  report.scenarioStart('retry at a real error gate re-runs the tool inside ONE node execution');
  await withHarness(async ({ dbg, url }) => {
    dbg.onPaused((pause) => {
      if (pause.point === 'error') dbg.resume(pause.runId, pause.pauseId, 'retry');
      else dbg.resume(pause.runId, pause.pauseId, 'continue');
    });

    const gm = graphmind({ app: 'live-anthropic', url });
    await gm.ready();
    const client = gm.wrapClient(new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] }));

    let attempts = 0;
    const tools = gm.wrapTools({
      getRate: (input: { from?: unknown; to?: unknown }) => {
        attempts += 1;
        // Fails once, like a real flaky upstream; succeeds when re-run.
        if (attempts === 1) throw new Error('FX rate service returned HTTP 503');
        return { from: String(input.from), to: String(input.to), rate: RETRY_RATE };
      },
    });

    const result = await gm.run('fx-retry', () =>
      runLoop({
        client,
        tools: tools as Any,
        toolSchemas: [RATE_TOOL],
        prompt: RATE_PROMPT,
      }),
    );
    await delay(400);
    await gm.dispose();

    const runId = dbg.events('run.started')[0]?.runId ?? '';
    report.check(
      'the debugger paused on the real error and the tool body ran a second time',
      attempts === 2 && dbg.pauses.some((p) => p.point === 'error'),
      `${attempts} attempts, ${dbg.pauses.length} pauses`,
    );
    const toolStarts = started(dbg, runId).filter((n) => n.nodeId === 'tool:getRate');
    const toolEnds = finished(dbg, runId).filter((n) => n.nodeId === 'tool:getRate');
    report.check(
      'a retried tool stays ONE node execution (one started, one finished)',
      toolStarts.length === 1 && toolEnds.length === 1 && toolEnds[0]?.status === 'ok',
      `${toolStarts.length} started / ${toolEnds.length} finished / ${String(toolEnds[0]?.status)}`,
    );
    report.check(
      'the retried call\'s REAL result reached the model\'s next turn',
      result.finalText.includes(String(RETRY_RATE)),
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

    const gm = graphmind({ app: 'live-anthropic', url });
    await gm.ready();
    const client = gm.wrapClient(new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] }));
    const tools = gm.wrapTools({ pauseHere: async () => 'never used' });

    let deltas = 0;
    let chars = 0;
    let sawMessageStop = false;
    let firstTokenAt = 0;
    let streamOutcome: unknown = 'completed';
    let streamSettledAt = 0;
    let runAborted = false;

    await gm.run('abort-inflight', async (ctx) => {
      const streamTask = (async () => {
        const stream = (await client.messages.create({
          model: MODEL,
          max_tokens: 800,
          messages: [{ role: 'user', content: LONG_PROMPT }],
          stream: true,
        })) as AsyncIterable<Any>;
        for await (const event of stream) {
          if (event.type === 'message_stop') sawMessageStop = true;
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            deltas += 1;
            chars += String(event.delta.text ?? '').length;
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
      deltas > 0 && abortSentAt > firstTokenAt,
      `${deltas} text deltas before abort`,
    );
    report.check(
      'the debugger abort cancelled the in-flight request (stream cut off, no message_stop)',
      !sawMessageStop && chars < 400,
      `${chars} chars of a 250-word answer, message_stop=${sawMessageStop}`,
    );
    report.check(
      "the run's AbortController really fired",
      runAborted,
      `aborted=${runAborted}`,
    );
    report.check(
      'cancellation landed promptly after the abort control',
      streamSettledAt > 0 && streamSettledAt - abortSentAt < 2500,
      `${Math.round(streamSettledAt - abortSentAt)}ms`,
    );
    // REALITY GAP, not a defect: the Anthropic SDK deliberately swallows abort
    // errors inside its stream iterator, so the host's `for await` exits
    // cleanly instead of throwing. Record which way it went.
    if (streamOutcome === 'completed') {
      report.note(
        'Anthropic SDK: aborting mid-stream ends the host iterator CLEANLY (no throw) — ' +
          'core/streaming.mjs swallows AbortError. Agent loops must check the signal, ' +
          'not rely on a throw. GraphMind still marks the step aborted (see next check).',
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
      'the aborted llm step is reported as aborted, not errored',
      llmEnd?.status === 'aborted',
      String(llmEnd?.status),
    );
    recordRunUsage(report, dbg, runId, MODEL);
  });
}

async function scenarioDetachedOverhead(report: Report): Promise<void> {
  report.scenarioStart('detached mode adds no measurable overhead to a real call');
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const raw = new Anthropic({ apiKey });
  // Detached: enabled, but pointed at a port with nothing listening.
  const gm = graphmind({ app: 'live-anthropic-detached', url: 'ws://127.0.0.1:9/ingest' });
  const wrapped = gm.wrapClient(new Anthropic({ apiKey }));

  const request = {
    model: MODEL,
    max_tokens: 8,
    messages: [{ role: 'user' as const, content: 'Reply with the single word: ok' }],
  };

  const measure = async (client: Any): Promise<{ dispatch: number; total: number }> => {
    const t0 = clock();
    await client.messages.create(request);
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
  const overhead = wrappedDispatch - rawDispatch;

  report.check(
    'detached wrapping adds <15ms before the real HTTP request goes out',
    overhead < 15,
    `raw ${rawDispatch.toFixed(2)}ms -> wrapped ${wrappedDispatch.toFixed(2)}ms (+${overhead.toFixed(2)}ms)`,
  );
  report.check(
    'the detached session never attached (so this measured the detached path)',
    !gm.session.attached,
    `attached=${gm.session.attached}`,
  );
  report.note(
    `anthropic end-to-end median: raw ${median(rawRuns.map((r) => r.total)).toFixed(
      0,
    )}ms vs detached-wrapped ${median(wrappedRuns.map((r) => r.total)).toFixed(0)}ms (network dominates)`,
  );
}

async function scenarioFailOpen(report: Report): Promise<void> {
  report.scenarioStart('fail-open: kill the debugger mid-hold, the real agent finishes anyway');
  const server = await import('../harness/server.js').then((m) => m.startLiveServer());
  const { HeadlessDebugger } = await import('../harness/debugger.js');
  const dbg = await HeadlessDebugger.connect(server.uiUrl);
  dbg.setBreakpoint({ kind: 'llm', point: 'before' });

  let killedAt = 0;
  dbg.onPaused(async () => {
    if (killedAt !== 0) return;
    killedAt = clock();
    // The debugger dies without ever resuming the gate.
    dbg.close();
    await server.stop();
  });

  const gm = graphmind({ app: 'live-anthropic', url: server.ingestUrl });
  const attached = await gm.ready();
  report.check('attached before the kill', attached);
  const client = gm.wrapClient(new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] }));
  const tools = gm.wrapTools({ getWeather });

  let failure: unknown;
  let result: LoopResult | undefined;
  try {
    result = await gm.run('fail-open', () =>
      runLoop({
        client,
        tools: tools as Any,
        toolSchemas: [WEATHER_TOOL],
        prompt: PARALLEL_PROMPT,
      }),
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

export async function runAnthropicSuite(report: Report): Promise<void> {
  report.suiteStart('@graphmind-ai/anthropic  (real Anthropic API)');
  await scenarioCore(report);
  await scenarioErrorInject(report);
  await scenarioRetry(report);
  await scenarioAbort(report);
  await scenarioDetachedOverhead(report);
  await scenarioFailOpen(report);
}
