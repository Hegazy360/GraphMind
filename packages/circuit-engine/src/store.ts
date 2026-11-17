/**
 * JournalStore — the persistence contract of the engine. Two backends:
 * SqliteJournalStore (node:sqlite — dev, tests, self-host single node) and
 * PgJournalStore (Postgres via @graphmind-ai/db — the hosted service,
 * multi-worker, serverless). The engine only ever talks to this interface,
 * so the executor, gates, replay and analytics are backend-agnostic.
 *
 * Every method is async. node:sqlite is synchronous underneath, but a
 * network database cannot be, and one async contract is simpler than two
 * code paths in the executor. Callers MUST await every call — including the
 * void ones (updateRun, releaseLease, …): TypeScript does not flag a dropped
 * Promise<void>, and an unawaited write on Postgres can land after the read
 * that depends on it, or surface as an unhandled rejection.
 *
 * Both backends must agree exactly on observable behavior: Patch semantics,
 * claim rules, dense per-run seqs and list ordering (ties broken by
 * insertion order). test/store-contract.test.ts runs one suite on both.
 */
import type { BreakpointMatcher, JournalEntry, JsonValue, Run, RunStatus, WorkflowEvent } from '@graphmind-ai/circuit-schema';

/**
 * A partial where an explicitly-undefined field means "clear this column"
 * (exactOptionalPropertyTypes forbids that through a plain Partial).
 */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export interface WaitRow {
  runId: string;
  seq: number;
  eventName: string;
  match: Record<string, JsonValue> | undefined;
  expiresAt: number;
}

export interface RunFilter {
  workflow?: string;
  status?: RunStatus;
  limit?: number;
}

export interface JournalStore {
  // --- runs ---
  createRun(run: Run): Promise<Run>;
  getRun(id: string): Promise<Run | undefined>;
  findByIdempotencyKey(workflow: string, key: string): Promise<Run | undefined>;
  /** Newest first (created_at DESC, later insert first on ties); default limit 100. */
  listRuns(filter?: RunFilter): Promise<Run[]>;
  updateRun(id: string, patch: Patch<Run>): Promise<void>;
  /**
   * Claim up to `limit` due runs for `owner`, extending each lease to
   * now+leaseMs. Due means: status 'queued', or status 'suspended'/'paused'
   * with a wakeAt <= now (paused runs carry a wakeAt only when something —
   * an approval timeout — must fire without a human). Expired leases are
   * reclaimed here too: a crashed worker's runs come back automatically.
   * Oldest due first: COALESCE(wakeAt, createdAt) ASC, insertion order on ties.
   * Must be atomic across workers: two concurrent claimers never get the same run.
   */
  claimDue(now: number, owner: string, leaseMs: number, limit: number): Promise<Run[]>;
  releaseLease(id: string): Promise<void>;

  // --- journal ---
  listJournal(runId: string): Promise<JournalEntry[]>;
  getEntry(runId: string, seq: number): Promise<JournalEntry | undefined>;
  /** Appends with the next dense seq for the run; returns the stored entry. */
  appendEntry(entry: Omit<JournalEntry, 'seq'>): Promise<JournalEntry>;
  updateEntry(runId: string, seq: number, patch: Patch<JournalEntry>): Promise<void>;

  // --- waits & events ---
  addWait(wait: WaitRow): Promise<void>;
  removeWait(runId: string, seq: number): Promise<void>;
  /** In registration order (a re-registered wait moves to the end). */
  findWaits(eventName: string): Promise<WaitRow[]>;
  insertEvent(event: WorkflowEvent): Promise<void>;

  // --- breakpoints ---
  /** In the order they were set. */
  listBreakpoints(): Promise<BreakpointMatcher[]>;
  setBreakpoint(matcher: BreakpointMatcher): Promise<void>;
  clearBreakpoints(): Promise<void>;

  /** Release what the store owns (a SQLite handle; PgJournalStore leaves the caller's pool open). */
  close(): Promise<void>;
}
