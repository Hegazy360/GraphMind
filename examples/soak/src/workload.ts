/**
 * The mock model / mock agent.
 *
 * Deterministic (seeded) and free: no provider is called. The shape is the
 * shape a real ai-sdk adapter produces — an `agent:` root, `llm:step-N`
 * children with heavy token streaming, and `tool:<name>` leaves hanging off
 * the step that called them, with a sprinkling of errors. Node identity
 * follows decisions.md #1: `nodeId` is stable per logical node, `instanceId`
 * changes per execution.
 *
 * Every generated payload carries a loose extra field `i` — a per-run
 * ordinal. The wire contract preserves unknown payload fields, so `i` rides
 * through the server untouched and lets verification prove exactly-once
 * delivery and ordering without depending on the client's internal seq.
 */
import type { EventPayloadMap, EventType } from '@graphmind-ai/schema';
import { mulberry32, filler } from './util.ts';

export interface PlannedEvent<T extends EventType = EventType> {
  type: T;
  payload: EventPayloadMap[T] & { i: number };
}

export interface WorkloadOptions {
  /** Target number of events (the generator overshoots to finish a step). */
  events: number;
  /** Approximate number of distinct logical tool nodes. */
  toolNodes: number;
  /** Token batches emitted per llm step. */
  tokenBatchesPerStep: number;
  /** Deltas per `node.token` envelope. */
  deltasPerBatch: number;
  /** Characters per delta. */
  deltaChars: number;
  /** 1 in N tool executions fails. 0 disables errors. */
  errorEveryNTools: number;
  /** Bytes of filler in each tool result payload. */
  toolResultBytes: number;
  seed: number;
  runName: string;
}

export const DEFAULT_WORKLOAD: WorkloadOptions = {
  events: 10_000,
  toolNodes: 280,
  tokenBatchesPerStep: 40,
  deltasPerBatch: 4,
  deltaChars: 12,
  errorEveryNTools: 40,
  toolResultBytes: 220,
  seed: 20260827,
  runName: 'soak',
};

export interface WorkloadStats {
  events: number;
  logicalNodes: number;
  tokenEvents: number;
  errorEvents: number;
  bytes: number;
}

/**
 * Generate the event plan. Returns a lazily-built array: at 10k events with
 * the defaults this is ~6MB of payload strings, which is fine in the driver
 * and keeps emission itself allocation-free (important when measuring rate).
 */
export function buildWorkload(options: WorkloadOptions): {
  events: PlannedEvent[];
  stats: WorkloadStats;
} {
  const random = mulberry32(options.seed);
  const events: PlannedEvent[] = [];
  const nodeIds = new Set<string>();
  let tokenEvents = 0;
  let errorEvents = 0;

  const push = <T extends EventType>(type: T, payload: EventPayloadMap[T]): void => {
    events.push({ type, payload: { ...payload, i: events.length } } as PlannedEvent);
  };

  const root = `agent:${options.runName}`;
  nodeIds.add(root);

  const toolNames: string[] = [];
  for (let t = 0; t < Math.max(1, options.toolNodes); t += 1) {
    toolNames.push(`tool:t${String(t).padStart(3, '0')}`);
  }

  // Static structure first, the way an adapter announces known tools.
  push('graph.hint', {
    nodes: [
      { nodeId: root, kind: 'agent', name: options.runName },
      ...toolNames.map((nodeId) => ({
        nodeId,
        kind: 'tool' as const,
        name: nodeId.slice('tool:'.length),
        parentId: root,
      })),
    ],
  });
  for (const nodeId of toolNames) nodeIds.add(nodeId);

  push('node.started', {
    nodeId: root,
    kind: 'agent',
    name: options.runName,
    instanceId: 'run-0',
    input: { prompt: 'soak the debugger until something gives' },
  });

  const deltaText = filler(options.deltaChars, 'lorem ipsum dolor sit amet ');
  const toolResult = filler(options.toolResultBytes, 'result-chunk-');
  let step = 0;
  let toolExecutions = 0;
  const startedAt = Date.now();

  while (events.length < options.events) {
    const stepId = `llm:step-${step}`;
    nodeIds.add(stepId);
    push('node.started', {
      nodeId: stepId,
      parentId: root,
      kind: 'llm',
      name: `step ${step}`,
      instanceId: `${stepId}#0`,
      input: { messages: [{ role: 'user', content: `turn ${step}` }] },
    });
    for (let b = 0; b < options.tokenBatchesPerStep; b += 1) {
      const deltas = [];
      for (let d = 0; d < options.deltasPerBatch; d += 1) {
        deltas.push({ t: 'text' as const, v: deltaText });
      }
      push('node.token', { nodeId: stepId, deltas });
      tokenEvents += 1;
    }
    push('node.finished', {
      nodeId: stepId,
      instanceId: `${stepId}#0`,
      output: { text: deltaText.repeat(2) },
      usage: { inputTokens: 120 + step, outputTokens: 64 },
      durationMs: 40 + Math.floor(random() * 400),
      status: 'ok',
    });

    // 1..5 tool calls per step, drawn deterministically.
    const calls = 1 + Math.floor(random() * 5);
    for (let c = 0; c < calls; c += 1) {
      const nodeId = toolNames[toolExecutions % toolNames.length] as string;
      const instanceId = `call-${toolExecutions}`;
      const fails =
        options.errorEveryNTools > 0 && toolExecutions % options.errorEveryNTools === options.errorEveryNTools - 1;
      toolExecutions += 1;
      push('node.started', {
        nodeId,
        parentId: stepId,
        kind: 'tool',
        name: nodeId.slice('tool:'.length),
        instanceId,
        input: { query: `q-${toolExecutions}`, at: startedAt },
      });
      if (fails) {
        push('node.error', {
          nodeId,
          instanceId,
          error: { name: 'ToolError', message: `tool ${nodeId} exploded on call ${toolExecutions}` },
        });
        errorEvents += 1;
        push('node.finished', {
          nodeId,
          instanceId,
          durationMs: 5 + Math.floor(random() * 50),
          status: 'error',
        });
      } else {
        push('node.finished', {
          nodeId,
          instanceId,
          output: { rows: 3, body: toolResult },
          durationMs: 5 + Math.floor(random() * 90),
          status: 'ok',
        });
      }
    }
    step += 1;
  }

  push('node.finished', {
    nodeId: root,
    instanceId: 'run-0',
    output: { answer: 'done' },
    durationMs: Date.now() - startedAt,
    status: 'ok',
  });

  let bytes = 0;
  for (const event of events) bytes += Buffer.byteLength(JSON.stringify(event.payload));

  return {
    events,
    stats: {
      events: events.length,
      logicalNodes: nodeIds.size,
      tokenEvents,
      errorEvents,
      bytes,
    },
  };
}
