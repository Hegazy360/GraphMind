/**
 * The gated model request: everything both OpenAI APIs share.
 *
 * One request = one execution of the logical `llm:step` node. Per request:
 *
 *  1. `node.started` is emitted (so the viewer knows what is about to run),
 *  2. the `before` gate is awaited BEFORE the SDK method is called — nothing
 *     is in flight while a gate is held, so holds are indefinite-by-design and
 *     no HTTP timeout budget is burning,
 *  3. the SDK's own `APIPromise` is dispatched and tracked,
 *  4. streaming results are TEE'd (the caller gets one branch byte-for-byte,
 *     GraphMind observes the other); non-streaming results are summarized,
 *  5. on failure the `error` gate fires BEFORE the error reaches the host:
 *       retry    -> re-issue the request (the `before` gate fires again)
 *       inject   -> swallow the error and return the injected value as the
 *                   result of `create()`
 *       continue -> rethrow the SDK's original error untouched
 *       abort    -> abort the run's AbortController and throw an
 *                   AbortError-named reason (terminal; never retried)
 *  6. `node.finished` carries the output and mapped token usage.
 *
 * The `after` gate fires for non-streaming requests only (post-response,
 * pre-return; `inject` substitutes the whole completion). A streamed response
 * is already live by the time it is returned, so there is nothing meaningful
 * to hold there — the stream tee reports it as it flows instead.
 */
import type { GateNode, RunContext, RunStatus } from '@graphmind-ai/client';
import { GatedApiPromise, type ApiTracker } from './api-promise.js';
import type { AdapterCore } from './core.js';
import { LLM_NODE_ID, LLM_NODE_NAME, agentNodeId } from './ids.js';
import type { PromptKey } from './invocation.js';
import { isAbortLikeError } from './signals.js';
import {
  isStreamLike,
  isThenable,
  type RequestBodyLike,
  type StreamLike,
  type UsageWithExtras,
} from './sdk-types.js';

const LLM_GATE_NODE: GateNode = { nodeId: LLM_NODE_ID, kind: 'llm', name: LLM_NODE_NAME };

export interface StepCtx {
  /** `<invocationId>:s<N>` — this execution of the logical llm node. */
  readonly instanceId: string;
  /** Invocation-tracking scope (the run id, or `no-run`). */
  readonly scopeId: string;
  readonly startedAt: number;
  /** `chat.completions` or `responses`. */
  readonly api: string;
  /** The run this request belongs to, if any (carries the abort signal). */
  readonly run: RunContext | undefined;
}

/** What an observer uses to report on a step it is watching. */
export interface StepReporter {
  readonly ctx: StepCtx;
  readonly core: AdapterCore;
  token(channel: 'text' | 'reasoning' | 'tool-args', value: string): void;
  error(error: unknown): void;
  /**
   * The status a *cleanly ended* stream should carry.
   *
   * Both Stainless SDKs deliberately swallow abort errors inside their stream
   * iterators ("if the user calls `stream.controller.abort()`, we should exit
   * without throwing" — core/streaming.mjs), so a request the debugger aborted
   * mid stream looks exactly like one that ran to completion. Without this
   * check the canvas would show an aborted step as a successful one carrying a
   * truncated answer.
   */
  endStatus(): RunStatus;
  finish(
    output: unknown,
    status: RunStatus,
    usage?: UsageWithExtras | undefined,
    extra?: Record<string, unknown> | undefined,
  ): void;
}

/** What a non-streaming response boils down to on the wire. */
export interface ResultSummary {
  output: unknown;
  usage?: UsageWithExtras | undefined;
  status: RunStatus;
  error?: unknown;
  extra?: Record<string, unknown> | undefined;
}

/** The per-API behavior the shared request machinery delegates to. */
export interface LlmFlavor {
  /** `chat.completions` | `responses`. */
  readonly api: string;
  /** How this API's body chains into invocations. */
  promptKey(body: RequestBodyLike): PromptKey;
  /** `node.started.input` for this request. */
  nodeInput(body: RequestBodyLike): unknown;
  /** Boil a non-streaming result down; may emit provider-executed tool nodes. */
  summarize(reporter: StepReporter, value: unknown): ResultSummary;
  /** Drain the observer branch of a teed stream. Must never throw. */
  observeStream(reporter: StepReporter, stream: StreamLike): Promise<void>;
}

type CreateFn = (body: unknown, options?: unknown) => unknown;

function makeReporter(core: AdapterCore, ctx: StepCtx): StepReporter {
  let finished = false;
  return {
    ctx,
    core,
    token(channel, value) {
      core.pushToken(LLM_NODE_ID, ctx.instanceId, channel, value);
    },
    error(error) {
      core.errorNode(LLM_NODE_ID, ctx.instanceId, error);
    },
    endStatus() {
      return ctx.run?.signal.aborted === true ? 'aborted' : 'ok';
    },
    finish(output, status, usage, extra) {
      if (finished) return;
      finished = true;
      core.finishNode({
        nodeId: LLM_NODE_ID,
        instanceId: ctx.instanceId,
        output,
        ...(usage !== undefined ? { usage } : {}),
        durationMs: Date.now() - ctx.startedAt,
        status,
        extra: { api: ctx.api, ...extra },
      });
    },
  };
}

/**
 * Wrap one SDK `create` method with the gate machinery. Returns a function
 * with the same call signature that hands back a `GatedApiPromise`.
 */
export function makeGatedCreate(
  core: AdapterCore,
  flavor: LlmFlavor,
  resource: object,
  original: CreateFn,
): CreateFn {
  return function gatedCreate(body: unknown, options?: unknown): unknown {
    try {
      return new GatedApiPromise((track) =>
        runGatedRequest(core, flavor, resource, original, body, options, track),
      );
    } catch (error) {
      // Constructing the wrapper failed: hand the host the untouched SDK call.
      core.warner.warn(
        `create-wrap-failed:${flavor.api}`,
        `GraphMind could not instrument ${flavor.api}.create; the call runs uninstrumented (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return original.call(resource, body, options);
    }
  };
}

async function runGatedRequest(
  core: AdapterCore,
  flavor: LlmFlavor,
  resource: object,
  original: CreateFn,
  body: unknown,
  options: unknown,
  track: ApiTracker,
): Promise<unknown> {
  const attachWait = core.maybeWaitForAttach(); // waitForAttach: first-call gate
  if (attachWait !== undefined) await attachWait;

  const ctx: RunContext | undefined = core.session.currentRun();
  // A run the debugger aborted must not start new requests (terminal).
  if (ctx?.signal.aborted === true) throw core.abortError(ctx);

  const reporter = beginStep(core, flavor, body, ctx);
  if (reporter === undefined) {
    // Instrumentation prep failed; never break the host.
    const api = original.call(resource, body, options);
    if (isThenable(api)) track(api);
    return await (api as PromiseLike<unknown>);
  }

  // One `create()` call is ONE execution of the llm node even when the
  // debugger retries it; the attempt count rides along on node.finished.
  let attempt = 0;
  const attemptExtra = (): Record<string, unknown> | undefined =>
    attempt > 1 ? { attempts: attempt } : undefined;

  for (;;) {
    attempt += 1;
    const pre = await core.session.gate('before', LLM_GATE_NODE);
    if (pre.action === 'abort') {
      reporter.finish(undefined, 'aborted', undefined, attemptExtra());
      throw core.abortError(core.session.currentRun());
    }
    if (pre.action === 'inject') {
      reporter.finish(pre.output, 'ok', undefined, { injected: true, ...attemptExtra() });
      return pre.output;
    }
    // 'retry' before the request has been made is equivalent to continue.

    let value: unknown;
    try {
      const api = original.call(resource, body, core.prepareRequestOptions(options));
      if (isThenable(api)) track(api);
      value = await (api as PromiseLike<unknown>);
    } catch (error) {
      // Aborts are terminal: never gate them, never retry them (a
      // debugger-driven abort would otherwise loop back into the error gate).
      if (isAbortLikeError(error)) {
        reporter.finish(undefined, 'aborted', undefined, attemptExtra());
        throw error;
      }
      reporter.error(error);
      const dec = await core.session.gate('error', LLM_GATE_NODE);
      if (dec.action === 'inject') {
        reporter.finish(dec.output, 'ok', undefined, { injected: true, ...attemptExtra() });
        return dec.output;
      }
      if (dec.action === 'retry') continue;
      if (dec.action === 'abort') {
        reporter.finish(undefined, 'aborted', undefined, attemptExtra());
        throw core.abortError(core.session.currentRun());
      }
      reporter.finish(undefined, 'error', undefined, attemptExtra());
      throw error; // 'continue': the host sees the SDK's original error
    }

    if (isStreamLike(value)) {
      const teed = teeStream(value);
      if (teed === undefined) {
        // Exotic stream implementation: hand it over untouched, unobserved.
        core.warner.warn(
          `tee-unavailable:${flavor.api}`,
          `GraphMind could not tee a ${flavor.api} stream; the response is passed through unobserved.`,
        );
        reporter.finish(undefined, 'ok', undefined, { observed: false, ...attemptExtra() });
        return value;
      }
      void flavor.observeStream(reporter, teed.forObserver);
      return teed.forCaller;
    }

    const summary = flavor.summarize(reporter, value);
    const post = await core.session.gate('after', LLM_GATE_NODE);
    if (post.action === 'inject') {
      reporter.finish(post.output, 'ok', summary.usage, { injected: true, ...attemptExtra() });
      return post.output;
    }
    if (post.action === 'retry') continue;
    if (post.action === 'abort') {
      reporter.finish(summary.output, 'aborted', summary.usage, attemptExtra());
      throw core.abortError(core.session.currentRun());
    }
    if (summary.status === 'error' && summary.error !== undefined) reporter.error(summary.error);
    reporter.finish(summary.output, summary.status, summary.usage, {
      ...summary.extra,
      ...attemptExtra(),
    });
    return value;
  }
}

/** Emit `graph.hint` (first step) + `node.started`. Undefined if it failed. */
function beginStep(
  core: AdapterCore,
  flavor: LlmFlavor,
  body: unknown,
  ctx: RunContext | undefined,
): StepReporter | undefined {
  try {
    const request = (typeof body === 'object' && body !== null ? body : {}) as RequestBodyLike;
    const scopeId = ctx?.runId ?? 'no-run';
    const step = core.tracker.next(scopeId, flavor.promptKey(request));
    const instanceId = `${step.invocationId}:s${step.stepIndex}`;
    if (step.isFirstStep) core.emitGraphHint(request.tools, ctx);
    core.startNode({
      nodeId: LLM_NODE_ID,
      kind: 'llm',
      name: LLM_NODE_NAME,
      instanceId,
      parentId: ctx !== undefined ? agentNodeId(ctx.name) : undefined,
      input: flavor.nodeInput(request),
      extra: { api: flavor.api },
    });
    return makeReporter(core, {
      instanceId,
      scopeId,
      startedAt: Date.now(),
      api: flavor.api,
      run: ctx,
    });
  } catch {
    return undefined;
  }
}

/**
 * `Stream.tee()` gives both branches the identical chunk sequence (it pulls the
 * underlying iterator once and fans out), so what GraphMind observes is
 * byte-for-byte what the caller consumes.
 */
function teeStream(stream: StreamLike): { forCaller: StreamLike; forObserver: StreamLike } | undefined {
  try {
    const [forCaller, forObserver] = stream.tee();
    if (forCaller === undefined || forObserver === undefined) return undefined;
    return { forCaller, forObserver };
  } catch {
    return undefined;
  }
}
