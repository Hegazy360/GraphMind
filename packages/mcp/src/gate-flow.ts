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
 *
 * Tool calls only (0.6.0, contract C2): with `edit`, every gate is offered as
 * `editable`, and `continue` + input at `before` / `retry` + input at `after`
 * or `error` invokes the handler with the edited arguments (merged into the
 * live ones, checked by the tool's schema when it has one; a refusal keeps
 * the gate held). The schema's transforms never run twice: arguments the SDK
 * already parsed take a partial edit only when the schema leaves them
 * unchanged (see toolArgsValidator). The latest accepted edit stays the call's arguments for
 * later attempts. With `reportResult`, the `after` gate hands the handler's
 * result to the session's after-gate detectors.
 */
import {
  editedArgs,
  isAbortError,
  isEditableToolInput,
  toolGateOptions,
  withInstanceId,
  type GateDecision,
  type GateNode,
  type GateOptions,
  type RunContext,
  type RunStatus,
  type SchemaCheck,
  type ToolEdit,
} from '@graphmind-ai/client';
import { elapsedMs, now } from './clock.js';
import type { AdapterCore } from './core.js';

/** A gate that outlasts this is a real hold; warn about client timeouts once. */
const HOLD_WARN_MS = 1000;

/** How a tool call can take edited arguments. */
export interface GateFlowEdit {
  /** The arguments the handler received (the SDK's parsed copy of the model's). */
  live: unknown;
  /** The tool's schema check; undefined: the merged edit runs as it is. */
  check: SchemaCheck | undefined;
  /** Invoke the handler with other arguments (called again on `retry`). */
  invokeWith: (args: unknown) => unknown | Promise<unknown>;
  /**
   * `live` is the SDK's PARSED copy of the client's arguments (an McpServer
   * tool callback): the schema's transforms already ran on it, so an edit is
   * accepted only as toolArgsValidator allows for parsed arguments.
   */
  parsed?: boolean | undefined;
}

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
  /** Tool calls: how the call can run with edited arguments. */
  edit?: GateFlowEdit | undefined;
  /** Tool calls: hand the handler's result to the after-gate detectors. */
  reportResult?: boolean | undefined;
}

async function gateAt(
  core: AdapterCore,
  point: 'before' | 'after' | 'error',
  node: GateNode,
  options?: GateOptions,
): ReturnType<AdapterCore['session']['gate']> {
  // Fast path: detached gates resolve from a shared promise; do not even
  // spend two clock reads on them.
  if (!core.session.attached) return core.session.gate(point, node);
  const startedAt = now();
  const decision = await core.session.gate(point, node, options);
  if (now() - startedAt > HOLD_WARN_MS) core.warnHoldTimeout();
  return decision;
}

/**
 * Run one node through the gates. Returns the handler's result, or the
 * injected substitute. The host's own errors propagate untouched (after the
 * error gate has had its say).
 */
export async function gateFlow(options: GateFlowOptions): Promise<unknown> {
  const { core, ctx, instanceId } = options;
  // exec.paused names this execution (parallel calls of one node stay apart).
  const node = withInstanceId(options.node, instanceId);
  const startedAt = now();

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
      durationMs: elapsedMs(startedAt),
      status,
      ...(extra !== undefined ? { extra } : {}),
    });
  };

  // What runs: the handler as the SDK called it, until an edit is accepted.
  const editSite = options.edit;
  let invoke = options.invoke;
  let live = editSite?.live;
  // The arguments as the schema takes them, once an accepted edit gave them.
  let rawInput: unknown;
  const edit = (): ToolEdit | undefined =>
    editSite !== undefined && isEditableToolInput(live)
      ? { args: live, check: editSite.check, parsed: editSite.parsed, input: rawInput }
      : undefined;
  const applyEdit = (decision: GateDecision): void => {
    const edited = editSite === undefined ? undefined : editedArgs(decision);
    if (editSite === undefined || edited === undefined) return;
    live = edited.args;
    rawInput = edited.input;
    invoke = () => editSite.invokeWith(edited.args);
  };

  for (;;) {
    const pre = await gateAt(core, 'before', node, toolGateOptions(core.session, edit));
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
    applyEdit(pre);

    let result: unknown;
    try {
      result = await invoke();
    } catch (error) {
      // A debugger-driven abort surfacing from the handler body is terminal.
      if (ctx?.signal.aborted === true && isAbortError(error)) {
        settle(undefined, 'aborted');
        throw error;
      }
      core.errorNode(node.nodeId, instanceId, error);
      const decision = await gateAt(core, 'error', node, toolGateOptions(core.session, edit));
      if (decision.action === 'inject') {
        const injected = options.coerce(decision.output);
        settle(injected, 'ok', { injected: true, injectedAt: 'error' });
        return injected;
      }
      if (decision.action === 'retry') {
        applyEdit(decision);
        continue;
      }
      if (decision.action === 'abort') {
        settle(undefined, 'aborted');
        throw core.abortError(ctx);
      }
      settle(undefined, 'error');
      throw error; // 'continue': the SDK sees the handler's original error
    }

    const post = await gateAt(
      core,
      'after',
      node,
      toolGateOptions(core.session, edit, options.reportResult === true ? { result } : undefined),
    );
    if (post.action === 'inject') {
      const injected = options.coerce(post.output);
      settle(injected, 'ok', { injected: true, injectedAt: 'after' });
      return injected;
    }
    if (post.action === 'retry') {
      applyEdit(post);
      continue;
    }
    if (post.action === 'abort') {
      settle(result, 'aborted');
      throw core.abortError(ctx);
    }
    settle(result, 'ok');
    return result;
  }
}
