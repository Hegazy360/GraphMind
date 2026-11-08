/**
 * Run lifecycle. The state machine (each transition is tested in the engine):
 *
 *   queued → running ⇄ suspended(sleep | wait | approval | child | retry-backoff)
 *   running → paused(gate | error)  → queued   (continue | retry | inject | edit | skip)
 *                                   → aborted
 *   running → completed | failed | aborted | timed_out
 *
 * Invariants: one active invocation per run (lease with expiry — an expired
 * lease re-queues the run, so a crashed worker never loses one); completed
 * journal entries are immutable except through an audited intervention.
 */
import { z } from 'zod';
import { errorShape } from './journal.js';
import { jsonValue } from './json.js';

export const runStatus = z.enum([
  'queued',
  'running',
  'suspended',
  'paused',
  'completed',
  'failed',
  'aborted',
  'timed_out',
]);
export type RunStatus = z.infer<typeof runStatus>;

/** Statuses a run can still move out of. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'suspended', 'paused']);

export const run = z.object({
  id: z.string(),
  workflow: z.string(),
  status: runStatus,
  input: jsonValue,
  output: jsonValue.optional(),
  error: errorShape.optional(),
  idempotencyKey: z.string().optional(),
  /** Set on child runs spawned by ctx.invoke. */
  parentRunId: z.string().optional(),
  /** The parent journal entry (seq) this child reports back to. */
  parentSeq: z.number().int().optional(),
  /** Set on runs forked from another run's journal (replay --from / substitute). */
  forkedFrom: z
    .object({ runId: z.string(), fromSeq: z.number().int().optional() })
    .optional(),
  /** Earliest time a suspended/queued run is due to execute. */
  wakeAt: z.number().optional(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.number().optional(),
  /** The journal seq currently holding the run, when status is 'paused'. */
  pausedSeq: z.number().int().optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
});
export type Run = z.infer<typeof run>;

export const workflowEvent = z.object({
  id: z.string(),
  name: z.string(),
  data: jsonValue,
  receivedAt: z.number(),
});
export type WorkflowEvent = z.infer<typeof workflowEvent>;
