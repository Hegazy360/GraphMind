/**
 * Tool wrapper: wraps each tool's `execute` with gates. Pure decoration of
 * the user-provided ToolSet — the SDK sees ordinary tools.
 *
 *  - gate('before-tool') BEFORE invoking the original execute. Parallel tool
 *    calls in one step each call execute independently, so they gate
 *    independently.
 *  - try/catch around the original execute. On throw the error gate fires
 *    BEFORE the SDK ever sees the error (the SDK only observes what our
 *    wrapper returns/throws):
 *      inject   -> swallow error, return injected value as the tool result
 *      retry    -> re-invoke the original execute
 *      continue -> rethrow the original error to the SDK
 *      abort    -> rethrow as well (SDK turns it into a tool-error part)
 */

import type { Tool, ToolSet } from 'ai';
import type { GateEngine } from './gate.js';
import type { NodeInfo } from './protocol.js';

export function wrapToolsForDebug<TOOLS extends ToolSet>(
  tools: TOOLS,
  engine: GateEngine,
): TOOLS {
  const wrapped: Record<string, unknown> = {};

  for (const [toolName, t] of Object.entries(tools)) {
    const original = t.execute as
      | ((input: unknown, options: unknown) => PromiseLike<unknown> | unknown)
      | undefined;
    if (original === undefined) {
      wrapped[toolName] = t;
      continue;
    }

    wrapped[toolName] = {
      ...t,
      execute: async (input: unknown, options: { toolCallId?: string }) => {
        const node: NodeInfo = {
          kind: 'tool',
          toolName,
          input,
          ...(options?.toolCallId !== undefined
            ? { toolCallId: options.toolCallId }
            : {}),
        };
        engine.emitNode('tool-call', node);

        let attempt = 0;
        for (;;) {
          const pre = await engine.timedGate('before-tool', { ...node, attempt });
          if (pre.type === 'abort') {
            throw new Error(`aborted by debugger at before-tool:${toolName}`);
          }
          if (pre.type === 'inject') {
            engine.trace.mark('tool:inject-skip-exec', { toolName, attempt });
            return pre.output;
          }
          try {
            engine.trace.mark('tool:wrapper-exec-start', {
              toolName,
              toolCallId: options?.toolCallId,
              attempt,
            });
            const result = await original(input, options);
            engine.trace.mark('tool:wrapper-exec-end', { toolName, attempt });
            return result;
          } catch (error) {
            const errorText = error instanceof Error ? error.message : String(error);
            engine.trace.mark('tool:wrapper-exec-error', { toolName, attempt, error: errorText });
            engine.emitNode('tool-error', { ...node, attempt, error: errorText });

            const post = await engine.timedGate('on-error', {
              ...node,
              attempt,
              error: errorText,
            });
            if (post.type === 'inject') {
              engine.trace.mark('tool:error-injected', { toolName, attempt });
              return post.output;
            }
            if (post.type === 'retry') {
              attempt += 1;
              continue;
            }
            throw error; // 'continue' and 'abort': the SDK sees the original error
          }
        }
      },
    };
  }

  return wrapped as TOOLS;
}
