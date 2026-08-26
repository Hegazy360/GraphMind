/**
 * A scripted HTTP layer for the real `@anthropic-ai/sdk` client.
 *
 * The SDK accepts a custom `fetch`, so every test drives the REAL client (real
 * request building, real SSE parsing, real `MessageStream`) against responses
 * we script here. No API keys, no network, and `requests` is the ground truth
 * for "was an HTTP request issued?" assertions.
 */

export interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
  at: number;
}

/** One scripted turn: either a whole Message, or an SSE event script. */
export type ScriptedTurn =
  | { message: Record<string, unknown> }
  | { events: Record<string, unknown>[]; chunkDelayMs?: number }
  | { status: number; error: Record<string, unknown> };

export type Script = (
  body: Record<string, unknown>,
  index: number,
) => ScriptedTurn | Promise<ScriptedTurn>;

const encoder = new TextEncoder();

function sseBody(events: Record<string, unknown>[], chunkDelayMs: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= events.length) {
        controller.close();
        return;
      }
      const event = events[i++]!;
      if (chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
      controller.enqueue(
        encoder.encode(`event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`),
      );
    },
  });
}

export class FakeAnthropicTransport {
  readonly requests: RecordedRequest[] = [];

  constructor(private readonly script: Script) {}

  /** Pass as `new Anthropic({ fetch: transport.fetch })`. */
  readonly fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown } | undefined)?.url ?? input);
    let body: Record<string, unknown> = {};
    try {
      const raw = init?.body;
      if (typeof raw === 'string') body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const index = this.requests.length;
    this.requests.push({ url, body, at: Date.now() });

    const turn = await this.script(body, index);

    if ('error' in turn) {
      return new Response(JSON.stringify(turn.error), {
        status: turn.status,
        headers: { 'content-type': 'application/json', 'request-id': `req_${index}` },
      });
    }
    if ('events' in turn) {
      return new Response(sseBody(turn.events, turn.chunkDelayMs ?? 0), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'request-id': `req_${index}` },
      });
    }
    return new Response(JSON.stringify(turn.message), {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': `req_${index}` },
    });
  };
}

// -- message / event builders ------------------------------------------------

export interface ToolUseSpec {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export const USAGE = {
  input_tokens: 20,
  output_tokens: 10,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 2,
} as const;

/** A complete non-streaming assistant `Message`. */
export function assistantMessage(
  id: string,
  text: string,
  toolUses: ToolUseSpec[] = [],
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (text.length > 0) content.push({ type: 'text', text, citations: null });
  for (const use of toolUses) {
    content.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input });
  }
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content,
    stop_reason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { ...USAGE },
  };
}

/** Split a string into fixed-size deltas to exercise the tee under streaming. */
export function chunked(text: string, size = 17): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** The SSE event script equivalent of `assistantMessage`. */
export function assistantEvents(
  id: string,
  text: string,
  toolUses: ToolUseSpec[] = [],
  opts: { thinking?: string; chunkSize?: number } = {},
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: USAGE.input_tokens,
          output_tokens: 1,
          cache_read_input_tokens: USAGE.cache_read_input_tokens,
          cache_creation_input_tokens: USAGE.cache_creation_input_tokens,
        },
      },
    },
  ];
  let index = 0;

  if (opts.thinking !== undefined) {
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
    for (const delta of chunked(opts.thinking, opts.chunkSize ?? 17)) {
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: delta },
      });
    }
    events.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'signature_delta', signature: 'sig-abc' },
    });
    events.push({ type: 'content_block_stop', index });
    index += 1;
  }

  if (text.length > 0) {
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '', citations: null },
    });
    for (const delta of chunked(text, opts.chunkSize ?? 17)) {
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } });
    }
    events.push({ type: 'content_block_stop', index });
    index += 1;
  }

  for (const use of toolUses) {
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: use.id, name: use.name, input: {} },
    });
    for (const delta of chunked(JSON.stringify(use.input), 9)) {
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: delta },
      });
    }
    events.push({ type: 'content_block_stop', index });
    index += 1;
  }

  events.push({
    type: 'message_delta',
    delta: { stop_reason: toolUses.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: USAGE.output_tokens },
  });
  events.push({ type: 'message_stop' });
  return events;
}

/** Every `tool_result` payload present in a request body, by tool_use_id. */
export function collectToolResults(body: Record<string, unknown>): Record<string, string> {
  const results: Record<string, string> = {};
  const messages = (body['messages'] ?? []) as { role?: string; content?: unknown }[];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Record<string, unknown>[]) {
      if (part['type'] === 'tool_result' && typeof part['tool_use_id'] === 'string') {
        results[part['tool_use_id']] = String(part['content']);
      }
    }
  }
  return results;
}
