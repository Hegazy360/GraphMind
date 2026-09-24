/**
 * Aggregate cost for the top bar (run) and the inspector's "across all
 * executions" row (node), priced per LLM step from the bundled genai-prices
 * snapshot (context/cost.ts). The table is its own lazily loaded chunk: these
 * hooks start the download only once there is something to price (an LLM step
 * that reported usage), so a run without token counts never fetches it. Where
 * the chunk cannot load (a single-file export opened from disk) no dollar
 * figure renders at all.
 */
import { useMemo } from 'react';
import { sumCosts, type CostTotal } from '../context/cost.js';
import { usePriceTable } from '../prices/loader.js';
import { EST_LABEL } from '../prices/snapshot.js';
import { useRunStore } from '../store/runStore.js';
import type { NodeExecution, NodeState, RunState } from '../store/types.js';

function* llmExecutions(run: RunState): Generator<NodeExecution> {
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined || node.kind !== 'llm') continue;
    yield* node.executions;
  }
}

function hasLlmUsage(executions: Iterable<NodeExecution>): boolean {
  for (const exec of executions) if (exec.usage !== undefined) return true;
  return false;
}

/** Priced total of every LLM step in the run; undefined until something is priced. */
export function useRunCost(runId: string): CostTotal | undefined {
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? 0);
  const wanted = useMemo(() => {
    const run = useRunStore.getState().runs[runId];
    return run !== undefined && hasLlmUsage(llmExecutions(run));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusVersion is the change signal
  }, [runId, statusVersion]);
  const prices = usePriceTable(wanted);
  return useMemo(() => {
    if (prices.status !== 'ready') return undefined;
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return undefined;
    const total = sumCosts(prices.table, llmExecutions(run));
    return total.priced > 0 ? total : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusVersion is the change signal
  }, [prices, runId, statusVersion]);
}

/** Priced total of one LLM node's executions; undefined until something is priced. */
export function useNodeCost(node: NodeState): CostTotal | undefined {
  const prices = usePriceTable(node.kind === 'llm' && hasLlmUsage(node.executions));
  return useMemo(() => {
    if (prices.status !== 'ready' || node.kind !== 'llm') return undefined;
    const total = sumCosts(prices.table, node.executions);
    return total.priced > 0 ? total : undefined;
  }, [prices, node]);
}

/**
 * The hover text of an aggregate cost: how many executions it covers, which
 * were left out (no known price) and the estimate label.
 */
export function costTotalTitle(total: CostTotal, noun: string): string {
  const plural = (n: number): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const parts = [`${plural(total.priced)} priced`];
  if (total.unpriced > 0) parts.push(`${plural(total.unpriced)} with no known price not counted`);
  if (total.reported > 0) {
    parts.push(`${plural(total.reported)} recorded before 0.6 (input as reported — may leave out cached tokens)`);
  }
  return `${parts.join('; ')} — ${EST_LABEL}.`;
}
