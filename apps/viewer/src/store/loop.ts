/**
 * Loop hold, viewer side.
 *
 * The SDK holds the Nth consecutive call of one tool with identical arguments
 * and says so on `exec.paused` (`reason: 'loop'`, `loop: {repeats, firstSeq,
 * lastSeq, fingerprint}`). Everything the UI derives from that lives here so
 * the banner, the inspector block and the tests agree on one reading:
 *
 *  - `loopBannerText`  — "Loop: 3× searchFlights with identical arguments";
 *  - `identicalCalls`  — the executions in the streak (their `node.started`
 *                        seq falls in `firstSeq..lastSeq`), with whether each
 *                        got the same output as the one before — the evidence
 *                        that the model is not learning anything new;
 *  - `generateLoopRun` — a synthetic run that ends held on a loop, for the
 *                        browser test and design work (no recorded loop run
 *                        exists yet).
 */
import type { LoopInfo, NodeExecution, NodeState, Pause } from './types.js';

/**
 * The SDK's redaction placeholder (@graphmind-ai/client `REDACTED`). Kept as a
 * local copy — like InspectorPanel's — so this pure store module does not pull
 * lib/gate.ts's connection and store imports into everything that reads it.
 */
const REDACTED_PLACEHOLDER = '__REDACTED__';

/** The banner's one line. `undefined` when the pause is not a loop hold. */
export function loopBannerText(node: NodeState, pause: Pause, replayed = false): string | undefined {
  if (pause.reason !== 'loop') return undefined;
  const repeats = pause.loop?.repeats;
  const times = repeats === undefined ? '' : `${repeats}× `;
  const line = `${times}${node.name} with identical arguments`;
  return replayed ? `Was held — loop: ${line}` : `Loop: ${line}`;
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
        input: { model: 'gpt-4o-mini', step: round },
      },
      round === 1 ? 120 : 380,
    );
    emit(
      'node.finished',
      {
        nodeId: LOOP_NODES.llm,
        instanceId: stepId,
        output: { toolCalls: [{ name: 'searchFlights', args: LOOP_ARGS }] },
        usage: { inputTokens: 900 + round * 210, outputTokens: 38 },
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
