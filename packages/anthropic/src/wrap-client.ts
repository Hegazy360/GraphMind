/**
 * `gm.wrapClient(new Anthropic())` — a Proxy of the host's client. The user's
 * client object is never mutated and never re-created; only reads of
 * `messages` (and `beta.messages`) are redirected to instrumented views, and
 * only `create` / `stream` on those are instrumented.
 *
 * Per `messages.create` call:
 *  1. `node.started` (kind `llm`, nodeId `llm:step`, one `instanceId` per call)
 *     plus `graph.hint` on the first step of an invocation.
 *  2. `await session.gate('before', ...)` — awaited BEFORE the SDK method is
 *     called, so a held gate has NOTHING in flight. This is the core
 *     guarantee, and it is why the return value is a stand-in for the SDK's
 *     `APIPromise` (see api-promise.ts) rather than the real one.
 *  3. The result is observed: a `Message` is reported directly; a
 *     `Stream` is returned as a delegating Proxy that tees token deltas.
 *
 * `messages.stream()` (the `MessageStream` helper) is not instrumented
 * directly. It is invoked with the INSTRUMENTED `messages` object as its
 * receiver, so the `messages.create({...params, stream: true})` it performs
 * internally is the gated one — the helper keeps all of its own behavior
 * (events, `finalMessage()`, `abort()`), and its request is still held at the
 * gate before anything reaches the network.
 */
import type { GateNode, RunContext } from '@graphmind-ai/client';
import { gatedApiPromise } from './api-promise.js';
import type { AdapterCore } from './core.js';
import { LLM_NODE_ID, LLM_NODE_NAME, agentNodeId } from './ids.js';
import { StepReporter, observeMessage, observeStream } from './observe.js';
import type {
  ApiPromiseLike,
  MessageCreateParamsLike,
  MessageLike,
  RequestOptionsLike,
} from './sdk-types.js';

const LLM_GATE_NODE: GateNode = { nodeId: LLM_NODE_ID, kind: 'llm', name: LLM_NODE_NAME };

type CreateFn = (
  params: MessageCreateParamsLike,
  options?: RequestOptionsLike,
) => ApiPromiseLike<unknown>;

type StreamFn = (body: MessageCreateParamsLike, options?: RequestOptionsLike) => unknown;

/** Wrap an Anthropic client. Returns a Proxy; the input is untouched. */
export function wrapClient<T extends object>(client: T, core: AdapterCore): T {
  const bound = new Map<PropertyKey, unknown>();
  const wrapped = new Map<PropertyKey, unknown>();

  return new Proxy(client, {
    get(target, prop): unknown {
      if (prop === 'messages' || prop === 'beta') {
        const cached = wrapped.get(prop);
        if (cached !== undefined) return cached;
        const value = Reflect.get(target, prop, target) as unknown;
        if (value === null || typeof value !== 'object') return value;
        const view =
          prop === 'messages'
            ? wrapMessages(value as object, core)
            : wrapBeta(value as object, core);
        wrapped.set(prop, view);
        return view;
      }
      return forward(target, prop, bound);
    },
  }) as T;
}

/** `client.beta` — only its `messages` resource is instrumented. */
function wrapBeta<B extends object>(beta: B, core: AdapterCore): B {
  const bound = new Map<PropertyKey, unknown>();
  let messagesView: unknown;
  return new Proxy(beta, {
    get(target, prop): unknown {
      if (prop === 'messages') {
        if (messagesView !== undefined) return messagesView;
        const value = Reflect.get(target, prop, target) as unknown;
        if (value === null || typeof value !== 'object') return value;
        messagesView = wrapMessages(value as object, core);
        return messagesView;
      }
      return forward(target, prop, bound);
    },
  }) as B;
}

function wrapMessages<M extends object>(messages: M, core: AdapterCore): M {
  const bound = new Map<PropertyKey, unknown>();
  const originalCreate = Reflect.get(messages, 'create', messages) as unknown;
  const originalStream = Reflect.get(messages, 'stream', messages) as unknown;

  let proxy: M | undefined;

  const create: CreateFn | undefined =
    typeof originalCreate === 'function'
      ? (params, options) =>
          instrumentedCreate(core, messages, originalCreate as CreateFn, params, options)
      : undefined;

  // Delegate with the INSTRUMENTED receiver: MessageStream calls
  // `messages.create(...).withResponse()` internally, which routes the helper
  // through the same gate as a plain create.
  const stream: StreamFn | undefined =
    typeof originalStream === 'function'
      ? (body, options) =>
          (originalStream as StreamFn).call(proxy ?? messages, body, options)
      : undefined;

  proxy = new Proxy(messages, {
    get(target, prop): unknown {
      if (prop === 'create' && create !== undefined) return create;
      if (prop === 'stream' && stream !== undefined) return stream;
      return forward(target, prop, bound);
    },
  }) as M;
  return proxy;
}

/**
 * Forward a property read to the real object. Methods are bound to it (and
 * cached, so identity is stable) — the SDK's classes use private fields,
 * which throw when a method runs with a Proxy as its receiver.
 */
function forward(target: object, prop: PropertyKey, bound: Map<PropertyKey, unknown>): unknown {
  const value = Reflect.get(target, prop, target) as unknown;
  if (typeof value !== 'function') return value;
  const cached = bound.get(prop);
  if (cached !== undefined) return cached;
  const fn = (value as (...args: unknown[]) => unknown).bind(target);
  bound.set(prop, fn);
  return fn;
}

function instrumentedCreate(
  core: AdapterCore,
  target: object,
  original: CreateFn,
  params: MessageCreateParamsLike,
  options: RequestOptionsLike | undefined,
): ApiPromiseLike<unknown> {
  // Captured synchronously: the run context of the caller.
  const ctx = core.session.currentRun();
  const scopeId = core.scopeId(ctx);
  const streaming = params?.stream === true;
  let reporter: StepReporter | undefined;

  return gatedApiPromise<unknown>({
    start: async () => {
      const attachWait = core.maybeWaitForAttach();
      if (attachWait !== undefined) await attachWait;
      // A run the debugger aborted must not start new steps (terminal).
      if (ctx?.signal.aborted === true) throw core.abortError(ctx);

      reporter = beginStep(core, params, ctx, scopeId, streaming);

      const decision = await core.session.gate('before', LLM_GATE_NODE);
      if (decision.action === 'abort') {
        reporter?.finish(undefined, undefined, 'aborted');
        throw core.abortError(ctx);
      }
      // 'inject'/'retry' are not meaningful before a model call: continue.

      return { api: original.call(target, params, prepareOptions(core, options, ctx)) };
    },

    onValue: (value) => {
      if (reporter === undefined || value === null || typeof value !== 'object') return value;
      if (streaming) return observeStream(reporter, value as object);
      observeMessage(reporter, value as MessageLike);
      return value;
    },

    onError: (error) => {
      reporter?.fail(error);
    },
  });
}

/** `node.started` + `graph.hint` bookkeeping. Never throws. */
function beginStep(
  core: AdapterCore,
  params: MessageCreateParamsLike,
  ctx: RunContext | undefined,
  scopeId: string,
  streaming: boolean,
): StepReporter | undefined {
  try {
    const step = core.tracker.next(scopeId, params?.messages);
    const instanceId = `${step.invocationId}:s${step.stepIndex}`;
    if (step.isFirstStep) core.emitGraphHint(params, ctx);
    // `tool_use` ids the host never executed belong to the previous turn.
    core.clearToolUseScope(scopeId);
    core.startNode({
      nodeId: LLM_NODE_ID,
      kind: 'llm',
      name: LLM_NODE_NAME,
      instanceId,
      parentId: ctx !== undefined ? agentNodeId(ctx.name) : undefined,
      input: {
        model: params?.model,
        messages: params?.messages,
        ...(params?.system !== undefined ? { system: params.system } : {}),
        ...(params?.tools !== undefined
          ? { tools: params.tools.map((t) => t?.name).filter((n) => typeof n === 'string') }
          : {}),
        stream: streaming,
      },
    });
    return new StepReporter(core, instanceId, scopeId, ctx);
  } catch {
    // Instrumentation prep must never break the host call.
    return undefined;
  }
}

/** Chain the debugger's abort signal into the request options (attached only). */
function prepareOptions(
  core: AdapterCore,
  options: RequestOptionsLike | undefined,
  ctx: RunContext | undefined,
): RequestOptionsLike | undefined {
  try {
    if (!core.session.attached) return options;
    const original = options?.signal ?? undefined;
    const chained = core.chainSignal(original, ctx);
    if (chained === undefined || chained === original) return options;
    return { ...(options ?? {}), signal: chained };
  } catch {
    return options;
  }
}
