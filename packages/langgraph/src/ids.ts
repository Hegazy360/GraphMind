/**
 * Node identity (decisions.md #1): `nodeId` is stable per LOGICAL node so the
 * canvas renders one node per code location; `instanceId` distinguishes
 * repeated executions.
 *
 * For LangChain / LangGraph the logical node is the *name* of the run:
 * a LangGraph node name (`metadata.langgraph_node`), a runnable's `runName`,
 * or the last segment of its serialized `lc_id`. `instanceId` is LangChain's
 * own run id (a uuid), which is unique per execution and is exactly what the
 * schema's `instanceId` is for.
 */
import type { NodeKind } from '@graphmind-ai/client';

export function agentNodeId(name: string): string {
  return `agent:${name}`;
}

export function chainNodeId(name: string): string {
  return `chain:${name}`;
}

export function llmNodeId(name: string): string {
  return `llm:${name}`;
}

export function toolNodeId(name: string): string {
  return `tool:${name}`;
}

export function retrieverNodeId(name: string): string {
  return `retriever:${name}`;
}

export function nodeIdFor(kind: NodeKind, name: string): string {
  switch (kind) {
    case 'agent':
      return agentNodeId(name);
    case 'chain':
      return chainNodeId(name);
    case 'llm':
      return llmNodeId(name);
    case 'tool':
      return toolNodeId(name);
    case 'retriever':
      return retrieverNodeId(name);
    default:
      return `custom:${name}`;
  }
}

const base = Math.random().toString(16).slice(2, 8);
let counter = 0;

/** Compact per-process unique id (fallback instance ids). */
export function nextId(prefix: string): string {
  return `${prefix}_${base}_${(counter += 1)}`;
}
