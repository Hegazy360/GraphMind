/**
 * Per-node and per-run rollups: how many times did this run, how long did it
 * take, how many tokens did it burn, and roughly what did that cost.
 *
 * The cost figure is deliberately labelled as an estimate everywhere it is
 * shown: the wire protocol carries token counts, not prices, so we apply one
 * blended rate. It is here to answer "which step is eating the budget",
 * never to reconcile a bill.
 */
import type { RunState, NodeState } from './types.js';

/** Blended per-million-token rate (mid-tier frontier model, 2026). */
export const RATE_IN_PER_MTOK = 3;
export const RATE_OUT_PER_MTOK = 15;

export function estimateCostUsd(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * RATE_IN_PER_MTOK + (tokensOut / 1_000_000) * RATE_OUT_PER_MTOK;
}

export interface NodeStats {
  executions: number;
  /** Executions after the first — retries, loops, repeated tool calls. */
  retries: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
}

export function nodeStats(node: NodeState): NodeStats {
  let totalMs = 0;
  let maxMs = 0;
  let timed = 0;
  let errors = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const exec of node.executions) {
    if (exec.durationMs !== undefined) {
      totalMs += exec.durationMs;
      maxMs = Math.max(maxMs, exec.durationMs);
      timed += 1;
    }
    if (exec.status === 'error' || exec.error !== undefined) errors += 1;
    if (exec.usage !== undefined) {
      tokensIn += exec.usage.inputTokens;
      tokensOut += exec.usage.outputTokens;
    }
  }
  return {
    executions: node.executions.length,
    retries: Math.max(0, node.executions.length - 1),
    errors,
    totalMs,
    avgMs: timed === 0 ? 0 : totalMs / timed,
    maxMs,
    tokensIn,
    tokensOut,
    estCostUsd: estimateCostUsd(tokensIn, tokensOut),
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
  estCostUsd: number;
  /** Wall-clock span of the run so far. */
  wallMs: number;
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
  };
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    stats.nodes += 1;
    const per = nodeStats(node);
    stats.executions += per.executions;
    stats.errors += per.errors;
    stats.tokensIn += per.tokensIn;
    stats.tokensOut += per.tokensOut;
    if (node.kind === 'tool') stats.tools += per.executions;
    if (node.kind === 'llm') stats.steps += per.executions;
  }
  stats.estCostUsd = estimateCostUsd(stats.tokensIn, stats.tokensOut);
  const start = run.meta.startedTs;
  if (start !== undefined) {
    stats.wallMs = Math.max(0, (run.meta.finishedTs ?? now) - start);
  }
  return stats;
}

/**
 * Sibling/parent context for the "why did this fail" panel: what ran next to
 * the failing call, and what handed it its input.
 */
export interface FailureContext {
  parent?: { nodeId: string; name: string; kind: string };
  siblings: { nodeId: string; name: string; status: string; durationMs?: number }[];
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
      siblings.push({
        nodeId: id,
        name: sibling.name,
        status: last?.status ?? 'idle',
        ...(last?.durationMs !== undefined ? { durationMs: last.durationMs } : {}),
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
