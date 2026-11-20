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
 *
 * Every store call is awaited (the JournalStore is async). Public methods
 * are async accordingly; they keep the order of writes they had when the
 * store was synchronous, so crash windows are unchanged.
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
import {
  createContext,
  SuspendSignal,
  type InvocationIO,
  type McpGateway,
  type Suspension,
  type TestHooks,
} from './context.js';
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
  /** The owning account (see Run.accountId). */
  accountId?: string;
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

export interface DrainOptions {
  /** Wall-clock ms after which no new run is claimed (serverless time limits). Omit for "until quiescent". */
  budgetMs?: number;
  /** Safety valve against a run that re-queues itself forever (default 1000). */
  maxTicks?: number;
  /** Runs claimed per tick (default 25). */
  batch?: number;
}

export interface DrainResult {
  /** Due work likely remains (the budget ran out); false when nothing was due. */
  more: boolean;
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
  async cancel(runId: string, opts: { actor: string; reason?: string }): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) throw new InvalidResumeError(`run ${runId} not found`);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      throw new InvalidResumeError(`run ${runId} is ${run.status}; only active runs can be cancelled`);
    }
    if (run.status === 'paused' && run.pausedSeq !== undefined) {
      return this.resume(runId, run.pausedSeq, 'abort', opts);
    }
    for (const entry of await this.store.listJournal(runId)) {
      if (entry.kind === 'wait' && entry.status === 'suspended') await this.store.removeWait(runId, entry.seq);
    }
    await this.finishRun(run, 'aborted', {
      error: { name: 'RunAborted', message: `aborted by ${opts.actor}${opts.reason ? `: ${opts.reason}` : ''}` },
    });
    const cancelled = await this.store.getRun(runId);
    if (!cancelled) throw new InvalidResumeError(`run ${runId} vanished during cancel`);
    return cancelled;
  }

  async enqueue(workflow: string, input: JsonValue, opts: EnqueueOptions = {}): Promise<Run> {
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
    if (opts.accountId !== undefined) run.accountId = opts.accountId;
    return this.store.createRun(run);
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.store.getRun(id);
  }

  async getJournal(runId: string): Promise<JournalEntry[]> {
    return this.store.listJournal(runId);
  }

  async listRuns(filter?: { workflow?: string; status?: RunStatus; limit?: number; accountId?: string }): Promise<Run[]> {
    return this.store.listRuns(filter);
  }

  async setBreakpoint(matcher: BreakpointMatcher): Promise<void> {
    await this.store.setBreakpoint(matcher);
  }

  /** One account's breakpoints, or (undefined) all of them. */
  async clearBreakpoints(accountId?: string): Promise<void> {
    await this.store.clearBreakpoints(accountId);
  }

  /** Process due runs once. Returns how many were invoked. */
  async tick(limit = 25): Promise<number> {
    return (await this.tickUntil(limit, Number.POSITIVE_INFINITY)).invoked;
  }

  /**
   * One claim + invoke pass. Past `deadline` (performance.now() ms), runs
   * claimed but not yet started get their leases released at once so any
   * worker can take them immediately, instead of sitting out leaseMs.
   * At least one claimed run is always invoked, so a drain makes progress
   * even with a tiny budget.
   */
  private async tickUntil(limit: number, deadline: number): Promise<{ invoked: number; stoppedEarly: boolean }> {
    const due = await this.store.claimDue(this.clock.now(), this.owner, this.leaseMs, limit);
    let invoked = 0;
    for (const run of due) {
      if (invoked > 0 && performance.now() >= deadline) {
        for (const rest of due.slice(invoked)) await this.store.releaseLease(rest.id);
        return { invoked, stoppedEarly: true };
      }
      await this.invokeRun(run);
      invoked += 1;
    }
    return { invoked, stoppedEarly: false };
  }

  /**
   * Tick until quiescent (nothing due at the current clock), or until the
   * budget is spent. Two callers:
   *  - tests and the CLI's engine loop: `drain()` — run everything due now;
   *    throws if a run keeps re-queueing itself past maxTicks (an engine
   *    bug, not a workflow failure).
   *  - serverless (a cron / queue-triggered function with a hard time
   *    limit): `drain({ budgetMs })` — stop claiming new work once budgetMs
   *    of wall time has elapsed and resolve `{ more: true }` so the caller
   *    can re-trigger itself. The budget is checked between invocations,
   *    never inside one: a workflow invocation that has started finishes
   *    (or suspends) normally, so leave headroom for your longest one. It
   *    uses real time (performance.now), not the executor's Clock — the
   *    Clock is workflow time and may be a frozen ManualClock in tests.
   *
   * `more` is a hint: true when the budget ran out with work possibly due,
   * false when a claim found nothing due. Future timers (sleeps, waits,
   * approval timeouts) are not "more" — a periodic trigger picks them up.
   * A number argument is the legacy `maxTicks`.
   */
  async drain(opts: number | DrainOptions = {}): Promise<DrainResult> {
    const o: DrainOptions = typeof opts === 'number' ? { maxTicks: opts } : opts;
    const maxTicks = o.maxTicks ?? 1_000;
    const batch = o.batch ?? 25;
    const deadline = o.budgetMs !== undefined ? performance.now() + o.budgetMs : Number.POSITIVE_INFINITY;
    for (let i = 0; i < maxTicks; i++) {
      if (i > 0 && performance.now() >= deadline) return { more: true };
      const { invoked, stoppedEarly } = await this.tickUntil(batch, deadline);
      if (stoppedEarly) return { more: true };
      if (invoked === 0) return { more: false };
    }
    // With a budget the caller re-triggers anyway: report, don't throw.
    if (o.budgetMs !== undefined) return { more: true };
    throw new Error(`drain() still busy after ${maxTicks} ticks — a run is likely re-queueing itself`);
  }

  private async invokeRun(run: Run): Promise<void> {
    const def = this.registry.get(run.workflow);
    if (!def) {
      await this.finishRun(run, 'failed', { error: toErrorShape(new WorkflowNotRegisteredError(run.workflow)) });
      return;
    }
    const now = this.clock.now();
    if (now - run.createdAt >= def.config.timeoutMs) {
      await this.finishRun(run, 'timed_out', {
        error: { name: 'RunTimedOut', message: `run exceeded its ${def.config.timeoutMs}ms timeout` },
      });
      return;
    }
    await this.store.updateRun(run.id, {
      status: 'running',
      startedAt: run.startedAt ?? now,
      wakeAt: undefined,
      pausedSeq: undefined,
    });

    // The context may issue writes from concurrent branches of one
    // invocation (Promise.all over steps). node:sqlite applied them in
    // issue order because each call completed synchronously; a network
    // store would not, and seq assignment / patch order would depend on
    // round-trip timing. So writes go through one FIFO chain per
    // invocation: same order as before, on every backend. Arguments are
    // cloned at issue time because the context keeps mutating its objects
    // (e.g. an attempt's finishedAt) after handing them over.
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn);
      chain = next.catch(() => {});
      return next;
    };
    const io: InvocationIO = {
      runId: run.id,
      workflow: def,
      clock: this.clock,
      entries: await this.store.listJournal(run.id),
      // An account's breakpoints pause only that account's runs; operator ones (no account) pause every run.
      breakpoints: (await this.store.listBreakpoints()).filter((m) => m.accountId === undefined || m.accountId === run.accountId),
      append: (entry) => {
        const copy = structuredClone(entry);
        return serial(() => this.store.appendEntry(copy));
      },
      update: (seq, patch) => {
        const copy = structuredClone(patch);
        return serial(() => this.store.updateEntry(run.id, seq, copy));
      },
      addWait: (seq, eventName, match, expiresAt) => {
        const copy = structuredClone(match);
        return serial(() => this.store.addWait({ runId: run.id, seq, eventName, match: copy, expiresAt }));
      },
      removeWait: (seq) => serial(() => this.store.removeWait(run.id, seq)),
      spawnChild: (seq, workflow, input) => {
        const copy = structuredClone(input);
        return serial(
          async () =>
            (
              await this.enqueue(workflow, copy, {
                parentRunId: run.id,
                parentSeq: seq,
                ...(run.accountId !== undefined ? { accountId: run.accountId } : {}),
              })
            ).id,
        );
      },
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
      await this.finishRun(run, 'completed', output === undefined ? {} : { output });
    } catch (err) {
      if (err instanceof SuspendSignal) {
        await this.applySuspension(run, err.suspension);
      } else if (err instanceof HardCrash) {
        // Simulated process death: state and lease stay exactly as they are.
        return;
      } else {
        await this.finishRun(run, 'failed', { error: toErrorShape(err) });
      }
    }
  }

  private async applySuspension(run: Run, s: Suspension): Promise<void> {
    if (s.type === 'pause') {
      await this.store.updateRun(run.id, { status: 'paused', pausedSeq: s.seq, wakeAt: s.wakeAt });
    } else if (s.type === 'child') {
      await this.store.updateRun(run.id, { status: 'suspended', wakeAt: undefined });
    } else {
      await this.store.updateRun(run.id, { status: 'suspended', wakeAt: s.wakeAt });
    }
    await this.store.releaseLease(run.id);
  }

  private async finishRun(run: Run, status: RunStatus, result: { output?: JsonValue; error?: ErrorShape }): Promise<void> {
    await this.store.updateRun(run.id, {
      status,
      output: result.output,
      error: result.error,
      finishedAt: this.clock.now(),
      wakeAt: undefined,
      pausedSeq: undefined,
    });
    await this.store.releaseLease(run.id);
    if (run.parentRunId !== undefined && run.parentSeq !== undefined) {
      await this.settleParent(run.parentRunId, run.parentSeq, status, result);
    }
  }

  /** A child run finished: complete/fail the parent's entry and wake it. */
  private async settleParent(
    parentRunId: string,
    parentSeq: number,
    status: RunStatus,
    result: { output?: JsonValue; error?: ErrorShape },
  ): Promise<void> {
    const entry = await this.store.getEntry(parentRunId, parentSeq);
    if (!entry || entry.status !== 'suspended') return;
    const now = this.clock.now();
    if (status === 'completed') {
      await this.store.updateEntry(parentRunId, parentSeq, { status: 'completed', output: result.output, finishedAt: now });
    } else {
      await this.store.updateEntry(parentRunId, parentSeq, {
        status: 'failed',
        error: result.error ?? { name: 'ChildRunFailed', message: `child run finished as ${status}` },
        finishedAt: now,
      });
    }
    const parent = await this.store.getRun(parentRunId);
    if (parent && parent.status === 'suspended') {
      await this.store.updateRun(parentRunId, { status: 'queued', wakeAt: now });
    }
  }

  /**
   * Fix-and-resume: act on a paused journal entry. Appends an audited
   * intervention; never erases what production actually did.
   */
  async resume(runId: string, seq: number, action: ResumeAction, opts: ResumeOptions): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) throw new InvalidResumeError(`run ${runId} not found`);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      throw new InvalidResumeError(`run ${runId} is ${run.status}; only active runs can be resumed`);
    }
    const entry = await this.store.getEntry(runId, seq);
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
    await this.store.updateEntry(runId, seq, patch);

    if (action === 'abort') {
      const aborted = await this.store.getRun(runId);
      if (aborted) {
        await this.finishRun(aborted, 'aborted', { error: { name: 'RunAborted', message: `aborted by ${opts.actor}` } });
      }
    } else {
      await this.store.updateRun(runId, { status: 'queued', wakeAt: now, pausedSeq: undefined });
    }
    const updated = await this.store.getRun(runId);
    if (!updated) throw new InvalidResumeError(`run ${runId} vanished during resume`);
    return updated;
  }

  /**
   * Apply one fix to every run paused at the same step of the same workflow
   * — the third-party-outage remedy. Returns the resumed run ids.
   */
  async resumeAllPausedAt(workflow: string, step: string, action: ResumeAction, opts: ResumeOptions): Promise<string[]> {
    const resumed: string[] = [];
    for (const run of await this.store.listRuns({ workflow, status: 'paused', limit: 10_000 })) {
      if (run.pausedSeq === undefined) continue;
      const entry = await this.store.getEntry(run.id, run.pausedSeq);
      if (!entry || entry.name !== step || entry.status !== 'paused') continue;
      await this.resume(run.id, run.pausedSeq, action, opts);
      resumed.push(run.id);
    }
    return resumed;
  }

  /** Resolve a held approval entry. */
  async approve(runId: string, seq: number, decision: ApprovalDecision): Promise<Run> {
    const entry = await this.store.getEntry(runId, seq);
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
  async fork(
    runId: string,
    opts: { actor: string; uptoSeq?: number; substitute?: { seq: number; output: JsonValue } },
  ): Promise<Run> {
    const source = await this.store.getRun(runId);
    if (!source) throw new InvalidResumeError(`run ${runId} not found`);
    if (opts.uptoSeq === undefined && opts.substitute === undefined) {
      throw new InvalidResumeError('fork needs uptoSeq and/or substitute — an identical copy would just re-complete');
    }
    const cut = opts.substitute?.seq ?? opts.uptoSeq ?? Number.MAX_SAFE_INTEGER;
    const fork = await this.enqueue(source.workflow, source.input, {
      forkedFrom: { runId, fromSeq: cut },
      ...(source.accountId !== undefined ? { accountId: source.accountId } : {}),
    });
    const now = this.clock.now();
    for (const entry of await this.store.listJournal(runId)) {
      if (entry.seq > cut) break;
      if (entry.seq === cut || entry.seq === opts.substitute?.seq) {
        if (opts.substitute !== undefined && entry.seq === opts.substitute.seq) {
          const { seq: _seq, ...rest } = entry;
          await this.store.appendEntry({
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
      await this.store.appendEntry({ ...rest, runId: fork.id });
    }
    return fork;
  }

  /** Deliver an event: completes every matching wait and wakes its run. */
  /**
   * Deliver an event to the runs waiting for it. With `accountId`, only that
   * account's runs can match: one account's events never move another's runs.
   * Without it (operator, open dev server), every waiting run can match.
   */
  async publishEvent(
    name: string,
    data: JsonValue,
    opts: { accountId?: string } = {},
  ): Promise<{ eventId: string; matchedRuns: string[] }> {
    const now = this.clock.now();
    const event = { id: newId('evt'), name, data, receivedAt: now };
    await this.store.insertEvent(event);
    const matchedRuns: string[] = [];
    for (const wait of await this.store.findWaits(name)) {
      if (wait.match !== undefined && !subsetMatches(wait.match, data)) continue;
      const waiting = await this.store.getRun(wait.runId);
      if (waiting && opts.accountId !== undefined && waiting.accountId !== opts.accountId) continue;
      if (!waiting || !ACTIVE_RUN_STATUSES.has(waiting.status)) {
        // The run was cancelled or finished out from under its wait: clean up
        // the orphan instead of mutating a dead run's journal.
        await this.store.removeWait(wait.runId, wait.seq);
        continue;
      }
      await this.store.removeWait(wait.runId, wait.seq);
      await this.store.updateEntry(wait.runId, wait.seq, { status: 'completed', output: data, finishedAt: now });
      if (waiting.status === 'suspended') {
        await this.store.updateRun(wait.runId, { status: 'queued', wakeAt: now });
      }
      matchedRuns.push(wait.runId);
    }
    return { eventId: event.id, matchedRuns };
  }
}
