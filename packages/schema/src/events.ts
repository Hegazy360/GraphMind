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
  /**
   * Which detector held (0.6.0+; absent = `repeat`, the only 0.5 kind):
   * `repeat` the same call N times in a row; `cycle` a sequence of 2-4 calls
   * repeated with identical inputs and results; `error-repeat` the same tool
   * failing with the same error N times (arguments may differ). New kinds
   * still fill the four fields above so a 0.5 viewer renders them.
   */
  kind: z.enum(['repeat', 'cycle', 'error-repeat']).optional(),
  /** `cycle`: calls per lap. */
  period: z.number().int().positive().optional(),
  /** `cycle`: identical laps seen before this hold. */
  laps: z.number().int().positive().optional(),
});

/**
 * Details for a hold raised by a smart breakpoint (0.6.0+). It travels with
 * `reason: 'breakpoint'` — not a new reason value — so a 0.5 hub, whose
 * reason enum is closed, still accepts the frame and shows the pause.
 *   error-result        a tool returned an error-shaped result without throwing
 *   truncated-tool-call the model stopped (length / content filter) mid tool call
 */
export const SmartInfoSchema = z.looseObject({
  rule: z.enum(['error-result', 'truncated-tool-call']),
  /** Short, value-free explanation (never quotes hidden data; senders keep it <= 200 chars). */
  detail: z.string().optional(),
});

/** Why a proposed input edit was refused (the gate stays held). 0.6.0+. */
export const RefusalCodeSchema = z.enum([
  'schema',
  'shape',
  'placeholder',
  'truncated',
  'disabled',
  'unsupported',
]);

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
    /** Present when a smart breakpoint raised the hold (with `reason: 'breakpoint'`). */
    smart: SmartInfoSchema.optional(),
    /**
     * The adapter can apply an edited input at this pause (`exec.resume`
     * with `input`). Absent or false: offer no input editing here.
     */
    editable: z.boolean().optional(),
  }),

  /**
   * A proposed input edit was refused; the gate is STILL held and waits for
   * another `exec.resume`. `message` is short and never quotes values.
   */
  'exec.refused': z.looseObject({
    pauseId: z.string(),
    code: RefusalCodeSchema,
    /** Senders keep it <= 200 chars. */
    message: z.string().optional(),
    /** Echo of the `exec.resume.requestId` this answers. */
    requestId: z.string().optional(),
  }),

  /**
   * A previously-held gate was released. Also emitted when the client
   * releases gates on its own (fail-open auto-continue, pause timeout),
   * so viewers can always reconstruct pause history.
   */
  'exec.resumed': z.looseObject({
    pauseId: z.string(),
    action: ResumeActionSchema,
    /**
     * The gate ran with an edited input (0.6.0+). `after` is the input the
     * call actually ran with — subject to the same redaction switches as the
     * node's own input.
     */
    edited: z.looseObject({ after: z.unknown() }).optional(),
    /** Echo of the `exec.resume.requestId` this answers (absent on auto-continue). */
    requestId: z.string().optional(),
    /** Who released it, stamped by the debugger from its credential (never by the app). */
    principal: z.string().optional(),
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
