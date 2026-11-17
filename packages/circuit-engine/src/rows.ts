/**
 * Row <-> domain mapping shared by both JournalStore backends. Both return
 * JSON columns as TEXT (PgJournalStore selects `col::text`), so one parser
 * covers both and SQL NULL ("absent") stays distinct from JSON null.
 */
import type { Attempt, ErrorShape, Intervention, JournalEntry, JsonValue, Run } from '@graphmind-ai/circuit-schema';

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function maybeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function parseMaybe<T>(text: unknown): T | undefined {
  return text === null || text === undefined ? undefined : (JSON.parse(text as string) as T);
}

export type Row = Record<string, unknown>;

export function rowToRun(row: Row): Run {
  const run: Run = {
    id: row.id as string,
    workflow: row.workflow as string,
    status: row.status as Run['status'],
    input: JSON.parse(row.input as string) as JsonValue,
    createdAt: Number(row.created_at),
  };
  const output = parseMaybe<JsonValue>(row.output);
  if (output !== undefined) run.output = output;
  const error = parseMaybe<ErrorShape>(row.error);
  if (error !== undefined) run.error = error;
  if (row.idempotency_key != null) run.idempotencyKey = row.idempotency_key as string;
  if (row.parent_run_id != null) run.parentRunId = row.parent_run_id as string;
  if (row.parent_seq != null) run.parentSeq = Number(row.parent_seq);
  const forked = parseMaybe<Run['forkedFrom']>(row.forked_from);
  if (forked !== undefined) run.forkedFrom = forked;
  if (row.wake_at != null) run.wakeAt = Number(row.wake_at);
  if (row.lease_owner != null) run.leaseOwner = row.lease_owner as string;
  if (row.lease_expires_at != null) run.leaseExpiresAt = Number(row.lease_expires_at);
  if (row.paused_seq != null) run.pausedSeq = Number(row.paused_seq);
  if (row.started_at != null) run.startedAt = Number(row.started_at);
  if (row.finished_at != null) run.finishedAt = Number(row.finished_at);
  return run;
}

export function rowToEntry(row: Row): JournalEntry {
  const entry: JournalEntry = {
    runId: row.run_id as string,
    seq: Number(row.seq),
    kind: row.kind as JournalEntry['kind'],
    name: row.name as string,
    ordinal: Number(row.ordinal),
    key: row.key as string,
    status: row.status as JournalEntry['status'],
    attempts: JSON.parse(row.attempts as string) as Attempt[],
    interventions: JSON.parse(row.interventions as string) as Intervention[],
    startedAt: Number(row.started_at),
  };
  if (row.pause_point != null) entry.pausePoint = row.pause_point as JournalEntry['pausePoint'];
  const input = parseMaybe<JsonValue>(row.input);
  if (input !== undefined) entry.input = input;
  const output = parseMaybe<JsonValue>(row.output);
  if (output !== undefined) entry.output = output;
  const error = parseMaybe<ErrorShape>(row.error);
  if (error !== undefined) entry.error = error;
  if (row.wake_at != null) entry.wakeAt = Number(row.wake_at);
  if (row.wait_event != null) entry.waitEvent = row.wait_event as string;
  const match = parseMaybe<Record<string, JsonValue>>(row.wait_match);
  if (match !== undefined) entry.waitMatch = match;
  if (row.expires_at != null) entry.expiresAt = Number(row.expires_at);
  if (row.child_run_id != null) entry.childRunId = row.child_run_id as string;
  if (row.finished_at != null) entry.finishedAt = Number(row.finished_at);
  return entry;
}

export const RUN_COLUMNS: Record<string, string> = {
  workflow: 'workflow',
  status: 'status',
  input: 'input',
  output: 'output',
  error: 'error',
  idempotencyKey: 'idempotency_key',
  parentRunId: 'parent_run_id',
  parentSeq: 'parent_seq',
  forkedFrom: 'forked_from',
  wakeAt: 'wake_at',
  leaseOwner: 'lease_owner',
  leaseExpiresAt: 'lease_expires_at',
  pausedSeq: 'paused_seq',
  createdAt: 'created_at',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};
export const RUN_JSON_COLUMNS = new Set(['input', 'output', 'error', 'forkedFrom']);

export const ENTRY_COLUMNS: Record<string, string> = {
  kind: 'kind',
  name: 'name',
  ordinal: 'ordinal',
  key: 'key',
  status: 'status',
  pausePoint: 'pause_point',
  input: 'input',
  output: 'output',
  error: 'error',
  attempts: 'attempts',
  interventions: 'interventions',
  wakeAt: 'wake_at',
  waitEvent: 'wait_event',
  waitMatch: 'wait_match',
  expiresAt: 'expires_at',
  childRunId: 'child_run_id',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};
export const ENTRY_JSON_COLUMNS = new Set(['input', 'output', 'error', 'attempts', 'interventions', 'waitMatch']);

