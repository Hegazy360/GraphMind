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
/**
 * The synthetic node that parents protocol traffic (handshake, discovery,
 * keepalive, notifications). Opened folded — see `isWorkMethod` for the rule
 * that decides what goes under it.
 */
export const PROTOCOL_NODE_ID = 'mcp:protocol';
export const PROTOCOL_NODE_NAME = 'protocol';
/**
 * The error-badged child of `mcp:protocol` that records lines the server
 * wrote to stdout that are not JSON-RPC — plain text from a `console.log`,
 * or a structured logger's JSON — either corrupts the wire of a stdio
 * server. One logical node; one execution per recorded line.
 */
export const STDOUT_NOISE_NODE_ID = 'mcp:stdout-noise';
export const STDOUT_NOISE_NODE_NAME = 'stdout noise';

export interface MappedNode {
  nodeId: string;
  kind: NodeKind;
  name: string;
  /**
   * Where the node hangs: real work sits directly under the session node,
   * protocol traffic under `mcp:protocol`.
   */
  parentId: typeof SESSION_NODE_ID | typeof PROTOCOL_NODE_ID;
}

/**
 * THE rule for the session shape. A method is *work* — something the
 * connected model or user asked for — when it belongs to one of these
 * families:
 *
 *   tools/call, resources/read, prompts/get, sampling/createMessage,
 *   elicitation/*, completion/complete
 *
 * Everything else is *protocol*: `initialize`, `ping`, every listing
 * (`tools/list`, `resources/list`, `resources/templates/list`,
 * `prompts/list`, `roots/list`), subscriptions, `logging/setLevel`, `tasks/*`
 * and the whole `notifications/*` family. An UNKNOWN method is protocol too:
 * the work families are a closed, documented list, and a method this proxy
 * has never heard of is far more likely to be a new handshake/housekeeping
 * call than a new kind of user work. Either way it is still a node, still
 * gated, and never crashes the relay — it is only parented differently.
 */
export function isWorkMethod(method: string, direction?: Direction): boolean {
  switch (method) {
    case 'tools/call':
    case 'resources/read':
    case 'prompts/get':
    case 'completion/complete':
      // Only a client asks a server for work. The same name travelling the
      // other way — an echoing or hostile server — is not the agent's tool
      // call, and recording it as one would double-count it (and, since
      // 0.5.0, feed the loop hold a repeat the agent never made).
      return direction !== 'server-to-client';
    case 'sampling/createMessage':
      return direction !== 'client-to-server';
    default:
      return method.startsWith('elicitation/') && direction !== 'client-to-server';
  }
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
 * pretending it is something it is not — parented under `mcp:protocol` so
 * it does not bury the work (see `isWorkMethod`).
 */
export function mapMethod(method: string, params: unknown, direction?: Direction): MappedNode {
  if (direction !== undefined && !isWorkMethod(method, direction) && isWorkMethod(method)) {
    // A work-method name in the direction the protocol never sends it:
    // protocol traffic, parented under the fold, named by its method.
    return { nodeId: `mcp:${method}`, kind: 'custom', name: method, parentId: PROTOCOL_NODE_ID };
  }
  switch (method) {
    case 'tools/call': {
      const name = stringParam(params, 'name') ?? 'unknown';
      return { nodeId: `tool:${name}`, kind: 'tool', name, parentId: SESSION_NODE_ID };
    }
    case 'resources/read': {
      const uri = stringParam(params, 'uri') ?? 'unknown';
      return { nodeId: `resource:${uri}`, kind: 'resource', name: uri, parentId: SESSION_NODE_ID };
    }
    case 'prompts/get': {
      const name = stringParam(params, 'name') ?? 'unknown';
      return { nodeId: `prompt:${name}`, kind: 'prompt', name, parentId: SESSION_NODE_ID };
    }
    case 'sampling/createMessage':
      // Named 'sampling', matching @graphmind-ai/mcp and the node id: the
      // full method already rides on the node's `method` field, and a card
      // reads better with the thing than with the RPC name.
      return { nodeId: 'llm:sampling', kind: 'llm', name: 'sampling', parentId: SESSION_NODE_ID };
    default:
      return {
        nodeId: `mcp:${method}`,
        kind: 'custom',
        name: method,
        parentId: isWorkMethod(method, direction) ? SESSION_NODE_ID : PROTOCOL_NODE_ID,
      };
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
export function commandLabel(
  command: string,
  args: readonly string[],
  max = 64,
  hideArgs = false,
): string {
  const base = basename(command);
  const isPath = (arg: string): boolean => !arg.startsWith('-') && /[/\\]/.test(arg);
  // Under GRAPHMIND_HIDE_INPUTS the label is recorded as the app name, the
  // run name and the session node's name, so it keeps only what identifies
  // the server without carrying a value: basenames of file-path arguments
  // (`server.mjs`, `server-github`). Flags, flag values, URLs, `key=value`
  // and every other bare word are dropped — any of them can be a credential.
  const kept = hideArgs
    ? args.filter((arg) => isPath(arg) && !/:\/\/|[?=]/.test(arg))
    : args;
  const shortArgs = kept.map((arg) => (isPath(arg) ? basename(arg) : arg));
  const full = [base === '' ? command : base, ...shortArgs].join(' ');
  if (full.length <= max) return full;
  return `…${full.slice(full.length - (max - 1))}`;
}
