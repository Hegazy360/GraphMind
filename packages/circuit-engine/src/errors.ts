/**
 * Engine errors. NonDeterminismError is the important one: it is Circuit's
 * answer to Temporal's deploy-time landmine. When a re-invocation diverges
 * from the journal — a recorded call changed, the code makes a new call
 * while recorded effects remain unreplayed, or it finishes leaving recorded
 * effects orphaned — the run fails LOUDLY with a precise, named diff. It
 * never silently replays a value into code that asked a different question,
 * and never silently abandons an effect that already ran in production.
 */
import type { EntryKind, ErrorShape } from '@graphmind-ai/circuit-schema';

export interface CallIdentity {
  kind: EntryKind;
  name: string;
  ordinal: number;
  key: string;
}

export type Divergence =
  /** Same (name, ordinal) position, different call. */
  | { type: 'mismatch'; runId: string; name: string; ordinal: number; expected: { kind: EntryKind; key: string }; actual: { kind: EntryKind; key: string } }
  /** A brand-new call while recorded effects are still unreplayed. */
  | { type: 'novel-call'; runId: string; actual: CallIdentity; unreplayed: CallIdentity }
  /** The workflow finished, leaving recorded effects it never replayed. */
  | { type: 'orphaned'; runId: string; unreplayed: CallIdentity[] };

function describe(call: { kind: EntryKind; name?: string; ordinal?: number; key?: string }): string {
  const name = call.name !== undefined ? ` '${call.name}'` : '';
  const nth = call.ordinal !== undefined ? ` (call #${call.ordinal + 1})` : '';
  return `${call.kind}${name}${nth}`;
}

const REMEDY =
  `The deployed code no longer matches this in-flight run — replay it with 'circuit replay' to see the divergence, or resume it on the previous deployment.`;

function divergenceMessage(d: Divergence): string {
  switch (d.type) {
    case 'mismatch':
      return (
        `Run ${d.runId} diverged from its journal at '${d.name}' (call #${d.ordinal + 1}): the journal recorded a ` +
        `${describe({ kind: d.expected.kind })} with key ${d.expected.key}, but the current code made a ` +
        `${describe({ kind: d.actual.kind })} with key ${d.actual.key}. ${REMEDY}`
      );
    case 'novel-call':
      return (
        `Run ${d.runId} diverged from its journal: the code called ${describe(d.actual)}, which the journal has ` +
        `never seen, while recorded effect ${describe(d.unreplayed)} is still unreplayed. A recorded effect already ` +
        `ran in production; executing a different call in its place would duplicate work. ${REMEDY}`
      );
    case 'orphaned':
      return (
        `Run ${d.runId} diverged from its journal: the workflow finished, but ${d.unreplayed.length} recorded ` +
        `effect(s) were never replayed: ${d.unreplayed.map((u) => describe(u)).join(', ')}. ${REMEDY}`
      );
  }
}

export class NonDeterminismError extends Error {
  override name = 'NonDeterminismError';
  constructor(public readonly divergence: Divergence) {
    super(divergenceMessage(divergence));
  }
}

export class WorkflowNotRegisteredError extends Error {
  override name = 'WorkflowNotRegisteredError';
  constructor(workflow: string) {
    super(`No workflow named '${workflow}' is registered with this engine.`);
  }
}

export class InvalidResumeError extends Error {
  override name = 'InvalidResumeError';
}

/** A recorded failure, rethrown on replay with its original identity. */
export class ReplayedError extends Error {
  constructor(shape: ErrorShape) {
    super(shape.message);
    this.name = shape.name;
    if (shape.stack !== undefined) this.stack = shape.stack;
  }
}

export function toErrorShape(err: unknown): ErrorShape {
  if (err instanceof Error) {
    const shape: ErrorShape = { name: err.name, message: err.message };
    if (err.stack !== undefined) shape.stack = err.stack;
    return shape;
  }
  return { name: 'Error', message: String(err) };
}

/** Thrown by test hooks to simulate the process dying mid-run. */
export class HardCrash extends Error {
  override name = 'HardCrash';
}
