/**
 * The agent under test: a raw Anthropic tool loop, written the way people
 * actually write them — `client.messages.create` / `.stream()`, inspect
 * `stop_reason === 'tool_use'`, call your own functions, append `tool_result`
 * blocks, loop — driven through the REAL public adapter API.
 *
 * Scripted conversation (identical for every transport mode):
 *   turn 0: text intro + tool_use searchFlights                [1 tool call]
 *   turn 1: TWO PARALLEL tool_use blocks: checkWeather + convertCurrency
 *   turn 2: final text that echoes the tool_result payloads present in the
 *           incoming request body (so injected values provably reach it)
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Graphmind } from '../../src/index.js';
import {
  FakeAnthropicTransport,
  assistantEvents,
  assistantMessage,
  collectToolResults,
  type ScriptedTurn,
} from './fake-anthropic.js';
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

export const TOOL_USE_IDS = {
  flights: 'toolu_flights_1',
  weather: 'toolu_weather_1',
  currency: 'toolu_currency_1',
} as const;

export type TransportMode = 'create' | 'create-stream' | 'stream-helper';

export interface ScenarioFlags {
  /** How the loop talks to the API. Default: 'create' (non-streaming). */
  mode?: TransportMode;
  /** convertCurrency throws on every attempt. */
  currencyThrows?: boolean;
  /** convertCurrency throws only on its first attempt. */
  currencyThrowsOnce?: boolean;
  /** searchFlights body duration (default 10ms). */
  searchFlightsDelayMs?: number;
  /** Skip the gm.run boundary (implicit run). */
  noRun?: boolean;
  runName?: string;
  /** Include a thinking block in streamed turns. */
  thinking?: boolean;
  /** Delay between SSE frames. */
  chunkDelayMs?: number;
}

export const TURN_TEXT = [
  'Let me search for flights first. ',
  'Now checking weather and budget in parallel. ',
] as const;

/** The three-turn script, shared by all transport modes. */
export function makeScript(flags: ScenarioFlags = {}) {
  const streaming = flags.mode !== undefined && flags.mode !== 'create';
  return (body: Record<string, unknown>, index: number): ScriptedTurn => {
    const turn = (
      id: string,
      text: string,
      toolUses: { id: string; name: string; input: Record<string, unknown> }[],
    ): ScriptedTurn =>
      streaming
        ? {
            events: assistantEvents(id, text, toolUses, {
              ...(flags.thinking === true ? { thinking: 'Let me think about this. ' } : {}),
            }),
            ...(flags.chunkDelayMs !== undefined ? { chunkDelayMs: flags.chunkDelayMs } : {}),
          }
        : { message: assistantMessage(id, text, toolUses) };

    if (index === 0) {
      return turn('msg_0', TURN_TEXT[0], [
        { id: TOOL_USE_IDS.flights, name: 'searchFlights', input: { from: 'VIE', to: 'LIS' } },
      ]);
    }
    if (index === 1) {
      return turn('msg_1', TURN_TEXT[1], [
        { id: TOOL_USE_IDS.weather, name: 'checkWeather', input: { city: 'Lisbon' } },
        {
          id: TOOL_USE_IDS.currency,
          name: 'convertCurrency',
          input: { amount: 100, from: 'EUR', to: 'USD' },
        },
      ]);
    }
    return turn('msg_2', `Trip report: ${JSON.stringify(collectToolResults(body))}`, []);
  };
}

export function makeTools(marks: Marks, flags: ScenarioFlags = {}) {
  let currencyAttempts = 0;
  return {
    searchFlights: async ({ from, to }: { from: string; to: string }) => {
      marks.mark('tool:body-start', { toolName: 'searchFlights' });
      await tick(flags.searchFlightsDelayMs ?? 10);
      marks.mark('tool:body-end', { toolName: 'searchFlights' });
      return { flights: [{ id: 'TP1234', from, to, priceEUR: 199 }] };
    },

    checkWeather: async ({ city }: { city: string }) => {
      marks.mark('tool:body-start', { toolName: 'checkWeather' });
      await tick(10);
      marks.mark('tool:body-end', { toolName: 'checkWeather' });
      return { city, forecast: 'sunny', tempC: 31 };
    },

    convertCurrency: async ({ amount, to }: { amount: number; from: string; to: string }) => {
      currencyAttempts += 1;
      marks.mark('tool:body-start', { toolName: 'convertCurrency', attempt: currencyAttempts });
      if (
        flags.currencyThrows === true ||
        (flags.currencyThrowsOnce === true && currencyAttempts === 1)
      ) {
        marks.mark('tool:body-throw', { toolName: 'convertCurrency' });
        throw new Error('FX rate service returned HTTP 500');
      }
      await tick(10);
      marks.mark('tool:body-end', { toolName: 'convertCurrency' });
      return { amount, converted: Math.round(amount * 0.913 * 100) / 100, currency: to };
    },
  };
}

export const TOOL_DEFS = [
  {
    name: 'searchFlights',
    description: 'Search for flights between two airports',
    input_schema: {
      type: 'object' as const,
      properties: { from: { type: 'string' }, to: { type: 'string' } },
    },
  },
  {
    name: 'checkWeather',
    description: 'Get the weather forecast for a city',
    input_schema: { type: 'object' as const, properties: { city: { type: 'string' } } },
  },
  {
    name: 'convertCurrency',
    description: 'Convert an amount between currencies',
    input_schema: {
      type: 'object' as const,
      properties: { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
    },
  },
];

interface TurnResult {
  text: string;
  stopReason: string | undefined;
  toolUses: { id: string; name: string; input: unknown }[];
}

export interface ScenarioResult {
  text: string;
  turnTexts: string[];
  turns: number;
  requestCount: number;
  runError: unknown;
  toolErrors: string[];
  marks: Marks;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;
type ToolMap = Record<string, (input: any) => Promise<unknown>>;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function oneTurn(
  client: AnyClient,
  messages: unknown[],
  mode: TransportMode,
): Promise<TurnResult> {
  const params = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages,
    tools: TOOL_DEFS,
  };

  if (mode === 'create') {
    const message = await client.messages.create(params);
    return readMessage(message);
  }
  if (mode === 'stream-helper') {
    const stream = client.messages.stream(params);
    const message = await stream.finalMessage();
    return readMessage(message);
  }

  // Manual accumulation over `create({ stream: true })`.
  const stream = await client.messages.create({ ...params, stream: true });
  let text = '';
  let stopReason: string | undefined;
  const open = new Map<number, { type: string; id?: string; name?: string; json: string }>();
  const toolUses: { id: string; name: string; input: unknown }[] = [];
  for await (const event of stream as AsyncIterable<Record<string, any>>) {
    if (event['type'] === 'content_block_start') {
      const block = event['content_block'] as Record<string, unknown>;
      open.set(event['index'] as number, {
        type: String(block['type']),
        ...(typeof block['id'] === 'string' ? { id: block['id'] } : {}),
        ...(typeof block['name'] === 'string' ? { name: block['name'] } : {}),
        json: '',
      });
    } else if (event['type'] === 'content_block_delta') {
      const delta = event['delta'] as Record<string, unknown>;
      if (delta['type'] === 'text_delta') text += String(delta['text']);
      else if (delta['type'] === 'input_json_delta') {
        const block = open.get(event['index'] as number);
        if (block !== undefined) block.json += String(delta['partial_json']);
      }
    } else if (event['type'] === 'content_block_stop') {
      const block = open.get(event['index'] as number);
      if (block?.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
        toolUses.push({ id: block.id, name: block.name, input: JSON.parse(block.json || '{}') });
      }
    } else if (event['type'] === 'message_delta') {
      const reason = (event['delta'] as Record<string, unknown>)['stop_reason'];
      if (typeof reason === 'string') stopReason = reason;
    }
  }
  return { text, stopReason, toolUses };
}

function readMessage(message: Record<string, unknown>): TurnResult {
  let text = '';
  const toolUses: { id: string; name: string; input: unknown }[] = [];
  for (const block of (message['content'] ?? []) as Record<string, unknown>[]) {
    if (block['type'] === 'text') text += String(block['text']);
    else if (block['type'] === 'tool_use') {
      toolUses.push({
        id: String(block['id']),
        name: String(block['name']),
        input: block['input'],
      });
    }
  }
  return {
    text,
    stopReason: message['stop_reason'] as string | undefined,
    toolUses,
  };
}

/** Build a client + tools and run the loop through the adapter. */
export async function runScenario(
  gm: Graphmind,
  flags: ScenarioFlags = {},
  marks: Marks = new Marks(),
  transport: FakeAnthropicTransport = new FakeAnthropicTransport(makeScript(flags)),
): Promise<ScenarioResult> {
  const mode = flags.mode ?? 'create';
  const client = gm.wrapClient(
    new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch: transport.fetch }),
  ) as AnyClient;
  const tools = gm.wrapTools(makeTools(marks, flags)) as unknown as ToolMap;

  const turnTexts: string[] = [];
  const toolErrors: string[] = [];
  let runError: unknown;

  const loop = async (): Promise<void> => {
    const messages: unknown[] = [
      { role: 'user', content: 'Plan my trip from Vienna to Lisbon with a 100 EUR budget check.' },
    ];
    for (let i = 0; i < 5; i += 1) {
      const turn = await oneTurn(client, messages, mode);
      turnTexts.push(turn.text);
      const assistantContent: Record<string, unknown>[] = [];
      if (turn.text.length > 0) assistantContent.push({ type: 'text', text: turn.text });
      for (const use of turn.toolUses) {
        assistantContent.push({
          type: 'tool_use',
          id: use.id,
          name: use.name,
          input: use.input,
        });
      }
      messages.push({ role: 'assistant', content: assistantContent });
      if (turn.stopReason !== 'tool_use' || turn.toolUses.length === 0) return;

      // Parallel tool execution, exactly as an Anthropic loop does it.
      const results = await Promise.all(
        turn.toolUses.map(async (use) => {
          try {
            const output = await tools[use.name]!(use.input);
            return {
              type: 'tool_result',
              tool_use_id: use.id,
              content: JSON.stringify(output),
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toolErrors.push(message);
            return {
              type: 'tool_result',
              tool_use_id: use.id,
              is_error: true,
              content: message,
            };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
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
    requestCount: transport.requests.length,
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
