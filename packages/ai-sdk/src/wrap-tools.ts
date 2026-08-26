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
 * Streaming `execute` (declared `async function*`) gets a NON-async delegate
 * (decisions.md #4): the SDK type-sniffs execute's direct return value, so
 * the wrapper synchronously returns an async generator that gates at
 * before-start only, observes chunks, and never pauses mid-stream (errors
 * are observed, not gated).
 *
 * Provider-executed tools have no local `execute`; they pass through
 * untouched and are observed from the stream tee instead.
 */
import { isAbortError, type GateNode } from '@graphmind/client';
import type { RunStatus } from '@graphmind/schema';
import type { ToolSet } from 'ai';
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
    wrapped[toolName] = {
      ...t,
      execute: isAsyncGeneratorFunction(exec)
        ? makeStreamingExecute(core, toolName, exec)
        : makeExecute(core, toolName, exec),
    };
  }
  return wrapped as TOOLS;
}

function instanceIdOf(options: unknown): string {
  const toolCallId = (options as ToolCallOptionsLike | null | undefined)?.toolCallId;
  return typeof toolCallId === 'string' ? toolCallId : nextId('call');
}

function safeChunkPreview(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  try {
    return JSON.stringify(chunk)?.slice(0, 500) ?? String(chunk);
  } catch {
    return '[unserializable chunk]';
  }
}

function makeExecute(core: AdapterCore, toolName: string, original: ExecuteFn): ExecuteFn {
  return async (input: unknown, options: unknown): Promise<unknown> => {
    const node: GateNode = { nodeId: toolNodeId(toolName), kind: 'tool', name: toolName };
    const ctx = core.session.currentRun();
    const instanceId = instanceIdOf(options);
    const startedAt = Date.now();
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
        durationMs: Date.now() - startedAt,
        status,
        extra: { instanceId, ...extra },
      });

    for (;;) {
      const pre = await core.session.gate('before', node);
      if (pre.action === 'abort') {
        finish(undefined, 'aborted');
        throw core.abortError(ctx);
      }
      if (pre.action === 'inject') {
        finish(pre.output, 'ok', { injected: true });
        return pre.output;
      }
      // 'retry' before execution is equivalent to continue.

      let result: unknown;
      try {
        result = await original(input, execOptions);
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
        const dec = await core.session.gate('error', node);
        if (dec.action === 'inject') {
          finish(dec.output, 'ok', { injected: true });
          return dec.output;
        }
        if (dec.action === 'retry') continue;
        if (dec.action === 'abort') {
          finish(undefined, 'aborted');
          throw core.abortError(ctx);
        }
        finish(undefined, 'error');
        throw error; // 'continue': the SDK sees the original error
      }

      const post = await core.session.gate('after', node);
      if (post.action === 'inject') {
        finish(post.output, 'ok', { injected: true });
        return post.output;
      }
      if (post.action === 'retry') continue;
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

function makeStreamingExecute(core: AdapterCore, toolName: string, original: ExecuteFn): ExecuteFn {
  // NON-async: returns the async generator synchronously so the SDK's
  // AsyncIterable sniffing sees it on the direct return value.
  return (input: unknown, options: unknown): AsyncGenerator<unknown> => {
    async function* run(): AsyncGenerator<unknown> {
      const node: GateNode = { nodeId: toolNodeId(toolName), kind: 'tool', name: toolName };
      const ctx = core.session.currentRun();
      const instanceId = instanceIdOf(options);
      const startedAt = Date.now();
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
          durationMs: Date.now() - startedAt,
          status,
          extra: { instanceId, streaming: true, ...extra },
        });

      const pre = await core.session.gate('before', node);
      if (pre.action === 'abort') {
        finish(undefined, 'aborted');
        throw core.abortError(ctx);
      }
      if (pre.action === 'inject') {
        finish(pre.output, 'ok', { injected: true });
        yield pre.output;
        return;
      }

      let last: unknown;
      let chunks = 0;
      try {
        for await (const chunk of original(input, execOptions) as AsyncIterable<unknown>) {
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
