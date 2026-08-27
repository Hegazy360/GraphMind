/**
 * `client.chat.completions.create` — the Chat Completions flavor.
 *
 * Streaming observation reads exactly the fields the API defines
 * (`openai@6` `ChatCompletionChunk`):
 *   choices[].delta.content            -> `text` deltas
 *   choices[].delta.refusal            -> `text` deltas (marked in the output)
 *   choices[].delta.reasoning_content  -> `reasoning` deltas (OpenAI-compatible
 *                                         reasoning models; absent upstream)
 *   choices[].delta.tool_calls[].function.arguments -> `tool-args` deltas
 *   choices[].finish_reason            -> reported on node.finished
 *   usage                              -> only present with
 *                                         `stream_options: {include_usage:true}`
 */
import type { StepReporter, LlmFlavor, ResultSummary } from './llm-step.js';
import { promptKey, type PromptKey } from './invocation.js';
import { isAbortLikeError } from './signals.js';
import {
  mapChatUsage,
  parseToolInput,
  type ChatChunkLike,
  type ChatCompletionLike,
  type RequestBodyLike,
  type StreamLike,
  type ToolCallLike,
} from './sdk-types.js';

export interface ObservedToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
}

function mapToolCalls(calls: ToolCallLike[] | undefined): ObservedToolCall[] {
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => ({
    ...(call.id !== undefined ? { id: call.id } : {}),
    ...(call.function?.name !== undefined
      ? { name: call.function.name }
      : call.custom?.name !== undefined
        ? { name: call.custom.name }
        : {}),
    arguments: parseToolInput(call.function?.arguments ?? call.custom?.input),
  }));
}

export const chatFlavor: LlmFlavor = {
  api: 'chat.completions',

  promptKey(body: RequestBodyLike): PromptKey {
    return promptKey(body.messages);
  },

  nodeInput(body: RequestBodyLike): unknown {
    return {
      api: 'chat.completions',
      model: body.model,
      messages: body.messages,
      ...(body.stream === true ? { stream: true } : {}),
    };
  },

  summarize(_reporter: StepReporter, value: unknown): ResultSummary {
    const completion = (value ?? {}) as ChatCompletionLike;
    const choice = completion.choices?.[0];
    const message = choice?.message;
    const text = message?.content ?? '';
    const toolCalls = mapToolCalls(message?.tool_calls);
    return {
      output: {
        id: completion.id,
        model: completion.model,
        text,
        ...(message?.refusal != null ? { refusal: message.refusal } : {}),
        ...(message?.reasoning_content != null ? { reasoning: message.reasoning_content } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        finishReason: choice?.finish_reason ?? undefined,
      },
      usage: mapChatUsage(completion.usage),
      status: 'ok',
    };
  },

  async observeStream(reporter: StepReporter, stream: StreamLike): Promise<void> {
    let text = '';
    let refusal = '';
    let finishReason: string | undefined;
    let usage = mapChatUsage(undefined);
    let id: string | undefined;
    let model: string | undefined;
    const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();

    try {
      for await (const raw of stream) {
        const chunk = raw as ChatChunkLike;
        if (id === undefined && typeof chunk.id === 'string') id = chunk.id;
        if (model === undefined && typeof chunk.model === 'string') model = chunk.model;
        if (chunk.usage != null) usage = mapChatUsage(chunk.usage) ?? usage;

        for (const choice of chunk.choices ?? []) {
          if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (delta === undefined) continue;
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            text += delta.content;
            reporter.token('text', delta.content);
          }
          if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
            refusal += delta.refusal;
            reporter.token('text', delta.refusal);
          }
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            reporter.token('reasoning', delta.reasoning_content);
          }
          for (const call of delta.tool_calls ?? []) {
            const index = typeof call.index === 'number' ? call.index : 0;
            const entry = toolCalls.get(index) ?? { args: '' };
            if (typeof call.id === 'string') entry.id = call.id;
            if (typeof call.function?.name === 'string') entry.name = call.function.name;
            const args = call.function?.arguments;
            if (typeof args === 'string' && args.length > 0) {
              entry.args += args;
              reporter.token('tool-args', args);
            }
            toolCalls.set(index, entry);
          }
        }
      }

      const observed = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, entry]) => ({
          ...(entry.id !== undefined ? { id: entry.id } : {}),
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          arguments: parseToolInput(entry.args),
        }));

      reporter.finish(
        {
          id,
          model,
          text,
          ...(refusal.length > 0 ? { refusal } : {}),
          ...(observed.length > 0 ? { toolCalls: observed } : {}),
          finishReason,
        },
        'ok',
        usage,
        { streamed: true },
      );
    } catch (error) {
      // The observer runs detached from the host: report, never rethrow.
      try {
        const aborted = isAbortLikeError(error);
        if (!aborted) reporter.error(error);
        reporter.finish({ text, finishReason }, aborted ? 'aborted' : 'error', usage, {
          streamed: true,
        });
      } catch {
        // never throw out of the observer
      }
    }
  },
};
