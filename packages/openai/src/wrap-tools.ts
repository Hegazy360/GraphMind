/**
 * Tool wrapping: pure decoration of the functions your agent loop dispatches
 * `tool_calls` to. The OpenAI SDK does not execute local tools for you — you
 * read `tool_calls` (or `function_call` output items) and call your own code —
 * so GraphMind gates at exactly that call site.
 *
 * Per tool call:
 *
 *  - `gate('before')` BEFORE the original function runs,
 *  - `gate('after')` post-call, pre-return (decisions.md #2),
 *  - on throw, the `error` gate fires BEFORE the error reaches your loop:
 *      inject   -> swallow the error and return the injected value as the
 *                  tool's result (it lands in the tool message you feed back,
 *                  so the substitution reaches the model's next turn)
 *      retry    -> re-enter the loop (the before-gate fires again)
 *      continue -> rethrow the original error
 *      abort    -> the session aborts the run's AbortController and the
 *                  wrapper throws an AbortError-named reason (terminal).
 *
 * Parallel tool calls gate INDEPENDENTLY: each invocation awaits its own gate,
 * so `Promise.all(toolCalls.map(...))` holds one call while another runs.
 *
 * The second argument, when present, is used to derive the execution's
 * `instanceId`: pass the OpenAI tool call itself (`{ id }` for Chat
 * Completions, `{ call_id }` for the Responses API) or `{ toolCallId }`. It is
 * forwarded to your function unchanged.
 */
import { isAbortError, type GateNode, type RunStatus } from '@graphmind-ai/client';
import type { AdapterCore } from './core.js';
import { LLM_NODE_ID, nextId, toolNodeId } from './ids.js';
import { isObject, parseToolInput } from './sdk-types.js';

type AnyFn = (...args: unknown[]) => unknown;

/** Extract the tool call id from whatever the caller passed as the 2nd arg. */
function instanceIdOf(options: unknown): string {
  if (isObject(options)) {
    const candidates = [options['toolCallId'], options['id'], options['call_id']];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
  }
  return nextId('call');
}

/**
 * Wrap every function in `tools` with before/after/error gates. Values that
 * are not functions (and not objects with a function `execute`) pass through
 * untouched. Identity when GraphMind is disabled.
 */
export function wrapToolMap<T extends Record<string, unknown>>(tools: T, core: AdapterCore): T {
  const wrapped: Record<string, unknown> = {};
  for (const [toolName, value] of Object.entries(tools)) {
    if (typeof value === 'function') {
      core.gatedToolNames.add(toolName);
      wrapped[toolName] = makeGatedTool(core, toolName, value as AnyFn, undefined);
      continue;
    }
    if (isObject(value) && typeof value['execute'] === 'function') {
      core.gatedToolNames.add(toolName);
      wrapped[toolName] = {
        ...value,
        execute: makeGatedTool(core, toolName, value['execute'] as AnyFn, value),
      };
      continue;
    }
    wrapped[toolName] = value;
  }
  return wrapped as T;
}

function makeGatedTool(
  core: AdapterCore,
  toolName: string,
  original: AnyFn,
  thisArg: unknown,
): AnyFn {
  return async function gatedTool(...args: unknown[]): Promise<unknown> {
    const attachWait = core.maybeWaitForAttach(); // waitForAttach: first-call gate
    if (attachWait !== undefined) await attachWait;

    const node: GateNode = { nodeId: toolNodeId(toolName), kind: 'tool', name: toolName };
    const ctx = core.session.currentRun();
    const instanceId = instanceIdOf(args[1]);
    const startedAt = Date.now();
    core.startNode({
      nodeId: node.nodeId,
      kind: 'tool',
      name: toolName,
      instanceId,
      parentId: LLM_NODE_ID,
      input: parseToolInput(args[0]),
    });

    const finish = (output: unknown, status: RunStatus, extra?: Record<string, unknown>): void =>
      core.finishNode({
        nodeId: node.nodeId,
        instanceId,
        output,
        durationMs: Date.now() - startedAt,
        status,
        ...(extra !== undefined ? { extra } : {}),
      });

    for (;;) {
      const pre = await core.session.gate('before', node);
      if (pre.action === 'abort') {
        finish(undefined, 'aborted');
        throw core.abortError(core.session.currentRun());
      }
      if (pre.action === 'inject') {
        finish(pre.output, 'ok', { injected: true });
        return pre.output;
      }
      // 'retry' before execution is equivalent to continue.

      let result: unknown;
      try {
        result = await original.apply(thisArg, args);
      } catch (error) {
        // A debugger-driven abort surfacing from the tool body is terminal.
        if (ctx?.signal.aborted === true && isAbortError(error)) {
          finish(undefined, 'aborted');
          throw error;
        }
        core.errorNode(node.nodeId, instanceId, error);
        const dec = await core.session.gate('error', node);
        if (dec.action === 'inject') {
          finish(dec.output, 'ok', { injected: true });
          return dec.output;
        }
        if (dec.action === 'retry') continue;
        if (dec.action === 'abort') {
          finish(undefined, 'aborted');
          throw core.abortError(core.session.currentRun());
        }
        finish(undefined, 'error');
        throw error; // 'continue': your loop sees the original error
      }

      const post = await core.session.gate('after', node);
      if (post.action === 'inject') {
        finish(post.output, 'ok', { injected: true });
        return post.output;
      }
      if (post.action === 'retry') continue;
      if (post.action === 'abort') {
        finish(result, 'aborted');
        throw core.abortError(core.session.currentRun());
      }
      finish(result, 'ok');
      return result;
    }
  };
}
