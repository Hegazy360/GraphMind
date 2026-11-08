/**
 * The journal: Circuit's one load-bearing data structure. As a workflow run
 * executes, every effectful primitive (step, mcp call, sleep, wait, approval,
 * child invoke) appends exactly one entry. The same journal is then:
 *   - durability  (re-invocation memoizes completed entries),
 *   - debugging   (a paused entry is a gate you can inspect and change),
 *   - replay      (the entry list IS the tape),
 *   - testing     (a recorded journal replays as a regression fixture),
 *   - analytics   (behavior analysis reads entries, nothing else).
 *
 * Identity across re-invocations is (name, ordinal): the Nth call of that
 * entry name in program order. `key` is the honesty check — a canonical hash
 * of [name, input] — so changed code that reaches the same (name, ordinal)
 * with different input is reported as divergence, never silently replayed.
 */
import { z } from 'zod';
import { jsonValue } from './json.js';

export const entryKind = z.enum(['step', 'mcp', 'sleep', 'wait', 'approval', 'child']);
export type EntryKind = z.infer<typeof entryKind>;

export const entryStatus = z.enum([
  /** Created; executing now, or waiting for a retry's backoff to elapse. */
  'running',
  /** Finished with an output; re-invocations replay it without executing. */
  'completed',
  /** Finished with an error that propagates into the workflow code. */
  'failed',
  /** Held at a gate (before / after / error, or an approval) awaiting a human. */
  'paused',
  /** Resolved by a `skip` resume: replays as `undefined`. */
  'skipped',
  /** Parked on time or an external signal: sleep, wait, child run. */
  'suspended',
]);
export type EntryStatus = z.infer<typeof entryStatus>;

export const pausePoint = z.enum(['before', 'after', 'error']);
export type PausePoint = z.infer<typeof pausePoint>;

export const errorShape = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});
export type ErrorShape = z.infer<typeof errorShape>;

/** Every try of an entry is kept — retries are visible, never erased. */
export const attempt = z.object({
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  error: errorShape.optional(),
});
export type Attempt = z.infer<typeof attempt>;

export const resumeAction = z.enum(['continue', 'retry', 'inject', 'edit', 'skip', 'abort']);
export type ResumeAction = z.infer<typeof resumeAction>;

/**
 * A human (or API caller) changed a run. Append-only: the journal records
 * what production actually did, including what operators did to it.
 */
export const intervention = z.object({
  actor: z.string(),
  action: resumeAction,
  at: z.number(),
  reason: z.string().optional(),
  /** Present when the action replaced the entry's input (edit / retry-with-edit). */
  editedInput: z.boolean().optional(),
  /** Present when the action supplied the entry's output (inject). */
  injectedOutput: z.boolean().optional(),
});
export type Intervention = z.infer<typeof intervention>;

export const retryPolicy = z.object({
  /** Maximum attempts in total (1 = no retries). */
  max: z.number().int().min(1).max(100),
  backoff: z.enum(['fixed', 'exponential']),
  initialMs: z.number().int().min(0),
  maxMs: z.number().int().min(0).optional(),
});
export type RetryPolicy = z.infer<typeof retryPolicy>;

export const journalEntry = z.object({
  runId: z.string(),
  /** Dense, per-run, in creation order. */
  seq: z.number().int().min(0),
  kind: entryKind,
  name: z.string(),
  /** Nth call of `name` in this run, 0-based — identity with `name`. */
  ordinal: z.number().int().min(0),
  /** canonical([name, input]) — divergence honesty check. */
  key: z.string(),
  status: entryStatus,
  pausePoint: pausePoint.optional(),
  input: jsonValue.optional(),
  output: jsonValue.optional(),
  error: errorShape.optional(),
  attempts: z.array(attempt),
  interventions: z.array(intervention),
  /** sleep: when to resume; running+attempts: when the next retry is due. */
  wakeAt: z.number().optional(),
  /** wait entries: the event they match. */
  waitEvent: z.string().optional(),
  waitMatch: z.record(z.string(), jsonValue).optional(),
  /** wait / approval: when the entry times out. */
  expiresAt: z.number().optional(),
  /** child entries: the spawned run. */
  childRunId: z.string().optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
});
export type JournalEntry = z.infer<typeof journalEntry>;

/**
 * Breakpoints pause matching entries at a gate point. Matcher semantics are
 * GraphMind's: every present field must match, absent fields match anything,
 * `point` defaults to `before`.
 */
export const breakpointMatcher = z.object({
  workflow: z.string().optional(),
  step: z.string().optional(),
  kind: entryKind.optional(),
  point: pausePoint.default('before'),
});
export type BreakpointMatcher = z.infer<typeof breakpointMatcher>;
