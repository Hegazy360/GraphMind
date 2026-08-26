/**
 * Synthetic stress runs. A deterministic generator that produces a large,
 * realistically-shaped agent run (fan-out sub-agents, parallel tool calls,
 * streamed steps, retries, a failure that holds a gate) so the viewer's
 * scaling work can be measured instead of asserted.
 *
 * Used by `?stress=300` in the dev server and by the perf test. Ships in the
 * bundle only via a dynamic import from the stress connection.
 */
import type { EventEnvelope, EventType, MessagePayloadMap } from '@graphmind-ai/schema';
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';

export interface StressOptions {
  /** Target number of logical nodes (default 300). */
  nodes?: number;
  /** Approximate total number of envelopes (default 5000). */
  events?: number;
  runId?: string;
  /** Epoch ms of the first event. */
  startTs?: number;
  seed?: number;
}

/** Tiny deterministic PRNG (mulberry32) — same run for the same seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOL_NAMES = [
  'searchDocs', 'fetchPage', 'runSql', 'embedChunk', 'rankResults', 'callApi',
  'writeFile', 'readFile', 'summarize', 'classify', 'extractEntities', 'validate',
  'translate', 'geocode', 'sendEmail', 'chargeCard', 'checkInventory', 'scoreLead',
];

const WORD_POOL = [
  'analysing', 'the', 'retrieved', 'passages', 'to', 'determine', 'whether', 'the',
  'inventory', 'figures', 'reconcile', 'with', 'last', "quarter's", 'ledger', 'entries.',
  'Next', 'I', 'will', 'call', 'the', 'validation', 'tool', 'on', 'each', 'anomaly.',
];

export interface StressRun {
  runId: string;
  envelopes: EventEnvelope[];
  nodeCount: number;
}

/**
 * Build a stress run. Shape: one root agent → `workers` sub-agents, each with
 * its own `llm:step` node and a handful of tools. Every tool logical node is
 * executed 1–3 times, one worker fails and holds an error gate.
 */
export function generateStressRun(options: StressOptions = {}): StressRun {
  const targetNodes = Math.max(8, options.nodes ?? 300);
  const targetEvents = Math.max(targetNodes * 4, options.events ?? 5000);
  const runId = options.runId ?? `stress-${targetNodes}`;
  const random = rng(options.seed ?? 7);
  let ts = options.startTs ?? Date.now() - 90_000;
  let seq = 1;

  const envelopes: EventEnvelope[] = [];
  const emit = <T extends EventType>(type: T, payload: MessagePayloadMap[T], stepMs = 0): void => {
    ts += stepMs;
    envelopes.push({
      gm: PROTOCOL_VERSION,
      seq: seq++,
      ts,
      runId,
      type,
      payload,
    } as EventEnvelope);
  };

  // Each worker contributes: 1 agent + 1 llm step + `toolsPerWorker` tools.
  const toolsPerWorker = 4;
  const perWorker = 2 + toolsPerWorker;
  const workers = Math.max(1, Math.round((targetNodes - 1) / perWorker));
  const nodeCount = 1 + workers * perWorker;

  emit('run.started', {
    app: 'bulk-classifier',
    sdk: { name: 'ai', version: '7.0.79' },
    meta: { env: 'stress', workers, entry: 'examples/stress/main.ts' },
  });

  const rootId = 'agent:bulk-classifier';
  emit('node.started', {
    nodeId: rootId,
    kind: 'agent',
    name: 'bulk-classifier',
    instanceId: runId,
    input: { batch: 'invoices-2026-Q2', items: workers * 12 },
  }, 40);

  // Failure lands in a worker roughly two-thirds through the run.
  const failingWorker = Math.max(0, Math.floor(workers * 0.66));
  const tokenBudget = Math.max(0, targetEvents - nodeCount * 3 - 8);
  const tokenEventsPerStep = Math.max(1, Math.floor(tokenBudget / Math.max(1, workers * 2)));

  for (let w = 0; w < workers; w++) {
    const workerId = `agent:worker-${w}`;
    const stepId = `llm:step-${w}`;
    emit('node.started', {
      nodeId: workerId,
      parentId: rootId,
      kind: 'agent',
      name: `worker ${w}`,
      instanceId: `${workerId}#1`,
      input: { shard: w, items: 12 },
    }, 12 + Math.floor(random() * 25));

    const toolIds: string[] = [];
    for (let t = 0; t < toolsPerWorker; t++) {
      toolIds.push(`tool:${TOOL_NAMES[(w * toolsPerWorker + t) % TOOL_NAMES.length] ?? 'callApi'}-${w}-${t}`);
    }
    emit('graph.hint', {
      nodes: [
        { nodeId: stepId, kind: 'llm', name: 'llm step', parentId: workerId },
        ...toolIds.map((id, i) => ({
          nodeId: id,
          kind: 'tool' as const,
          name: id.slice(5),
          parentId: stepId,
          ...(i === toolsPerWorker - 1 ? { providerExecuted: true, ungated: true } : {}),
        })),
      ],
    });

    // Two LLM steps per worker, tools fanned out in parallel between them.
    for (let s = 0; s < 2; s++) {
      emit('node.started', {
        nodeId: stepId,
        parentId: workerId,
        kind: 'llm',
        name: 'llm step',
        instanceId: `${stepId}#${s + 1}`,
        input: { messages: 4 + s * 2 },
      }, 20 + Math.floor(random() * 40));

      for (let k = 0; k < tokenEventsPerStep; k++) {
        const words: string[] = [];
        const count = 2 + Math.floor(random() * 4);
        for (let i = 0; i < count; i++) {
          words.push(WORD_POOL[Math.floor(random() * WORD_POOL.length)] ?? 'token');
        }
        emit('node.token', {
          nodeId: stepId,
          deltas: [{ t: 'text', v: `${words.join(' ')} ` }],
        }, 8);
      }

      emit('node.finished', {
        nodeId: stepId,
        instanceId: `${stepId}#${s + 1}`,
        output: { toolCalls: toolsPerWorker },
        usage: {
          inputTokens: 900 + Math.floor(random() * 2200),
          outputTokens: 120 + Math.floor(random() * 500),
        },
        durationMs: 400 + Math.floor(random() * 2600),
        status: 'ok',
      }, 30);

      if (s === 0) {
        // Parallel tool fan-out: all start, then all finish.
        const runningTools = toolIds.map((id, i) => ({ id, instanceId: `${id}#${i}` }));
        for (const tool of runningTools) {
          emit('node.started', {
            nodeId: tool.id,
            parentId: stepId,
            kind: 'tool',
            name: tool.id.slice(5),
            instanceId: tool.instanceId,
            input: { query: `shard ${w}`, limit: 20 },
          }, 4);
        }
        for (let i = 0; i < runningTools.length; i++) {
          const tool = runningTools[i];
          if (tool === undefined) continue;
          const isFailure = w === failingWorker && i === runningTools.length - 2;
          if (isFailure) {
            emit('node.error', {
              nodeId: tool.id,
              instanceId: tool.instanceId,
              error: {
                name: 'UpstreamTimeout',
                message: `${tool.id.slice(5)} did not respond within 30s`,
                stack: `UpstreamTimeout: ${tool.id.slice(5)} did not respond within 30s\n    at fetchWithTimeout (src/net/http.ts:88:11)\n    at async ${tool.id.slice(5)} (src/tools/${tool.id.slice(5)}.ts:24:20)`,
              },
            }, 30);
            emit('node.finished', {
              nodeId: tool.id,
              instanceId: tool.instanceId,
              output: null,
              durationMs: 30_000,
              status: 'error',
            });
            emit('exec.paused', { pauseId: `pause-${w}`, nodeId: tool.id, point: 'error' }, 5);
            emit('exec.resumed', { pauseId: `pause-${w}`, action: 'retry' }, 900);
            emit('node.started', {
              nodeId: tool.id,
              parentId: stepId,
              kind: 'tool',
              name: tool.id.slice(5),
              instanceId: `${tool.instanceId}r`,
              input: { query: `shard ${w}`, limit: 20, retry: 1 },
            }, 10);
            emit('node.finished', {
              nodeId: tool.id,
              instanceId: `${tool.instanceId}r`,
              output: { rows: 12 },
              durationMs: 210,
              status: 'ok',
            }, 220);
            continue;
          }
          emit('node.finished', {
            nodeId: tool.id,
            instanceId: tool.instanceId,
            output: { rows: Math.floor(random() * 40), cached: random() > 0.7 },
            durationMs: 60 + Math.floor(random() * 1800),
            status: 'ok',
          }, 6 + Math.floor(random() * 30));
        }
      }
    }

    emit('node.finished', {
      nodeId: workerId,
      instanceId: `${workerId}#1`,
      output: { classified: 12, flagged: Math.floor(random() * 3) },
      durationMs: 2000 + Math.floor(random() * 6000),
      status: 'ok',
    }, 15);
  }

  emit('node.finished', {
    nodeId: rootId,
    instanceId: runId,
    output: { shards: workers, ok: workers },
    usage: { inputTokens: 12_000, outputTokens: 4_200 },
    durationMs: Math.max(1, ts - (options.startTs ?? ts)),
    status: 'ok',
  }, 60);
  emit('run.finished', { status: 'ok' }, 10);

  return { runId, envelopes, nodeCount };
}
