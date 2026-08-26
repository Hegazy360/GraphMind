/**
 * Node identity (decisions.md #1): `nodeId` is stable per LOGICAL node so the
 * canvas renders one node per code location; `instanceId` distinguishes
 * repeated executions (tool call id, invocation step index).
 *
 * Both OpenAI APIs (`chat.completions` and `responses`) map onto the SAME
 * logical LLM node — an app that migrates from one to the other keeps its
 * graph — and the concrete API is reported as a field on the node payload.
 */

/** The one logical LLM node of an OpenAI agent loop. */
export const LLM_NODE_ID = 'llm:step';
export const LLM_NODE_NAME = 'step';

export function toolNodeId(toolName: string): string {
  return `tool:${toolName}`;
}

export function agentNodeId(runName: string): string {
  return `agent:${runName}`;
}

const base = Math.random().toString(16).slice(2, 8);
let counter = 0;

/** Compact per-process unique id (invocations, fallback instance ids). */
export function nextId(prefix: string): string {
  return `${prefix}_${base}_${(counter += 1)}`;
}
