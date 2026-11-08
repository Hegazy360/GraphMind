/**
 * JournalStore — the persistence contract of the engine. Two backends are
 * planned: SqliteJournalStore (node:sqlite — dev, tests, self-host single
 * node; in this repo now) and PostgresJournalStore (the hosted service,
 * post-session). The engine only ever talks to this interface, so the
 * executor, gates, replay and analytics are backend-agnostic.
 *
 * All methods are synchronous: node:sqlite is sync, and the Postgres
 * implementation will wrap the same contract behind an async adapter at the
 * executor boundary (the executor already awaits around every store call
 * site via its own async surface).
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
  createRun(run: Run): Run;
  getRun(id: string): Run | undefined;
  findByIdempotencyKey(workflow: string, key: string): Run | undefined;
  listRuns(filter?: RunFilter): Run[];
  updateRun(id: string, patch: Patch<Run>): void;
  /**
   * Claim up to `limit` due runs for `owner`, extending each lease to
   * now+leaseMs. Due means: status 'queued', or status 'suspended'/'paused'
   * with a wakeAt <= now (paused runs carry a wakeAt only when something —
   * an approval timeout — must fire without a human). Expired leases are
   * reclaimed here too: a crashed worker's runs come back automatically.
   */
  claimDue(now: number, owner: string, leaseMs: number, limit: number): Run[];
  releaseLease(id: string): void;

  // --- journal ---
  listJournal(runId: string): JournalEntry[];
  getEntry(runId: string, seq: number): JournalEntry | undefined;
  /** Appends with the next dense seq for the run; returns the stored entry. */
  appendEntry(entry: Omit<JournalEntry, 'seq'>): JournalEntry;
  updateEntry(runId: string, seq: number, patch: Patch<JournalEntry>): void;

  // --- waits & events ---
  addWait(wait: WaitRow): void;
  removeWait(runId: string, seq: number): void;
  findWaits(eventName: string): WaitRow[];
  insertEvent(event: WorkflowEvent): void;

  // --- breakpoints ---
  listBreakpoints(): BreakpointMatcher[];
  setBreakpoint(matcher: BreakpointMatcher): void;
  clearBreakpoints(): void;

  close(): void;
}
