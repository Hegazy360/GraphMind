/**
 * Loop hold, viewer side.
 *
 * The SDK holds the Nth consecutive call of one tool with identical arguments
 * and says so on `exec.paused` (`reason: 'loop'`, `loop: {repeats, firstSeq,
 * lastSeq, fingerprint}`). Everything the UI derives from that lives here so
 * the banner, the inspector block and the tests agree on one reading:
 *
 *  - `loopBannerText`  — "Loop: 3× searchFlights with identical arguments",
 *                        and the 0.6.0 kinds (`loop.kind`): a `cycle` of 2-4
 *                        calls repeated with the same arguments and results,
 *                        and `error-repeat`, the same error N times in a row;
 *  - `cycleLap`        — the calls of one lap of a cycle, in order;
 *  - `errorStreak`     — the failed calls behind an error-repeat hold;
 *  - `identicalCalls`  — the executions in the streak (their `node.started`
 *                        seq falls in `firstSeq..lastSeq`), with whether each
 *                        got the same output as the one before — the evidence
 *                        that the model is not learning anything new;
 *  - `generateLoopRun` — a synthetic run that ends held on a loop, for the
 *                        browser test and design work (no recorded loop run
 *                        exists yet).
 */
import type { LoopInfo, NodeExecution, NodeState, Pause, RunState } from './types.js';

/**
 * The SDK's redaction placeholder (@graphmind-ai/client `REDACTED`). Kept as a
 * local copy — like InspectorPanel's — so this pure store module does not pull
 * lib/gate.ts's connection and store imports into everything that reads it.
 */
const REDACTED_PLACEHOLDER = '__REDACTED__';

/** "1 identical round", "3 identical rounds". */
function rounds(n: number): string {
  return `${n} identical ${n === 1 ? 'round' : 'rounds'}`;
}

/** A banner sentence in the past tense, for a hold in an exported run. */
export function pastTense(line: string): string {
  return `Was held — ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
}

/**
 * The banner's one line. `undefined` when the pause is not a loop hold.
 *
 *  - repeat (and every 0.5 loop hold): "Loop: 3× searchFlights with identical
 *    arguments";
 *  - cycle: "Loop: search → fetch, 3 identical rounds (same arguments, same
 *    results). Holding round 4 at search." — the lap is read off the run when
 *    it is given and the executions carry seqs; otherwise the lap is named by
 *    its length;
 *  - error-repeat: "Repeated error: run_sql failed 3× in a row with the same
 *    error (arguments varied)." — "(same arguments)" when the recorded inputs
 *    say so, and nothing when they cannot (hidden or missing).
 */
export function loopBannerText(
  node: NodeState,
  pause: Pause,
  replayed = false,
  run?: RunState,
): string | undefined {
  if (pause.reason !== 'loop') return undefined;
  const loop = pause.loop;
  let line: string;
  if (loop?.kind === 'cycle') {
    const laps = loop.laps ?? loop.repeats;
    const lap = run === undefined ? [] : cycleLap(run, node, pause);
    const names =
      lap.length >= 2
        ? lap.map((call) => call.node.name).join(' → ')
        : loop.period !== undefined
          ? `a cycle of ${loop.period} calls`
          : 'a repeating cycle of calls';
    line =
      `Loop: ${names}, ${rounds(laps)} (same arguments, same results). ` +
      `Holding round ${laps + 1} at ${node.name}.`;
  } else if (loop?.kind === 'error-repeat') {
    const args = errorStreakArguments(errorStreak(node, loop));
    const suffix = args === 'varied' ? ' (arguments varied)' : args === 'same' ? ' (same arguments)' : '';
    line = `Repeated error: ${node.name} failed ${loop.repeats}× in a row with the same error${suffix}.`;
  } else {
    const repeats = loop?.repeats;
    const times = repeats === undefined ? '' : `${repeats}× `;
    line = `Loop: ${times}${node.name} with identical arguments`;
  }
  return replayed ? pastTense(line) : line;
}

/** One call of a cycle's lap: which node, and the execution that made it. */
export interface LapCall {
  node: NodeState;
  exec: NodeExecution;
  seq: number;
}

/**
 * The first lap of a `cycle` hold, in call order: the executions of the held
 * node's kind (the detector watches one kind) whose `node.started` seq falls
 * in `firstSeq..lastSeq`, cut to `period` calls — or, without a period, to
 * the calls before the lap's first node comes round again. Empty when the
 * stream carries no seqs or the pause is not a cycle.
 */
export function cycleLap(run: RunState, node: NodeState, pause: Pause): LapCall[] {
  const loop = pause.loop;
  if (pause.reason !== 'loop' || loop?.kind !== 'cycle') return [];
  const calls: LapCall[] = [];
  for (const nodeId of run.order) {
    const candidate = run.nodes[nodeId];
    if (candidate === undefined || candidate.kind !== node.kind) continue;
    for (const exec of candidate.executions) {
      if (exec.seq !== undefined && exec.seq >= loop.firstSeq && exec.seq <= loop.lastSeq) {
        calls.push({ node: candidate, exec, seq: exec.seq });
      }
    }
  }
  calls.sort((a, b) => a.seq - b.seq);
  if (calls.length === 0) return [];
  if (loop.period !== undefined) return calls.slice(0, loop.period);
  const first = calls[0];
  const again = calls.findIndex((c, i) => i > 0 && c.node.nodeId === first?.node.nodeId);
  return again > 0 ? calls.slice(0, again) : calls;
}

/**
 * The failed calls behind an `error-repeat` hold, oldest first: this node's
 * finished executions whose `node.started` seq falls in `firstSeq..lastSeq`
 * (the held call, still running at its `before` gate, is not one of them). A
 * stream without seqs falls back to the last `repeats` finished executions.
 */
export function errorStreak(node: NodeState, loop: LoopInfo | undefined): NodeExecution[] {
  if (loop === undefined) return [];
  const finished = node.executions.filter((exec) => exec.status !== 'running');
  const inRange = finished.filter(
    (exec) => exec.seq !== undefined && exec.seq >= loop.firstSeq && exec.seq <= loop.lastSeq,
  );
  if (inRange.length > 0) return inRange;
  return loop.repeats > 0 ? finished.slice(-loop.repeats) : [];
}

/**
 * Did the failing calls ask for the same thing? `undefined` when the inputs
 * cannot say — hidden (`__REDACTED__`), missing, or fewer than two calls —
 * rather than guessing from a placeholder.
 */
export function errorStreakArguments(calls: readonly NodeExecution[]): 'same' | 'varied' | undefined {
  if (calls.length < 2) return undefined;
  const inputs: string[] = [];
  for (const call of calls) {
    if (call.input === undefined || call.input === REDACTED_PLACEHOLDER) return undefined;
    const json = stableJson(call.input);
    if (json === undefined) return undefined;
    inputs.push(json);
  }
  return inputs.every((json) => json === inputs[0]) ? 'same' : 'varied';
}

export interface IdenticalCall {
  /** 1-based position among the node's executions (matches the "#n" chips). */
  index: number;
  exec: NodeExecution;
  /** The call the gate is holding right now. */
  current: boolean;
  /** Its output is byte-identical (as stable JSON) to the previous call's. */
  sameOutputAsPrevious: boolean;
}

function stableJson(value: unknown): string | undefined {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, v: unknown) => {
      if (v !== null && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        if (!Array.isArray(v)) {
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(v as Record<string, unknown>).sort()) {
            sorted[k] = (v as Record<string, unknown>)[k];
          }
          return sorted;
        }
      }
      return v;
    });
  } catch {
    return undefined;
  }
}

/**
 * The executions that make up the streak, oldest first. Executions are
 * matched by the seq of their `node.started`; a stream that predates
 * `NodeExecution.seq` falls back to the last `repeats` executions.
 */
export function identicalCalls(node: NodeState, loop: LoopInfo | undefined): IdenticalCall[] {
  if (loop === undefined) return [];
  const indexed = node.executions.map((exec, i) => ({ exec, index: i + 1 }));
  let picked = indexed.filter(
    ({ exec }) => exec.seq !== undefined && exec.seq >= loop.firstSeq && exec.seq <= loop.lastSeq,
  );
  if (picked.length === 0 && loop.repeats > 0) picked = indexed.slice(-loop.repeats);
  const currentIndex =
    picked.findIndex(({ exec }) => exec.seq === loop.lastSeq) >= 0
      ? picked.findIndex(({ exec }) => exec.seq === loop.lastSeq)
      : picked.length - 1;
  // A hidden output (GRAPHMIND_HIDE_OUTPUTS / HIDE_TOOL_RESULTS) is the same
  // placeholder every time — that is not evidence of the same answer.
  const comparable = (output: unknown): string | undefined =>
    output === undefined || output === REDACTED_PLACEHOLDER ? undefined : stableJson(output);
  return picked.map(({ exec, index }, i) => {
    const previous = picked[i - 1]?.exec;
    const here = comparable(exec.output);
    const before = previous === undefined ? undefined : comparable(previous.output);
    return {
      index,
      exec,
      current: i === currentIndex,
      sameOutputAsPrevious: here !== undefined && before !== undefined && here === before,
    };
  });
}

// ── synthetic run ────────────────────────────────────────────────────────────

export interface LoopFixtureEnvelope {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
}

export const LOOP_RUN_ID = 'run-loop-3c1a';

export const LOOP_NODES = {
  agent: 'agent:trip-planner',
  llm: 'llm:step',
  flights: 'tool:searchFlights',
} as const;

/** The arguments the model keeps asking for. */
export const LOOP_ARGS = { from: 'AMS', to: 'LIS', date: '2026-10-03' } as const;

/** What the tool keeps answering. */
export const LOOP_OUTPUT = {
  flights: [
    { carrier: 'TP', depart: '07:10', arrive: '09:05', priceEur: 128 },
    { carrier: 'KL', depart: '12:40', arrive: '14:35', priceEur: 141 },
  ],
} as const;

/**
 * sha256("[\"tool:searchFlights\",{\"date\":\"2026-10-03\",\"from\":\"AMS\",\"to\":\"LIS\"}]")[0:32]
 * — the fingerprint @graphmind-ai/client computes for LOOP_ARGS.
 */
export const LOOP_FINGERPRINT = '0822a220d43d7d43cf74b9fc661a2349';

export const LOOP_REPEATS = 3;

/** The model's own request, as the AI SDK adapter records it (contract C1). */
const LOOP_SYSTEM = 'You are a travel assistant. Use searchFlights to find flights.';
const LOOP_ASK = 'Find me the cheapest morning flight AMS → LIS on 3 October.';
const LOOP_TOOL_HASH = '6f2c1a9e0b7d4c33';
const LOOP_TOOL_SCHEMA = {
  type: 'function',
  name: 'searchFlights',
  description: 'Search flights between two airports on a date',
  inputSchema: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string' } },
    required: ['from', 'to', 'date'],
  },
};

/**
 * Round `round`'s prompt: the system prompt, the ask, and every earlier
 * round's tool call and its (identical) result — so the prompt diff shows
 * what a loop looks like: the same call and the same answer appended again.
 */
function loopPrompt(round: number): unknown[] {
  const prompt: unknown[] = [
    { role: 'system', content: LOOP_SYSTEM },
    { role: 'user', content: [{ type: 'text', text: LOOP_ASK }] },
  ];
  for (let earlier = 1; earlier < round; earlier += 1) {
    const toolCallId = `call-${earlier}`;
    prompt.push(
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'searchFlights', input: { ...LOOP_ARGS } }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId, toolName: 'searchFlights', output: { type: 'json', value: LOOP_OUTPUT } }],
      },
    );
  }
  return prompt;
}

/**
 * An agent that asks for the same flight search three times in a row and is
 * held by the loop guard on the third. Each round is one `llm:step` deciding
 * to call the tool, then the tool call. `startTs` is for tests that assert
 * on exact offsets; the viewer passes nothing.
 */
export function generateLoopRun(startTs: number = Date.now() - 6_000): LoopFixtureEnvelope[] {
  const out: LoopFixtureEnvelope[] = [];
  let seq = 0;
  let ts = startTs;
  const emit = (type: string, payload: Record<string, unknown>, gapMs = 0): LoopFixtureEnvelope => {
    ts += gapMs;
    const env = { gm: 1, seq: seq++, ts, runId: LOOP_RUN_ID, type, payload };
    out.push(env);
    return env;
  };

  emit('run.started', {
    app: 'trip-planner',
    sdk: { name: 'ai', version: '7.0.79' },
    meta: { name: 'trip-planner', env: 'dev' },
  });
  emit(
    'node.started',
    {
      nodeId: LOOP_NODES.agent,
      kind: 'agent',
      name: 'trip-planner',
      instanceId: LOOP_RUN_ID,
      input: { prompt: 'Find me the cheapest morning flight AMS → LIS on 3 October.' },
    },
    40,
  );

  const startSeqs: number[] = [];
  for (let round = 1; round <= LOOP_REPEATS; round += 1) {
    const stepId = `step-${round}`;
    emit(
      'node.started',
      {
        nodeId: LOOP_NODES.llm,
        kind: 'llm',
        name: 'step',
        parentId: LOOP_NODES.agent,
        instanceId: stepId,
        input: {
          prompt: loopPrompt(round),
          modelId: 'gpt-4o-mini',
          provider: 'openai.chat',
          tools: [{ name: 'searchFlights', schemaHash: LOOP_TOOL_HASH }],
          // Each definition once per run (C1): on the first step only.
          ...(round === 1 ? { toolSchemas: { [LOOP_TOOL_HASH]: LOOP_TOOL_SCHEMA } } : {}),
        },
      },
      round === 1 ? 120 : 380,
    );
    emit(
      'node.finished',
      {
        nodeId: LOOP_NODES.llm,
        instanceId: stepId,
        output: { toolCalls: [{ name: 'searchFlights', args: LOOP_ARGS }] },
        // A 0.6 sender stamps `inclusive` on every usage (C1).
        usage: { inputTokens: 900 + round * 210, outputTokens: 38, inclusive: true },
        durationMs: 640.25,
        status: 'ok',
      },
      640,
    );
    const callId = `call-${round}`;
    const started = emit(
      'node.started',
      {
        nodeId: LOOP_NODES.flights,
        kind: 'tool',
        name: 'searchFlights',
        parentId: LOOP_NODES.llm,
        instanceId: callId,
        input: { ...LOOP_ARGS },
      },
      30,
    );
    startSeqs.push(started.seq);
    if (round < LOOP_REPEATS) {
      emit(
        'node.finished',
        {
          nodeId: LOOP_NODES.flights,
          instanceId: callId,
          output: LOOP_OUTPUT,
          durationMs: 212.4,
          status: 'ok',
        },
        212,
      );
    }
  }

  emit(
    'exec.paused',
    {
      pauseId: 'pause-loop-1',
      nodeId: LOOP_NODES.flights,
      point: 'before',
      reason: 'loop',
      loop: {
        repeats: LOOP_REPEATS,
        firstSeq: startSeqs[0] ?? 0,
        lastSeq: startSeqs[startSeqs.length - 1] ?? 0,
        fingerprint: LOOP_FINGERPRINT,
      },
    },
    4,
  );
  return out;
}
