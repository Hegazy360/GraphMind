/**
 * Observation of one LLM step: what the model produced, what it wants to call
 * next, and how much it cost.
 *
 * Two shapes to cover, both from `messages.create`:
 *  - non-streaming: a `Message` — walked once for text, `tool_use` blocks and
 *    server-tool blocks, then reported.
 *  - streaming (`stream: true`, and therefore also `messages.stream()`): a
 *    `Stream<RawMessageStreamEvent>`. The adapter returns a Proxy of it whose
 *    async iterator DELEGATES to the original, so every event the host sees is
 *    the original object, in the original order, unmodified. Nothing is
 *    buffered or re-encoded — the observer only reads what flows past.
 *
 * `tool_use` ids are queued into the core so a later `gm.wrapTools` call can
 * use the model's real call id as its `instanceId`. Server-executed tools
 * (`server_tool_use` — web search, code execution, ...) run on Anthropic's
 * side and cannot be held, so they are observed and marked `ungated`.
 */
import { isAbortError, type RunContext, type RunStatus } from '@graphmind-ai/client';
import type { AdapterCore } from './core.js';
import { LLM_NODE_ID, toolNodeId } from './ids.js';
import {
  SERVER_TOOL_USE_BLOCK,
  isServerToolResultBlock,
  isToolUseBlock,
  mapUsage,
  mergeUsage,
  parseToolInput,
  type ContentBlockLike,
  type MessageLike,
  type StreamEventLike,
  type UsageLike,
} from './sdk-types.js';

/** Per-step reporting state; `node.finished` is emitted at most once. */
export class StepReporter {
  private settled = false;
  private readonly serverTools = new Map<string, { name: string; startedAt: number }>();

  constructor(
    readonly core: AdapterCore,
    readonly instanceId: string,
    readonly scopeId: string,
    readonly ctx: RunContext | undefined,
    readonly startedAt: number = Date.now(),
  ) {}

  get done(): boolean {
    return this.settled;
  }

  finish(
    output: unknown,
    usage: UsageLike | undefined,
    status: RunStatus,
    extra?: Record<string, unknown>,
  ): void {
    if (this.settled) return;
    this.settled = true;
    this.core.finishNode({
      nodeId: LLM_NODE_ID,
      instanceId: this.instanceId,
      output,
      usage: mapUsage(usage),
      durationMs: Date.now() - this.startedAt,
      status,
      ...(extra !== undefined ? { extra } : {}),
    });
  }

  /** Report a failed step. Aborts are terminal, not errors. */
  fail(error: unknown, output?: unknown): void {
    if (this.settled) return;
    const aborted = isAbortError(error) || this.ctx?.signal.aborted === true;
    if (!aborted) this.core.errorNode(LLM_NODE_ID, this.instanceId, error);
    this.finish(output, undefined, aborted ? 'aborted' : 'error');
  }

  /**
   * Walk one assistant content block: queue `tool_use` ids for correlation
   * and surface server-executed tool calls as (ungated) tool nodes.
   */
  observeBlock(block: ContentBlockLike): void {
    try {
      if (isToolUseBlock(block)) {
        if (typeof block.id === 'string' && typeof block.name === 'string') {
          this.core.recordToolUse(this.scopeId, block.name, block.id);
        }
        return;
      }
      if (block.type === SERVER_TOOL_USE_BLOCK) {
        const { id, name } = block;
        if (typeof id !== 'string' || typeof name !== 'string') return;
        if (this.serverTools.has(id)) return;
        this.serverTools.set(id, { name, startedAt: Date.now() });
        this.core.startNode({
          nodeId: toolNodeId(name),
          kind: 'tool',
          name,
          instanceId: id,
          parentId: LLM_NODE_ID,
          input: parseToolInput(block.input),
          extra: { serverExecuted: true, ungated: true },
        });
        return;
      }
      if (isServerToolResultBlock(block)) {
        const id = block.tool_use_id;
        if (typeof id !== 'string') return;
        const started = this.serverTools.get(id);
        if (started === undefined) return;
        this.serverTools.delete(id);
        const content = block.content as { type?: string } | undefined;
        this.core.finishNode({
          nodeId: toolNodeId(started.name),
          instanceId: id,
          output: block.content,
          durationMs: Date.now() - started.startedAt,
          status:
            typeof content?.type === 'string' && content.type.endsWith('_error') ? 'error' : 'ok',
          extra: { serverExecuted: true },
        });
      }
    } catch {
      // observation must never break the host
    }
  }
}

/** Report a completed non-streaming `messages.create`. */
export function observeMessage(reporter: StepReporter, message: MessageLike): void {
  try {
    for (const block of message.content ?? []) reporter.observeBlock(block);
    const text = collectText(message);
    if (text.length > 0) reporter.core.pushToken(LLM_NODE_ID, 'text', text);
    reporter.finish(
      { text, stopReason: message.stop_reason ?? undefined, model: message.model },
      message.usage,
      'ok',
    );
  } catch (error) {
    reporter.fail(error);
  }
}

function collectText(message: MessageLike): string {
  let text = '';
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

interface OpenBlock {
  type: string | undefined;
  id: string | undefined;
  name: string | undefined;
  json: string;
}

/**
 * Return a Proxy of the SDK's `Stream` whose async iterator delegates to the
 * original one. Every other property/method is forwarded to the real object
 * (bound to it, so its private fields keep working).
 *
 * Note: `Stream.tee()` reads the stream's internal iterator rather than
 * `Symbol.asyncIterator`, so a branch obtained from `tee()` is not observed —
 * iterate the returned stream (or `for await` it) to keep observation.
 */
export function observeStream<S extends object>(reporter: StepReporter, stream: S): S {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(stream, {
    get(target, prop): unknown {
      if (prop === Symbol.asyncIterator) {
        return (): AsyncIterator<StreamEventLike> =>
          teeIterator(
            reporter,
            (target as AsyncIterable<StreamEventLike>)[Symbol.asyncIterator](),
          );
      }
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const cached = bound.get(prop);
      if (cached !== undefined) return cached;
      const fn = (value as (...args: unknown[]) => unknown).bind(target);
      bound.set(prop, fn);
      return fn;
    },
  }) as S;
}

async function* teeIterator(
  reporter: StepReporter,
  inner: AsyncIterator<StreamEventLike>,
): AsyncGenerator<StreamEventLike, void, undefined> {
  const open = new Map<number, OpenBlock>();
  let text = '';
  let usage: UsageLike | undefined;
  let stopReason: string | undefined;
  let model: string | undefined;
  let streamError: unknown;

  try {
    for (;;) {
      const next = await inner.next();
      if (next.done === true) break;
      const event = next.value;
      try {
        switch (event.type) {
          case 'message_start': {
            model = event.message?.model;
            usage = mergeUsage(usage, event.message?.usage);
            break;
          }
          case 'content_block_start': {
            const block = event.content_block ?? {};
            if (typeof event.index === 'number') {
              open.set(event.index, {
                type: block.type,
                id: block.id,
                name: block.name,
                json: '',
              });
            }
            // Queue `tool_use` ids as soon as the model announces them.
            if (isToolUseBlock(block)) reporter.observeBlock(block);
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta ?? {};
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              text += delta.text;
              reporter.core.pushToken(LLM_NODE_ID, 'text', delta.text);
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              reporter.core.pushToken(LLM_NODE_ID, 'reasoning', delta.thinking);
            } else if (
              delta.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string'
            ) {
              reporter.core.pushToken(LLM_NODE_ID, 'tool-args', delta.partial_json);
              if (typeof event.index === 'number') {
                const block = open.get(event.index);
                if (block !== undefined) block.json += delta.partial_json;
              }
            }
            break;
          }
          case 'content_block_stop': {
            if (typeof event.index !== 'number') break;
            const block = open.get(event.index);
            open.delete(event.index);
            if (block?.type === SERVER_TOOL_USE_BLOCK) {
              reporter.observeBlock({
                type: block.type,
                id: block.id,
                name: block.name,
                input: block.json.length > 0 ? parseToolInput(block.json) : {},
              });
            }
            break;
          }
          case 'message_delta': {
            usage = mergeUsage(usage, event.usage);
            const reason = event.delta?.stop_reason;
            if (typeof reason === 'string') stopReason = reason;
            break;
          }
          case 'error': {
            streamError = event.error ?? new Error('anthropic stream error');
            break;
          }
          default:
            break;
        }
      } catch {
        // never let observation disturb the host's stream
      }
      yield event;
    }
    if (streamError !== undefined) reporter.fail(streamError, { text, stopReason, model });
    else reporter.finish({ text, stopReason, model }, usage, 'ok');
  } catch (error) {
    reporter.fail(error, { text, stopReason, model });
    throw error; // the host's own error — always propagates untouched
  } finally {
    // The host broke out early (or threw): the step is over either way.
    if (!reporter.done) reporter.finish({ text, stopReason, model }, usage, 'ok');
    try {
      await inner.return?.(undefined);
    } catch {
      // closing the provider iterator is best-effort
    }
  }
}
