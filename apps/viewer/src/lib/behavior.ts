/**
 * The viewer's bridge to @graphmind-ai/analyze: map the run store's derived
 * state to the analyzer's `RunSample`, so the Behaviour section shows the
 * SAME numbers `graphmind runs --behavior` and the MCP `get_behavior` tool
 * compute from the stored events. The metrics live in the package; this
 * file only reshapes state the reducer already built.
 */
import type { ExecutionSample, RunSample, WasteIncident } from '@graphmind-ai/analyze';
import type { NodeExecution, NodeState, RunState } from '../store/types.js';

function toSample(node: NodeState, exec: NodeExecution): ExecutionSample {
  const heldMs = exec.heldMs ?? exec.derivedHeldMs;
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
    instanceId: exec.instanceId,
    ...(exec.seq !== undefined ? { seq: exec.seq } : {}),
    startedTs: exec.startedTs,
    status: exec.status,
    input: exec.input,
    ...(exec.output !== undefined ? { output: exec.output } : {}),
    ...(exec.usage !== undefined ? { usage: exec.usage } : {}),
    ...(exec.durationMs !== undefined ? { durationMs: exec.durationMs } : {}),
    ...(heldMs !== undefined ? { heldMs } : {}),
    ...(exec.error !== undefined ? { errorMessage: exec.error.message } : {}),
  };
}

/** Executions in start order (envelope seq when present, start time otherwise). */
export function sampleFromRunState(run: RunState): RunSample {
  const executions: ExecutionSample[] = [];
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    for (const exec of node.executions) executions.push(toSample(node, exec));
  }
  executions.sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    return (a.startedTs ?? 0) - (b.startedTs ?? 0);
  });
  const status = run.meta.status === 'pending' ? 'running' : run.meta.status;
  return {
    runId: run.runId,
    app: run.meta.app,
    status,
    executions,
  };
}

/**
 * The LLM executions that ran inside waste-incident spans — what the loops
 * cost in model time. Seq-based like the report's own span numbers, so a
 * fixture without seqs prices nothing rather than guessing.
 */
export function wasteSpanExecutions(run: RunState, incidents: readonly WasteIncident[]): NodeExecution[] {
  const spans = incidents
    .filter((incident) => incident.firstSeq !== undefined && incident.lastSeq !== undefined)
    .map((incident) => [incident.firstSeq as number, incident.lastSeq as number] as const);
  if (spans.length === 0) return [];
  const out: NodeExecution[] = [];
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined || node.kind !== 'llm') continue;
    for (const exec of node.executions) {
      const seq = exec.seq;
      if (seq === undefined) continue;
      if (spans.some(([first, last]) => seq >= first && seq <= last)) out.push(exec);
    }
  }
  return out;
}
