/**
 * The gate loop every instrumented MCP node runs through — one shape for
 * tools, resources, prompts and sampling, because the debugger's contract is
 * the same for all four:
 *
 *  - `gate('before')` BEFORE the handler is invoked, so a held gate has
 *    nothing in flight: the handler body has not started, no side effect has
 *    happened, and `abort` costs nothing.
 *  - `gate('after')` post-handler, pre-return (decisions.md #2) — fires in
 *    step mode or on an explicit `after` breakpoint.
 *  - `gate('error')` when the handler throws, BEFORE the error escapes into
 *    the SDK (which would turn it into an `isError` tool result or a JSON-RPC
 *    error and lose the chance to recover it).
 *
 * Decisions:
 *    continue -> proceed / rethrow the original error
 *    retry    -> re-invoke the handler (the before gate fires again)
 *    inject   -> the handler's RESULT is replaced by the debugger's value,
 *                coerced into a valid MCP result (see coerce.ts) so the client
 *                actually receives it
 *    abort    -> the session aborts the run's AbortController; this throws an
 *                AbortError-named reason
 */
import { isAbortError, type GateNode, type RunContext, type RunStatus } from '@graphmind-ai/client';
import type { AdapterCore } from './core.js';

/** A gate that outlasts this is a real hold; warn about client timeouts once. */
const HOLD_WARN_MS = 1000;

export interface GateFlowOptions {
  core: AdapterCore;
  ctx: RunContext | undefined;
  node: GateNode;
  instanceId: string;
  parentId?: string | undefined;
  input: unknown;
  /** Extra loose fields on `node.started`. */
  startExtra?: Record<string, unknown> | undefined;
  /** Invoke the host's handler. Called again on `retry`. */
  invoke: () => unknown | Promise<unknown>;
  /** Lift a debugger-supplied `inject` value into a valid result. */
  coerce: (value: unknown) => unknown;
}

async function gateAt(
  core: AdapterCore,
  point: 'before' | 'after' | 'error',
  node: GateNode,
): ReturnType<AdapterCore['session']['gate']> {
  // Fast path: detached gates resolve from a shared promise; do not even
  // spend two clock reads on them.
  if (!core.session.attached) return core.session.gate(point, node);
  const startedAt = Date.now();
  const decision = await core.session.gate(point, node);
  if (Date.now() - startedAt > HOLD_WARN_MS) core.warnHoldTimeout();
  return decision;
}

/**
 * Run one node through the gates. Returns the handler's result, or the
 * injected substitute. The host's own errors propagate untouched (after the
 * error gate has had its say).
 */
export async function gateFlow(options: GateFlowOptions): Promise<unknown> {
  const { core, ctx, node, instanceId } = options;
  const startedAt = Date.now();

  core.startNode({
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    instanceId,
    parentId: options.parentId,
    input: options.input,
    extra: options.startExtra,
  });

  const settle = (output: unknown, status: RunStatus, extra?: Record<string, unknown>): void => {
    core.finishNode({
      nodeId: node.nodeId,
      instanceId,
      output,
      durationMs: Date.now() - startedAt,
      status,
      ...(extra !== undefined ? { extra } : {}),
    });
  };

  for (;;) {
    const pre = await gateAt(core, 'before', node);
    if (pre.action === 'abort') {
      settle(undefined, 'aborted');
      throw core.abortError(ctx);
    }
    if (pre.action === 'inject') {
      const injected = options.coerce(pre.output);
      settle(injected, 'ok', { injected: true, injectedAt: 'before' });
      return injected;
    }
    // 'retry' before execution is equivalent to continue.

    let result: unknown;
    try {
      result = await options.invoke();
    } catch (error) {
      // A debugger-driven abort surfacing from the handler body is terminal.
      if (ctx?.signal.aborted === true && isAbortError(error)) {
        settle(undefined, 'aborted');
        throw error;
      }
      core.errorNode(node.nodeId, instanceId, error);
      const decision = await gateAt(core, 'error', node);
      if (decision.action === 'inject') {
        const injected = options.coerce(decision.output);
        settle(injected, 'ok', { injected: true, injectedAt: 'error' });
        return injected;
      }
      if (decision.action === 'retry') continue;
      if (decision.action === 'abort') {
        settle(undefined, 'aborted');
        throw core.abortError(ctx);
      }
      settle(undefined, 'error');
      throw error; // 'continue': the SDK sees the handler's original error
    }

    const post = await gateAt(core, 'after', node);
    if (post.action === 'inject') {
      const injected = options.coerce(post.output);
      settle(injected, 'ok', { injected: true, injectedAt: 'after' });
      return injected;
    }
    if (post.action === 'retry') continue;
    if (post.action === 'abort') {
      settle(result, 'aborted');
      throw core.abortError(ctx);
    }
    settle(result, 'ok');
    return result;
  }
}
