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
 * Edited arguments (0.6.0, contract C2): a call whose first argument is an
 * object — or the JSON text of one, as `tool_call.function.arguments` arrives
 * — is offered as `editable` at every gate (the session shows it only when
 * the app and the debugger both enabled edits). `continue` + input at
 * `before`, or `retry` + input at `after` / `error`, calls the REAL function
 * with the edit merged into the live arguments (top-level keys replace),
 * handed over in the form it came in (an object, or JSON text again); the
 * second argument is forwarded unchanged. A tool object that carries its own
 * schema (`parameters`, `inputSchema`, `input_schema` or `schema`: zod, a
 * Standard Schema, or JSON Schema) has the merged arguments checked against
 * it first, and a failure keeps the gate held; without one they are accepted
 * as merged. Either way the function receives the MERGED arguments, never the
 * schema's parsed output: it gets what your loop passes and parses it itself
 * (or not), so a schema transform never runs twice. The latest accepted edit stays the call's arguments for later
 * attempts. `node.started` (and so the loop fingerprint) keeps what the model
 * asked for; `exec.resumed.edited` records what ran. The `after` gate also
 * hands the result to the session's after-gate detectors.
 *
 * Parallel tool calls gate INDEPENDENTLY: each invocation awaits its own gate,
 * so `Promise.all(toolCalls.map(...))` holds one call while another runs.
 *
 * The second argument, when present, is used to derive the execution's
 * `instanceId`: pass the OpenAI tool call itself (`{ id }` for Chat
 * Completions, `{ call_id }` for the Responses API) or `{ toolCallId }`. It is
 * forwarded to your function unchanged.
 */
import { monotonicNow, elapsedMs } from '@graphmind-ai/client';
import {
  editedArgs,
  isAbortError,
  isEditableToolInput,
  toolGateOptions,
  toolSchemaCheck,
  type GateDecision,
  type GateNode,
  type RunStatus,
  type SchemaCheck,
  type ToolEdit,
} from '@graphmind-ai/client';
import type { AdapterCore } from './core.js';
import { LLM_NODE_ID, nextId, toolNodeId } from './ids.js';
import { isObject, parseToolInput } from './sdk-types.js';

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Extract the tool call id from whatever the caller passed as the 2nd arg.
 * A bare `id` only counts when the object also looks like a tool call — the
 * SDK's `runTools()` passes its *runner* there, and reusing one id across every
 * call would collapse distinct executions into one node instance.
 */
function instanceIdOf(options: unknown): string {
  if (isObject(options)) {
    const explicit = options['toolCallId'] ?? options['call_id'];
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const looksLikeToolCall =
      'function' in options || 'name' in options || options['type'] === 'function';
    const id = options['id'];
    if (looksLikeToolCall && typeof id === 'string' && id.length > 0) return id;
  }
  return nextId('call');
}

/**
 * The schema a tool object carries, as a check for edited arguments:
 * `parameters` (OpenAI function tools, the Agents SDK's zod parameters),
 * `inputSchema`, `input_schema` or `schema`, or `function.parameters` (a Chat
 * Completions tool definition). Undefined for a bare function or a tool with
 * none of these.
 */
function schemaCheckOf(tool: unknown): SchemaCheck | undefined {
  try {
    if (!isObject(tool)) return undefined;
    const fn = tool['function'];
    const candidates = [
      tool['parameters'],
      tool['inputSchema'],
      tool['input_schema'],
      tool['schema'],
      isObject(fn) ? fn['parameters'] : undefined,
    ];
    for (const candidate of candidates) {
      const check = toolSchemaCheck(candidate);
      if (check !== undefined) return check;
    }
  } catch {
    // an unreadable tool object carries no schema
  }
  return undefined;
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
      wrapped[toolName] = makeGatedTool(core, toolName, value as AnyFn, undefined, undefined);
      continue;
    }
    if (isObject(value) && typeof value['execute'] === 'function') {
      core.gatedToolNames.add(toolName);
      wrapped[toolName] = {
        ...value,
        execute: makeGatedTool(core, toolName, value['execute'] as AnyFn, value, schemaCheckOf(value)),
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
  check: SchemaCheck | undefined,
): AnyFn {
  return async function gatedTool(...args: unknown[]): Promise<unknown> {
    const attachWait = core.maybeWaitForAttach(); // waitForAttach: first-call gate
    if (attachWait !== undefined) await attachWait;

    const node: GateNode = { nodeId: toolNodeId(toolName), kind: 'tool', name: toolName };
    const ctx = core.session.currentRun();
    const instanceId = instanceIdOf(args[1]);
    const startedAt = monotonicNow();
    const input = parseToolInput(args[0]);
    core.startNode({
      nodeId: node.nodeId,
      kind: 'tool',
      name: toolName,
      instanceId,
      parentId: LLM_NODE_ID,
      input,
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

    // What the function is called with: your arguments until an edit is
    // accepted. `live` is the first argument as an object (parsed from JSON
    // text when it came as text); an edit is handed back in the same form.
    let callArgs: unknown[] = args;
    let live = input;
    const asText = typeof args[0] === 'string';
    // The function gets the arguments as your loop passed them (and does any
    // parsing itself), so an edit runs MERGED: the schema only judges it, and
    // its transforms never run on top of the function's own parsing.
    const edit = (): ToolEdit | undefined =>
      args.length >= 1 && isEditableToolInput(live) ? { args: live, check, runMerged: true } : undefined;
    const applyEdit = (decision: GateDecision): void => {
      const edited = editedArgs(decision);
      if (edited === undefined) return;
      live = edited.args;
      callArgs = [asText ? JSON.stringify(edited.args) : edited.args, ...args.slice(1)];
    };

    for (;;) {
      const pre = await core.session.gate('before', node, toolGateOptions(core.session, edit));
      if (pre.action === 'abort') {
        finish(undefined, 'aborted');
        throw core.abortError(core.session.currentRun());
      }
      if (pre.action === 'inject') {
        finish(pre.output, 'ok', { injected: true });
        return pre.output;
      }
      // 'retry' before execution is equivalent to continue.
      applyEdit(pre);

      let result: unknown;
      try {
        result = await original.apply(thisArg, callArgs);
      } catch (error) {
        // A debugger-driven abort surfacing from the tool body is terminal.
        if (ctx?.signal.aborted === true && isAbortError(error)) {
          finish(undefined, 'aborted');
          throw error;
        }
        core.errorNode(node.nodeId, instanceId, error);
        const dec = await core.session.gate('error', node, toolGateOptions(core.session, edit));
        if (dec.action === 'inject') {
          finish(dec.output, 'ok', { injected: true });
          return dec.output;
        }
        if (dec.action === 'retry') {
          applyEdit(dec);
          continue;
        }
        if (dec.action === 'abort') {
          finish(undefined, 'aborted');
          throw core.abortError(core.session.currentRun());
        }
        finish(undefined, 'error');
        throw error; // 'continue': your loop sees the original error
      }

      const post = await core.session.gate('after', node, toolGateOptions(core.session, edit, { result }));
      if (post.action === 'inject') {
        finish(post.output, 'ok', { injected: true });
        return post.output;
      }
      if (post.action === 'retry') {
        applyEdit(post);
        continue;
      }
      if (post.action === 'abort') {
        finish(result, 'aborted');
        throw core.abortError(core.session.currentRun());
      }
      finish(result, 'ok');
      return result;
    }
  };
}
