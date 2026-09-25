/**
 * Per-node and per-run rollups: how many times did this run, how long did it
 * take, how many tokens did it burn.
 *
 * Token counts go through lib/usage.ts (contract C1): input totals include
 * cached tokens when the sender stamped `inclusive`, and are labelled "as
 * reported" otherwise; cache read / write and reasoning counts are summed
 * only when some execution reported them.
 *
 * Cost is not here: it used to be one blended $3/$15 rate applied to every
 * model. It is now priced per step, per model, from the bundled genai-prices
 * snapshot (context/cost.ts), and only for models the snapshot knows.
 */
import { heldMsOf, ranMs, runHeldMs } from '../lib/duration.js';
import { addUsage, emptyTotals, mergeTotals, type TotalBasis, type UsageTotals } from '../lib/usage.js';
import type { RunState, NodeState } from './types.js';

/** The optional token fields of a stats object, present only when reported. */
function tokenExtras(totals: UsageTotals): Pick<NodeStats, 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'tokenBasis'> {
  return {
    ...(totals.cacheReadTokens !== undefined ? { cacheReadTokens: totals.cacheReadTokens } : {}),
    ...(totals.cacheWriteTokens !== undefined ? { cacheWriteTokens: totals.cacheWriteTokens } : {}),
    ...(totals.reasoningTokens !== undefined ? { reasoningTokens: totals.reasoningTokens } : {}),
    ...(totals.basis !== undefined ? { tokenBasis: totals.basis } : {}),
  };
}

export interface NodeStats {
  executions: number;
  /** Executions after the first — retries, loops, repeated tool calls. */
  retries: number;
  errors: number;
  /** Sum of what the executions themselves took — held time excluded. */
  totalMs: number;
  avgMs: number;
  maxMs: number;
  /** Time the debugger held this node's executions, summed. */
  heldMs: number;
  /** Prompt tokens: totals (cache included) unless `tokenBasis` says otherwise. */
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** `reported` / `mixed`: some counts predate 0.6 and may exclude cached tokens. */
  tokenBasis?: TotalBasis;
  /** The raw totals (for rollups). */
  usage: UsageTotals;
}

export function nodeStats(node: NodeState): NodeStats {
  let totalMs = 0;
  let maxMs = 0;
  let heldMs = 0;
  let timed = 0;
  let errors = 0;
  const usage = emptyTotals();
  for (const exec of node.executions) {
    const ran = ranMs(exec);
    if (ran !== undefined) {
      totalMs += ran;
      maxMs = Math.max(maxMs, ran);
      heldMs += heldMsOf(exec);
      timed += 1;
    }
    if (exec.status === 'error' || exec.error !== undefined) errors += 1;
    if (exec.usage !== undefined) addUsage(usage, exec.usage);
  }
  return {
    executions: node.executions.length,
    retries: Math.max(0, node.executions.length - 1),
    errors,
    totalMs,
    avgMs: timed === 0 ? 0 : totalMs / timed,
    maxMs,
    heldMs,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    ...tokenExtras(usage),
    usage,
  };
}

export interface RunStats {
  nodes: number;
  executions: number;
  errors: number;
  tools: number;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  tokenBasis?: TotalBasis;
  /** Wall-clock span of the run so far — held time INCLUDED (it is wall time). */
  wallMs: number;
  /** Wall time during which some gate in the run was held (union of pauses). */
  heldMs: number;
  /** `wallMs - heldMs`: the span the run was actually running. */
  ranMs: number;
}

/**
 * The non-LLM nodes whose usage is a ROLLUP of usage a descendant also
 * reported: an agent's node.finished summing its steps (the bundled demo),
 * or an AI SDK OTel import's `ai.usage` on the generateText span beside each
 * doGenerate span. Adding both double-counts, and the est. cost beside the
 * total prices LLM steps only — so run and group totals skip these. An LLM
 * step always counts (the cost prices every one).
 *
 * `ids` limits the walk to a group (its descendants), `stopAt` is the
 * group's root: an ancestor outside the group is not marked.
 */
export function rollupNodeIds(run: RunState, ids: Iterable<string> = run.order, stopAt?: string): Set<string> {
  const out = new Set<string>();
  for (const nodeId of ids) {
    const node = run.nodes[nodeId];
    if (node === undefined || !node.executions.some((e) => e.usage !== undefined && e.usage !== null)) continue;
    let parentId = node.parentId;
    for (let guard = 0; parentId !== undefined && parentId !== stopAt && guard < 64; guard += 1) {
      if (out.has(parentId)) break; // its ancestors are marked already
      if (run.nodes[parentId]?.kind !== 'llm') out.add(parentId);
      parentId = run.nodes[parentId]?.parentId;
    }
  }
  return out;
}

export function runStats(run: RunState, now: number = Date.now()): RunStats {
  const stats: RunStats = {
    nodes: 0,
    executions: 0,
    errors: 0,
    tools: 0,
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    wallMs: 0,
    heldMs: 0,
    ranMs: 0,
  };
  const usage = emptyTotals();
  const rollups = rollupNodeIds(run);
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    stats.nodes += 1;
    const per = nodeStats(node);
    stats.executions += per.executions;
    stats.errors += per.errors;
    if (!rollups.has(nodeId)) mergeTotals(usage, per.usage);
    if (node.kind === 'tool') stats.tools += per.executions;
    if (node.kind === 'llm') stats.steps += per.executions;
  }
  stats.tokensIn = usage.inputTokens;
  stats.tokensOut = usage.outputTokens;
  Object.assign(stats, tokenExtras(usage));
  const start = run.meta.startedTs;
  if (start !== undefined) {
    stats.wallMs = Math.max(0, (run.meta.finishedTs ?? now) - start);
    stats.heldMs = Math.min(stats.wallMs, runHeldMs(run, run.meta.finishedTs ?? now));
    stats.ranMs = Math.max(0, stats.wallMs - stats.heldMs);
  }
  return stats;
}

/**
 * Sibling/parent context for the "why did this fail" panel: what ran next to
 * the failing call, and what handed it its input.
 */
export interface FailureContext {
  parent?: { nodeId: string; name: string; kind: string };
  /** `ranMs` is the sibling's last execution minus held time. */
  siblings: { nodeId: string; name: string; status: string; ranMs?: number }[];
}

export function failureContext(run: RunState, nodeId: string): FailureContext {
  const node = run.nodes[nodeId];
  if (node === undefined) return { siblings: [] };
  const parentId = node.parentId;
  const parent = parentId === undefined ? undefined : run.nodes[parentId];
  const siblings: FailureContext['siblings'] = [];
  if (parentId !== undefined) {
    for (const id of run.order) {
      if (id === nodeId) continue;
      const sibling = run.nodes[id];
      if (sibling === undefined || sibling.parentId !== parentId) continue;
      const last = sibling.executions[sibling.executions.length - 1];
      const ran = last === undefined ? undefined : ranMs(last);
      siblings.push({
        nodeId: id,
        name: sibling.name,
        status: last?.status ?? 'idle',
        ...(ran !== undefined ? { ranMs: ran } : {}),
      });
    }
  }
  return {
    ...(parent !== undefined
      ? { parent: { nodeId: parent.nodeId, name: parent.name, kind: parent.kind } }
      : {}),
    siblings,
  };
}
