/**
 * The replay model: a language model that answers from a recording instead
 * of from a provider.
 *
 * WHY THIS EXISTS AND A GATE DOES NOT DO IT. Every other replayed call is
 * answered at its `before` gate with `inject` — the adapter hands the
 * recorded value straight back. A model step cannot work that way: the SDK
 * needs the provider's own **native** result (`{content, finishReason,
 * usage, warnings}`), and what GraphMind records is a normalized summary
 * (`{text, finishReason, toolCalls}`). The summary is enough to RECONSTRUCT
 * a native result, but only the adapter knows that shape — so replay of a
 * model step is a model substitution, done here, and `wrapModel` installs
 * it when a tape is loaded.
 *
 * WHAT IS FAITHFUL AND WHAT IS NOT. Reconstructed from the recording:
 *   - the assistant text, as one `text` part;
 *   - every client-executed tool call the model requested, with the
 *     arguments it chose (so the same tools run with the same inputs — the
 *     trajectory, which is what a regression test is about);
 *   - the normalized finish reason and the recorded token usage.
 * NOT reconstructed, because it was never recorded: provider metadata, the
 * raw HTTP response, reasoning parts, and the exact token *stream* (a
 * replayed stream emits the text as a single delta). Logprobs and
 * provider-executed tool results are likewise absent. A replayed step is
 * therefore a faithful account of WHAT THE MODEL DECIDED, not a byte-exact
 * replay of the provider's response — `graphmind replay` says so, and
 * nothing here pretends otherwise.
 *
 * A step with no entry left on the tape is a miss, handled by the tape's
 * own policy (`--on-miss`): fatal by default, so a diverged agent stops
 * rather than silently calling the real provider mid-replay.
 */
import { ReplayMissError, type ReplayTape, type TapeEntry } from '@graphmind-ai/client';
import { LLM_NODE_ID } from './ids.js';

/** `node.finished.output` of a recorded LLM step, as this module reads it. */
interface RecordedStep {
  text?: unknown;
  finishReason?: unknown;
  rawFinishReason?: unknown;
  toolCalls?: { id?: unknown; name?: unknown; input?: unknown; inputText?: unknown }[];
}

/** The native content parts a reconstructed result carries. */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string };

function readStep(entry: TapeEntry): RecordedStep {
  const output = entry.output;
  return output !== null && typeof output === 'object' ? (output as RecordedStep) : {};
}

/**
 * Native `content` for one recorded step. A tool call whose arguments never
 * parsed (`inputText`) is replayed with that raw text, exactly as truncated
 * as it was — the recording's truncated-tool-call is part of the behaviour
 * under test, not something to repair here.
 */
function contentOf(step: RecordedStep): ContentPart[] {
  const content: ContentPart[] = [];
  const text = typeof step.text === 'string' ? step.text : '';
  if (text !== '') content.push({ type: 'text', text });
  let index = 0;
  for (const call of Array.isArray(step.toolCalls) ? step.toolCalls : []) {
    const name = typeof call.name === 'string' ? call.name : undefined;
    if (name === undefined) continue;
    const id = typeof call.id === 'string' && call.id !== '' ? call.id : `replay_${index}`;
    const input =
      typeof call.inputText === 'string'
        ? call.inputText
        : JSON.stringify(call.input === undefined ? {} : call.input);
    content.push({ type: 'tool-call', toolCallId: id, toolName: name, input });
    index += 1;
  }
  return content;
}

/**
 * The provider's own finish-reason spelling when it was recorded, else the
 * normalized one. The middleware normalizes whatever it is given, so a
 * replayed step records the same `finishReason` the original did.
 */
function finishReasonOf(step: RecordedStep): { unified: string; raw?: string } {
  const unified = typeof step.finishReason === 'string' ? step.finishReason : 'stop';
  const raw = typeof step.rawFinishReason === 'string' ? step.rawFinishReason : undefined;
  return raw === undefined ? { unified } : { unified, raw };
}

/** Recorded usage, in the nested shape the current model specs use. */
function usageOf(entry: TapeEntry): Record<string, unknown> {
  const usage = entry.usage;
  const read = (key: string): number => {
    if (usage === null || typeof usage !== 'object') return 0;
    const value = (usage as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const input = read('inputTokens');
  const output = read('outputTokens');
  return {
    inputTokens: { total: input, noCache: input - read('cacheReadTokens'), cacheRead: read('cacheReadTokens'), cacheWrite: read('cacheWriteTokens') },
    outputTokens: { total: output, text: output - read('reasoningTokens'), reasoning: read('reasoningTokens') },
  };
}

/** A model-spec warning telling anyone reading the result where it came from. */
const REPLAY_WARNING = {
  type: 'other' as const,
  message:
    'this response was replayed from a GraphMind recording, not produced by a provider ' +
    '(text and tool calls are faithful; provider metadata and token streaming are not)',
};

/**
 * A language model that serves `tape`'s recorded LLM steps in order.
 *
 * Deliberately duck-typed rather than typed against one `LanguageModelVn`:
 * this package supports `ai >=6 <8` (specs V3 and V4), whose result shapes
 * agree on everything used here, and the middleware that wraps this model
 * already reads results duck-typed (`sdk-types.ts`).
 */
export function createReplayModel(
  tape: ReplayTape,
  modelId: string,
  /**
   * The model being replaced. Only its `specificationVersion` is used: this
   * package supports `ai >=6 <8`, whose model specs are V3 and V4, and a
   * replay model that claims the wrong one is silently put through the
   * SDK's cross-spec conversion (which reshapes tool calls — a replayed run
   * then produced text and no tool calls at all). Inheriting it from the
   * real model is right by construction on every supported major.
   */
  original: unknown,
): Record<string, unknown> {
  const specificationVersion =
    typeof (original as { specificationVersion?: unknown } | undefined)?.specificationVersion === 'string'
      ? (original as { specificationVersion: string }).specificationVersion
      : 'v3';
  const next = (): TapeEntry => {
    const entry = tape.next(LLM_NODE_ID);
    if (entry === undefined) {
      throw new ReplayMissError(
        'the recording has no further LLM steps — the agent took more model turns than it did ' +
          'when recorded. Re-record, or pass --on-miss=live to let the extra steps call the provider.',
        { kind: 'miss', nodeId: LLM_NODE_ID, nodeKind: 'llm', ordinal: -1 },
      );
    }
    return entry;
  };

  /**
   * The real model, for the steps replay must not answer: past a
   * counterfactual cut (the conversation has diverged, so the recorded
   * reply answers a prompt that no longer exists) and under
   * `--live-model` (the point there is to let the model decide afresh).
   * Calling it means a provider request, a key, and tokens — which
   * `graphmind replay` warns about before it starts.
   */
  const real = original as {
    doGenerate?: (options: unknown) => Promise<unknown>;
    doStream?: (options: unknown) => Promise<unknown>;
  };

  return {
    specificationVersion,
    provider: 'graphmind.replay',
    modelId,
    supportedUrls: {},

    doGenerate: async (options: unknown) => {
      if (tape.modelIsLive(LLM_NODE_ID)) return await real.doGenerate?.(options);
      const entry = next();
      const step = readStep(entry);
      return {
        content: contentOf(step),
        finishReason: finishReasonOf(step),
        usage: usageOf(entry),
        warnings: [REPLAY_WARNING],
      };
    },

    doStream: async (options: unknown) => {
      if (tape.modelIsLive(LLM_NODE_ID)) return await real.doStream?.(options);
      const entry = next();
      const step = readStep(entry);
      const content = contentOf(step);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [REPLAY_WARNING] });
            for (const part of content) {
              if (part.type === 'text') {
                // One delta, not a token-by-token re-enactment: the
                // recording kept the text, never the timing of its pieces.
                controller.enqueue({ type: 'text-start', id: '0' });
                controller.enqueue({ type: 'text-delta', id: '0', delta: part.text });
                controller.enqueue({ type: 'text-end', id: '0' });
              } else {
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                });
              }
            }
            controller.enqueue({
              type: 'finish',
              finishReason: finishReasonOf(step),
              usage: usageOf(entry),
            });
            controller.close();
          },
        }),
      };
    },
  };
}
