/**
 * Circuit and Jack as data sources: their records, folded into the same
 * `RunSample` the debugger's runs become, so trends and recommendations work
 * on all three services with one set of rules.
 *
 *   Circuit  one run → one sample. `step` and `mcp` journal entries become
 *            tool executions (`child` too: a child workflow is a call);
 *            sleeps, waits and approvals are waiting, not work, and are left
 *            out. Human fixes (retry, inject, skip, edit...) are kept.
 *   Jack     one tool call → one sample with one execution: Jack has calls,
 *            not runs, so "runs" in a Jack trend are calls. The log holds no
 *            arguments or results by design; status codes are the evidence.
 *
 * The input types are structural (the subset of Circuit's `Run` /
 * `JournalEntry` and Jack's `CallRow` read here), so this package keeps no
 * dependency on either service and stays bundleable in the viewer.
 */
import type { ExecutionSample, RunSample } from './sample.js';

export interface CircuitRunLike {
  id: string;
  workflow: string;
  status: string;
  createdAt: number;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
}

export interface CircuitEntryLike {
  seq: number;
  kind: string;
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: { message: string } | undefined;
  attempts?: Array<{ startedAt: number; finishedAt?: number | undefined; error?: { message: string } | undefined }> | undefined;
  interventions?: Array<{ action: string }> | undefined;
  startedAt: number;
  finishedAt?: number | undefined;
}

const CIRCUIT_WORK = new Set(['step', 'mcp', 'child']);

function circuitRunStatus(status: string): NonNullable<RunSample['status']> {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'failed':
    case 'timed_out':
      return 'error';
    case 'aborted':
      return 'aborted';
    default:
      return 'running'; // queued, running, suspended, paused: not over yet
  }
}

/** One Circuit run and its journal → a sample (`app` is the workflow name). */
export function sampleFromCircuitRun(run: CircuitRunLike, journal: readonly CircuitEntryLike[]): RunSample {
  const executions: ExecutionSample[] = [];
  for (const entry of journal) {
    if (!CIRCUIT_WORK.has(entry.kind)) continue;
    const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
    const lastError = entry.error?.message ?? [...attempts].reverse().find((a) => a.error !== undefined)?.error?.message;
    const status: ExecutionSample['status'] =
      entry.status === 'completed' ? 'ok' : entry.status === 'failed' ? 'error' : entry.status === 'paused' && lastError !== undefined ? 'error' : 'running';
    const execution: ExecutionSample = {
      nodeId: `circuit:${run.workflow}:${entry.kind}:${entry.name}`,
      kind: 'tool',
      name: entry.name,
      instanceId: `${run.id}#${entry.seq}`,
      seq: entry.seq,
      startedTs: entry.startedAt,
      status,
    };
    if (entry.input !== undefined) execution.input = entry.input;
    if (entry.output !== undefined) execution.output = entry.output;
    if (entry.finishedAt !== undefined) execution.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
    if (lastError !== undefined && status !== 'ok') execution.errorMessage = lastError;
    if (Array.isArray(entry.interventions) && entry.interventions.length > 0) {
      execution.interventions = entry.interventions.map((i) => ({ action: String(i.action) }));
    }
    executions.push(execution);
  }
  return { runId: run.id, app: run.workflow, status: circuitRunStatus(run.status), origin: 'circuit', executions };
}

export interface JackCallLike {
  id: number | string;
  tool: string;
  /** `ok`, `upstream_error`, `invalid_arguments`, `forbidden`, `declined`, `credentials`, or an upstream error kind. */
  status: string;
  upstreamStatus: number | null;
  ms: number;
  at: number;
}

/** Calls that are not the tool's fault: the user said no, or was not allowed. */
const JACK_NOT_A_FAILURE = new Set(['ok', 'declined', 'forbidden', 'credentials']);

function jackError(call: JackCallLike): string {
  if (call.status === 'upstream_error' && call.upstreamStatus !== null) return `API answered HTTP ${call.upstreamStatus}`;
  if (call.status === 'invalid_arguments') return 'arguments did not match the tool schema';
  return call.status.replace(/_/g, ' ');
}

/** A Jack project's call log → one sample per call (`app` is the project). */
export function samplesFromJackCalls(project: string, calls: readonly JackCallLike[]): RunSample[] {
  return calls.map((call) => {
    const fails = !JACK_NOT_A_FAILURE.has(call.status);
    const execution: ExecutionSample = {
      nodeId: `jack:${project}:${call.tool}`,
      kind: 'tool',
      name: call.tool,
      instanceId: String(call.id),
      startedTs: call.at,
      status: fails ? 'error' : 'ok',
      durationMs: Math.max(0, call.ms),
      output: { status: call.status, ...(call.upstreamStatus !== null ? { upstreamStatus: call.upstreamStatus } : {}) },
    };
    if (fails) execution.errorMessage = jackError(call);
    return { runId: `call-${call.id}`, app: project, status: fails ? 'error' : 'ok', origin: 'jack', executions: [execution] } satisfies RunSample;
  });
}
