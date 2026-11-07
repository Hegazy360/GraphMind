/**
 * Comparing a replayed run's trajectory against the recording's.
 *
 * The assertion is about what the agent DID — which tools, in what order,
 * with what arguments — not about the prose it produced. Two runs whose
 * final sentence differs by a comma are the same run; two runs that called
 * `refundPayment` with different amounts are not, however similar the
 * replies read.
 *
 * Divergences are CLASSIFIED rather than collapsed into pass/fail, because
 * the four kinds mean different things to whoever is reading:
 *
 *   regression          a call the recording made is gone, or failed where
 *                       it succeeded. Something broke.
 *   alternative         the same calls with the same arguments, in a
 *                       different order (parallel tool calls land in
 *                       whatever order they finish). Not a failure.
 *   extra               a call the recording never made. Usually a real
 *                       change; sometimes a retry the model chose to add.
 *   arguments           the same call, different arguments. The most
 *                       interesting one: the trajectory held but a value
 *                       moved.
 *
 * `--assert` fails on `regression`, `extra` and `arguments`; `alternative`
 * passes with a note. That line is drawn here, once, and both the CLI's
 * exit code and its report read it from the same place.
 */
import type { TrajectoryStep } from './tape.js';

export type DivergenceKind = 'regression' | 'alternative' | 'extra' | 'arguments';

export interface Divergence {
  kind: DivergenceKind;
  /** Position in the recorded trajectory, when the step has one. */
  at: number;
  nodeId: string;
  name: string;
  message: string;
}

export interface CompareResult {
  /** Steps present and identical in both, in order. */
  matched: number;
  recorded: number;
  actual: number;
  divergences: Divergence[];
  /** True when nothing worse than an `alternative` was found. */
  ok: boolean;
}

/** A step's identity for ordering purposes: the node and its arguments. */
function identity(step: TrajectoryStep): string {
  return `${step.nodeId}\u0000${step.key ?? '?'}`;
}

/**
 * Compare two trajectories. Deliberately simple and explainable: a
 * positional walk, with a same-multiset check first so a pure reordering is
 * named as one rather than reported as N regressions and N extras.
 */
export function compareTrajectories(
  recorded: readonly TrajectoryStep[],
  actual: readonly TrajectoryStep[],
): CompareResult {
  const divergences: Divergence[] = [];

  const bag = (steps: readonly TrajectoryStep[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const step of steps) counts.set(identity(step), (counts.get(identity(step)) ?? 0) + 1);
    return counts;
  };
  const sameMultiset = (a: Map<string, number>, b: Map<string, number>): boolean => {
    if (a.size !== b.size) return false;
    for (const [key, count] of a) if (b.get(key) !== count) return false;
    return true;
  };

  const reorderedOnly =
    recorded.length === actual.length &&
    sameMultiset(bag(recorded), bag(actual)) &&
    recorded.some((step, index) => identity(step) !== identity(actual[index]!));

  if (reorderedOnly) {
    divergences.push({
      kind: 'alternative',
      at: 0,
      nodeId: '(run)',
      name: '(run)',
      message:
        `the same ${recorded.length} calls ran with the same arguments, in a different order ` +
        '(parallel tool calls finish in whatever order they finish)',
    });
    return { matched: recorded.length, recorded: recorded.length, actual: actual.length, divergences, ok: true };
  }

  const length = Math.max(recorded.length, actual.length);
  let matched = 0;
  for (let i = 0; i < length; i += 1) {
    const want = recorded[i];
    const got = actual[i];
    if (want === undefined && got !== undefined) {
      divergences.push({
        kind: 'extra',
        at: i,
        nodeId: got.nodeId,
        name: got.name,
        message: `step ${i + 1}: called ${got.name}, which the recording never did`,
      });
      continue;
    }
    if (want !== undefined && got === undefined) {
      divergences.push({
        kind: 'regression',
        at: i,
        nodeId: want.nodeId,
        name: want.name,
        message: `step ${i + 1}: the recording called ${want.name} here; the replay stopped first`,
      });
      continue;
    }
    if (want === undefined || got === undefined) continue;
    if (want.nodeId !== got.nodeId) {
      divergences.push({
        kind: 'regression',
        at: i,
        nodeId: want.nodeId,
        name: want.name,
        message: `step ${i + 1}: expected ${want.name}, got ${got.name}`,
      });
      continue;
    }
    if (want.key !== undefined && got.key !== undefined && want.key !== got.key) {
      divergences.push({
        kind: 'arguments',
        at: i,
        nodeId: want.nodeId,
        name: want.name,
        message: `step ${i + 1}: ${want.name} ran with different arguments than the recording`,
      });
      continue;
    }
    if (want.status !== got.status) {
      divergences.push({
        kind: 'regression',
        at: i,
        nodeId: want.nodeId,
        name: want.name,
        message: `step ${i + 1}: ${want.name} ${got.status === 'error' ? 'failed' : `ended ${got.status}`}, but the recording has it ${want.status}`,
      });
      continue;
    }
    matched += 1;
  }

  return {
    matched,
    recorded: recorded.length,
    actual: actual.length,
    divergences,
    ok: divergences.every((divergence) => divergence.kind === 'alternative'),
  };
}
