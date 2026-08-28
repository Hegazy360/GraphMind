/**
 * The MCP protocol -> GraphMind graph mapping.
 *
 * Method names come from `@modelcontextprotocol/sdk` 1.30's `spec.types.ts`
 * (protocol revision 2025-11-25): `initialize`, `ping`, `tools/list`,
 * `tools/call`, `resources/list`, `resources/templates/list`,
 * `resources/read`, `resources/subscribe`, `resources/unsubscribe`,
 * `prompts/list`, `prompts/get`, `completion/complete`, `logging/setLevel`,
 * `sampling/createMessage`, `elicitation/create`, `roots/list`, `tasks/*`,
 * and the `notifications/*` family.
 *
 * Node identity follows decisions.md #1 — `nodeId` is stable per LOGICAL node
 * so the canvas shows one `tool:search` box that lights up on every call,
 * while `instanceId` separates the executions.
 */
import { basename } from 'node:path';
import type { NodeKind } from '@graphmind-ai/client';

/** The session node every request hangs off. */
export const SESSION_NODE_ID = 'mcp:session';

export interface MappedNode {
  nodeId: string;
  kind: NodeKind;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringParam(params: unknown, key: string): string | undefined {
  if (!isRecord(params)) return undefined;
  const value = params[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Map a JSON-RPC method (+ its params) onto a graph node.
 *
 * The three interesting cases get first-class kinds — a tool call is a tool,
 * a `resources/read` is a resource, a `prompts/get` is a prompt, and a
 * server-initiated `sampling/createMessage` is an LLM step. Everything else
 * (handshake, listings, pings, logging, tasks) becomes a `custom` node named
 * after its method, which keeps the protocol chatter visible without
 * pretending it is something it is not.
 */
export function mapMethod(method: string, params: unknown): MappedNode {
  switch (method) {
    case 'tools/call': {
      const name = stringParam(params, 'name') ?? 'unknown';
      return { nodeId: `tool:${name}`, kind: 'tool', name };
    }
    case 'resources/read': {
      const uri = stringParam(params, 'uri') ?? 'unknown';
      return { nodeId: `resource:${uri}`, kind: 'resource', name: uri };
    }
    case 'prompts/get': {
      const name = stringParam(params, 'name') ?? 'unknown';
      return { nodeId: `prompt:${name}`, kind: 'prompt', name };
    }
    case 'sampling/createMessage':
      // Named 'sampling', matching @graphmind-ai/mcp and the node id: the
      // full method already rides on the node's `method` field, and a card
      // reads better with the thing than with the RPC name.
      return { nodeId: 'llm:sampling', kind: 'llm', name: 'sampling' };
    default:
      return { nodeId: `mcp:${method}`, kind: 'custom', name: method };
  }
}

/** Which side of the pipe a frame came from. */
export type Direction = 'client-to-server' | 'server-to-client';

export function otherSide(direction: Direction): Direction {
  return direction === 'client-to-server' ? 'server-to-client' : 'client-to-server';
}

/** Short label used in stderr traces and node payloads. */
export function directionLabel(direction: Direction): string {
  return direction === 'client-to-server' ? 'client->server' : 'server->client';
}

/**
 * A display name for the proxied command, used as the run's `app` and as the
 * session node's name.
 *
 * Three deliberate choices, all because this string is what a developer scans
 * in a list of runs:
 *
 *  - the executable is shown by its basename (an MCP client launches
 *    `/Users/…/bin/node`, but the run is "node");
 *  - so is every argument that is a bare path, because an MCP client config
 *    holds absolute paths and `node …/node_modules/tsx/dist/cli.mjs
 *    …/src/server.ts` is 90 characters of noise around two useful words.
 *    Anything flag-shaped is left alone — `--config=/etc/x` means what it
 *    says, and the value may be the only thing distinguishing two runs;
 *  - what is still over-long is trimmed from the LEFT, since the
 *    distinguishing part of a command is its end.
 *
 * The untouched command and argv stay on the session node's `input`.
 */
export function commandLabel(command: string, args: readonly string[], max = 64): string {
  const base = basename(command);
  const shortArgs = args.map((arg) =>
    !arg.startsWith('-') && /[/\\]/.test(arg) ? basename(arg) : arg,
  );
  const full = [base === '' ? command : base, ...shortArgs].join(' ');
  if (full.length <= max) return full;
  return `…${full.slice(full.length - (max - 1))}`;
}
