/**
 * The public entry point of @graphmind-ai/langgraph.
 *
 *   const gm = graphmind({ app: 'research-agent' });
 *   await graph.invoke(input, { callbacks: [gm.handler()] });
 *
 * Fail-open invariants (inherited from @graphmind-ai/client and enforced at
 * this layer too): a disabled session makes every wrapper an identity function
 * and every handler method a no-op; a detached session adds only buffered
 * events and fast-path gates; the adapter never throws into the host graph
 * (except the one abort it is asked to raise); a debugger that disconnects
 * mid-hold auto-continues every held gate.
 */
import { createRequire } from 'node:module';
import {
  createSession,
  isAbortError,
  toErrorInfo,
  type ReadyOptions,
  type RunContext,
  type SdkInfo,
  type Session,
  type SessionOptions,
} from '@graphmind-ai/client';
import { AdapterCore, type AbortMode, type ChainPolicy } from './core.js';
import { GraphMindCallbackHandler, type HandlerOptions } from './handler.js';
import { agentNodeId } from './ids.js';
import {
  gateFunction,
  wrapStructuredTool as wrapStructuredToolImpl,
  type GatedFunction,
  type StructuredToolLike,
} from './wrap-tools.js';

/**
 * The subset of LangChain's `RunnableConfig` this adapter reads and writes.
 * `gm.config()` accepts any config object and returns it widened with the
 * handler's `signal`, so the result stays assignable to whatever LangChain's
 * own (much larger) config type is in your version.
 */
export interface RunnableConfigLike {
  callbacks?: unknown;
  signal?: AbortSignal;
  configurable?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tags?: string[];
  runName?: string;
}

export interface GraphmindOptions extends Omit<SessionOptions, 'appName' | 'sdk'> {
  /** Application name shown in the viewer. Default: "langgraph-app". */
  app?: string;
  /** Override the reported SDK info. Default: the installed @langchain/core. */
  sdk?: SdkInfo;
  /** node.token batching interval per node in ms. Default 34 (~30/sec). */
  tokenFlushIntervalMs?: number;
  /**
   * Which chain runs become graph nodes. `all` (default) renders every chain
   * except LangGraph's own hidden internals; `langgraph` renders only the
   * graph and its named nodes; `none` renders only LLMs, tools and retrievers.
   */
  chains?: ChainPolicy;
  /**
   * Cap on the serialized size of any single `input`/`output` payload, in
   * characters. Larger values are sent as a truncated preview. Default 20000.
   */
  maxPayloadChars?: number;
  /**
   * Open a GraphMind run automatically for each root LangChain run that starts
   * outside `gm.run(...)`. Default true. Set false to attribute everything to
   * the session's implicit run instead.
   */
  autoRun?: boolean;
  /**
   * How an `abort` gate decision stops the graph. `throw` (default) raises an
   * AbortError-named error out of the callback, which LangChain propagates;
   * `signal` only cancels `gm.config()`'s abort signal, leaving the host in
   * control. See the README's capability matrix.
   */
  abortMode?: AbortMode;
  /**
   * Attach guarantee for the first execution: when `true` (default timeout,
   * 2000ms) or a number (timeout in ms), the first `gm.run()` / first root
   * chain / first wrapped tool call awaits `gm.ready()` before proceeding, so
   * the debugger's gates are armed from the very first event. Still fail-open:
   * on timeout execution continues detached.
   */
  waitForAttach?: boolean | number;
}

export interface Graphmind {
  /** The underlying GraphMind session (advanced: stats, custom events). */
  readonly session: Session;
  /**
   * Attach guarantee: force the lazy transport to connect now and resolve
   * `true` once the handshake completes (gates armed), `false` on timeout
   * (default 2000ms) or when GraphMind is disabled. Never throws.
   */
  ready(opts?: ReadyOptions): Promise<boolean>;
  /**
   * A fresh `BaseCallbackHandler` that maps the LangChain run tree onto
   * GraphMind nodes and holds execution at gates. Use ONE handler per
   * invocation: it carries that invocation's abort signal.
   */
  handler(options?: HandlerOptions): GraphMindCallbackHandler;
  /** `[gm.handler()]`, for `{ callbacks: gm.callbacks() }`. */
  callbacks(options?: HandlerOptions): GraphMindCallbackHandler[];
  /**
   * A ready-made LangChain config: a fresh handler in `callbacks` plus its
   * abort signal in `signal`, merged onto anything you pass in.
   *
   *   await graph.invoke(input, gm.config({ configurable: { thread_id } }));
   */
  config<C extends object = Record<string, never>>(
    base?: C,
    options?: HandlerOptions,
  ): C & { signal: AbortSignal };
  /**
   * Wrap a plain async function with the FULL gate set (before / after /
   * error, with inject, retry and abort). Identity when GraphMind is disabled.
   */
  tool<A extends unknown[], R>(name: string, fn: GatedFunction<A, R>): GatedFunction<A, R>;
  /**
   * Wrap a record (or array) of plain functions and/or LangChain tools with
   * the full gate set. Identity when GraphMind is disabled. Record keys become
   * node names; array entries use each tool's own `name`.
   */
  wrapTools<T>(tools: T): T;
  /**
   * Clone a LangChain `tool()` / StructuredTool with its executing function
   * gated, so `inject` and `retry` work for it. Identity when disabled.
   */
  wrapStructuredTool<T extends StructuredToolLike>(tool: T): T;
  /**
   * Explicit run boundary: groups everything `fn` does into one run, names the
   * agent node, and carries the AbortController the `abort` action uses. A
   * handler used inside `gm.run` joins this run instead of opening its own.
   */
  run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T>;
  /**
   * Pre-announce a compiled LangGraph's nodes so the viewer can render the
   * whole graph before anything executes. Call it BEFORE `graph.invoke(...)`:
   * the roster is remembered and emitted as the first event of every run this
   * adapter opens afterwards, so it still lands ahead of any node without
   * opening a run of its own to carry it. Called inside `gm.run(...)` it ships
   * into that run immediately (once). Safe to skip; safe to call twice.
   */
  hintGraph(graph: unknown): void;
  /** Release held gates, flush pending events, close the socket. Idempotent. */
  dispose(): Promise<void>;
}

function detectVersion(specifier: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(specifier) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a GraphMind adapter instance. Never throws; misconfiguration degrades
 * to a disabled session (see @graphmind-ai/client `createSession`).
 */
export function graphmind(options: GraphmindOptions = {}): Graphmind {
  const {
    app,
    sdk,
    tokenFlushIntervalMs,
    chains,
    maxPayloadChars,
    autoRun,
    abortMode,
    waitForAttach,
    ...sessionOptions
  } = options;

  const coreVersion = detectVersion('@langchain/core/package.json');
  const langgraphVersion = detectVersion('@langchain/langgraph/package.json');

  const session = createSession({
    ...sessionOptions,
    appName: app ?? 'langgraph-app',
    sdk: sdk ?? { name: 'langchain', version: coreVersion ?? 'unknown' },
    meta: {
      ...(langgraphVersion !== undefined ? { langgraph: langgraphVersion } : {}),
      ...options.meta,
    },
  });

  const core = new AdapterCore(session, {
    logger: options.logger,
    tokenFlushIntervalMs,
    chains,
    maxPayloadChars,
    autoRun,
    abortMode,
    waitForAttach,
  });

  // Handlers register themselves with the core only while a run is open, so a
  // server that builds one per request never accumulates them.
  const makeHandler = (handlerOptions?: HandlerOptions): GraphMindCallbackHandler =>
    new GraphMindCallbackHandler(core, handlerOptions ?? {});

  return {
    session,

    ready(opts?: ReadyOptions): Promise<boolean> {
      return session.ready(opts);
    },

    handler(handlerOptions?: HandlerOptions): GraphMindCallbackHandler {
      return makeHandler(handlerOptions);
    },

    callbacks(handlerOptions?: HandlerOptions): GraphMindCallbackHandler[] {
      return [makeHandler(handlerOptions)];
    },

    config<C extends object = Record<string, never>>(
      base?: C,
      handlerOptions?: HandlerOptions,
    ): C & { signal: AbortSignal } {
      const merged = { ...(base ?? {}) } as RunnableConfigLike;
      if (!session.enabled) return merged as C & { signal: AbortSignal };
      try {
        const handler = makeHandler(handlerOptions);
        merged.callbacks = appendCallback(merged.callbacks, handler, core);
        merged.signal =
          merged.signal === undefined
            ? handler.signal
            : AbortSignal.any([merged.signal, handler.signal]);
      } catch (error) {
        core.warner.warn(
          'config-failed',
          `gm.config() failed; returning the config uninstrumented (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
      return merged as C & { signal: AbortSignal };
    },

    tool<A extends unknown[], R>(name: string, fn: GatedFunction<A, R>): GatedFunction<A, R> {
      if (!session.enabled) return fn;
      try {
        return gateFunction(core, name, fn);
      } catch {
        return fn;
      }
    },

    wrapTools<T>(tools: T): T {
      if (!session.enabled) return tools;
      try {
        return wrapToolCollection(core, tools) as T;
      } catch (error) {
        core.warner.warn(
          'wrap-tools-failed',
          `wrapTools failed; returning the tools uninstrumented (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        return tools;
      }
    },

    wrapStructuredTool<T extends StructuredToolLike>(tool: T): T {
      if (!session.enabled) return tool;
      try {
        return wrapStructuredToolImpl(core, tool);
      } catch (error) {
        core.warner.warn(
          'wrap-structured-tool-failed',
          `wrapStructuredTool failed; returning the tool uninstrumented (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        return tool;
      }
    },

    async run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T> {
      const attachWait = core.maybeWaitForAttach();
      if (attachWait !== undefined) await attachWait;
      return session.run(name, async (ctx) => {
        const nodeId = agentNodeId(name);
        const startedAt = Date.now();
        core.startNode({ nodeId, kind: 'agent', name, instanceId: ctx.runId });
        try {
          const result = await fn(ctx);
          core.finishNode({
            nodeId,
            instanceId: ctx.runId,
            durationMs: Date.now() - startedAt,
            status: ctx.signal.aborted ? 'aborted' : 'ok',
          });
          return result;
        } catch (error) {
          const aborted = ctx.signal.aborted || isAbortError(error);
          if (!aborted) session.emit('node.error', { nodeId, instanceId: ctx.runId, error: toErrorInfo(error) });
          core.finishNode({
            nodeId,
            instanceId: ctx.runId,
            durationMs: Date.now() - startedAt,
            status: aborted ? 'aborted' : 'error',
          });
          throw error; // the host's own error — always propagates
        }
      });
    },

    hintGraph(graph: unknown): void {
      if (!session.enabled) return;
      try {
        const nodes = readGraphNodes(graph);
        if (nodes.length === 0) return;
        // Remembered so every run this adapter opens later is pre-rendered:
        // the documented call order is hintGraph() *before* graph.invoke(),
        // when no run exists yet (see AdapterCore.setGraphHint).
        core.setGraphHint(nodes);
        // Emits only when a run is already open (inside gm.run(...), or after
        // the graph has started). Outside one, `session.emit` would open the
        // session's implicit run just to carry the hint, which shows up in the
        // viewer as an empty placeholder run next to the real one; the roster
        // is delivered as the first event of the graph's own run instead.
        core.replayGraphHint();
      } catch (error) {
        core.warner.warn(
          'hint-graph-failed',
          `hintGraph() could not read the compiled graph; skipping the hint (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    },

    async dispose(): Promise<void> {
      for (const handler of [...core.openHandlers]) await handler.close();
      core.dispose();
      await session.dispose();
    },
  };
}

function appendCallback(existing: unknown, handler: unknown, core: AdapterCore): unknown {
  if (existing === undefined || existing === null) return [handler];
  if (Array.isArray(existing)) return [...existing, handler];
  const manager = existing as { copy?: unknown; addHandler?: unknown };
  if (typeof manager.copy === 'function' && typeof manager.addHandler === 'function') {
    const copy = (manager.copy as () => { addHandler: (h: unknown, inherit?: boolean) => void })();
    copy.addHandler(handler, true);
    return copy;
  }
  core.warner.warn(
    'config-callbacks',
    'gm.config() could not merge into the existing `callbacks` value; pass the handler yourself ' +
      'with { callbacks: [...yours, gm.handler()] }.',
  );
  return existing;
}

function wrapToolCollection(core: AdapterCore, tools: unknown): unknown {
  if (Array.isArray(tools)) return tools.map((entry) => wrapOne(core, undefined, entry));
  if (tools === null || typeof tools !== 'object') return tools;
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tools as Record<string, unknown>)) {
    wrapped[key] = wrapOne(core, key, value);
  }
  return wrapped;
}

function wrapOne(core: AdapterCore, key: string | undefined, value: unknown): unknown {
  if (typeof value === 'function') {
    const name = key ?? (typeof value.name === 'string' && value.name.length > 0 ? value.name : 'tool');
    return gateFunction(core, name, value as GatedFunction);
  }
  if (value !== null && typeof value === 'object') {
    const candidate = value as StructuredToolLike;
    if (typeof candidate.func === 'function' || typeof candidate.invoke === 'function') {
      return wrapStructuredToolImpl(core, candidate);
    }
  }
  return value;
}

/** Read `graph.getGraph().nodes` from a compiled LangGraph, duck-typed. */
function readGraphNodes(graph: unknown): { nodeId: string; kind: 'chain'; name: string }[] {
  const getGraph = (graph as { getGraph?: unknown } | null)?.getGraph;
  if (typeof getGraph !== 'function') return [];
  const drawable = (getGraph as () => { nodes?: unknown }).call(graph);
  const nodes = drawable?.nodes;
  if (nodes === null || typeof nodes !== 'object') return [];
  const hints: { nodeId: string; kind: 'chain'; name: string }[] = [];
  for (const entry of Object.values(nodes as Record<string, unknown>)) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (name === '__start__' || name === '__end__') continue;
    hints.push({ nodeId: `chain:${name}`, kind: 'chain', name });
  }
  return hints;
}
