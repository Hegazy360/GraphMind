/**
 * Per-node and per-run rollups: how many times did this run, how long did it
 * take, how many tokens did it burn, and roughly what did that cost.
 *
 * The cost figure is deliberately labelled as an estimate everywhere it is
 * shown: the wire protocol carries token counts, not prices, so we apply one
 * blended rate. It is here to answer "which step is eating the budget",
 * never to reconcile a bill.
 *
 * Token counts go through lib/usage.ts (contract C1): input totals include
 * cached tokens when the sender stamped `inclusive`, and are labelled "as
 * reported" otherwise; cache read / write and reasoning counts are summed
 * only when some execution reported them.
 */
import { heldMsOf, ranMs, runHeldMs } from '../lib/duration.js';
import { addUsage, emptyTotals, mergeTotals, type TotalBasis, type UsageTotals } from '../lib/usage.js';
import type { RunState, NodeState } from './types.js';

/** Blended per-million-token rate (mid-tier frontier model, 2026). */
export const RATE_IN_PER_MTOK = 3;
export const RATE_OUT_PER_MTOK = 15;
/** The common provider multipliers on the input rate: cache reads 0.1x, 5-minute cache writes 1.25x. */
export const CACHE_READ_RATE = 0.1;
export const CACHE_WRITE_RATE = 1.25;

/**
 * Blended estimate. `tokensIn` is the prompt total; the cached share (when
 * reported) is priced at the cache multipliers instead of the full rate — a
 * cache-heavy agent would otherwise read ~10x too expensive.
 */
export function estimateCostUsd(
  tokensIn: number,
  tokensOut: number,
  cache: { read?: number | undefined; write?: number | undefined } = {},
): number {
  const read = cache.read ?? 0;
  const write = cache.write ?? 0;
  const fresh = Math.max(0, tokensIn - read - write);
  const promptUnits = fresh + read * CACHE_READ_RATE + write * CACHE_WRITE_RATE;
  return (promptUnits / 1_000_000) * RATE_IN_PER_MTOK + (tokensOut / 1_000_000) * RATE_OUT_PER_MTOK;
}

function costOf(totals: UsageTotals): number {
  return estimateCostUsd(totals.inputTokens, totals.outputTokens, {
    read: totals.cacheReadTokens,
    write: totals.cacheWriteTokens,
  });
}

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
  estCostUsd: number;
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
    estCostUsd: costOf(usage),
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
  estCostUsd: number;
  /** Wall-clock span of the run so far — held time INCLUDED (it is wall time). */
  wallMs: number;
  /** Wall time during which some gate in the run was held (union of pauses). */
  heldMs: number;
  /** `wallMs - heldMs`: the span the run was actually running. */
  ranMs: number;
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
    estCostUsd: 0,
    wallMs: 0,
    heldMs: 0,
    ranMs: 0,
  };
  const usage = emptyTotals();
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    stats.nodes += 1;
    const per = nodeStats(node);
    stats.executions += per.executions;
    stats.errors += per.errors;
    mergeTotals(usage, per.usage);
    if (node.kind === 'tool') stats.tools += per.executions;
    if (node.kind === 'llm') stats.steps += per.executions;
  }
  stats.tokensIn = usage.inputTokens;
  stats.tokensOut = usage.outputTokens;
  Object.assign(stats, tokenExtras(usage));
  stats.estCostUsd = costOf(usage);
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
