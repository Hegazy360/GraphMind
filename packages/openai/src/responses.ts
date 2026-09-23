/**
 * `client.responses.create` — the Responses API flavor.
 *
 * Streaming observation reads the event types the API defines
 * (`openai@6` `ResponseStreamEvent`):
 *   response.output_text.delta            -> `text` deltas
 *   response.refusal.delta                -> `text` deltas
 *   response.reasoning_summary_text.delta -> `reasoning` deltas
 *   response.reasoning_text.delta         -> `reasoning` deltas
 *   response.function_call_arguments.delta,
 *   response.custom_tool_call_input.delta,
 *   response.mcp_call_arguments.delta     -> `tool-args` deltas
 *   response.output_item.added / .done    -> provider-executed tool nodes
 *                                            (web_search, code_interpreter,
 *                                             file_search, image_generation,
 *                                             mcp_call, ...): observe-only,
 *                                            marked `ungated` (decisions.md #4)
 *   response.completed / .failed / .incomplete / error -> terminal state+usage
 *
 * `client.responses.stream()` and `client.responses.parse()` route through
 * this same path — see `wrap-client.ts`.
 */
import {
  normalizeFinishReason,
  toolCall,
  type RecordedToolCall,
  type RunStatus,
} from '@graphmind-ai/client';
import { promptKey, type PromptKey } from './invocation.js';
import type { LlmFlavor, ResultSummary, StepReporter } from './llm-step.js';
import { isAbortLikeError } from './signals.js';
import {
  isProviderExecutedItem,
  mapResponsesUsage,
  outputItemName,
  type RequestBodyLike,
  type ResponseEventLike,
  type ResponseLike,
  type ResponseOutputItemLike,
  type StreamLike,
  type UsageWithExtras,
} from './sdk-types.js';

const TEXT_DELTA_EVENTS = new Set(['response.output_text.delta', 'response.refusal.delta']);
const REASONING_DELTA_EVENTS = new Set([
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
]);
const TOOL_ARGS_DELTA_EVENTS = new Set([
  'response.function_call_arguments.delta',
  'response.custom_tool_call_input.delta',
  'response.mcp_call_arguments.delta',
  'response.code_interpreter_call_code.delta',
]);

/** Pull the assistant text out of a Response, preferring the SDK's helper field. */
function responseText(response: ResponseLike): string {
  if (typeof response.output_text === 'string') return response.output_text;
  let text = '';
  for (const item of response.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === 'string') text += part.text;
    }
  }
  return text;
}

/**
 * The locally-executed calls the model requested (contract C1 shape): a
 * `function_call`'s JSON arguments parsed (text kept as `inputText` when they
 * do not parse — an `incomplete` response cut them off); a
 * `custom_tool_call`'s freeform `input` recorded as the string it is.
 */
function functionCalls(response: ResponseLike): RecordedToolCall[] {
  const calls: RecordedToolCall[] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'function_call') {
      const call = toolCall(item.call_id, item.name, item.arguments);
      if (call !== undefined) calls.push(call);
    } else if (item.type === 'custom_tool_call') {
      if (typeof item.name !== 'string' || item.name.length === 0) continue;
      calls.push({
        ...(typeof item.call_id === 'string' && item.call_id.length > 0 ? { id: item.call_id } : {}),
        name: item.name,
        input: item.input ?? '',
      });
    }
  }
  return calls;
}

/**
 * Responses has no single finish reason: `status`, plus
 * `incomplete_details.reason` when it stopped early. The raw value is the
 * reason when there is one (`max_output_tokens`, `content_filter`), else the
 * status (`completed`, `failed`, `cancelled`, ...).
 */
function finishFields(
  response: ResponseLike,
  hasToolCalls: boolean,
): { finishReason?: string; rawFinishReason?: string } {
  const reason = response.incomplete_details?.reason;
  const raw =
    typeof reason === 'string' && reason.length > 0
      ? reason
      : typeof response.status === 'string' && response.status.length > 0
        ? response.status
        : undefined;
  const finishReason = normalizeFinishReason(raw, hasToolCalls);
  return {
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(raw !== undefined ? { rawFinishReason: raw } : {}),
  };
}

/** Emit observe-only nodes for the built-in tools OpenAI ran server-side. */
function reportProviderTools(reporter: StepReporter, response: ResponseLike): void {
  for (const item of response.output ?? []) {
    if (!isProviderExecutedItem(item.type)) continue;
    const name = outputItemName(item);
    reporter.core.providerToolStarted(item, name);
    reporter.core.providerToolFinished(item, name);
  }
}

function statusOf(response: ResponseLike): RunStatus {
  if (response.error != null) return 'error';
  if (response.status === 'failed') return 'error';
  if (response.status === 'cancelled') return 'aborted';
  return 'ok';
}

function summarizeResponse(reporter: StepReporter, response: ResponseLike): ResultSummary {
  reportProviderTools(reporter, response);
  reporter.core.tracker.noteResponseId(reporter.ctx.scopeId, response.id);
  const calls = functionCalls(response);
  const status = statusOf(response);
  return {
    output: {
      id: response.id,
      model: response.model,
      text: responseText(response),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      ...finishFields(response, calls.length > 0),
      status: response.status,
      ...(response.incomplete_details != null
        ? { incompleteReason: response.incomplete_details.reason }
        : {}),
      ...(response.error != null ? { error: response.error } : {}),
    },
    usage: mapResponsesUsage(response.usage),
    status,
    ...(status === 'error' ? { error: toError(response) } : {}),
  };
}

function toError(response: ResponseLike): Error {
  const message =
    (typeof response.error?.message === 'string' ? response.error.message : undefined) ??
    `response ${response.id ?? ''} finished with status ${response.status ?? 'failed'}`;
  const error = new Error(message);
  error.name = 'OpenAIResponseError';
  return error;
}

export const responsesFlavor: LlmFlavor = {
  api: 'responses',

  promptKey(body: RequestBodyLike): PromptKey {
    return promptKey(body.input, body.previous_response_id);
  },

  nodeInput(body: RequestBodyLike): unknown {
    return {
      api: 'responses',
      model: body.model,
      input: body.input,
      ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
      ...(body.previous_response_id !== undefined
        ? { previousResponseId: body.previous_response_id }
        : {}),
      ...(body.stream === true ? { stream: true } : {}),
    };
  },

  summarize(reporter: StepReporter, value: unknown): ResultSummary {
    return summarizeResponse(reporter, (value ?? {}) as ResponseLike);
  },

  async observeStream(reporter: StepReporter, stream: StreamLike): Promise<void> {
    let text = '';
    let usage: UsageWithExtras | undefined;
    let terminal: ResponseLike | undefined;
    let streamError: unknown;
    const openItems = new Map<string, string>();

    try {
      for await (const raw of stream) {
        const event = raw as ResponseEventLike;
        const type = event.type;
        if (typeof type !== 'string') continue;

        if (TEXT_DELTA_EVENTS.has(type) && typeof event.delta === 'string') {
          text += event.delta;
          reporter.token('text', event.delta);
          continue;
        }
        if (REASONING_DELTA_EVENTS.has(type) && typeof event.delta === 'string') {
          reporter.token('reasoning', event.delta);
          continue;
        }
        if (TOOL_ARGS_DELTA_EVENTS.has(type) && typeof event.delta === 'string') {
          reporter.token('tool-args', event.delta);
          continue;
        }

        switch (type) {
          case 'response.output_item.added': {
            const item = event.item;
            if (item !== undefined && isProviderExecutedItem(item.type)) {
              const name = outputItemName(item);
              if (typeof item.id === 'string') openItems.set(item.id, name);
              reporter.core.providerToolStarted(item, name);
            }
            break;
          }
          case 'response.output_item.done': {
            const item = event.item;
            if (item !== undefined && isProviderExecutedItem(item.type)) {
              const id = typeof item.id === 'string' ? item.id : undefined;
              const name = (id !== undefined ? openItems.get(id) : undefined) ?? outputItemName(item);
              if (id !== undefined) openItems.delete(id);
              reporter.core.providerToolFinished(item, name);
            }
            break;
          }
          case 'response.completed':
          case 'response.failed':
          case 'response.incomplete':
            terminal = event.response;
            if (terminal !== undefined) usage = mapResponsesUsage(terminal.usage) ?? usage;
            break;
          case 'error':
            streamError = streamEventError(event);
            break;
          default:
            break;
        }
      }

      if (streamError !== undefined) {
        reporter.error(streamError);
        reporter.finish({ text }, 'error', usage, { streamed: true });
        return;
      }
      if (terminal !== undefined) {
        const summary = summarizeResponse(reporter, terminal);
        if (summary.status === 'error' && summary.error !== undefined) reporter.error(summary.error);
        reporter.finish(summary.output, summary.status, summary.usage ?? usage, {
          streamed: true,
          ...summary.extra,
        });
        return;
      }
      reporter.finish({ text }, reporter.endStatus(), usage, { streamed: true });
    } catch (error) {
      // The observer runs detached from the host: report, never rethrow.
      try {
        const aborted = isAbortLikeError(error);
        if (!aborted) reporter.error(error);
        reporter.finish({ text }, aborted ? 'aborted' : 'error', usage, { streamed: true });
      } catch {
        // never throw out of the observer
      }
    }
  },
};

function streamEventError(event: ResponseEventLike): Error {
  const error = new Error(event.message ?? 'OpenAI responses stream error');
  error.name = typeof event.code === 'string' && event.code.length > 0 ? event.code : 'OpenAIError';
  return error;
}
