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
 *                                         (the LAST chunk, with empty choices)
 *
 * `node.finished.output` (contract C1): `finishReason` normalized, the API's
 * own `finish_reason` as `rawFinishReason`, and `toolCalls: [{id, name,
 * input, inputText?}]`. A function call's arguments are JSON text; when they
 * do not parse (cut off by `length`), `input` is null and `inputText` keeps
 * the text. A custom (freeform) tool's input is text by design and is
 * recorded as the `input` string.
 */
import { normalizeFinishReason, toolCall, type RecordedToolCall } from '@graphmind-ai/client';
import type { StepReporter, LlmFlavor, ResultSummary } from './llm-step.js';
import { promptKey, type PromptKey } from './invocation.js';
import { isAbortLikeError } from './signals.js';
import {
  mapChatUsage,
  type ChatChunkLike,
  type ChatCompletionLike,
  type RequestBodyLike,
  type StreamLike,
  type ToolCallLike,
} from './sdk-types.js';

function mapToolCalls(calls: ToolCallLike[] | undefined): RecordedToolCall[] {
  if (!Array.isArray(calls)) return [];
  const out: RecordedToolCall[] = [];
  for (const call of calls) {
    if (call === null || typeof call !== 'object') continue;
    if (call.function === undefined && call.custom !== undefined) {
      const name = call.custom.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      out.push({
        ...(typeof call.id === 'string' && call.id.length > 0 ? { id: call.id } : {}),
        name,
        input: call.custom.input ?? '',
      });
      continue;
    }
    const recorded = toolCall(call.id, call.function?.name, call.function?.arguments);
    if (recorded !== undefined) out.push(recorded);
  }
  return out;
}

/** `finishReason` + `rawFinishReason` for a chat completion. */
function finishFields(
  raw: string | null | undefined,
  hasToolCalls: boolean,
): { finishReason?: string; rawFinishReason?: string } {
  const finishReason = normalizeFinishReason(raw, hasToolCalls);
  return {
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(typeof raw === 'string' && raw.length > 0 ? { rawFinishReason: raw } : {}),
  };
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
        ...finishFields(choice?.finish_reason, toolCalls.length > 0),
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
    /** The streamed calls in index order; unparseable (cut-off) args kept as text. */
    const collected = (): RecordedToolCall[] => {
      const out: RecordedToolCall[] = [];
      for (const [, entry] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        const call = toolCall(entry.id, entry.name, entry.args);
        if (call !== undefined) out.push(call);
      }
      return out;
    };

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

      const observed = collected();

      reporter.finish(
        {
          id,
          model,
          text,
          ...(refusal.length > 0 ? { refusal } : {}),
          ...(observed.length > 0 ? { toolCalls: observed } : {}),
          ...finishFields(finishReason, observed.length > 0),
        },
        reporter.endStatus(),
        usage,
        { streamed: true },
      );
    } catch (error) {
      // The observer runs detached from the host: report, never rethrow.
      try {
        const aborted = isAbortLikeError(error);
        if (!aborted) reporter.error(error);
        const observed = collected();
        reporter.finish(
          {
            text,
            ...(observed.length > 0 ? { toolCalls: observed } : {}),
            ...finishFields(finishReason, observed.length > 0),
          },
          aborted ? 'aborted' : 'error',
          usage,
          { streamed: true },
        );
      } catch {
        // never throw out of the observer
      }
    }
  },
};
