/**
 * The invocation context: what `ctx` is while a workflow function runs.
 *
 * Re-invocation model: the workflow function is re-run from the top on every
 * wake. Each context call claims the next ordinal for its name and looks the
 * pair up in the journal — a completed entry replays (the function body does
 * NOT run again), the first novel call executes for real, and anything that
 * must outlive this invocation (sleep, wait, approval, child, retry backoff,
 * a held gate) throws SuspendSignal to unwind cleanly. User code never sees
 * SuspendSignal: it is not an Error subclass on purpose, so a workflow's
 * `catch (e)` blocks don't swallow it accidentally — only `finally` observes
 * the unwind, which matches process death semantics (and that is exactly
 * what a suspension is: the invocation ends; a later one continues the run).
 */
import {
  toJsonValue,
  parseDuration,
  type BreakpointMatcher,
  type EntryKind,
  type JournalEntry,
  type JsonValue,
  type PausePoint,
  type RetryPolicy,
} from '@graphmind-ai/circuit-schema';
import {
  normalizeRetries,
  type ApprovalResult,
  type ApprovalSpec,
  type Ctx,
  type StepOptions,
  type WaitForEventSpec,
  type AnyWorkflow,
} from '@graphmind-ai/circuit-sdk';
import { NonDeterminismError, ReplayedError, toErrorShape, type CallIdentity } from './errors.js';
import { entryKey } from './keys.js';
import type { Clock } from './clock.js';
import type { Patch } from './store.js';

export type Suspension =
  | { type: 'sleep'; wakeAt: number }
  | { type: 'retry'; wakeAt: number }
  | { type: 'wait'; wakeAt: number }
  | { type: 'pause'; seq: number; wakeAt?: number }
  | { type: 'child' };

/** Deliberately NOT an Error: user catch blocks must not intercept it. */
export class SuspendSignal {
  constructor(public readonly suspension: Suspension) {}
}

/**
 * Hermetic replay reached the live frontier: the next thing the workflow
 * would do is execute a real effect. Thrown only when io.hermetic is set;
 * like SuspendSignal, deliberately not an Error.
 */
export class TapeEndSignal {
  constructor(public readonly frontier: { kind: EntryKind; name: string; ordinal: number }) {}
}

export interface TestHooks {
  /** Throws HardCrash here to simulate the process dying after a persist. */
  afterStepPersist?: (runId: string, seq: number) => void;
}

/** Everything the context needs from the executor, nothing more. */
export interface InvocationIO {
  runId: string;
  workflow: AnyWorkflow;
  clock: Clock;
  entries: JournalEntry[];
  breakpoints: BreakpointMatcher[];
  append(entry: Omit<JournalEntry, 'seq'>): JournalEntry;
  update(seq: number, patch: Patch<JournalEntry>): void;
  addWait(seq: number, eventName: string, match: Record<string, JsonValue> | undefined, expiresAt: number): void;
  removeWait(seq: number): void;
  spawnChild(seq: number, workflow: string, input: JsonValue): string;
  log(message: string): void;
  hooks?: TestHooks;
  /**
   * Replay-only mode: journal entries replay normally, but any novel call or
   * real execution throws TapeEndSignal instead of running. Nothing escapes
   * to the outside world. updates go to the caller's in-memory copy only.
   */
  hermetic?: boolean;
  /** MCP connections; absent when the engine has none configured. */
  mcp?: McpGateway;
}

export type McpPolicy = 'allow' | 'approve' | 'deny';

/** What the engine needs from the MCP layer (implemented in circuit-mcp). */
export interface McpGateway {
  /** Policy for the tool, and whether its definition changed since it was pinned. */
  inspect(connection: string, tool: string): Promise<{ policy: McpPolicy; changed?: string }>;
  /** Call the tool; acceptDefinition re-pins a changed definition a human approved. */
  call(connection: string, tool: string, args: JsonValue, opts: { acceptDefinition: boolean }): Promise<JsonValue>;
}

function matcherMatches(m: BreakpointMatcher, workflow: string, step: string, kind: EntryKind, point: PausePoint): boolean {
  if (m.point !== point) return false;
  if (m.workflow !== undefined && m.workflow !== workflow) return false;
  if (m.step !== undefined && m.step !== step) return false;
  if (m.kind !== undefined && m.kind !== kind) return false;
  return true;
}

function backoffMs(policy: RetryPolicy, failedAttempts: number): number {
  const raw =
    policy.backoff === 'fixed' ? policy.initialMs : policy.initialMs * 2 ** Math.max(0, failedAttempts - 1);
  return Math.min(raw, policy.maxMs ?? Number.MAX_SAFE_INTEGER);
}

function identityOf(entry: JournalEntry): CallIdentity {
  return { kind: entry.kind, name: entry.name, ordinal: entry.ordinal, key: entry.key };
}

export interface Invocation {
  ctx: Ctx;
  /**
   * Call after the workflow function returns: a journal entry this
   * invocation never replayed means the new code abandoned a recorded
   * effect that already ran in production — a named divergence.
   */
  finalize: () => void;
}

export function createContext(io: InvocationIO): Invocation {
  const ordinals = new Map<string, number>();
  const byIdentity = new Map<string, JournalEntry>();
  /** seqs this invocation has replayed or created. */
  const consumed = new Set<number>();
  for (const entry of io.entries) {
    byIdentity.set(`${entry.name}\u0000${entry.ordinal}`, entry);
  }

  const now = (): number => io.clock.now();
  const wfName = io.workflow.config.name;

  function takeOrdinal(name: string): number {
    const next = ordinals.get(name) ?? 0;
    ordinals.set(name, next + 1);
    return next;
  }

  function lookup(name: string, ordinal: number): JournalEntry | undefined {
    const entry = byIdentity.get(`${name}\u0000${ordinal}`);
    if (entry) consumed.add(entry.seq);
    return entry;
  }

  function firstUnreplayed(): JournalEntry | undefined {
    return io.entries.find((entry) => !consumed.has(entry.seq));
  }

  /** The divergence honesty check — see NonDeterminismError. */
  function assertSameCall(entry: JournalEntry, kind: EntryKind, key: string): void {
    if (entry.kind === kind && entry.key === key) return;
    throw new NonDeterminismError({
      type: 'mismatch',
      runId: io.runId,
      name: entry.name,
      ordinal: entry.ordinal,
      expected: { kind: entry.kind, key: entry.key },
      actual: { kind, key },
    });
  }

  function breakpointAt(step: string, kind: EntryKind, point: PausePoint): boolean {
    return io.breakpoints.some((m) => matcherMatches(m, wfName, step, kind, point));
  }

  /** Every novel call funnels through here — the rename/insertion guard. */
  function appendAndIndex(entry: Omit<JournalEntry, 'seq'>): JournalEntry {
    const pending = firstUnreplayed();
    if (pending) {
      throw new NonDeterminismError({
        type: 'novel-call',
        runId: io.runId,
        actual: { kind: entry.kind, name: entry.name, ordinal: entry.ordinal, key: entry.key },
        unreplayed: identityOf(pending),
      });
    }
    if (io.hermetic === true) {
      throw new TapeEndSignal({ kind: entry.kind, name: entry.name, ordinal: entry.ordinal });
    }
    const stored = io.append(entry);
    byIdentity.set(`${stored.name}\u0000${stored.ordinal}`, stored);
    consumed.add(stored.seq);
    return stored;
  }

  function patch(entry: JournalEntry, changes: Patch<JournalEntry>): void {
    io.update(entry.seq, changes);
    Object.assign(entry, changes);
  }

  async function executeAttempt<T>(
    entry: JournalEntry,
    policy: RetryPolicy,
    fn: () => T | Promise<T>,
  ): Promise<JsonValue | undefined> {
    const attempt = { startedAt: now() } as { startedAt: number; finishedAt?: number; error?: ReturnType<typeof toErrorShape> };
    const attempts = [...entry.attempts, attempt];
    patch(entry, { attempts, status: 'running' });
    let raw: unknown;
    try {
      raw = await fn();
    } catch (err) {
      attempt.finishedAt = now();
      attempt.error = toErrorShape(err);
      const failures = attempts.length;
      if (failures < policy.max) {
        const wakeAt = now() + backoffMs(policy, failures);
        patch(entry, { attempts, wakeAt });
        throw new SuspendSignal({ type: 'retry', wakeAt });
      }
      const pauseOnError = io.workflow.config.onError === 'pause' || breakpointAt(entry.name, entry.kind, 'error');
      if (pauseOnError) {
        patch(entry, { attempts, status: 'paused', pausePoint: 'error', error: attempt.error });
        throw new SuspendSignal({ type: 'pause', seq: entry.seq });
      }
      patch(entry, { attempts, status: 'failed', error: attempt.error, finishedAt: now() });
      throw err;
    }
    attempt.finishedAt = now();
    const output = toJsonValue(raw, `'${entry.name}' result`);
    if (breakpointAt(entry.name, entry.kind, 'after')) {
      const paused: Partial<JournalEntry> = { attempts, status: 'paused', pausePoint: 'after' };
      if (output !== undefined) paused.output = output;
      patch(entry, paused);
      throw new SuspendSignal({ type: 'pause', seq: entry.seq });
    }
    const done: Patch<JournalEntry> = { attempts, status: 'completed', finishedAt: now(), error: undefined };
    if (output !== undefined) done.output = output;
    patch(entry, done);
    io.hooks?.afterStepPersist?.(io.runId, entry.seq);
    return output;
  }

  /**
   * Shared replay dispatch for executable kinds (step, mcp). Returns the
   * memoized output, or undefined to signal "novel or re-executable" — the
   * caller then runs the real function.
   */
  function settle(entry: JournalEntry): { done: true; output: JsonValue | undefined } | { done: false } {
    switch (entry.status) {
      case 'completed':
        return { done: true, output: entry.output };
      case 'skipped':
        return { done: true, output: undefined };
      case 'failed':
        throw new ReplayedError(entry.error ?? { name: 'Error', message: `'${entry.name}' failed` });
      case 'paused':
        throw new SuspendSignal({ type: 'pause', seq: entry.seq });
      case 'running': {
        if (entry.wakeAt !== undefined && entry.wakeAt > now()) {
          throw new SuspendSignal({ type: 'retry', wakeAt: entry.wakeAt });
        }
        return { done: false };
      }
      case 'suspended':
        // An executable entry is never parked as 'suspended'; a journal that
        // says so was written by a different kind — the key check upstream
        // reports it, this is unreachable defense.
        throw new ReplayedError({ name: 'CorruptJournalError', message: `entry '${entry.name}' has impossible status` });
    }
  }

  const ctx: Ctx = {
    runId: io.runId,
    workflow: wfName,

    async step<T>(name: string, optsOrFn: StepOptions | (() => T | Promise<T>), maybeFn?: () => T | Promise<T>): Promise<T> {
      const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as () => T | Promise<T>;
      const opts: StepOptions = typeof optsOrFn === 'function' ? {} : optsOrFn;
      const policy = normalizeRetries(opts.retries, io.workflow.config.retries);
      const ordinal = takeOrdinal(name);
      const key = entryKey('step', name, undefined);
      const existing = lookup(name, ordinal);
      if (existing) {
        assertSameCall(existing, 'step', key);
        const settled = settle(existing);
        if (settled.done) return settled.output as T;
        if (io.hermetic === true) throw new TapeEndSignal({ kind: 'step', name, ordinal });
        return (await executeAttempt(existing, policy, fn)) as T;
      }
      if (breakpointAt(name, 'step', 'before')) {
        const held = appendAndIndex({
          runId: io.runId, kind: 'step', name, ordinal, key,
          status: 'paused', pausePoint: 'before', attempts: [], interventions: [], startedAt: now(),
        });
        throw new SuspendSignal({ type: 'pause', seq: held.seq });
      }
      const entry = appendAndIndex({
        runId: io.runId, kind: 'step', name, ordinal, key,
        status: 'running', attempts: [], interventions: [], startedAt: now(),
      });
      return (await executeAttempt(entry, policy, fn)) as T;
    },

    async sleep(name, duration) {
      const ms = parseDuration(duration);
      const ordinal = takeOrdinal(name);
      const key = entryKey('sleep', name, ms);
      const existing = lookup(name, ordinal);
      if (existing) {
        assertSameCall(existing, 'sleep', key);
        if (existing.status === 'completed') return;
        const wakeAt = existing.wakeAt ?? now();
        if (wakeAt <= now()) {
          patch(existing, { status: 'completed', finishedAt: now() });
          return;
        }
        throw new SuspendSignal({ type: 'sleep', wakeAt });
      }
      const wakeAt = now() + ms;
      appendAndIndex({
        runId: io.runId, kind: 'sleep', name, ordinal, key,
        status: 'suspended', wakeAt, attempts: [], interventions: [], startedAt: now(),
      });
      throw new SuspendSignal({ type: 'sleep', wakeAt });
    },

    async waitForEvent(name, spec: WaitForEventSpec) {
      const timeoutMs = parseDuration(spec.timeout ?? '7d');
      const ordinal = takeOrdinal(name);
      const key = entryKey('wait', name, [spec.name, spec.match ?? null]);
      const existing = lookup(name, ordinal);
      if (existing) {
        assertSameCall(existing, 'wait', key);
        if (existing.status === 'completed') return existing.output ?? null;
        const expiresAt = existing.expiresAt ?? now();
        if (expiresAt <= now()) {
          io.removeWait(existing.seq);
          patch(existing, { status: 'completed', output: null, finishedAt: now() });
          return null;
        }
        throw new SuspendSignal({ type: 'wait', wakeAt: expiresAt });
      }
      const expiresAt = now() + timeoutMs;
      const entry = appendAndIndex({
        runId: io.runId, kind: 'wait', name, ordinal, key,
        status: 'suspended', waitEvent: spec.name, expiresAt, attempts: [], interventions: [], startedAt: now(),
        ...(spec.match !== undefined ? { waitMatch: spec.match } : {}),
      });
      io.addWait(entry.seq, spec.name, spec.match, expiresAt);
      throw new SuspendSignal({ type: 'wait', wakeAt: expiresAt });
    },

    async approval(name, spec: ApprovalSpec = {}) {
      const timeoutMs = parseDuration(spec.timeout ?? '72h');
      const ordinal = takeOrdinal(name);
      const key = entryKey('approval', name, [spec.approvers ?? null]);
      const existing = lookup(name, ordinal);
      if (existing) {
        assertSameCall(existing, 'approval', key);
        if (existing.status === 'completed') return existing.output as unknown as ApprovalResult;
        if (existing.status === 'skipped') return { approved: false, timedOut: false };
        const expiresAt = existing.expiresAt ?? now();
        if (expiresAt <= now()) {
          patch(existing, { status: 'completed', output: { approved: false, timedOut: true }, finishedAt: now() });
          return { approved: false, timedOut: true };
        }
        throw new SuspendSignal({ type: 'pause', seq: existing.seq, wakeAt: expiresAt });
      }
      const expiresAt = now() + timeoutMs;
      const input = toJsonValue({ approvers: spec.approvers ?? null, context: spec.context ?? null }, `approval '${name}'`);
      const held = appendAndIndex({
        runId: io.runId, kind: 'approval', name, ordinal, key,
        status: 'paused', pausePoint: 'before', expiresAt, attempts: [], interventions: [], startedAt: now(),
        ...(input !== undefined ? { input } : {}),
      });
      throw new SuspendSignal({ type: 'pause', seq: held.seq, wakeAt: expiresAt });
    },

    async invoke<T = JsonValue>(name: string, workflowName: string, input: JsonValue): Promise<T> {
      const ordinal = takeOrdinal(name);
      const key = entryKey('child', name, [workflowName, input]);
      const existing = lookup(name, ordinal);
      if (existing) {
        assertSameCall(existing, 'child', key);
        if (existing.status === 'completed') return existing.output as T;
        if (existing.status === 'skipped') return undefined as T;
        if (existing.status === 'failed') {
          throw new ReplayedError(existing.error ?? { name: 'Error', message: `child '${workflowName}' failed` });
        }
        throw new SuspendSignal({ type: 'child' });
      }
      const entry = appendAndIndex({
        runId: io.runId, kind: 'child', name, ordinal, key,
        status: 'suspended', input: [workflowName, input], attempts: [], interventions: [], startedAt: now(),
      });
      const childRunId = io.spawnChild(entry.seq, workflowName, input);
      patch(entry, { childRunId });
      throw new SuspendSignal({ type: 'child' });
    },

    mcp(connection: string) {
      return {
        call: async (tool: string, args: unknown = {}, opts: StepOptions = {}) => {
          const name = `${connection}.${tool}`;
          const ordinal = takeOrdinal(name);
          const input = toJsonValue(args ?? {}, `'${name}' arguments`) ?? {};
          const key = entryKey('mcp', name, input);
          let policy = normalizeRetries(opts.retries, io.workflow.config.retries);
          let entry = lookup(name, ordinal);
          if (entry) {
            assertSameCall(entry, 'mcp', key);
            const settled = settle(entry);
            if (settled.done) return settled.output as JsonValue;
            if (io.hermetic === true) throw new TapeEndSignal({ kind: 'mcp', name, ordinal });
          } else {
            const base = { runId: io.runId, kind: 'mcp' as const, name, ordinal, key, input, attempts: [], interventions: [], startedAt: now() };
            if (io.hermetic === true) appendAndIndex({ ...base, status: 'running' }); // throws TapeEndSignal / divergence
            const gateway = io.mcp;
            if (!gateway) {
              throw new Error(`ctx.mcp('${connection}') used, but this engine has no MCP connections — start it with --mcp <config.json>`);
            }
            const verdict = await gateway.inspect(connection, tool);
            const hold = verdict.changed !== undefined
              ? { name: 'ToolDefinitionChanged', message: `The definition of ${name} changed since it was pinned (${verdict.changed}). Review it, then "Run it" to accept the new definition, or abort.` }
              : verdict.policy === 'approve'
                ? { name: 'ApprovalRequired', message: `Policy requires a human to approve every call to ${name}. Check the arguments, then run, edit, or abort.` }
                : breakpointAt(name, 'mcp', 'before')
                  ? undefined
                  : null;
            if (hold !== null) {
              const held = appendAndIndex({ ...base, status: 'paused', pausePoint: 'before', ...(hold ? { error: hold } : {}) });
              throw new SuspendSignal({ type: 'pause', seq: held.seq });
            }
            entry = appendAndIndex({ ...base, status: 'running' });
            if (verdict.policy === 'deny') {
              policy = { ...policy, max: 1 };
              const denied = entry;
              return (await executeAttempt(denied, policy, () => {
                throw Object.assign(new Error(`Policy denies calls to ${name}`), { name: 'PolicyDenied' });
              })) as JsonValue;
            }
          }
          const current = entry;
          const gateway = io.mcp;
          if (!gateway) throw new Error(`ctx.mcp('${connection}') used, but this engine has no MCP connections`);
          const accepted = current.interventions.length > 0;
          return (await executeAttempt(current, policy, () =>
            gateway.call(connection, tool, current.input ?? input, { acceptDefinition: accepted }),
          )) as JsonValue;
        },
      };
    },

    log(...args) {
      io.log(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    },
  };

  function finalize(): void {
    const unreplayed = io.entries.filter((entry) => !consumed.has(entry.seq));
    if (unreplayed.length > 0) {
      throw new NonDeterminismError({ type: 'orphaned', runId: io.runId, unreplayed: unreplayed.map(identityOf) });
    }
  }

  return { ctx, finalize };
}
