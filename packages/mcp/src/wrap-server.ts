/**
 * `gm.wrapServer(new McpServer(...))` — a Proxy of the host's server. The
 * object you pass in is never mutated, never re-created, and never has a
 * property written to it; only reads of the registration methods, `connect`
 * and `server` are redirected to instrumented views.
 *
 * What gets instrumented, and where the seam is:
 *
 *  - `registerTool` / `registerResource` / `registerPrompt` (and the
 *    deprecated `tool` / `resource` / `prompt` overloads): the callback you
 *    pass is decorated before the SDK ever sees it. The gate therefore sits
 *    INSIDE the request, after the SDK has routed and validated it and before
 *    a single line of your handler body runs — which is the whole reason to
 *    instrument in-process rather than proxy the protocol from outside.
 *  - `server.setRequestHandler(...)` on the low-level `Server`: the same
 *    treatment for `tools/call`, `resources/read` and `prompts/get`. Any other
 *    method is forwarded with one extra function call and nothing else.
 *  - `server.createMessage(...)` and the `extra.sendRequest` given to your
 *    handler: a `sampling/createMessage` becomes a gated `llm` node nested
 *    under the request that issued it.
 *  - `connect(transport)`: the session's `graph.hint`, so the viewer can draw
 *    the server and its whole surface before the first request arrives.
 *
 * Everything else is forwarded to the real object, with methods bound to it
 * (the SDK's classes use private fields, which throw when a method runs with a
 * Proxy as its receiver).
 */
import {
  isAbortError,
  type NodeKind,
  type RunContext,
  type RunStatus,
} from '@graphmind-ai/client';
import { coerceInjected } from './coerce.js';
import type { AdapterCore } from './core.js';
import { gateFlow } from './gate-flow.js';
import {
  SAMPLING_NODE_ID,
  SAMPLING_NODE_NAME,
  nextId,
  promptNodeId,
  resourceNodeId,
  toolNodeId,
} from './ids.js';
import { ServerState } from './server-state.js';
import {
  isFunction,
  isHandlerExtra,
  isObject,
  type AnyFn,
  type RequestHandlerExtraLike,
} from './sdk-types.js';

/** Marks a Proxy we made, so wrapping twice is a no-op instead of a double gate. */
const WRAPPED = Symbol.for('graphmind.mcp.wrapped');

type RequestShape = 'tool' | 'resource' | 'prompt';

/** Registration methods and the node kind each one produces. */
const REGISTRARS = new Map<string, RequestShape>([
  ['registerTool', 'tool'],
  ['tool', 'tool'],
  ['registerResource', 'resource'],
  ['resource', 'resource'],
  ['registerPrompt', 'prompt'],
  ['prompt', 'prompt'],
]);

/** A registered node's current identity — mutable, because `update()` renames. */
interface NameRef {
  name: string;
  nodeId: string;
}

interface RequestDescriptor {
  shape: RequestShape;
  kind: NodeKind;
  nodeId: string;
  name: string;
  method: string;
  runName: string;
  input: unknown;
  uri?: string | undefined;
}

export interface WrapServerOptions {
  /** Override the name/version shown on the `server` node. */
  server?: { name?: string | undefined; version?: string | undefined } | undefined;
  /** The `app` name, used when the server's own name cannot be read. */
  appName: string;
}

/**
 * Wrap an `McpServer` or a low-level `Server`. Returns a Proxy; the input is
 * untouched. An unrecognised object is returned unchanged with one warning —
 * an unfamiliar peer must never break the host's server.
 */
export function wrapServer<T extends object>(
  server: T,
  core: AdapterCore,
  options: WrapServerOptions,
): T {
  if ((server as Record<PropertyKey, unknown>)[WRAPPED] === true) return server;
  const state = new ServerState(core, server, options.appName, options.server);
  const record = server as unknown as Record<string, unknown>;
  if (isFunction(record['registerTool']) || isFunction(record['tool'])) {
    return wrapMcpServer(server, state);
  }
  if (isFunction(record['setRequestHandler'])) {
    return wrapProtocolServer(server, state);
  }
  core.warner.warn(
    'unknown-server',
    'wrapServer received an object that is neither an McpServer nor a Server (no registerTool / setRequestHandler); returning it uninstrumented',
  );
  return server;
}

// -- the high-level McpServer ------------------------------------------------

function wrapMcpServer<T extends object>(target: T, state: ServerState): T {
  const bound = new Map<PropertyKey, unknown>();
  const views = new Map<PropertyKey, unknown>();

  return new Proxy(target, {
    get(t, prop): unknown {
      if (prop === WRAPPED) return true;

      if (prop === 'server') {
        return memo(views, prop, () => {
          const real = Reflect.get(t, prop, t) as unknown;
          return isObject(real) ? wrapProtocolServer(real, state) : real;
        });
      }

      if (prop === 'connect') {
        const original = Reflect.get(t, prop, t) as unknown;
        if (!isFunction(original)) return original;
        return memo(views, prop, () => makeConnect(t, original, state));
      }

      const shape = typeof prop === 'string' ? REGISTRARS.get(prop) : undefined;
      if (shape !== undefined) {
        const original = Reflect.get(t, prop, t) as unknown;
        if (!isFunction(original)) return original;
        return memo(views, prop, () => makeRegistrar(t, original, shape, state));
      }

      return forward(t, prop, bound);
    },
    set(t, prop, value): boolean {
      return Reflect.set(t, prop, value, t);
    },
  }) as T;
}

/**
 * One interceptor for all six registration overloads. Every one of them takes
 * the node's name first and its callback last, so the wrapper does not have to
 * know which overload it is looking at: swap the last function argument, keep
 * everything else byte-identical, hand the result to the SDK.
 */
function makeRegistrar(
  target: object,
  original: AnyFn,
  shape: RequestShape,
  state: ServerState,
): AnyFn {
  return (...args: unknown[]): unknown => {
    let callArgs = args;
    let ref: NameRef | undefined;

    try {
      const name = typeof args[0] === 'string' ? args[0] : undefined;
      let callbackIndex = -1;
      for (let i = args.length - 1; i > 0; i -= 1) {
        if (isFunction(args[i])) {
          callbackIndex = i;
          break;
        }
      }
      if (name !== undefined && callbackIndex > 0) {
        ref = { name, nodeId: nodeIdFor(shape, name) };
        state.record(shape, name, ref.nodeId);
        const next = [...args];
        next[callbackIndex] = wrapHandlerCallback(args[callbackIndex] as AnyFn, shape, ref, state);
        callArgs = next;
      }
    } catch (error) {
      // Instrumentation prep must never break a registration.
      state.core.warner.warn(
        'registration-failed',
        `could not instrument a ${shape} registration; it is registered uninstrumented (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      callArgs = args;
      ref = undefined;
    }

    // Outside the try: a throw from the SDK itself (duplicate name, bad
    // schema) is the host's error and must surface exactly once.
    const registration = original.apply(target, callArgs);
    if (ref === undefined || !isObject(registration)) return registration;
    try {
      return wrapRegistration(registration, shape, ref, state);
    } catch {
      return registration;
    }
  };
}

/**
 * `RegisteredTool` / `RegisteredResource` / `RegisteredPrompt`: the one method
 * that matters is `update()`, which can swap the callback (which would drop
 * instrumentation) or rename the node (which would leave the graph stale).
 */
function wrapRegistration<R extends object>(
  registration: R,
  shape: RequestShape,
  ref: NameRef,
  state: ServerState,
): R {
  const bound = new Map<PropertyKey, unknown>();
  let updateView: unknown;

  return new Proxy(registration, {
    get(t, prop): unknown {
      if (prop === WRAPPED) return true;
      if (prop !== 'update') return forward(t, prop, bound);
      const original = Reflect.get(t, prop, t) as unknown;
      if (!isFunction(original)) return original;
      if (updateView !== undefined) return updateView;
      updateView = (updates: unknown): unknown => {
        if (!isObject(updates)) return original.call(t, updates);
        let next: Record<string, unknown> = updates;
        try {
          next = { ...updates };
          if (typeof next['name'] === 'string') {
            const newNodeId = nodeIdFor(shape, next['name']);
            state.rename(shape, ref.nodeId, newNodeId, next['name']);
            ref.name = next['name'];
            ref.nodeId = newNodeId;
          }
          const callback = next['callback'];
          if (isFunction(callback)) {
            next['callback'] = wrapHandlerCallback(callback, shape, ref, state);
          }
        } catch {
          next = updates;
        }
        return original.call(t, next);
      };
      return updateView;
    },
    set(t, prop, value): boolean {
      return Reflect.set(t, prop, value, t);
    },
  }) as R;
}

/**
 * The decorated handler the SDK will call. Every MCP callback signature —
 * `(args, extra)`, `(extra)`, `(uri, extra)`, `(uri, variables, extra)` — puts
 * the `RequestHandlerExtra` last, so the wrapper reads the trailing argument
 * and leaves the rest of the call exactly as the SDK built it.
 */
function wrapHandlerCallback(
  original: AnyFn,
  shape: RequestShape,
  ref: NameRef,
  state: ServerState,
): AnyFn {
  return async function graphmindHandler(this: unknown, ...args: unknown[]): Promise<unknown> {
    let plan: { descriptor: RequestDescriptor; extra: RequestHandlerExtraLike | undefined } | undefined;
    try {
      const last = args.length > 0 ? args[args.length - 1] : undefined;
      const extra = isHandlerExtra(last) ? last : undefined;
      const handlerArgs = extra === undefined ? args : args.slice(0, args.length - 1);
      plan = { descriptor: describeCallback(shape, ref, handlerArgs), extra };
    } catch {
      plan = undefined;
    }
    if (plan === undefined) return await original.apply(this, args);

    const { descriptor, extra } = plan;
    const self = this;
    return await runInstrumentedRequest(state, descriptor, extra, (nextExtra) => {
      const callArgs =
        extra === undefined ? args : [...args.slice(0, args.length - 1), nextExtra];
      return original.apply(self, callArgs);
    });
  };
}

// -- the low-level Server (and McpServer's `.server`) ------------------------

function wrapProtocolServer<T extends object>(target: T, state: ServerState): T {
  const bound = new Map<PropertyKey, unknown>();
  const views = new Map<PropertyKey, unknown>();

  return new Proxy(target, {
    get(t, prop): unknown {
      if (prop === WRAPPED) return true;

      if (prop === 'setRequestHandler' || prop === 'connect' || prop === 'createMessage') {
        const original = Reflect.get(t, prop, t) as unknown;
        if (!isFunction(original)) return original;
        return memo(views, prop, () => {
          if (prop === 'setRequestHandler') return makeSetRequestHandler(t, original, state);
          if (prop === 'connect') return makeConnect(t, original, state);
          return makeCreateMessage(t, original, state);
        });
      }

      return forward(t, prop, bound);
    },
    set(t, prop, value): boolean {
      return Reflect.set(t, prop, value, t);
    },
  }) as T;
}

function makeSetRequestHandler(target: object, original: AnyFn, state: ServerState): AnyFn {
  return (...args: unknown[]): unknown => {
    const handler = args[1];
    if (args.length < 2 || !isFunction(handler)) return original.apply(target, args);

    const wrapped = async function graphmindRequestHandler(
      this: unknown,
      request: unknown,
      extra: unknown,
    ): Promise<unknown> {
      let descriptor: RequestDescriptor | undefined;
      try {
        descriptor = describeRequest(request);
      } catch {
        descriptor = undefined;
      }
      // Methods this adapter does not model (tools/list, initialize, ping, ...)
      // cost exactly one extra function call.
      if (descriptor === undefined) return await handler.call(this, request, extra);

      const self = this;
      return await runInstrumentedRequest(
        state,
        descriptor,
        isHandlerExtra(extra) ? extra : undefined,
        (nextExtra) => handler.call(self, request, nextExtra ?? extra),
      );
    };

    return original.apply(target, [args[0], wrapped, ...args.slice(2)]);
  };
}

function makeConnect(target: object, original: AnyFn, state: ServerState): AnyFn {
  return async (...args: unknown[]): Promise<unknown> => {
    const wait = state.core.maybeWaitForAttach();
    if (wait !== undefined) await wait;
    const result = await (original.apply(target, args) as Promise<unknown>);
    state.noteConnected(args[0]);
    return result;
  };
}

function makeCreateMessage(target: object, original: AnyFn, state: ServerState): AnyFn {
  return (...args: unknown[]): Promise<unknown> => {
    const ctx = state.core.session.currentRun();
    const parentId = state.core.parentFor(ctx);
    const options = prepareRequestOptions(state, args[1], ctx);
    return gateSampling(state, args[0], ctx, parentId, () =>
      Promise.resolve(original.apply(target, [args[0], options, ...args.slice(2)]) as unknown),
    );
  };
}

/** Chain the debugger's abort signal into an outgoing request's options. */
function prepareRequestOptions(
  state: ServerState,
  options: unknown,
  ctx: RunContext | undefined,
): unknown {
  try {
    if (!state.core.session.attached || ctx === undefined) return options;
    const current = isObject(options) ? (options['signal'] as AbortSignal | undefined) : undefined;
    const chained = state.core.chainSignal(current, ctx);
    if (chained === undefined || chained === current) return options;
    return { ...(isObject(options) ? options : {}), signal: chained };
  } catch {
    return options;
  }
}

// -- the shared request path -------------------------------------------------

/**
 * One incoming request = one run (unless the caller already opened one), a
 * `server` node for the session that is handling it, and the tool / resource /
 * prompt node underneath, gated.
 */
async function runInstrumentedRequest(
  state: ServerState,
  descriptor: RequestDescriptor,
  extra: RequestHandlerExtraLike | undefined,
  invoke: (extra: RequestHandlerExtraLike | undefined) => unknown,
): Promise<unknown> {
  const core = state.core;
  const wait = core.maybeWaitForAttach();
  if (wait !== undefined) await wait;

  state.record(descriptor.kind, descriptor.name, descriptor.nodeId);
  const sessionId = state.noteSessionId(extra?.sessionId);
  const instanceId = state.instanceIdFor(extra?.requestId, sessionId);

  return await core.withRun(descriptor.runName, async (ctx) => {
    core.emitGraphHint(state.hintNodes(), ctx?.runId ?? 'no-run');

    const serverStartedAt = Date.now();
    core.startNode({
      nodeId: state.nodeId,
      kind: 'server',
      name: state.serverName,
      instanceId,
      input: { method: descriptor.method, ...state.sessionInfo(sessionId) },
    });
    core.setParent(ctx, descriptor.nodeId);

    const handlerExtra =
      extra === undefined
        ? undefined
        : state.instrumentExtra(extra, ctx, descriptor.nodeId, (params, sctx, parentId, call) =>
            gateSampling(state, params, sctx, parentId, call),
          );

    let status: RunStatus = 'ok';
    try {
      return await gateFlow({
        core,
        ctx,
        node: { nodeId: descriptor.nodeId, kind: descriptor.kind, name: descriptor.name },
        instanceId,
        parentId: state.nodeId,
        input: descriptor.input,
        invoke: () => invoke(handlerExtra),
        coerce: (value) => coerceInjected(descriptor.shape, value, descriptor.uri),
      });
    } catch (error) {
      status = ctx?.signal.aborted === true || isAbortError(error) ? 'aborted' : 'error';
      throw error; // the host's own error — always propagates
    } finally {
      core.clearParent(ctx, descriptor.nodeId);
      core.finishNode({
        nodeId: state.nodeId,
        instanceId,
        output: undefined,
        durationMs: Date.now() - serverStartedAt,
        status,
        extra: { method: descriptor.method },
      });
    }
  });
}

/** `sampling/createMessage`: an `llm` node, gated like any other. */
function gateSampling(
  state: ServerState,
  params: unknown,
  ctx: RunContext | undefined,
  parentId: string | undefined,
  invoke: () => Promise<unknown>,
): Promise<unknown> {
  state.recordSampling();
  return gateFlow({
    core: state.core,
    ctx,
    node: { nodeId: SAMPLING_NODE_ID, kind: 'llm', name: SAMPLING_NODE_NAME },
    instanceId: nextId('sampling'),
    parentId,
    input: params,
    invoke,
    coerce: (value) => coerceInjected('sampling', value),
  });
}

// -- descriptors -------------------------------------------------------------

function nodeIdFor(shape: RequestShape, name: string): string {
  if (shape === 'tool') return toolNodeId(name);
  if (shape === 'resource') return resourceNodeId(name);
  return promptNodeId(name);
}

/** Node identity for a callback registered through the high-level API. */
function describeCallback(
  shape: RequestShape,
  ref: NameRef,
  handlerArgs: unknown[],
): RequestDescriptor {
  if (shape === 'resource') {
    // `(uri: URL, extra)` or `(uri: URL, variables, extra)`. A URL serializes
    // to `{}`, so it is stringified before it can reach the wire.
    const uri = handlerArgs.length > 0 ? String(handlerArgs[0]) : '';
    const variables = handlerArgs.length > 1 ? handlerArgs[1] : undefined;
    return {
      shape,
      kind: 'resource',
      nodeId: ref.nodeId,
      name: ref.name,
      method: 'resources/read',
      runName: `resources/read:${ref.name}`,
      input: { uri, ...(variables !== undefined ? { variables } : {}) },
      uri,
    };
  }
  const input = handlerArgs.length > 0 ? handlerArgs[0] : undefined;
  if (shape === 'prompt') {
    return {
      shape,
      kind: 'prompt',
      nodeId: ref.nodeId,
      name: ref.name,
      method: 'prompts/get',
      runName: `prompts/get:${ref.name}`,
      input,
    };
  }
  return {
    shape,
    kind: 'tool',
    nodeId: ref.nodeId,
    name: ref.name,
    method: 'tools/call',
    runName: `tools/call:${ref.name}`,
    input,
  };
}

/**
 * Node identity for a raw request arriving at a low-level `setRequestHandler`.
 * Only the three request kinds this adapter models are described; everything
 * else returns undefined and is forwarded untouched.
 *
 * A resource read has no registration to name it here, so the URI IS the
 * logical node — the one place where the low-level path is coarser than the
 * high-level one (which keeps a templated resource as a single node).
 */
function describeRequest(request: unknown): RequestDescriptor | undefined {
  if (!isObject(request)) return undefined;
  const method = request['method'];
  const params = isObject(request['params']) ? request['params'] : {};

  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? params['name'] : undefined;
    if (name === undefined) return undefined;
    return {
      shape: 'tool',
      kind: 'tool',
      nodeId: toolNodeId(name),
      name,
      method,
      runName: `tools/call:${name}`,
      input: params['arguments'],
    };
  }

  if (method === 'prompts/get') {
    const name = typeof params['name'] === 'string' ? params['name'] : undefined;
    if (name === undefined) return undefined;
    return {
      shape: 'prompt',
      kind: 'prompt',
      nodeId: promptNodeId(name),
      name,
      method,
      runName: `prompts/get:${name}`,
      input: params['arguments'],
    };
  }

  if (method === 'resources/read') {
    const uri = typeof params['uri'] === 'string' ? params['uri'] : undefined;
    if (uri === undefined) return undefined;
    return {
      shape: 'resource',
      kind: 'resource',
      nodeId: resourceNodeId(uri),
      name: uri,
      method,
      runName: `resources/read:${uri}`,
      input: { uri },
      uri,
    };
  }

  return undefined;
}

// -- proxy plumbing ----------------------------------------------------------

function memo(cache: Map<PropertyKey, unknown>, key: PropertyKey, make: () => unknown): unknown {
  if (cache.has(key)) return cache.get(key);
  const value = make();
  cache.set(key, value);
  return value;
}

/**
 * Forward a property read to the real object. Methods are bound to it (and
 * cached, so identity is stable) — the SDK's classes use private fields, which
 * throw when a method runs with a Proxy as its receiver.
 */
function forward(target: object, prop: PropertyKey, bound: Map<PropertyKey, unknown>): unknown {
  const value = Reflect.get(target, prop, target) as unknown;
  if (typeof value !== 'function') return value;
  const cached = bound.get(prop);
  if (cached !== undefined) return cached;
  const fn = (value as AnyFn).bind(target);
  bound.set(prop, fn);
  return fn;
}
