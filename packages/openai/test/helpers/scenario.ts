/**
 * The agent under test: a hand-written OpenAI tool loop, exactly how people
 * write one today — call `chat.completions.create`, read `tool_calls`,
 * dispatch them (in parallel) to local functions, push `tool` messages, loop.
 * Driven through the REAL public adapter API (`gm.wrapClient` / `gm.wrapTools`).
 *
 * Scripted conversation:
 *   turn 0: text intro + tool call searchFlights(VIE->LIS)        [1 tool call]
 *   turn 1: TWO PARALLEL tool calls: checkWeather + convertCurrency
 *   turn 2: final text that echoes the tool results present in the incoming
 *           messages (so injected values provably reach the answer)
 */
import OpenAI from 'openai';
import type { Graphmind } from '../../src/index.js';
import { chatChunks, chatCompletion, chunked, FakeOpenAI, type Scripted } from './fake-openai.js';
import { tick, waitUntil } from './fake-viewer.js';

export interface Mark {
  name: string;
  at: number;
  data?: Record<string, unknown>;
}

export class Marks {
  readonly all: Mark[] = [];
  mark(name: string, data?: Record<string, unknown>): void {
    this.all.push({ name, at: Date.now(), ...(data !== undefined ? { data } : {}) });
  }
  first(name: string, pred?: (mark: Mark) => boolean): Mark | undefined {
    return this.all.find((m) => m.name === name && (pred === undefined || pred(m)));
  }
  count(name: string): number {
    return this.all.filter((m) => m.name === name).length;
  }
}

export interface ScenarioFlags {
  /** Use `stream: true` for every turn. */
  stream?: boolean;
  /** convertCurrency throws on every attempt. */
  currencyThrows?: boolean;
  /** convertCurrency throws only on its first attempt. */
  currencyThrowsOnce?: boolean;
  /** Tool body duration (default 25ms). */
  toolDelayMs?: number;
  /** Skip the gm.run boundary (implicit run). */
  noRun?: boolean;
  runName?: string;
}

export function makeTools(marks: Marks, flags: ScenarioFlags = {}) {
  let currencyAttempts = 0;
  const delay = flags.toolDelayMs ?? 25;
  return {
    searchFlights: async (args: { from: string; to: string }) => {
      marks.mark('tool:body-start', { toolName: 'searchFlights' });
      await tick(delay);
      marks.mark('tool:body-end', { toolName: 'searchFlights' });
      return { flights: [{ id: 'TP1234', from: args.from, to: args.to, priceEUR: 199 }] };
    },
    checkWeather: async (args: { city: string }) => {
      marks.mark('tool:body-start', { toolName: 'checkWeather' });
      await tick(delay);
      marks.mark('tool:body-end', { toolName: 'checkWeather' });
      return { city: args.city, forecast: 'sunny', tempC: 31 };
    },
    convertCurrency: async (args: { amount: number; from: string; to: string }) => {
      currencyAttempts += 1;
      marks.mark('tool:body-start', { toolName: 'convertCurrency', attempt: currencyAttempts });
      if (flags.currencyThrows === true || (flags.currencyThrowsOnce === true && currencyAttempts === 1)) {
        marks.mark('tool:body-throw', { toolName: 'convertCurrency' });
        throw new Error('FX rate service returned HTTP 500');
      }
      await tick(delay);
      marks.mark('tool:body-end', { toolName: 'convertCurrency' });
      return {
        amount: args.amount,
        converted: Math.round(args.amount * 0.913 * 100) / 100,
        currency: args.to,
      };
    },
  };
}

export const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'searchFlights',
      description: 'Search for flights between two airports',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'checkWeather',
      description: 'Get the weather forecast for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'convertCurrency',
      description: 'Convert an amount between currencies',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
        required: ['amount', 'from', 'to'],
      },
    },
  },
];

/** Collect every tool result present in an outgoing chat message array. */
export function collectToolResults(messages: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(messages)) return out;
  const namesById = new Map<string, string>();
  for (const raw of messages) {
    const message = raw as Record<string, unknown>;
    for (const call of (message['tool_calls'] as { id: string; function: { name: string } }[]) ?? []) {
      namesById.set(call.id, call.function.name);
    }
    if (message['role'] === 'tool') {
      const id = String(message['tool_call_id']);
      const name = namesById.get(id) ?? id;
      try {
        out[name] = JSON.parse(String(message['content']));
      } catch {
        out[name] = message['content'];
      }
    }
  }
  return out;
}

/** The three scripted turns, as a `FakeOpenAI` chat handler. */
export function scriptChatTurns(marks: Marks, stream: boolean): (body: Record<string, unknown>, index: number) => Scripted {
  return (body, index) => {
    marks.mark('http:chat', { call: index });
    if (index === 0) {
      const toolCalls = [
        { id: 'call-flights-1', name: 'searchFlights', args: { from: 'VIE', to: 'LIS' } },
      ];
      return stream
        ? { kind: 'sse', events: chatChunks({ textChunks: chunked('Let me search for flights first. '), toolCalls }) }
        : { kind: 'json', body: chatCompletion({ text: 'Let me search for flights first. ', toolCalls }) };
    }
    if (index === 1) {
      const toolCalls = [
        { id: 'call-weather-1', name: 'checkWeather', args: { city: 'Lisbon' } },
        { id: 'call-currency-1', name: 'convertCurrency', args: { amount: 100, from: 'EUR', to: 'USD' } },
      ];
      return stream
        ? {
            kind: 'sse',
            events: chatChunks({
              textChunks: chunked('Now checking weather and budget in parallel. '),
              toolCalls,
            }),
          }
        : {
            kind: 'json',
            body: chatCompletion({ text: 'Now checking weather and budget in parallel. ', toolCalls }),
          };
    }
    const answer = `Trip report: ${JSON.stringify(collectToolResults(body['messages']))}`;
    return stream
      ? { kind: 'sse', events: chatChunks({ textChunks: chunked(answer), finishReason: 'stop' }) }
      : { kind: 'json', body: chatCompletion({ text: answer, finishReason: 'stop' }) };
  };
}

export interface ScenarioResult {
  text: string;
  turnTexts: string[];
  turns: number;
  requestCount: number;
  runError: unknown;
  toolErrors: unknown[];
  marks: Marks;
}

interface AccumulatedTurn {
  text: string;
  toolCalls: { id: string; name: string; args: string }[];
  finishReason: string | undefined;
}

async function oneTurn(
  client: OpenAI,
  messages: unknown[],
  stream: boolean,
): Promise<AccumulatedTurn> {
  if (!stream) {
    const completion = await client.chat.completions.create({
      model: 'gpt-5.4',
      messages: messages as never,
      tools: TOOL_SCHEMAS,
    });
    const choice = completion.choices[0];
    return {
      text: choice?.message.content ?? '',
      toolCalls: (choice?.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: 'function' in call ? call.function.name : '',
        args: 'function' in call ? call.function.arguments : '{}',
      })),
      finishReason: choice?.finish_reason,
    };
  }

  const response = await client.chat.completions.create({
    model: 'gpt-5.4',
    messages: messages as never,
    tools: TOOL_SCHEMAS,
    stream: true,
    stream_options: { include_usage: true },
  });
  let text = '';
  let finishReason: string | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const chunk of response) {
    for (const choice of chunk.choices) {
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
      if (typeof choice.delta.content === 'string') text += choice.delta.content;
      for (const call of choice.delta.tool_calls ?? []) {
        const entry = calls.get(call.index) ?? { id: '', name: '', args: '' };
        if (call.id !== undefined) entry.id = call.id;
        if (call.function?.name !== undefined) entry.name = call.function.name;
        if (call.function?.arguments !== undefined) entry.args += call.function.arguments;
        calls.set(call.index, entry);
      }
    }
  }
  return {
    text,
    toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry),
    finishReason,
  };
}

/** Run the scripted agent loop through the wrapped client + tools. */
export async function runChatScenario(
  gm: Graphmind,
  client: OpenAI,
  server: FakeOpenAI,
  flags: ScenarioFlags = {},
  marks: Marks = new Marks(),
): Promise<ScenarioResult> {
  const tools = gm.wrapTools(makeTools(marks, flags)) as Record<
    string,
    (input: unknown, call?: unknown) => Promise<unknown>
  >;
  const toolErrors: unknown[] = [];
  const turnTexts: string[] = [];
  let runError: unknown;

  const loop = async (): Promise<void> => {
    const messages: unknown[] = [
      { role: 'system', content: 'You plan trips.' },
      { role: 'user', content: 'Plan my trip from Vienna to Lisbon with a 100 EUR budget check.' },
    ];
    for (let turn = 0; turn < 5; turn += 1) {
      const result = await oneTurn(client, messages, flags.stream === true);
      turnTexts.push(result.text);
      if (result.toolCalls.length === 0) return;
      messages.push({
        role: 'assistant',
        content: result.text,
        tool_calls: result.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.args },
        })),
      });
      // Parallel dispatch: each wrapped tool gates independently.
      const outcomes = await Promise.all(
        result.toolCalls.map(async (call) => {
          const fn = tools[call.name];
          if (fn === undefined) return { call, content: JSON.stringify({ error: 'unknown tool' }) };
          try {
            const value = await fn(JSON.parse(call.args), call);
            return { call, content: JSON.stringify(value) };
          } catch (error) {
            toolErrors.push(error);
            throw error;
          }
        }),
      );
      for (const outcome of outcomes) {
        messages.push({ role: 'tool', tool_call_id: outcome.call.id, content: outcome.content });
      }
    }
  };

  try {
    if (flags.noRun === true) await loop();
    else await gm.run(flags.runName ?? 'scenario', () => loop());
  } catch (error) {
    runError = error;
  }

  return {
    text: turnTexts[turnTexts.length - 1] ?? '',
    turnTexts,
    turns: turnTexts.length,
    requestCount: server.callCount,
    runError,
    toolErrors,
    marks,
  };
}

/** Force the session to start its transport and wait until it is attached. */
export async function attach(gm: Graphmind): Promise<void> {
  void gm.session.gate('after', { nodeId: '__warmup', kind: 'custom', name: '__warmup' });
  await waitUntil(() => gm.session.attached, 8000, 'session attach');
}
