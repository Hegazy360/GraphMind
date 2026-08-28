/**
 * Everything one wrapped MCP server knows about itself: its identity, the
 * surface it has registered (which becomes the `graph.hint` the viewer
 * pre-renders), the transport session it is attached to, and the helpers that
 * turn a request into node identity.
 *
 * The registry is built from the calls we intercept — `registerTool`,
 * `registerResource`, `registerPrompt`, and, on the low-level `Server` path,
 * the first request seen for a given tool/resource/prompt. Nothing here reads
 * the SDK's private registries; the one private peek in the codebase is the
 * server's own `{name, version}` (see sdk-types.readServerInfo), and it falls
 * back to the app name.
 */
import type { GraphNodeHint, NodeKind, RunContext } from '@graphmind-ai/client';
import type { AdapterCore } from './core.js';
import { SAMPLING_NODE_ID, SAMPLING_NODE_NAME, nextId, serverNodeId } from './ids.js';
import {
  isFunction,
  isObject,
  readServerInfo,
  requestIdString,
  type RequestHandlerExtraLike,
  type TransportLike,
} from './sdk-types.js';

/** Cap on distinct logical nodes remembered for `graph.hint`. */
const MAX_REGISTRY = 512;

export class ServerState {
  readonly serverName: string;
  readonly serverVersion: string | undefined;
  readonly nodeId: string;

  /** nodeId -> hint, in registration order. */
  private readonly registry = new Map<string, GraphNodeHint>();
  /** Distinguishes executions across connections (JSON-RPC ids restart at 0). */
  private connectionKey: string;
  private connections = 0;
  private sessionId: string | undefined;

  constructor(
    readonly core: AdapterCore,
    server: unknown,
    appName: string,
    override?: { name?: string | undefined; version?: string | undefined } | undefined,
  ) {
    const detected = readServerInfo(server);
    this.serverName = override?.name ?? detected.name ?? appName;
    this.serverVersion = override?.version ?? detected.version;
    this.nodeId = serverNodeId(this.serverName);
    this.connectionKey = nextId('conn');
  }

  /** Remember a logical node so `graph.hint` can pre-render it. */
  record(kind: NodeKind, name: string, nodeId: string): void {
    try {
      if (this.registry.has(nodeId)) return;
      if (this.registry.size >= MAX_REGISTRY) return;
      this.registry.set(nodeId, { nodeId, kind, name, parentId: this.nodeId });
    } catch {
      // never throw into the host
    }
  }

  /** Rename a logical node in place (a `RegisteredTool.update({name})`). */
  rename(kind: NodeKind, nodeId: string, newNodeId: string, newName: string): void {
    try {
      this.registry.delete(nodeId);
      this.record(kind, newName, newNodeId);
    } catch {
      // never throw into the host
    }
  }

  recordSampling(): void {
    this.record('llm', SAMPLING_NODE_NAME, SAMPLING_NODE_ID);
  }

  /** The static graph: the server session plus everything registered on it. */
  hintNodes(): GraphNodeHint[] {
    const server: GraphNodeHint = {
      nodeId: this.nodeId,
      kind: 'server',
      name: this.serverName,
    };
    return [server, ...this.registry.values()];
  }

  /**
   * A transport is live: pick up its session id and announce the graph, so the
   * viewer can draw the server and everything registered on it before the
   * first request arrives.
   *
   * The announcement gets its own tiny, immediately-finished run rather than
   * riding the session's implicit run — which would sit in the viewer's run
   * list as a nameless run stuck at "running" for the life of the process.
   */
  noteConnected(transport: unknown): void {
    try {
      this.connections += 1;
      this.connectionKey = nextId('conn');
      const sessionId = (transport as TransportLike | undefined)?.sessionId;
      this.sessionId = typeof sessionId === 'string' ? sessionId : undefined;
      const nodes = this.hintNodes();
      const key = `connect:${this.connections}`;
      void this.core.session
        .run(`mcp:connect ${this.serverName}`, () => {
          this.core.emitGraphHint(nodes, key);
        })
        .catch(() => undefined);
    } catch {
      // never throw into the host
    }
  }

  /**
   * Learn the transport session id from a request. Streamable HTTP mints it
   * during `initialize`, i.e. AFTER `connect()`, so the per-request `extra` is
   * the only reliable source; stdio and in-memory transports simply never set
   * one.
   */
  noteSessionId(sessionId: unknown): string | undefined {
    if (typeof sessionId === 'string' && sessionId.length > 0) this.sessionId = sessionId;
    return this.sessionId;
  }

  /** Session/connection metadata attached to the `server` node's input. */
  sessionInfo(sessionId: string | undefined): Record<string, unknown> {
    return {
      ...(this.serverVersion !== undefined ? { version: this.serverVersion } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }

  /**
   * One execution id per request. The JSON-RPC id is the natural choice, but
   * it restarts at 0 on every new client connection, so it is namespaced by
   * the transport session (or, failing that, by the connection this server is
   * currently serving).
   */
  instanceIdFor(requestId: unknown, sessionId: string | undefined): string {
    const id = requestIdString(requestId);
    return id === undefined ? nextId('req') : `${sessionId ?? this.connectionKey}:${id}`;
  }

  /**
   * The `extra` handed to the host's handler: a shallow copy (never a mutation
   * of the SDK's object) with the debugger's abort signal chained in and
   * `sendRequest` instrumented, so a `sampling/createMessage` issued from
   * inside the handler becomes a gated child node.
   */
  instrumentExtra(
    extra: RequestHandlerExtraLike,
    ctx: RunContext | undefined,
    parentNodeId: string,
    gateSampling: SamplingGate,
  ): RequestHandlerExtraLike {
    try {
      const out: RequestHandlerExtraLike = { ...extra };
      if (this.core.session.attached && ctx !== undefined) {
        const chained = this.core.chainSignal(extra.signal, ctx);
        if (chained !== undefined && chained !== extra.signal) out.signal = chained;
      }
      const send = extra.sendRequest;
      if (isFunction(send)) {
        out.sendRequest = async (
          request: unknown,
          resultSchema: unknown,
          options?: unknown,
        ): Promise<unknown> => {
          const method = isObject(request) ? request['method'] : undefined;
          const call = (): Promise<unknown> =>
            Promise.resolve(send(request, resultSchema, options) as unknown);
          if (method !== 'sampling/createMessage') return await call();
          const params = isObject(request) ? request['params'] : undefined;
          return await gateSampling(params, ctx, parentNodeId, call);
        };
      }
      return out;
    } catch {
      return extra;
    }
  }
}

/** Runs a sampling call through the gates. Implemented in wrap-server.ts. */
export type SamplingGate = (
  params: unknown,
  ctx: RunContext | undefined,
  parentId: string | undefined,
  invoke: () => Promise<unknown>,
) => Promise<unknown>;
