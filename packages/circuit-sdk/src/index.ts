/**
 * @graphmind-ai/circuit-sdk — author surface of GraphMind Circuit.
 *
 * A workflow is a plain async TypeScript function over a context. Every
 * effect goes through the context and becomes one journal entry; code
 * between effects can be anything (no determinism rules for it) because the
 * engine re-invokes the function and replays completed entries by
 * (name, ordinal). The one rule that IS enforced: the sequence of context
 * calls must be reproducible from the journal — a mismatch is reported as a
 * named divergence, never silently replayed.
 */
import {
  parseDuration,
  retryPolicy as retryPolicySchema,
  type Duration,
  type JsonValue,
  type RetryPolicy,
} from '@graphmind-ai/circuit-schema';
import { z } from 'zod';

export { z };
export type { Duration, JsonValue, RetryPolicy };

export interface StepOptions {
  /** Attempts in total; a number n means {max: n, exponential from 1s}. */
  retries?: number | RetryPolicy;
}

export interface WaitForEventSpec {
  /** Event name to match (exact). */
  name: string;
  /** Every present key must deep-equal the same key in the event data. */
  match?: Record<string, JsonValue>;
  /** How long to wait before resolving null. Default: '7d'. */
  timeout?: Duration;
}

export interface ApprovalSpec {
  /** Who may approve — opaque strings surfaced by the control plane ('role:finance'). */
  approvers?: string[];
  /** Auto-deny after this long. Default: '72h'. */
  timeout?: Duration;
  /** Shown to the approver next to the request. */
  context?: JsonValue;
}

export interface ApprovalResult {
  approved: boolean;
  by?: string;
  comment?: string;
  timedOut?: boolean;
}

export interface Ctx {
  readonly runId: string;
  readonly workflow: string;
  /** Run `fn` once, durably: a completed step replays without executing. */
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  step<T>(name: string, opts: StepOptions, fn: () => T | Promise<T>): Promise<T>;
  /** Durable timer. Suspends the run; no compute is held while sleeping. */
  sleep(name: string, duration: Duration): Promise<void>;
  /** Park until a matching event arrives; resolves null on timeout. */
  waitForEvent(name: string, spec: WaitForEventSpec): Promise<JsonValue | null>;
  /** Hold for a human decision; a gate by construction. */
  approval(name: string, spec?: ApprovalSpec): Promise<ApprovalResult>;
  /** Run another workflow as a durable child; resolves with its output. */
  invoke<T = JsonValue>(name: string, workflow: string, input: JsonValue): Promise<T>;
  /** Attach a log line to the current entry (not journaled as an effect). */
  log(...args: unknown[]): void;
  /**
   * An MCP server connection configured on the engine. Each `call` is one
   * journaled, gated step: retries, pause-on-error, policy and tool pinning
   * apply. Arguments are typed once `circuit mcp pull` has generated
   * `circuit.mcp.d.ts` (it augments McpRegistry).
   */
  mcp<C extends string>(connection: C): McpConnection<C>;
}

/** Augmented by the generated circuit.mcp.d.ts: connection → tool → args. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface McpRegistry {}

type ToolsOf<C extends string> = C extends keyof McpRegistry
  ? McpRegistry[C]
  : Record<string, Record<string, JsonValue> | undefined>;

export interface McpConnection<C extends string> {
  call<T extends keyof ToolsOf<C> & string>(tool: T, args?: ToolsOf<C>[T], opts?: StepOptions): Promise<JsonValue>;
}

export type TriggerSpec =
  | { type: 'api' }
  | { type: 'event'; name: string }
  | { type: 'cron'; schedule: string; tz?: string };

export interface WorkflowConfig<I, O> {
  name: string;
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  triggers?: TriggerSpec[];
  /**
   * What happens when a step exhausts its retries:
   * 'pause' holds the run at an error gate for fix-and-resume (default);
   * 'fail' lets the error propagate into the workflow code.
   */
  onError?: 'pause' | 'fail';
  /** Default retry policy for steps that don't set their own. */
  retries?: number | RetryPolicy;
  /** Whole-run timeout. Default: '7d'. */
  timeout?: Duration;
}

export interface WorkflowDefinition<I = JsonValue, O = JsonValue> {
  readonly config: ResolvedWorkflowConfig<I, O>;
  readonly fn: (ctx: Ctx, input: I) => Promise<O>;
}

/**
 * Type-erased definition for registries and engines. WorkflowDefinition is
 * invariant in I/O (its Zod schemas use them in both positions), so concrete
 * definitions only flow into generic holders through this alias.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWorkflow = WorkflowDefinition<any, any>;

export interface ResolvedWorkflowConfig<I, O> {
  name: string;
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  triggers: TriggerSpec[];
  onError: 'pause' | 'fail';
  retries: RetryPolicy;
  timeoutMs: number;
}

export const DEFAULT_RETRIES: RetryPolicy = Object.freeze({
  max: 1,
  backoff: 'exponential',
  initialMs: 1_000,
  maxMs: 60_000,
});

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class WorkflowConfigError extends Error {
  override name = 'WorkflowConfigError';
}

export function normalizeRetries(retries: number | RetryPolicy | undefined, fallback: RetryPolicy): RetryPolicy {
  if (retries === undefined) return fallback;
  if (typeof retries === 'number') {
    if (!Number.isInteger(retries) || retries < 1 || retries > 100) {
      throw new WorkflowConfigError(`retries must be an integer attempt count between 1 and 100, got ${retries}`);
    }
    return { max: retries, backoff: 'exponential', initialMs: 1_000, maxMs: 60_000 };
  }
  return retryPolicySchema.parse(retries);
}

/**
 * Define a workflow. Validates the config eagerly so a bad name, duration or
 * retry policy fails at module load, not on the first production run.
 */
export function workflow<I = JsonValue, O = JsonValue>(
  config: WorkflowConfig<I, O>,
  fn: (ctx: Ctx, input: I) => Promise<O>,
): WorkflowDefinition<I, O> {
  if (!NAME_PATTERN.test(config.name)) {
    throw new WorkflowConfigError(
      `workflow name ${JSON.stringify(config.name)} must be kebab-case: lowercase letters, digits and '-', max 64 chars`,
    );
  }
  const resolved: ResolvedWorkflowConfig<I, O> = {
    name: config.name,
    triggers: config.triggers ?? [{ type: 'api' }],
    onError: config.onError ?? 'pause',
    retries: normalizeRetries(config.retries, DEFAULT_RETRIES),
    timeoutMs: parseDuration(config.timeout ?? '7d'),
  };
  if (config.input !== undefined) resolved.input = config.input;
  if (config.output !== undefined) resolved.output = config.output;
  return { config: resolved, fn };
}
