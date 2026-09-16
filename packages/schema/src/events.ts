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

/**
 * Present on an event when the sender replaced payload fields with the
 * redaction placeholder ("__REDACTED__") — e.g. under GRAPHMIND_HIDE_INPUTS.
 * `keys` names the payload fields that were replaced (e.g. ["input"]).
 */
export const RedactionSummarySchema = z.looseObject({
  count: z.number().int().nonnegative(),
  keys: z.array(z.string()),
});

/** Why execution is held (0.5.0+; older senders omit it). */
export const PauseReasonSchema = z.enum(['breakpoint', 'error', 'step', 'loop']);

/**
 * Details for `reason: 'loop'`: the gate held because the same logical node
 * was entered `repeats` consecutive times with an identical canonical input.
 */
export const LoopInfoSchema = z.looseObject({
  repeats: z.number().int().nonnegative(),
  firstSeq: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  fingerprint: z.string(),
});

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
    input: z.unknown().optional(),
    /**
     * Rendering hint: open this node folded (children hidden until the user
     * unfolds it). Used for synthetic grouping nodes such as MCP protocol
     * traffic. Receivers may ignore it.
     */
    collapsed: z.boolean().optional(),
    redaction: RedactionSummarySchema.optional(),
  }),

  /** Streamed deltas produced by a node (batched by the sender). */
  'node.token': z.looseObject({
    nodeId: z.string(),
    deltas: z.array(TokenDeltaSchema),
    redaction: RedactionSummarySchema.optional(),
  }),

  /** A node finished. */
  'node.finished': z.looseObject({
    nodeId: z.string(),
    /**
     * The execution this completion belongs to. Optional for backwards
     * compatibility; senders SHOULD set it — without it a receiver has to
     * attribute the result to the most recent open instance, which
     * mis-attributes when the same logical node runs concurrently.
     */
    instanceId: z.string().optional(),
    output: z.unknown().optional(),
    usage: TokenUsageSchema.optional(),
    /**
     * Wall-clock end - start, INCLUDING any time the node was held at a gate.
     * May be fractional (high-resolution clocks). Receivers show
     * `durationMs - heldMs` as the time the code actually ran.
     */
    durationMs: z.number().nonnegative(),
    /**
     * Time this execution spent held at gates (before/after/error), in ms.
     * Optional: older senders omit it, and receivers can also derive it from
     * `exec.paused`/`exec.resumed` timestamps.
     */
    heldMs: z.number().nonnegative().optional(),
    status: RunStatusSchema,
    redaction: RedactionSummarySchema.optional(),
  }),

  /** A node threw. Emitted in addition to `node.finished` bookkeeping. */
  'node.error': z.looseObject({
    nodeId: z.string(),
    /** See `node.finished.instanceId`. */
    instanceId: z.string().optional(),
    error: ErrorInfoSchema,
    /** See `node.finished.heldMs`. */
    heldMs: z.number().nonnegative().optional(),
  }),

  /** Execution is held at a gate, waiting for `exec.resume`. */
  'exec.paused': z.looseObject({
    pauseId: z.string(),
    nodeId: z.string(),
    point: PausePointSchema,
    reason: PauseReasonSchema.optional(),
    /** Present when `reason` is `loop`. */
    loop: LoopInfoSchema.optional(),
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
