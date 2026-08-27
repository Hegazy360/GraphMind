/**
 * Test double for the OpenAI HTTP API: a scripted `fetch` implementation
 * handed to the real SDK through `new OpenAI({ fetch })`. Everything below the
 * wire is the SDK's own code — request building, SSE decoding, `Stream`,
 * `APIPromise`, `ResponseStream`, the runners — so the adapter is exercised
 * against genuine SDK objects without an API key or a network.
 */

export type Scripted =
  | { kind: 'json'; status?: number; body: unknown; delayMs?: number }
  | { kind: 'sse'; events: unknown[]; done?: boolean; chunkDelayMs?: number }
  | { kind: 'status'; status: number; body?: unknown };

export interface RecordedRequest {
  path: string;
  method: string;
  body: Record<string, unknown>;
  at: number;
}

export type Handler = (body: Record<string, unknown>, callIndex: number) => Scripted;

const encoder = new TextEncoder();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseBody(events: unknown[], done: boolean, chunkDelayMs: number): ReadableStream<Uint8Array> {
  let index = 0;
  let sentDone = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < events.length) {
        if (chunkDelayMs > 0) await delay(chunkDelayMs);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index])}\n\n`));
        index += 1;
        return;
      }
      if (done && !sentDone) {
        sentDone = true;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        return;
      }
      controller.close();
    },
  });
}

async function toResponse(scripted: Scripted, signal?: AbortSignal | null): Promise<Response> {
  if (scripted.kind === 'json' && scripted.delayMs !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, scripted.delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
  if (scripted.kind === 'sse') {
    return new Response(sseBody(scripted.events, scripted.done ?? true, scripted.chunkDelayMs ?? 1), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_fake' },
    });
  }
  const status = scripted.kind === 'status' ? scripted.status : (scripted.status ?? 200);
  const body = scripted.kind === 'status' ? (scripted.body ?? { error: { message: 'boom' } }) : scripted.body;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_fake' },
  });
}

/** A scripted OpenAI endpoint: routes by URL path, one handler per path. */
export class FakeOpenAI {
  readonly requests: RecordedRequest[] = [];

  private readonly handlers = new Map<string, Handler>();
  private readonly counts = new Map<string, number>();

  /** `POST /chat/completions`. */
  onChat(handler: Handler): this {
    this.handlers.set('/chat/completions', handler);
    return this;
  }

  /** `POST /responses`. */
  onResponses(handler: Handler): this {
    this.handlers.set('/responses', handler);
    return this;
  }

  requestsFor(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path.endsWith(path));
  }

  get callCount(): number {
    return this.requests.length;
  }

  /** The `fetch` implementation to hand to `new OpenAI({ fetch })`. */
  readonly fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    const path = url.pathname.replace(/^\/v\d+/, '');
    let body: Record<string, unknown> = {};
    try {
      const raw = init?.body;
      if (typeof raw === 'string') body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = {};
    }
    this.requests.push({ path, method: init?.method ?? 'post', body, at: Date.now() });

    const handler = this.handlers.get(path);
    if (handler === undefined) {
      return await toResponse({
        kind: 'status',
        status: 404,
        body: { error: { message: `no handler for ${path}` } },
      });
    }
    const index = this.counts.get(path) ?? 0;
    this.counts.set(path, index + 1);
    return await toResponse(handler(body, index), init?.signal);
  };
}

// -- Chat Completions payload builders ---------------------------------------

export interface ChatToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** Split a string into fixed-size deltas to exercise the tee under streaming. */
export function chunked(text: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export const CHAT_USAGE = {
  prompt_tokens: 20,
  completion_tokens: 10,
  total_tokens: 30,
  prompt_tokens_details: { cached_tokens: 4 },
  completion_tokens_details: { reasoning_tokens: 6 },
};

export function chatCompletion(options: {
  text?: string;
  toolCalls?: ChatToolCall[];
  finishReason?: string;
  id?: string;
}): unknown {
  const toolCalls = options.toolCalls ?? [];
  return {
    id: options.id ?? 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-5.4',
    choices: [
      {
        index: 0,
        finish_reason: options.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        message: {
          role: 'assistant',
          content: options.text ?? null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              }
            : {}),
        },
      },
    ],
    usage: CHAT_USAGE,
  };
}

/** SSE chunks for one streamed chat completion (text, then tool calls, then usage). */
export function chatChunks(options: {
  textChunks?: string[];
  reasoningChunks?: string[];
  toolCalls?: ChatToolCall[];
  finishReason?: string;
  includeUsage?: boolean;
}): unknown[] {
  const events: unknown[] = [];
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.4' };
  const choice = (delta: unknown, finish: string | null = null): unknown => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });

  events.push(choice({ role: 'assistant', content: '' }));
  for (const chunk of options.reasoningChunks ?? []) events.push(choice({ reasoning_content: chunk }));
  for (const chunk of options.textChunks ?? []) events.push(choice({ content: chunk }));

  const toolCalls = options.toolCalls ?? [];
  toolCalls.forEach((call, index) => {
    events.push(
      choice({
        tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }],
      }),
    );
    for (const piece of chunked(JSON.stringify(call.args), 5)) {
      events.push(choice({ tool_calls: [{ index, function: { arguments: piece } }] }));
    }
  });

  events.push(choice({}, options.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')));
  if (options.includeUsage !== false) events.push({ ...base, choices: [], usage: CHAT_USAGE });
  return events;
}

// -- Responses API payload builders ------------------------------------------

export const RESPONSES_USAGE = {
  input_tokens: 31,
  output_tokens: 12,
  total_tokens: 43,
  input_tokens_details: { cached_tokens: 8, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 5 },
};

export interface ResponseFunctionCall {
  id: string;
  callId: string;
  name: string;
  args: unknown;
}

export function responseObject(options: {
  id?: string;
  text?: string;
  functionCalls?: ResponseFunctionCall[];
  providerCalls?: { id: string; type: string; name?: string; output?: unknown }[];
  status?: string;
  error?: unknown;
}): Record<string, unknown> {
  const output: unknown[] = [];
  for (const call of options.providerCalls ?? []) {
    output.push({
      id: call.id,
      type: call.type,
      status: 'completed',
      ...(call.name !== undefined ? { name: call.name } : {}),
      ...(call.output !== undefined ? { output: call.output } : {}),
    });
  }
  for (const call of options.functionCalls ?? []) {
    output.push({
      id: call.id,
      type: 'function_call',
      status: 'completed',
      call_id: call.callId,
      name: call.name,
      arguments: JSON.stringify(call.args),
    });
  }
  if (options.text !== undefined) {
    output.push({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: options.text, annotations: [] }],
    });
  }
  return {
    id: options.id ?? 'resp_1',
    object: 'response',
    created_at: 1,
    model: 'gpt-5.4',
    status: options.status ?? 'completed',
    output,
    error: options.error ?? null,
    incomplete_details: null,
    usage: RESPONSES_USAGE,
  };
}

/** SSE events for one streamed Responses call. */
export function responseEvents(options: {
  id?: string;
  textChunks?: string[];
  reasoningChunks?: string[];
  functionCalls?: ResponseFunctionCall[];
  providerCalls?: { id: string; type: string; name?: string; output?: unknown }[];
  status?: string;
  terminalType?: 'response.completed' | 'response.failed' | 'response.incomplete';
}): unknown[] {
  const events: unknown[] = [];
  let seq = 0;
  const next = (): number => (seq += 1);
  const id = options.id ?? 'resp_1';
  const skeleton = responseObject({ id, status: 'in_progress' });

  events.push({ type: 'response.created', sequence_number: next(), response: { ...skeleton, output: [] } });

  let outputIndex = 0;
  for (const call of options.providerCalls ?? []) {
    const item = {
      id: call.id,
      type: call.type,
      status: 'in_progress',
      ...(call.name !== undefined ? { name: call.name } : {}),
    };
    events.push({
      type: 'response.output_item.added',
      sequence_number: next(),
      output_index: outputIndex,
      item,
    });
    events.push({
      type: 'response.output_item.done',
      sequence_number: next(),
      output_index: outputIndex,
      item: { ...item, status: 'completed', ...(call.output !== undefined ? { output: call.output } : {}) },
    });
    outputIndex += 1;
  }

  for (const chunk of options.reasoningChunks ?? []) {
    events.push({
      type: 'response.reasoning_summary_text.delta',
      sequence_number: next(),
      item_id: 'rs_1',
      output_index: outputIndex,
      summary_index: 0,
      delta: chunk,
    });
  }

  for (const call of options.functionCalls ?? []) {
    events.push({
      type: 'response.output_item.added',
      sequence_number: next(),
      output_index: outputIndex,
      item: {
        id: call.id,
        type: 'function_call',
        status: 'in_progress',
        call_id: call.callId,
        name: call.name,
        arguments: '',
      },
    });
    for (const piece of chunked(JSON.stringify(call.args), 5)) {
      events.push({
        type: 'response.function_call_arguments.delta',
        sequence_number: next(),
        item_id: call.id,
        output_index: outputIndex,
        delta: piece,
      });
    }
    outputIndex += 1;
  }

  if (options.textChunks !== undefined) {
    events.push({
      type: 'response.output_item.added',
      sequence_number: next(),
      output_index: outputIndex,
      item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    });
    events.push({
      type: 'response.content_part.added',
      sequence_number: next(),
      item_id: 'msg_1',
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    for (const chunk of options.textChunks) {
      events.push({
        type: 'response.output_text.delta',
        sequence_number: next(),
        item_id: 'msg_1',
        output_index: outputIndex,
        content_index: 0,
        logprobs: [],
        delta: chunk,
      });
    }
  }

  const final = responseObject({
    id,
    ...(options.textChunks !== undefined ? { text: options.textChunks.join('') } : {}),
    ...(options.functionCalls !== undefined ? { functionCalls: options.functionCalls } : {}),
    ...(options.providerCalls !== undefined ? { providerCalls: options.providerCalls } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
  });
  events.push({
    type: options.terminalType ?? 'response.completed',
    sequence_number: next(),
    response: final,
  });
  return events;
}
