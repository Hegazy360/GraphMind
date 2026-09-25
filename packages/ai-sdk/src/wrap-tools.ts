/**
 * Tool wrapping: pure decoration of the user's ToolSet — the SDK sees
 * ordinary tools. Per tool call (parallel calls gate independently because
 * ai@7 invokes each call's `execute` concurrently):
 *
 *  - `gate('before')` BEFORE invoking the original execute.
 *  - `gate('after')` post-execute, pre-return (decisions.md #2).
 *  - On throw, the `error` gate fires BEFORE the SDK ever sees the error:
 *      inject   -> swallow the error, return the injected value as the result
 *      retry    -> re-enter the loop (before-gate fires again)
 *      continue -> rethrow the original error (SDK turns it into an
 *                  error-text tool result and keeps looping)
 *      abort    -> the session aborts the run's AbortController; the wrapper
 *                  throws an AbortError-named reason (never a bare Error).
 *
 * Edited arguments (0.6.0, contract C2): every gate of a call whose arguments
 * are an object is offered as `editable` (the session shows it only when the
 * app and the debugger both enabled edits). `continue` + input at `before`,
 * or `retry` + input at `after` / `error`, runs the REAL execute with the
 * edited arguments — merged into the live ones (top-level keys replace), then
 * re-validated with `asSchema(tool.inputSchema).validate`, because the SDK
 * validated the MODEL's arguments before `execute` ran and an edit bypasses
 * that. The schema's parsed value is what runs; a refusal keeps the gate
 * held. `execute` receives arguments the schema already PARSED, so the edit
 * is merged into the model's own arguments (kept from the model step by the
 * middleware, per toolCallId) and parsed once from there — a transform never
 * runs twice on a key the user did not touch. Without them (tools wrapped but
 * the model not), a partial edit is accepted only when the schema leaves the
 * parsed arguments unchanged (see toolArgsValidator). The latest accepted edit stays the call's arguments for later
 * attempts. `node.started` (and so the loop fingerprint) keeps what the model
 * asked for; `exec.resumed.edited` records what ran. The `after` gate also
 * hands the result to the session's after-gate detectors.
 *
 * Streaming `execute` (declared `async function*`) gets a NON-async delegate
 * (decisions.md #4): the SDK type-sniffs execute's direct return value, so
 * the wrapper synchronously returns an async generator that gates at
 * before-start only (editable too: nothing has run yet), observes chunks, and
 * never pauses mid-stream (errors are observed, not gated).
 *
 * Provider-executed tools have no local `execute`; they pass through
 * untouched and are observed from the stream tee instead.
 */
import { monotonicNow, elapsedMs } from '@graphmind-ai/client';
import {
  describeValidationError,
  editedArgs,
  isAbortError,
  isEditableToolInput,
  toolGateOptions,
  type GateNode,
  type InputValidation,
  type RunStatus,
  type SchemaCheck,
  type ToolEdit,
} from '@graphmind-ai/client';
import { asSchema, type ToolSet } from 'ai';
import type { AdapterCore } from './core.js';
import { LLM_NODE_ID, nextId, toolNodeId } from './ids.js';
import {
  isAsyncGeneratorFunction,
  isAsyncIterable,
  type ToolCallOptionsLike,
} from './sdk-types.js';

type ExecuteFn = (input: unknown, options: unknown) => unknown;

export function wrapToolSet<TOOLS extends ToolSet>(tools: TOOLS, core: AdapterCore): TOOLS {
  const wrapped: Record<string, unknown> = {};
  for (const [toolName, t] of Object.entries(tools)) {
    const original = (t as { execute?: unknown }).execute;
    const providerExecuted = (t as { isProviderExecuted?: boolean }).isProviderExecuted === true;
    if (typeof original !== 'function' || providerExecuted) {
      wrapped[toolName] = t; // nothing to gate: observed via the stream tee
      continue;
    }
    const exec = original as ExecuteFn;
    const check = schemaCheckFor(core, toolName, t);
    wrapped[toolName] = {
      ...t,
      execute: isAsyncGeneratorFunction(exec)
        ? makeStreamingExecute(core, toolName, exec, check)
        : makeExecute(core, toolName, exec, check),
    };
  }
  return wrapped as TOOLS;
}

/**
 * The tool's own schema, applied to an edit: `asSchema(tool.inputSchema)
 * .validate` — the check the SDK ran on the model's arguments
 * (`doParseToolCall`), which an edit arrives too late for. Its parsed value
 * (defaults, transforms) is what the call runs with. Resolved lazily, only
 * when an edit arrives. A tool with no input schema, or whose schema has no
 * validator (`jsonSchema()` without `validate`), accepts the merged edit as
 * it is — said once per tool, since nothing checked it.
 */
function schemaCheckFor(core: AdapterCore, toolName: string, tool: unknown): SchemaCheck {
  const unchecked = (value: unknown, why: string): InputValidation => {
    core.warner.warn(
      `edit-unvalidated:${toolName}`,
      `edited arguments for tool "${toolName}" run without a schema check (${why}); ` +
        'the tool receives them as merged.',
    );
    return { ok: true, value };
  };
  return async (value) => {
    const inputSchema = (tool as { inputSchema?: unknown }).inputSchema;
    if (inputSchema === undefined || inputSchema === null) return unchecked(value, 'it has no inputSchema');
    const schema = asSchema(inputSchema as Parameters<typeof asSchema>[0]);
    const validate = (schema as { validate?: unknown }).validate;
    if (typeof validate !== 'function') return unchecked(value, 'its schema has no validate function');
    const result = (await (validate as (input: unknown) => unknown).call(schema, value)) as
      | { success: true; value: unknown }
      | { success: false; error: unknown };
    if (result.success) return { ok: true, value: result.value };
    return { ok: false, code: 'schema', message: describeValidationError(result.error, value) };
  };
}

function toolCallIdOf(options: unknown): string | undefined {
  try {
    const toolCallId = (options as ToolCallOptionsLike | null | undefined)?.toolCallId;
    return typeof toolCallId === 'string' ? toolCallId : undefined;
  } catch {
    return undefined;
  }
}

function instanceIdOf(options: unknown): string {
  return toolCallIdOf(options) ?? nextId('call');
}

function safeChunkPreview(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  try {
    return JSON.stringify(chunk)?.slice(0, 500) ?? String(chunk);
  } catch {
    return '[unserializable chunk]';
  }
}

function makeExecute(
  core: AdapterCore,
  toolName: string,
  original: ExecuteFn,
  check: SchemaCheck,
): ExecuteFn {
  return async (input: unknown, options: unknown): Promise<unknown> => {
    const attachWait = core.maybeWaitForAttach(); // waitForAttach: first-call gate
    if (attachWait !== undefined) await attachWait;
    const node: GateNode = { nodeId: toolNodeId(toolName), kind: 'tool', name: toolName };
    const ctx = core.session.currentRun();
    const instanceId = instanceIdOf(options);
    const startedAt = monotonicNow();
    core.startNode({
      nodeId: node.nodeId,
      kind: 'tool',
      name: toolName,
      instanceId,
      parentId: LLM_NODE_ID,
      input,
    });
    const execOptions = core.prepareToolOptions(options);

    const finish = (output: unknown, status: RunStatus, extra?: Record<string, unknown>): void =>
      core.finishNode({
        nodeId: node.nodeId,
        output,
        durationMs: elapsedMs(startedAt),
        status,
        extra: { instanceId, ...extra },
      });

    // What the call runs with: the model's arguments (as the SDK parsed them
    // with the tool's schema) until an edit is accepted. An edit merges into
    // `raw` — the same arguments as the model sent them — so the schema's
    // transforms never run twice on keys the user did not touch.
    let args = input;
    let raw = core.takeToolInput(toolCallIdOf(options));
    const edit = (): ToolEdit | undefined =>
      isEditableToolInput(args) ? { args, check, parsed: true, input: raw } : undefined;
    const applyEdit = (edited: { args: unknown; input?: unknown } | undefined): void => {
      if (edited === undefined) return;
      args = edited.args;
      raw = edited.input;
    };

    for (;;) {
      const pre = await core.session.gate('before', node, toolGateOptions(core.session, edit));
      if (pre.action === 'abort') {
        finish(undefined, 'aborted');
        throw core.abortError(ctx);
      }
      if (pre.action === 'inject') {
        finish(pre.output, 'ok', { injected: true });
        return pre.output;
      }
      // 'retry' before execution is equivalent to continue.
      applyEdit(editedArgs(pre));

      let result: unknown;
      try {
        result = await original(args, execOptions);
        if (isAsyncIterable(result)) {
          core.warner.warn(
            `streaming-fallback:${toolName}`,
            `tool "${toolName}" returned an AsyncIterable from a non-generator execute; ` +
              'GraphMind drained it to the final value. Declare execute as `async function*` ' +
              'to stream preliminary results through the debugger.',
          );
          result = await drainToLast(result);
        }
      } catch (error) {
        // A debugger-driven abort surfacing from the tool body is terminal.
        if (ctx?.signal.aborted === true && isAbortError(error)) {
          finish(undefined, 'aborted');
          throw error;
        }
        core.errorNode(node.nodeId, error);
        const dec = await core.session.gate('error', node, toolGateOptions(core.session, edit));
        if (dec.action === 'inject') {
          finish(dec.output, 'ok', { injected: true });
          return dec.output;
        }
        if (dec.action === 'retry') {
          applyEdit(editedArgs(dec));
          continue;
        }
        if (dec.action === 'abort') {
          finish(undefined, 'aborted');
          throw core.abortError(ctx);
        }
        finish(undefined, 'error');
        throw error; // 'continue': the SDK sees the original error
      }

      const post = await core.session.gate('after', node, toolGateOptions(core.session, edit, { result }));
      if (post.action === 'inject') {
        finish(post.output, 'ok', { injected: true });
        return post.output;
      }
      if (post.action === 'retry') {
        applyEdit(editedArgs(post));
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

async function drainToLast(iterable: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown;
  for await (const value of iterable) last = value;
  return last;
}

function makeStreamingExecute(
  core: AdapterCore,
  toolName: string,
  original: ExecuteFn,
  check: SchemaCheck,
): ExecuteFn {
  // NON-async: returns the async generator synchronously so the SDK's
  // AsyncIterable sniffing sees it on the direct return value.
  return (input: unknown, options: unknown): AsyncGenerator<unknown> => {
    async function* run(): AsyncGenerator<unknown> {
      const attachWait = core.maybeWaitForAttach(); // waitForAttach: first-call gate
      if (attachWait !== undefined) await attachWait;
      const node: GateNode = { nodeId: toolNodeId(toolName), kind: 'tool', name: toolName };
      const ctx = core.session.currentRun();
      const instanceId = instanceIdOf(options);
      const startedAt = monotonicNow();
      core.startNode({
        nodeId: node.nodeId,
        kind: 'tool',
        name: toolName,
        instanceId,
        parentId: LLM_NODE_ID,
        input,
        extra: { streaming: true },
      });
      const execOptions = core.prepareToolOptions(options);

      const finish = (output: unknown, status: RunStatus, extra?: Record<string, unknown>): void =>
        core.finishNode({
          nodeId: node.nodeId,
          output,
          durationMs: elapsedMs(startedAt),
          status,
          extra: { instanceId, streaming: true, ...extra },
        });

      const raw = core.takeToolInput(toolCallIdOf(options));
      const pre = await core.session.gate(
        'before',
        node,
        toolGateOptions(core.session, () =>
          isEditableToolInput(input) ? { args: input, check, parsed: true, input: raw } : undefined,
        ),
      );
      if (pre.action === 'abort') {
        finish(undefined, 'aborted');
        throw core.abortError(ctx);
      }
      if (pre.action === 'inject') {
        finish(pre.output, 'ok', { injected: true });
        yield pre.output;
        return;
      }
      const preEdit = editedArgs(pre);
      const args = preEdit === undefined ? input : preEdit.args;

      let last: unknown;
      let chunks = 0;
      try {
        for await (const chunk of original(args, execOptions) as AsyncIterable<unknown>) {
          last = chunk;
          chunks += 1;
          core.pushToken(node.nodeId, 'text', safeChunkPreview(chunk));
          yield chunk;
        }
      } catch (error) {
        // No mid-stream gates (decisions.md #4): observe and rethrow.
        const aborted = isAbortError(error) || ctx?.signal.aborted === true;
        if (!aborted) core.errorNode(node.nodeId, error);
        finish(undefined, aborted ? 'aborted' : 'error');
        throw error;
      }
      finish(last, 'ok', { chunks });
    }
    return run();
  };
}
