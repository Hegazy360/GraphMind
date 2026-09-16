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
  detectSdkGeneration,
  isFunction,
  isHandlerContext,
  isObject,
  readServerInfo,
  requestIdString,
  type RequestContextLike,
  type RequestHandlerExtraLike,
  type RequestTrailer,
  type TransportLike,
} from './sdk-types.js';

/** The npm package each SDK generation ships its server in. */
const SDK_PACKAGE: Record<1 | 2, string> = {
  1: '@modelcontextprotocol/sdk',
  2: '@modelcontextprotocol/server',
};

/** Cap on distinct logical nodes remembered for `graph.hint`. */
const MAX_REGISTRY = 512;

export class ServerState {
  readonly serverName: string;
  readonly serverVersion: string | undefined;
  readonly nodeId: string;
  /** Which SDK package the wrapped object structurally belongs to, if it can be told. */
  readonly sdkPackage: string | undefined;

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
    const generation = detectSdkGeneration(server);
    this.sdkPackage = generation === undefined ? undefined : SDK_PACKAGE[generation];
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

  /**
   * Session/connection metadata attached to the `server` node's input. The
   * `sdk` field names the package THIS object came from — the session-level
   * badge can only say which package is installed, and a migration has both.
   */
  sessionInfo(sessionId: string | undefined): Record<string, unknown> {
    return {
      ...(this.serverVersion !== undefined ? { version: this.serverVersion } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(this.sdkPackage !== undefined ? { sdk: this.sdkPackage } : {}),
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
   * The trailing argument handed to the host's handler, instrumented: a
   * shallow copy (never a mutation of the SDK's object) with the debugger's
   * abort signal chained in and the outbound-request hooks wrapped, so a
   * `sampling/createMessage` issued from inside the handler becomes a gated
   * child node. Dispatches on shape: the 1.x `RequestHandlerExtra` or the
   * 2.x context (`ctx.mcpReq`).
   */
  instrumentTrailer(
    trailer: RequestTrailer,
    ctx: RunContext | undefined,
    parentNodeId: string,
    gateSampling: SamplingGate,
  ): RequestTrailer {
    return isHandlerContext(trailer)
      ? this.instrumentContext(trailer, ctx, parentNodeId, gateSampling)
      : this.instrumentExtra(trailer, ctx, parentNodeId, gateSampling);
  }

  /**
   * `@modelcontextprotocol/server` 2.x: `{ ...ctx, mcpReq: { ...ctx.mcpReq } }`
   * with `signal` chained and both ways a handler can ask the client's LLM —
   * `ctx.mcpReq.requestSampling(params)` and
   * `ctx.mcpReq.send({ method: 'sampling/createMessage' })` — routed through
   * the sampling gate. `mcpReq`'s members are closures (not methods relying
   * on `this`), which is what makes the copy safe; they are still invoked
   * with the original `mcpReq` as receiver, belt and braces.
   */
  instrumentContext(
    context: RequestContextLike,
    ctx: RunContext | undefined,
    parentNodeId: string,
    gateSampling: SamplingGate,
  ): RequestContextLike {
    try {
      const req = context.mcpReq;
      const nextReq = { ...req };
      if (this.core.session.attached && ctx !== undefined) {
        const chained = this.core.chainSignal(req.signal, ctx);
        if (chained !== undefined && chained !== req.signal) nextReq.signal = chained;
      }
      const requestSampling = req.requestSampling;
      if (isFunction(requestSampling)) {
        nextReq.requestSampling = async (params: unknown, options?: unknown): Promise<unknown> =>
          await gateSampling(params, ctx, parentNodeId, () =>
            Promise.resolve(requestSampling.call(req, params, this.chainOptions(options, ctx)) as unknown),
          );
      }
      const send = req.send;
      if (isFunction(send)) {
        nextReq.send = async (
          request: unknown,
          schemaOrOptions?: unknown,
          maybeOptions?: unknown,
        ): Promise<unknown> => {
          const method = isObject(request) ? request['method'] : undefined;
          const call = (): Promise<unknown> =>
            Promise.resolve(send.call(req, request, schemaOrOptions, maybeOptions) as unknown);
          if (method !== 'sampling/createMessage') return await call();
          const params = isObject(request) ? request['params'] : undefined;
          return await gateSampling(params, ctx, parentNodeId, call);
        };
      }
      return { ...context, mcpReq: nextReq };
    } catch {
      return context;
    }
  }

  /** Chain the debugger's signal into an outgoing request's `options.signal` (attached only). */
  private chainOptions(options: unknown, ctx: RunContext | undefined): unknown {
    try {
      if (!this.core.session.attached || ctx === undefined) return options;
      const current = isObject(options) ? (options['signal'] as AbortSignal | undefined) : undefined;
      const chained = this.core.chainSignal(current, ctx);
      if (chained === undefined || chained === current) return options;
      return { ...(isObject(options) ? options : {}), signal: chained };
    } catch {
      return options;
    }
  }

  /**
   * `@modelcontextprotocol/sdk` 1.x: the `extra` handed to the host's handler,
   * with the debugger's abort signal chained in and `sendRequest`
   * instrumented.
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
