/**
 * Node identity (decisions.md #1): `nodeId` is stable per LOGICAL node so the
 * canvas renders one node per code location; `instanceId` distinguishes
 * repeated executions.
 *
 * For an MCP server the logical nodes are the things you REGISTERED — one
 * node per tool, per resource (the registration, not the concrete URI, so a
 * templated resource stays one node), per prompt — plus the server session
 * itself and the one sampling node the server drives. The execution ids come
 * from the protocol: the JSON-RPC request id, namespaced by the connection so
 * two sessions on the same process can never collide (a client's ids restart
 * at 0 on every connection).
 */

export function serverNodeId(serverName: string): string {
  return `server:${serverName}`;
}

export function toolNodeId(toolName: string): string {
  return `tool:${toolName}`;
}

export function resourceNodeId(name: string): string {
  return `resource:${name}`;
}

export function promptNodeId(name: string): string {
  return `prompt:${name}`;
}

/** The one logical node for `sampling/createMessage` (server -> client LLM). */
export const SAMPLING_NODE_ID = 'llm:sampling';
export const SAMPLING_NODE_NAME = 'sampling';

const base = Math.random().toString(16).slice(2, 8);
let counter = 0;

/** Compact per-process unique id (connections, fallback instance ids). */
export function nextId(prefix: string): string {
  return `${prefix}_${base}_${(counter += 1)}`;
}
