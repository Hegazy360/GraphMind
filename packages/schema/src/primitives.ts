/**
 * Shared primitive schemas used by both event and control payloads.
 *
 * All object schemas are LOOSE (`z.looseObject`): unknown fields are
 * preserved, not rejected. This is the forward-compatibility rule of the
 * protocol — a v1 peer must tolerate fields added by a later v1.x sender.
 */
import { z } from 'zod';

/** What kind of graph node an event refers to. */
export const NodeKindSchema = z.enum(['agent', 'llm', 'tool', 'custom']).meta({ id: 'NodeKind' });
export type NodeKind = z.infer<typeof NodeKindSchema>;

/** Terminal status of a run or node. */
export const RunStatusSchema = z.enum(['ok', 'error', 'aborted']).meta({ id: 'RunStatus' });
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Where in a node's lifecycle a gate/pause sits. */
export const PausePointSchema = z.enum(['before', 'after', 'error']).meta({ id: 'PausePoint' });
export type PausePoint = z.infer<typeof PausePointSchema>;

/** How a held gate was released. */
export const ResumeActionSchema = z
  .enum(['continue', 'retry', 'inject', 'abort'])
  .meta({ id: 'ResumeAction' });
export type ResumeAction = z.infer<typeof ResumeActionSchema>;

/** Execution mode of the debuggee. */
export const RunModeSchema = z.enum(['run', 'step']).meta({ id: 'RunMode' });
export type RunMode = z.infer<typeof RunModeSchema>;

/** Serialized error. `stack` is optional and may be redacted by the sender. */
export const ErrorInfoSchema = z
  .looseObject({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  })
  .meta({ id: 'ErrorInfo' });
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

/** Token usage of an LLM node. */
export const TokenUsageSchema = z
  .looseObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .meta({ id: 'TokenUsage' });
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** One streamed delta. `t` is the channel, `v` the text fragment. */
export const TokenDeltaSchema = z
  .looseObject({
    t: z.enum(['text', 'reasoning', 'tool-args']),
    v: z.string(),
  })
  .meta({ id: 'TokenDelta' });
export type TokenDelta = z.infer<typeof TokenDeltaSchema>;

/**
 * A breakpoint matcher. Every present field must match; absent fields match
 * anything. `point` defaults to `before` when omitted.
 * A fully-empty matcher `{}` therefore means "pause before every node".
 */
export const BreakpointMatcherSchema = z
  .looseObject({
    kind: NodeKindSchema.optional(),
    name: z.string().optional(),
    point: PausePointSchema.optional(),
  })
  .meta({ id: 'BreakpointMatcher' });
export type BreakpointMatcher = z.infer<typeof BreakpointMatcherSchema>;

/** A node pre-announced via `graph.hint` (static structure, before running). */
export const GraphNodeHintSchema = z
  .looseObject({
    nodeId: z.string(),
    kind: NodeKindSchema,
    name: z.string(),
    parentId: z.string().optional(),
  })
  .meta({ id: 'GraphNodeHint' });
export type GraphNodeHint = z.infer<typeof GraphNodeHintSchema>;

/** The SDK the instrumented app uses (e.g. `{ name: "ai", version: "7.0.79" }`). */
export const SdkInfoSchema = z
  .looseObject({
    name: z.string(),
    version: z.string(),
  })
  .meta({ id: 'SdkInfo' });
export type SdkInfo = z.infer<typeof SdkInfoSchema>;
