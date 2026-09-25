/**
 * Tool wrapping for raw Anthropic loops.
 *
 * The Anthropic SDK has no tool runtime: the host inspects `tool_use` blocks
 * and calls its own functions. `gm.wrapTools({ searchFlights })` decorates
 * those plain functions so each call becomes a gated tool node:
 *
 *  - `gate('before')` BEFORE the original function body runs.
 *  - `gate('after')` post-body, pre-return (step mode; decisions.md #2).
 *  - On throw, the `error` gate fires BEFORE the error reaches the host loop:
 *      inject   -> swallow the error, return the injected value as the result
 *                  (it becomes the next turn's tool_result)
 *      retry    -> re-enter the loop (the before-gate fires again)
 *      continue -> rethrow the original error (the host's own handling wins)
 *      abort    -> the session aborts the run's AbortController; the wrapper
 *                  throws an AbortError-named reason (never a bare Error).
 *
 * Edited arguments (0.6.0, contract C2): a call made with ONE object argument
 * (the usual `tool_use.input`) is offered as `editable` at every gate (the
 * session shows it only when the app and the debugger both enabled edits).
 * `continue` + input at `before`, or `retry` + input at `after` / `error`,
 * calls the REAL function with the edit merged into the live arguments
 * (top-level keys replace, the rest keep their live values). A plain function
 * carries no schema, so the merged object is not checked further — the
 * function itself is the validator, and a throw lands on the error gate. The
 * latest accepted edit stays the call's argument for later attempts.
 * `node.started` (and so the loop fingerprint) keeps what the model asked
 * for; `exec.resumed.edited` records what ran. The `after` gate also hands
 * the result to the session's after-gate detectors.
 *
 * Parallel tool calls gate INDEPENDENTLY: each invocation is its own async
 * frame with its own gate, so `await Promise.all([...])` over several wrapped
 * tools holds each one separately.
 *
 * The `instanceId` is the model's real `tool_use` id whenever the adapter
 * observed the LLM step that requested it (see core.recordToolUse); otherwise
 * a synthetic id is used.
 */
import { monotonicNow, elapsedMs } from '@graphmind-ai/client';
import {
  editedArgs,
  isAbortError,
  isEditableToolInput,
  toolGateOptions,
  withInstanceId,
  type GateNode,
  type RunStatus,
  type ToolEdit,
} from '@graphmind-ai/client';
import type { AdapterCore } from './core.js';
import { LLM_NODE_ID, nextId, toolNodeId } from './ids.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- signature preservation */
/** Any host tool function. `any[]` is required to preserve exact signatures. */
export type AnyToolFn = (...args: any[]) => any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A wrapped tool: same parameters, always a promise (gates are async). */
export type GatedFn<F extends AnyToolFn> = (
  ...args: Parameters<F>
) => Promise<Awaited<ReturnType<F>>>;

export type ToolFnSet = Record<string, AnyToolFn>;

export type GatedTools<T extends ToolFnSet> = { [K in keyof T]: GatedFn<T[K]> };

export function wrapToolSet<T extends ToolFnSet>(tools: T, core: AdapterCore): GatedTools<T> {
  const wrapped: Record<string, unknown> = {};
  for (const [toolName, fn] of Object.entries(tools)) {
    if (typeof fn !== 'function') {
      wrapped[toolName] = fn;
      continue;
    }
    wrapped[toolName] = wrapToolFn(toolName, fn, core);
  }
  return wrapped as GatedTools<T>;
}

export function wrapToolFn<F extends AnyToolFn>(
  toolName: string,
  fn: F,
  core: AdapterCore,
): GatedFn<F> {
  core.gatedToolNames.add(toolName);
  const node: GateNode = { nodeId: toolNodeId(toolName), kind: 'tool', name: toolName };

  return async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
    const attachWait = core.maybeWaitForAttach(); // waitForAttach: first-call gate
    if (attachWait !== undefined) await attachWait;

    const ctx = core.session.currentRun();
    const scopeId = core.scopeId(ctx);
    const instanceId = core.takeToolUse(scopeId, toolName) ?? nextId('call');
    // exec.paused names this call (parallel calls of one tool stay apart).
    const gateNode = withInstanceId(node, instanceId);
    const startedAt = monotonicNow();
    core.startNode({
      nodeId: node.nodeId,
      kind: 'tool',
      name: toolName,
      instanceId,
      parentId: LLM_NODE_ID,
      input: toolInput(args),
    });

    const finish = (output: unknown, status: RunStatus, extra?: Record<string, unknown>): void =>
      core.finishNode({
        nodeId: node.nodeId,
        instanceId,
        output,
        durationMs: elapsedMs(startedAt),
        status,
        ...(extra !== undefined ? { extra } : {}),
      });

    // What the function is called with: the host's arguments until an edit
    // is accepted. Only a single object argument can take an edit.
    let callArgs: unknown[] = args;
    const edit = (): ToolEdit | undefined =>
      callArgs.length === 1 && isEditableToolInput(callArgs[0]) ? { args: callArgs[0] } : undefined;
    const applyEdit = (decision: Parameters<typeof editedArgs>[0]): void => {
      const edited = editedArgs(decision);
      if (edited !== undefined) callArgs = [edited.args];
    };

    for (;;) {
      const pre = await core.session.gate('before', gateNode, toolGateOptions(core.session, edit));
      if (pre.action === 'abort') {
        finish(undefined, 'aborted');
        throw core.abortError(ctx);
      }
      if (pre.action === 'inject') {
        finish(pre.output, 'ok', { injected: true });
        return pre.output as Awaited<ReturnType<F>>;
      }
      // 'retry' before execution is equivalent to continue.
      applyEdit(pre);

      let result: Awaited<ReturnType<F>>;
      try {
        result = (await fn(...callArgs)) as Awaited<ReturnType<F>>;
      } catch (error) {
        // A debugger-driven abort surfacing from the tool body is terminal.
        if (ctx?.signal.aborted === true && isAbortError(error)) {
          finish(undefined, 'aborted');
          throw error;
        }
        core.errorNode(node.nodeId, instanceId, error);
        const dec = await core.session.gate('error', gateNode, toolGateOptions(core.session, edit));
        if (dec.action === 'inject') {
          finish(dec.output, 'ok', { injected: true });
          return dec.output as Awaited<ReturnType<F>>;
        }
        if (dec.action === 'retry') {
          applyEdit(dec);
          continue;
        }
        if (dec.action === 'abort') {
          finish(undefined, 'aborted');
          throw core.abortError(ctx);
        }
        finish(undefined, 'error');
        throw error; // 'continue': the host sees the original error
      }

      const post = await core.session.gate('after', gateNode, toolGateOptions(core.session, edit, { result }));
      if (post.action === 'inject') {
        finish(post.output, 'ok', { injected: true });
        return post.output as Awaited<ReturnType<F>>;
      }
      if (post.action === 'retry') {
        applyEdit(post);
        continue;
      }
      if (post.action === 'abort') {
        finish(result, 'aborted');
        throw core.abortError(ctx);
      }
      finish(result, 'ok');
      return result;
    }
  };
}

/** One argument is reported as-is (the usual `tool_use.input`); many as a list. */
function toolInput(args: readonly unknown[]): unknown {
  if (args.length === 0) return undefined;
  if (args.length === 1) return args[0];
  return args;
}
