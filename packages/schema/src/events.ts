/**
 * Event payloads: messages the instrumented app sends to the viewer.
 */
import { z } from 'zod';
import {
  ErrorInfoSchema,
  GraphNodeHintSchema,
  NodeKindSchema,
  PausePointSchema,
  ResumeActionSchema,
  RunStatusSchema,
  SdkInfoSchema,
  TokenDeltaSchema,
  TokenUsageSchema,
} from './primitives.js';

export const EventPayloadSchemas = {
  /** A run (one top-level agent invocation) has begun. */
  'run.started': z.looseObject({
    /** Human-readable application name. */
    app: z.string(),
    /** The AI SDK driving this run. */
    sdk: SdkInfoSchema,
    /** Free-form metadata (run name, environment, git sha, ...). */
    meta: z.record(z.string(), z.unknown()).optional(),
  }),

  /** The run ended. `error` is present when status is `error`. */
  'run.finished': z.looseObject({
    status: RunStatusSchema,
    error: ErrorInfoSchema.optional(),
  }),

  /** Optional static graph structure so the viewer can pre-render nodes. */
  'graph.hint': z.looseObject({
    nodes: z.array(GraphNodeHintSchema),
  }),

  /** A node (agent / llm call / tool call / custom span) started executing. */
  'node.started': z.looseObject({
    nodeId: z.string(),
    parentId: z.string().optional(),
    kind: NodeKindSchema,
    name: z.string(),
    /** Distinguishes repeated executions of the same logical node. */
    instanceId: z.string(),
    input: z.unknown(),
  }),

  /** Streamed deltas produced by a node (batched by the sender). */
  'node.token': z.looseObject({
    nodeId: z.string(),
    deltas: z.array(TokenDeltaSchema),
  }),

  /** A node finished. */
  'node.finished': z.looseObject({
    nodeId: z.string(),
    output: z.unknown(),
    usage: TokenUsageSchema.optional(),
    durationMs: z.number().nonnegative(),
    status: RunStatusSchema,
  }),

  /** A node threw. Emitted in addition to `node.finished` bookkeeping. */
  'node.error': z.looseObject({
    nodeId: z.string(),
    error: ErrorInfoSchema,
  }),

  /** Execution is held at a gate, waiting for `exec.resume`. */
  'exec.paused': z.looseObject({
    pauseId: z.string(),
    nodeId: z.string(),
    point: PausePointSchema,
  }),

  /**
   * A previously-held gate was released. Also emitted when the client
   * releases gates on its own (fail-open auto-continue, pause timeout),
   * so viewers can always reconstruct pause history.
   */
  'exec.resumed': z.looseObject({
    pauseId: z.string(),
    action: ResumeActionSchema,
  }),
} as const;

export type EventType = keyof typeof EventPayloadSchemas;

export type EventPayloadMap = {
  [K in EventType]: z.infer<(typeof EventPayloadSchemas)[K]>;
};

export const EVENT_TYPES = Object.keys(EventPayloadSchemas) as readonly EventType[];

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(EventPayloadSchemas, type);
}
