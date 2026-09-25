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
import { monotonicNow, elapsedMs } from '@graphmind-ai/client';
import {
  isAbortError,
  normalizeFinishReason,
  resultGateOptions,
  toolCall,
  type GateNode,
  type RecordedToolCall,
  type RunContext,
  type RunStatus,
} from '@graphmind-ai/client';
import type { AdapterCore } from './core.js';
import { LLM_NODE_ID, LLM_NODE_NAME, toolNodeId } from './ids.js';
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

const LLM_GATE_NODE: GateNode = { nodeId: LLM_NODE_ID, kind: 'llm', name: LLM_NODE_NAME };

/** Per-step reporting state; `node.finished` is emitted at most once. */
export class StepReporter {
  private settled = false;
  private readonly serverTools = new Map<string, { name: string; startedAt: number }>();

  constructor(
    readonly core: AdapterCore,
    readonly instanceId: string,
    readonly scopeId: string,
    readonly ctx: RunContext | undefined,
    readonly startedAt: number = monotonicNow(),
  ) {}

  get done(): boolean {
    return this.settled;
  }

  /**
   * The status a *cleanly ended* step should carry.
   *
   * The Anthropic SDK swallows abort errors inside its stream iterator ("if
   * the user calls `stream.controller.abort()`, we should exit without
   * throwing" — core/streaming.mjs), so a request the debugger aborted mid
   * stream looks exactly like one that finished. Without this check the
   * canvas would show an aborted step as a successful one carrying a
   * truncated answer.
   */
  endStatus(): RunStatus {
    return this.ctx?.signal.aborted === true ? 'aborted' : 'ok';
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
      durationMs: elapsedMs(this.startedAt),
      status,
      ...(extra !== undefined ? { extra } : {}),
    });
  }

  /**
   * The step's `after` gate: post-response, before the host has the whole
   * message (a `Message` not yet returned, a stream not yet past its last
   * event). While a debugger is attached it hands the session the normalized
   * output — what the smart hold `truncated-tool-call` inspects; detached it
   * is called with no options, like every other gate. Resolves true when the
   * debugger aborted the run there (the caller finishes the step `aborted`
   * and throws the run's AbortError). `retry` / `inject` cannot re-run or
   * substitute a model call the SDK already made and continue, with a
   * warning. Never rejects.
   */
  async gateAfter(output: unknown): Promise<boolean> {
    try {
      const decision = await this.core.session.gate('after', LLM_GATE_NODE, resultGateOptions(this.core.session, output));
      if (decision.action === 'abort') return true;
      if (decision.action === 'retry' || decision.action === 'inject') {
        this.core.warner.warn(
          `llm-after-${decision.action}`,
          `the debugger asked to ${decision.action} a model step at its after gate, but the Anthropic ` +
            "SDK's call has already been made; the step continued with the model's real output.",
        );
      }
    } catch {
      // a gate never rejects; belt and braces
    }
    return false;
  }

  /**
   * Report a failed step. Aborts are terminal, not errors. `usage` is what the
   * stream reported before it failed (message_start's billed prompt): kept.
   */
  fail(error: unknown, output?: unknown, usage?: UsageLike): void {
    if (this.settled) return;
    const aborted = isAbortError(error) || this.ctx?.signal.aborted === true;
    if (!aborted) this.core.errorNode(LLM_NODE_ID, this.instanceId, error);
    this.finish(output, usage, aborted ? 'aborted' : 'error');
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
        this.serverTools.set(id, { name, startedAt: monotonicNow() });
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
          durationMs: elapsedMs(started.startedAt),
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

/**
 * `node.finished.output` of an LLM step (contract C1): the text, the
 * normalized `finishReason` with Anthropic's own `stop_reason` as
 * `rawFinishReason`, and the `tool_use` calls the model requested
 * (`server_tool_use` blocks run on Anthropic's side and are their own tool
 * nodes). `stopReason` is the 0.5 name of `rawFinishReason`, kept through 0.6.x.
 */
export function stepOutput(
  text: string,
  stopReason: string | undefined,
  model: string | undefined,
  calls: RecordedToolCall[] = [],
): Record<string, unknown> {
  const finishReason = normalizeFinishReason(stopReason, calls.length > 0);
  return {
    text,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(stopReason !== undefined ? { rawFinishReason: stopReason } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
    stopReason,
    model,
  };
}

/** The `tool_use` blocks of a complete message, as recorded tool calls. */
function messageToolCalls(message: MessageLike): RecordedToolCall[] {
  const calls: RecordedToolCall[] = [];
  for (const block of message.content ?? []) {
    if (!isToolUseBlock(block)) continue;
    const call = toolCall(block.id, block.name, block.input);
    if (call !== undefined) calls.push(call);
  }
  return calls;
}

/**
 * Report a completed non-streaming `messages.create`, through the step's
 * `after` gate before the host receives it. Rejects only with the run's
 * AbortError, when the debugger aborted there.
 */
export async function observeMessage(reporter: StepReporter, message: MessageLike): Promise<void> {
  let output: Record<string, unknown>;
  let usage: UsageLike | undefined;
  try {
    for (const block of message.content ?? []) reporter.observeBlock(block);
    const text = collectText(message);
    if (text.length > 0) reporter.core.pushToken(LLM_NODE_ID, 'text', text);
    output = stepOutput(text, message.stop_reason ?? undefined, message.model, messageToolCalls(message));
    usage = message.usage;
  } catch (error) {
    reporter.fail(error);
    return;
  }
  if (await reporter.gateAfter(output)) {
    reporter.finish(output, usage, 'aborted');
    throw reporter.core.abortError(reporter.ctx);
  }
  reporter.finish(output, usage, 'ok');
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
  /** Completed `tool_use` calls by block index (stream order on output). */
  const calls = new Map<number, RecordedToolCall>();
  let text = '';
  let usage: UsageLike | undefined;
  let stopReason: string | undefined;
  let model: string | undefined;
  let streamError: unknown;
  /** Completed calls plus any `tool_use` block the stream never closed. */
  const output = (): Record<string, unknown> => {
    try {
      const all = new Map(calls);
      for (const [index, block] of open) {
        if (block.type !== 'tool_use' || all.has(index)) continue;
        const call = toolCall(block.id, block.name, block.json);
        if (call !== undefined) all.set(index, call);
      }
      const ordered = [...all.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
      return stepOutput(text, stopReason, model, ordered);
    } catch {
      return { text, stopReason, model }; // reporting must never throw
    }
  };
  /** The step's `after` gate already ran (it runs once per stream). */
  let gated = false;
  /**
   * The step's `after` gate, before the host gets the message's last event:
   * on `abort`, finish the step aborted and throw the run's AbortError (the
   * host's iteration rejects with it). Not after a stream `error` event.
   */
  const gateOnce = async (): Promise<void> => {
    if (gated || streamError !== undefined) return;
    gated = true;
    const snapshot = output();
    if (await reporter.gateAfter(snapshot)) {
      reporter.finish(snapshot, usage, 'aborted');
      throw reporter.core.abortError(reporter.ctx);
    }
  };

  try {
    for (;;) {
      const next = await inner.next();
      if (next.done === true) break;
      const event = next.value;
      let stopping = false;
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
            if (block?.type === 'tool_use') {
              // An argument-less call streams no deltas: '' is `{}`.
              const call = toolCall(block.id, block.name, block.json);
              if (call !== undefined) calls.set(event.index, call);
            } else if (block?.type === SERVER_TOOL_USE_BLOCK) {
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
          case 'message_stop': {
            stopping = true;
            break;
          }
          default:
            break;
        }
      } catch {
        // never let observation disturb the host's stream
      }
      // Held before `message_stop`: once the host has it, the SDK's
      // MessageStream hands over the final message (and tools run).
      if (stopping) await gateOnce();
      yield event;
    }
    await gateOnce(); // a stream that ended without `message_stop`
    if (streamError !== undefined) reporter.fail(streamError, output(), usage);
    else reporter.finish(output(), usage, reporter.endStatus());
  } catch (error) {
    reporter.fail(error, output(), usage);
    throw error; // the host's own error — always propagates untouched
  } finally {
    // The host broke out early (or threw): the step is over either way.
    if (!reporter.done) reporter.finish(output(), usage, reporter.endStatus());
    try {
      await inner.return?.(undefined);
    } catch {
      // closing the provider iterator is best-effort
    }
  }
}
