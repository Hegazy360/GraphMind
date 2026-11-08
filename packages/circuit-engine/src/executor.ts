/**
 * The executor: claims due runs, re-invokes workflow functions over their
 * journals, applies suspensions, and owns the two intervention surfaces —
 * resume (fix-and-resume on a paused entry) and approve (human decisions).
 *
 * Crash safety: an invocation holds a lease; every journal write lands
 * before the step's result is used; if the process dies, the lease expires
 * and claimDue hands the run to the next worker, which re-invokes and
 * replays the journal. Nothing is lost, nothing runs twice (a completed
 * entry never re-executes).
 */
import { randomUUID } from 'node:crypto';
import {
  toJsonValue,
  type ErrorShape,
  type BreakpointMatcher,
  type JournalEntry,
  type JsonValue,
  type ResumeAction,
  type Run,
  type RunStatus,
  ACTIVE_RUN_STATUSES,
} from '@graphmind-ai/circuit-schema';
import type { AnyWorkflow } from '@graphmind-ai/circuit-sdk';
import { canonicalValue } from '@graphmind-ai/analyze';
import { createContext, SuspendSignal, type McpGateway, type Suspension, type TestHooks } from './context.js';
import { HardCrash, InvalidResumeError, toErrorShape, WorkflowNotRegisteredError } from './errors.js';
import { systemClock, type Clock } from './clock.js';
import type { JournalStore, Patch } from './store.js';

export interface ExecutorOptions {
  store: JournalStore;
  clock?: Clock;
  /** How long one invocation may hold a run before it is reclaimable. */
  leaseMs?: number;
  owner?: string;
  workflows?: ReadonlyArray<AnyWorkflow>;
  onLog?: (runId: string, message: string) => void;
  hooks?: TestHooks;
  /** MCP connections available to ctx.mcp (see @graphmind-ai/circuit-mcp). */
  mcp?: McpGateway;
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  parentRunId?: string;
  parentSeq?: number;
  forkedFrom?: { runId: string; fromSeq?: number };
}

export interface ResumeOptions {
  actor: string;
  reason?: string;
  /** edit / retry-with-edit: replaces the entry's input. */
  input?: JsonValue;
  /** inject: the output the entry completes with. */
  output?: JsonValue;
}

export interface ApprovalDecision {
  approved: boolean;
  by: string;
  comment?: string;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/** Every present key in `match` must canonically equal the same key in data. */
function subsetMatches(match: Record<string, JsonValue>, data: JsonValue): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  for (const [key, expected] of Object.entries(match)) {
    if (canonicalValue((data as Record<string, JsonValue>)[key]) !== canonicalValue(expected)) return false;
  }
  return true;
}

export class Executor {
  private readonly store: JournalStore;
  private readonly clock: Clock;
  private readonly leaseMs: number;
  private readonly owner: string;
  private readonly registry = new Map<string, AnyWorkflow>();
  private readonly onLog: (runId: string, message: string) => void;
  private readonly hooks: TestHooks | undefined;
  private readonly mcp: McpGateway | undefined;

  constructor(opts: ExecutorOptions) {
    this.store = opts.store;
    this.clock = opts.clock ?? systemClock;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.owner = opts.owner ?? newId('worker');
    this.onLog = opts.onLog ?? (() => {});
    this.hooks = opts.hooks;
    this.mcp = opts.mcp;
    for (const def of opts.workflows ?? []) this.register(def);
  }

  register(def: AnyWorkflow): void {
    this.registry.set(def.config.name, def);
  }

  /** Swap the whole registry — dev-mode reload after the workflows file changed. */
  replaceWorkflows(defs: ReadonlyArray<AnyWorkflow>): void {
    this.registry.clear();
    for (const def of defs) this.register(def);
  }

  workflowNames(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Abort any active run, whatever it is doing — paused, suspended, queued or
   * between invocations. Pending waits are cleaned up so a later event cannot
   * touch the dead run.
   */
  cancel(runId: string, opts: { actor: string; reason?: string }): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new InvalidResumeError(`run ${runId} not found`);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      throw new InvalidResumeError(`run ${runId} is ${run.status}; only active runs can be cancelled`);
    }
    if (run.status === 'paused' && run.pausedSeq !== undefined) {
      return this.resume(runId, run.pausedSeq, 'abort', opts);
    }
    for (const entry of this.store.listJournal(runId)) {
      if (entry.kind === 'wait' && entry.status === 'suspended') this.store.removeWait(runId, entry.seq);
    }
    this.finishRun(run, 'aborted', {
      error: { name: 'RunAborted', message: `aborted by ${opts.actor}${opts.reason ? `: ${opts.reason}` : ''}` },
    });
    const cancelled = this.store.getRun(runId);
    if (!cancelled) throw new InvalidResumeError(`run ${runId} vanished during cancel`);
    return cancelled;
  }

  enqueue(workflow: string, input: JsonValue, opts: EnqueueOptions = {}): Run {
    const def = this.registry.get(workflow);
    if (!def) throw new WorkflowNotRegisteredError(workflow);
    if (def.config.input) input = toJsonValue(def.config.input.parse(input), `'${workflow}' input`) ?? null;
    const run: Run = {
      id: newId('run'),
      workflow,
      status: 'queued',
      input,
      createdAt: this.clock.now(),
    };
    if (opts.idempotencyKey !== undefined) run.idempotencyKey = opts.idempotencyKey;
    if (opts.parentRunId !== undefined) run.parentRunId = opts.parentRunId;
    if (opts.parentSeq !== undefined) run.parentSeq = opts.parentSeq;
    if (opts.forkedFrom !== undefined) run.forkedFrom = opts.forkedFrom;
    return this.store.createRun(run);
  }

  getRun(id: string): Run | undefined {
    return this.store.getRun(id);
  }

  getJournal(runId: string): JournalEntry[] {
    return this.store.listJournal(runId);
  }

  listRuns(filter?: { workflow?: string; status?: RunStatus; limit?: number }): Run[] {
    return this.store.listRuns(filter);
  }

  setBreakpoint(matcher: BreakpointMatcher): void {
    this.store.setBreakpoint(matcher);
  }

  clearBreakpoints(): void {
    this.store.clearBreakpoints();
  }

  /** Process due runs once. Returns how many were invoked. */
  async tick(limit = 25): Promise<number> {
    const due = this.store.claimDue(this.clock.now(), this.owner, this.leaseMs, limit);
    for (const run of due) {
      await this.invokeRun(run);
    }
    return due.length;
  }

  /** Tick until quiescent (nothing due at the current clock). */
  async drain(maxTicks = 1_000): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if ((await this.tick()) === 0) return;
    }
    throw new Error(`drain() still busy after ${maxTicks} ticks — a run is likely re-queueing itself`);
  }

  private async invokeRun(run: Run): Promise<void> {
    const def = this.registry.get(run.workflow);
    if (!def) {
      this.finishRun(run, 'failed', { error: toErrorShape(new WorkflowNotRegisteredError(run.workflow)) });
      return;
    }
    const now = this.clock.now();
    if (now - run.createdAt >= def.config.timeoutMs) {
      this.finishRun(run, 'timed_out', {
        error: { name: 'RunTimedOut', message: `run exceeded its ${def.config.timeoutMs}ms timeout` },
      });
      return;
    }
    this.store.updateRun(run.id, {
      status: 'running',
      startedAt: run.startedAt ?? now,
      wakeAt: undefined,
      pausedSeq: undefined,
    });

    const io = {
      runId: run.id,
      workflow: def,
      clock: this.clock,
      entries: this.store.listJournal(run.id),
      breakpoints: this.store.listBreakpoints(),
      append: (entry: Omit<JournalEntry, 'seq'>) => this.store.appendEntry(entry),
      update: (seq: number, patch: Patch<JournalEntry>) => this.store.updateEntry(run.id, seq, patch),
      addWait: (seq: number, eventName: string, match: Record<string, JsonValue> | undefined, expiresAt: number) =>
        this.store.addWait({ runId: run.id, seq, eventName, match, expiresAt }),
      removeWait: (seq: number) => this.store.removeWait(run.id, seq),
      spawnChild: (seq: number, workflow: string, input: JsonValue) =>
        this.enqueue(workflow, input, { parentRunId: run.id, parentSeq: seq }).id,
      log: (message: string) => this.onLog(run.id, message),
      ...(this.mcp !== undefined ? { mcp: this.mcp } : {}),
      ...(this.hooks !== undefined ? { hooks: this.hooks } : {}),
    };

    try {
      const { ctx, finalize } = createContext(io);
      const raw = await def.fn(ctx, run.input as never);
      finalize();
      let output = toJsonValue(raw, `'${run.workflow}' result`);
      if (def.config.output) output = toJsonValue(def.config.output.parse(output), `'${run.workflow}' result`);
      this.finishRun(run, 'completed', output === undefined ? {} : { output });
    } catch (err) {
      if (err instanceof SuspendSignal) {
        this.applySuspension(run, err.suspension);
      } else if (err instanceof HardCrash) {
        // Simulated process death: state and lease stay exactly as they are.
        return;
      } else {
        this.finishRun(run, 'failed', { error: toErrorShape(err) });
      }
    }
  }

  private applySuspension(run: Run, s: Suspension): void {
    if (s.type === 'pause') {
      this.store.updateRun(run.id, { status: 'paused', pausedSeq: s.seq, wakeAt: s.wakeAt });
    } else if (s.type === 'child') {
      this.store.updateRun(run.id, { status: 'suspended', wakeAt: undefined });
    } else {
      this.store.updateRun(run.id, { status: 'suspended', wakeAt: s.wakeAt });
    }
    this.store.releaseLease(run.id);
  }

  private finishRun(run: Run, status: RunStatus, result: { output?: JsonValue; error?: ErrorShape }): void {
    this.store.updateRun(run.id, {
      status,
      output: result.output,
      error: result.error,
      finishedAt: this.clock.now(),
      wakeAt: undefined,
      pausedSeq: undefined,
    });
    this.store.releaseLease(run.id);
    if (run.parentRunId !== undefined && run.parentSeq !== undefined) {
      this.settleParent(run.parentRunId, run.parentSeq, status, result);
    }
  }

  /** A child run finished: complete/fail the parent's entry and wake it. */
  private settleParent(
    parentRunId: string,
    parentSeq: number,
    status: RunStatus,
    result: { output?: JsonValue; error?: ErrorShape },
  ): void {
    const entry = this.store.getEntry(parentRunId, parentSeq);
    if (!entry || entry.status !== 'suspended') return;
    const now = this.clock.now();
    if (status === 'completed') {
      this.store.updateEntry(parentRunId, parentSeq, { status: 'completed', output: result.output, finishedAt: now });
    } else {
      this.store.updateEntry(parentRunId, parentSeq, {
        status: 'failed',
        error: result.error ?? { name: 'ChildRunFailed', message: `child run finished as ${status}` },
        finishedAt: now,
      });
    }
    const parent = this.store.getRun(parentRunId);
    if (parent && parent.status === 'suspended') {
      this.store.updateRun(parentRunId, { status: 'queued', wakeAt: now });
    }
  }

  /**
   * Fix-and-resume: act on a paused journal entry. Appends an audited
   * intervention; never erases what production actually did.
   */
  resume(runId: string, seq: number, action: ResumeAction, opts: ResumeOptions): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new InvalidResumeError(`run ${runId} not found`);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      throw new InvalidResumeError(`run ${runId} is ${run.status}; only active runs can be resumed`);
    }
    const entry = this.store.getEntry(runId, seq);
    if (!entry) throw new InvalidResumeError(`run ${runId} has no journal entry #${seq}`);
    if (entry.status !== 'paused' && action !== 'abort') {
      throw new InvalidResumeError(`entry '${entry.name}' (#${seq}) is ${entry.status}, not paused`);
    }
    const now = this.clock.now();
    const point = entry.pausePoint ?? 'before';
    const intervention = {
      actor: opts.actor,
      action,
      at: now,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.input !== undefined ? { editedInput: true } : {}),
      ...(opts.output !== undefined ? { injectedOutput: true } : {}),
    };
    const interventions = [...entry.interventions, intervention];
    const patch: Patch<JournalEntry> = { interventions };

    switch (action) {
      case 'continue':
        if (point === 'before') patch.status = 'running';
        else if (point === 'after') Object.assign(patch, { status: 'completed', finishedAt: now });
        else Object.assign(patch, { status: 'failed', finishedAt: now });
        break;
      case 'retry':
        Object.assign(patch, { status: 'running', error: undefined, pausePoint: undefined, wakeAt: undefined });
        if (opts.input !== undefined) patch.input = opts.input;
        break;
      case 'inject':
        if (opts.output === undefined) throw new InvalidResumeError(`inject requires an output`);
        Object.assign(patch, { status: 'completed', output: opts.output, error: undefined, finishedAt: now });
        break;
      case 'edit':
        if (point !== 'before') throw new InvalidResumeError(`edit is only valid at a before gate, not '${point}'`);
        if (opts.input === undefined) throw new InvalidResumeError(`edit requires an input`);
        Object.assign(patch, { status: 'running', input: opts.input });
        break;
      case 'skip':
        Object.assign(patch, { status: 'skipped', finishedAt: now });
        break;
      case 'abort':
        Object.assign(patch, {
          status: 'failed',
          error: { name: 'RunAborted', message: `aborted by ${opts.actor}` },
          finishedAt: now,
        });
        break;
    }
    this.store.updateEntry(runId, seq, patch);

    if (action === 'abort') {
      const aborted = this.store.getRun(runId);
      if (aborted) {
        this.finishRun(aborted, 'aborted', { error: { name: 'RunAborted', message: `aborted by ${opts.actor}` } });
      }
    } else {
      this.store.updateRun(runId, { status: 'queued', wakeAt: now, pausedSeq: undefined });
    }
    const updated = this.store.getRun(runId);
    if (!updated) throw new InvalidResumeError(`run ${runId} vanished during resume`);
    return updated;
  }

  /**
   * Apply one fix to every run paused at the same step of the same workflow
   * — the third-party-outage remedy. Returns the resumed run ids.
   */
  resumeAllPausedAt(workflow: string, step: string, action: ResumeAction, opts: ResumeOptions): string[] {
    const resumed: string[] = [];
    for (const run of this.store.listRuns({ workflow, status: 'paused', limit: 10_000 })) {
      if (run.pausedSeq === undefined) continue;
      const entry = this.store.getEntry(run.id, run.pausedSeq);
      if (!entry || entry.name !== step || entry.status !== 'paused') continue;
      this.resume(run.id, run.pausedSeq, action, opts);
      resumed.push(run.id);
    }
    return resumed;
  }

  /** Resolve a held approval entry. */
  approve(runId: string, seq: number, decision: ApprovalDecision): Run {
    const entry = this.store.getEntry(runId, seq);
    if (!entry || entry.kind !== 'approval') throw new InvalidResumeError(`entry #${seq} is not an approval`);
    const output = {
      approved: decision.approved,
      by: decision.by,
      ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
    };
    return this.resume(runId, seq, 'inject', { actor: decision.by, output });
  }

  /**
   * Fork a run: copy its journal up to a point — optionally answering one
   * entry with a substituted output — into a new run that executes the rest
   * LIVE. The "what-if" instrument: the original run is never touched.
   */
  fork(
    runId: string,
    opts: { actor: string; uptoSeq?: number; substitute?: { seq: number; output: JsonValue } },
  ): Run {
    const source = this.store.getRun(runId);
    if (!source) throw new InvalidResumeError(`run ${runId} not found`);
    if (opts.uptoSeq === undefined && opts.substitute === undefined) {
      throw new InvalidResumeError('fork needs uptoSeq and/or substitute — an identical copy would just re-complete');
    }
    const cut = opts.substitute?.seq ?? opts.uptoSeq ?? Number.MAX_SAFE_INTEGER;
    const fork = this.enqueue(source.workflow, source.input, { forkedFrom: { runId, fromSeq: cut } });
    const now = this.clock.now();
    for (const entry of this.store.listJournal(runId)) {
      if (entry.seq > cut) break;
      if (entry.seq === cut || entry.seq === opts.substitute?.seq) {
        if (opts.substitute !== undefined && entry.seq === opts.substitute.seq) {
          const { seq: _seq, ...rest } = entry;
          this.store.appendEntry({
            ...rest,
            runId: fork.id,
            status: 'completed',
            output: opts.substitute.output,
            error: undefined as never,
            finishedAt: now,
            interventions: [
              ...entry.interventions,
              { actor: opts.actor, action: 'inject', at: now, injectedOutput: true, reason: 'fork substitution' },
            ],
          });
        }
        break;
      }
      // Only settled effects carry over; the fork re-executes everything else.
      if (entry.status !== 'completed' && entry.status !== 'failed' && entry.status !== 'skipped') break;
      const { seq: _seq, ...rest } = entry;
      this.store.appendEntry({ ...rest, runId: fork.id });
    }
    return fork;
  }

  /** Deliver an event: completes every matching wait and wakes its run. */
  publishEvent(name: string, data: JsonValue): { eventId: string; matchedRuns: string[] } {
    const now = this.clock.now();
    const event = { id: newId('evt'), name, data, receivedAt: now };
    this.store.insertEvent(event);
    const matchedRuns: string[] = [];
    for (const wait of this.store.findWaits(name)) {
      if (wait.match !== undefined && !subsetMatches(wait.match, data)) continue;
      const waiting = this.store.getRun(wait.runId);
      if (!waiting || !ACTIVE_RUN_STATUSES.has(waiting.status)) {
        // The run was cancelled or finished out from under its wait: clean up
        // the orphan instead of mutating a dead run's journal.
        this.store.removeWait(wait.runId, wait.seq);
        continue;
      }
      this.store.removeWait(wait.runId, wait.seq);
      this.store.updateEntry(wait.runId, wait.seq, { status: 'completed', output: data, finishedAt: now });
      if (waiting.status === 'suspended') {
        this.store.updateRun(wait.runId, { status: 'queued', wakeAt: now });
      }
      matchedRuns.push(wait.runId);
    }
    return { eventId: event.id, matchedRuns };
  }
}
