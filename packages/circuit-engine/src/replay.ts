/**
 * Replay, deploy-check and fork — the P2 pillar.
 *
 * A journal IS a tape. replayJournal() re-invokes a workflow function over a
 * cloned journal in hermetic mode: completed effects replay, and the first
 * thing that would touch the outside world ends the replay instead of
 * running. Nothing escapes — no network, no child runs, no store writes.
 *
 * Built on that:
 *  - checkDeploy(): "would this code change break runs that are in flight?"
 *    — the question Temporal makes teams answer in production. Run it in CI
 *    or before `circuit deploy`; it names every run that would diverge and
 *    exactly where.
 *  - fixtures: a finished run exported as JSON replays as a regression test.
 *  - forkRun() (on the Executor): copy a journal prefix — optionally with a
 *    substituted step output — into a new run that executes the rest LIVE:
 *    the "what-if" instrument.
 */
import type { JournalEntry, JsonValue, Run } from '@graphmind-ai/circuit-schema';
import type { AnyWorkflow } from '@graphmind-ai/circuit-sdk';
import { canonicalValue } from '@graphmind-ai/analyze';
import { createContext, SuspendSignal, TapeEndSignal, type InvocationIO } from './context.js';
import { NonDeterminismError, toErrorShape, type Divergence } from './errors.js';
import type { JournalStore } from './store.js';

const NO_IGNORED_KEYS: ReadonlySet<string> = new Set();

export type ReplayOutcome =
  /** The function consumed the whole journal and returned. */
  | { kind: 'identical'; output: JsonValue | undefined }
  /** It consumed the journal so far and would continue with new live work. */
  | { kind: 'compatible'; frontier: { kind: string; name: string; ordinal: number } }
  /** It would suspend (sleep/wait/approval/pause) at the same place. */
  | { kind: 'compatible-suspends' }
  /** The code no longer matches the journal — the deploy-check red flag. */
  | { kind: 'diverged'; divergence: Divergence }
  /** The workflow code itself threw during replay (new behavior). */
  | { kind: 'replay-error'; error: { name: string; message: string } };

export interface Fixture {
  circuitFixture: 1;
  workflow: string;
  input: JsonValue;
  output?: JsonValue;
  recordedAt: number;
  journal: JournalEntry[];
}

function replayClock(entries: JournalEntry[]): number {
  let latest = 0;
  for (const entry of entries) {
    latest = Math.max(latest, entry.startedAt, entry.finishedAt ?? 0, entry.wakeAt ?? 0, entry.expiresAt ?? 0);
  }
  return latest + 1;
}

/** Hermetic re-invocation of `def` over a cloned journal. */
export async function replayJournal(
  def: AnyWorkflow,
  input: JsonValue,
  journal: JournalEntry[],
): Promise<ReplayOutcome> {
  const entries = structuredClone(journal);
  const at = replayClock(entries);
  const io: InvocationIO = {
    runId: entries[0]?.runId ?? 'replay',
    workflow: def,
    clock: { now: () => at },
    entries,
    breakpoints: [],
    hermetic: true,
    // Hermetic mode throws TapeEndSignal before any of these can be reached;
    // they exist so a bug surfaces as a loud throw, not a silent effect.
    append: async () => {
      throw new Error('hermetic replay attempted a journal append');
    },
    update: async (seq, patch) => {
      const entry = entries.find((e) => e.seq === seq);
      if (entry) Object.assign(entry, patch);
    },
    addWait: async () => {},
    removeWait: async () => {},
    spawnChild: async () => {
      throw new Error('hermetic replay attempted to spawn a child run');
    },
    log: () => {},
  };
  const { ctx, finalize } = createContext(io);
  try {
    const output = (await def.fn(ctx, input as never)) as JsonValue | undefined;
    finalize();
    return { kind: 'identical', output };
  } catch (err) {
    if (err instanceof TapeEndSignal) return { kind: 'compatible', frontier: err.frontier };
    if (err instanceof SuspendSignal) return { kind: 'compatible-suspends' };
    if (err instanceof NonDeterminismError) return { kind: 'diverged', divergence: err.divergence };
    return { kind: 'replay-error', error: toErrorShape(err) };
  }
}

export async function exportFixture(store: JournalStore, runId: string): Promise<Fixture> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const fixture: Fixture = {
    circuitFixture: 1,
    workflow: run.workflow,
    input: run.input,
    recordedAt: run.finishedAt ?? run.createdAt,
    journal: await store.listJournal(runId),
  };
  if (run.output !== undefined) fixture.output = run.output;
  return fixture;
}

export type FixtureVerdict =
  | { kind: 'pass' }
  /** Same trajectory, different final output — a behavioral regression. */
  | { kind: 'output-changed'; recorded: JsonValue | undefined; replayed: JsonValue | undefined }
  | { kind: 'diverged'; divergence: Divergence }
  | { kind: 'incomplete'; detail: string }
  | { kind: 'replay-error'; error: { name: string; message: string } };

/** Replay a recorded fixture against (presumably newer) workflow code. */
export async function replayFixture(def: AnyWorkflow, fixture: Fixture): Promise<FixtureVerdict> {
  const outcome = await replayJournal(def, fixture.input, fixture.journal);
  switch (outcome.kind) {
    case 'identical': {
      // Key-order-insensitive: a fixture exported from PgJournalStore (JSONB
      // reorders object keys) must still pass against code that builds the
      // same object in a different key order. No ignored keys.
      const same = canonicalValue(outcome.output ?? null, NO_IGNORED_KEYS) === canonicalValue(fixture.output ?? null, NO_IGNORED_KEYS);
      return same ? { kind: 'pass' } : { kind: 'output-changed', recorded: fixture.output, replayed: outcome.output };
    }
    case 'compatible':
      return {
        kind: 'incomplete',
        detail: `replay ran past the recording: the code would execute new work at ${outcome.frontier.kind} '${outcome.frontier.name}' — re-record this fixture`,
      };
    case 'compatible-suspends':
      return { kind: 'incomplete', detail: 'replay suspended before the end of the recording — re-record this fixture' };
    case 'diverged':
      return { kind: 'diverged', divergence: outcome.divergence };
    case 'replay-error':
      return { kind: 'replay-error', error: outcome.error };
  }
}

export interface DeployCheckEntry {
  runId: string;
  workflow: string;
  status: Run['status'];
  outcome: ReplayOutcome;
}

export interface DeployCheckReport {
  checked: number;
  /** Runs the new code would break, with the exact divergence each. */
  broken: DeployCheckEntry[];
}

/**
 * Would deploying `defs` break any in-flight run? Replays every active run's
 * journal against the new code, hermetically. This is the Temporal
 * "versioning landmine", answered before the deploy instead of after it.
 */
export async function checkDeploy(
  defs: ReadonlyArray<AnyWorkflow>,
  store: JournalStore,
  /** Only this account's in-flight runs. Undefined: every run. */
  accountId?: string,
): Promise<DeployCheckReport> {
  const broken: DeployCheckEntry[] = [];
  let checked = 0;
  for (const def of defs) {
    for (const status of ['running', 'suspended', 'paused', 'queued'] as const) {
      for (const run of await store.listRuns({ workflow: def.config.name, status, limit: 10_000, ...(accountId !== undefined ? { accountId } : {}) })) {
        checked += 1;
        const outcome = await replayJournal(def, run.input, await store.listJournal(run.id));
        if (outcome.kind === 'diverged' || outcome.kind === 'replay-error') {
          broken.push({ runId: run.id, workflow: run.workflow, status: run.status, outcome });
        }
      }
    }
  }
  return { checked, broken };
}
