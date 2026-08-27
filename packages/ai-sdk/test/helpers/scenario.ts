/**
 * The agent under test (ported from examples/spike/src/agent.ts, driven
 * through the REAL public adapter API instead of the spike's gate engine):
 * `streamText` with a scripted mock language model (whichever spec the
 * installed `ai` major exports — see ./sdk-compat.ts).
 *
 * Scripted conversation:
 *   step 0: text intro + tool-call searchFlights(VIE->LIS)       [1 tool call]
 *   step 1: TWO PARALLEL tool-calls: checkWeather + convertCurrency
 *   step 2: final text answer that echoes the tool results found in the
 *           incoming prompt (so injected values provably reach the answer)
 */
import { simulateReadableStream, stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import type { Graphmind } from '../../src/index.js';
import { tick, waitUntil } from './fake-viewer.js';
import {
  MockLanguageModel,
  type CallOptions,
  type MockLanguageModel as MockLanguageModelInstance,
  type Prompt,
  type StreamPart,
  type TimeoutOption,
  type Usage,
} from './sdk-compat.js';

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

const usage: Usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

const finish = (unified: 'stop' | 'tool-calls'): StreamPart => ({
  type: 'finish',
  usage,
  finishReason: { unified, raw: unified },
});

function textParts(id: string, chunks: string[]): StreamPart[] {
  return [
    { type: 'text-start', id },
    ...chunks.map((delta) => ({ type: 'text-delta', id, delta }) as const),
    { type: 'text-end', id },
  ];
}

/** Split a string into fixed-size deltas to exercise the tee under streaming. */
export function chunked(text: string, size = 17): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Pull every tool result out of an incoming provider prompt, by tool name. */
export function collectToolResults(prompt: Prompt): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') {
        results[part.toolName] =
          part.output.type === 'json' || part.output.type === 'error-json'
            ? part.output.value
            : part.output.type === 'text' || part.output.type === 'error-text'
              ? part.output.value
              : part.output;
      }
    }
  }
  return results;
}

export function makeMockModel(marks: Marks): MockLanguageModelInstance {
  let call = 0;

  return new MockLanguageModel({
    doStream: async (options: CallOptions) => {
      const index = call++;
      marks.mark('mock:doStream', { call: index });

      let parts: StreamPart[];
      if (index === 0) {
        parts = [
          { type: 'stream-start', warnings: [] },
          ...textParts('t0', chunked('Let me search for flights first. ')),
          {
            type: 'tool-call',
            toolCallId: 'call-flights-1',
            toolName: 'searchFlights',
            input: JSON.stringify({ from: 'VIE', to: 'LIS' }),
          },
          finish('tool-calls'),
        ];
      } else if (index === 1) {
        parts = [
          { type: 'stream-start', warnings: [] },
          ...textParts('t1', chunked('Now checking weather and budget in parallel. ')),
          {
            type: 'tool-call',
            toolCallId: 'call-weather-1',
            toolName: 'checkWeather',
            input: JSON.stringify({ city: 'Lisbon' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'call-currency-1',
            toolName: 'convertCurrency',
            input: JSON.stringify({ amount: 100, from: 'EUR', to: 'USD' }),
          },
          finish('tool-calls'),
        ];
      } else {
        // Final answer echoes the tool results present in the incoming prompt.
        const results = collectToolResults(options.prompt);
        const answer = `Trip report: ${JSON.stringify(results)}`;
        parts = [
          { type: 'stream-start', warnings: [] },
          ...textParts('t2', chunked(answer)),
          finish('stop'),
        ];
      }

      return {
        stream: simulateReadableStream<StreamPart>({
          chunks: parts,
          initialDelayInMs: 5,
          chunkDelayInMs: 2,
        }),
      };
    },
  });
}

export interface ScenarioFlags {
  /** convertCurrency throws on every attempt. */
  currencyThrows?: boolean;
  /** convertCurrency throws only on its first attempt. */
  currencyThrowsOnce?: boolean;
  /** searchFlights throws options.abortSignal.reason when the signal aborted. */
  searchFlightsChecksSignal?: boolean;
  /** searchFlights body duration (default 25ms). */
  searchFlightsDelayMs?: number;
  /** streamText `timeout` configuration passthrough. */
  timeout?: TimeoutOption;
  /** Skip the gm.run boundary (implicit run). */
  noRun?: boolean;
  runName?: string;
}

export function makeTools(marks: Marks, flags: ScenarioFlags) {
  let currencyAttempts = 0;
  return {
    searchFlights: tool({
      description: 'Search for flights between two airports',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async ({ from, to }, options) => {
        marks.mark('tool:body-start', { toolName: 'searchFlights' });
        if (flags.searchFlightsChecksSignal === true && options.abortSignal?.aborted === true) {
          throw options.abortSignal.reason;
        }
        await tick(flags.searchFlightsDelayMs ?? 25);
        if (flags.searchFlightsChecksSignal === true && options.abortSignal?.aborted === true) {
          throw options.abortSignal.reason;
        }
        marks.mark('tool:body-end', { toolName: 'searchFlights' });
        return { flights: [{ id: 'TP1234', from, to, priceEUR: 199 }] };
      },
    }),

    checkWeather: tool({
      description: 'Get the weather forecast for a city',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        marks.mark('tool:body-start', { toolName: 'checkWeather' });
        await tick(25);
        marks.mark('tool:body-end', { toolName: 'checkWeather' });
        return { city, forecast: 'sunny', tempC: 31 };
      },
    }),

    convertCurrency: tool({
      description: 'Convert an amount between currencies',
      inputSchema: z.object({ amount: z.number(), from: z.string(), to: z.string() }),
      execute: async ({ amount, to }) => {
        currencyAttempts += 1;
        marks.mark('tool:body-start', { toolName: 'convertCurrency', attempt: currencyAttempts });
        if (
          flags.currencyThrows === true ||
          (flags.currencyThrowsOnce === true && currencyAttempts === 1)
        ) {
          marks.mark('tool:body-throw', { toolName: 'convertCurrency' });
          throw new Error('FX rate service returned HTTP 500');
        }
        await tick(25);
        marks.mark('tool:body-end', { toolName: 'convertCurrency' });
        return { amount, converted: Math.round(amount * 0.913 * 100) / 100, currency: to };
      },
    }),
  };
}

export interface ScenarioResult {
  text: string;
  stepTexts: string[];
  stepCount: number;
  finalFinishReason: string;
  doStreamCalls: number;
  onErrorErrors: unknown[];
  runError: unknown;
  marks: Marks;
  durationMs: number;
}

/** Run the scripted agent through the wrapped model + tools. */
export async function runScenario(
  gm: Graphmind,
  flags: ScenarioFlags = {},
  marks: Marks = new Marks(),
): Promise<ScenarioResult> {
  const mock = makeMockModel(marks);
  const model = gm.wrapModel(mock);
  const tools = gm.wrapTools(makeTools(marks, flags));
  const onErrorErrors: unknown[] = [];
  let runError: unknown;

  const t0 = Date.now();
  const execute = async (): Promise<{ text: string; stepTexts: string[]; finish: string }> => {
    const result = streamText({
      model,
      tools,
      prompt: 'Plan my trip from Vienna to Lisbon with a 100 EUR budget check.',
      stopWhen: stepCountIs(5),
      ...(flags.timeout !== undefined ? { timeout: flags.timeout as never } : {}),
      onError: ({ error }) => {
        onErrorErrors.push(error);
      },
    });
    await result.consumeStream();
    // Bounded waits: on abort paths some result promises can settle late.
    const text = await Promise.race([result.text, tick(8000).then(() => '')]);
    const steps = await Promise.race([
      result.steps,
      tick(8000).then(() => [] as Awaited<typeof result.steps>),
    ]);
    const last = steps[steps.length - 1];
    return {
      text,
      stepTexts: steps.map((s) => s.text),
      finish: last === undefined ? 'none' : JSON.stringify(last.finishReason),
    };
  };

  let outcome: { text: string; stepTexts: string[]; finish: string } = {
    text: '',
    stepTexts: [],
    finish: 'none',
  };
  try {
    outcome =
      flags.noRun === true
        ? await execute()
        : await gm.run(flags.runName ?? 'scenario', () => execute());
  } catch (error) {
    runError = error;
  }

  return {
    text: outcome.text,
    stepTexts: outcome.stepTexts,
    stepCount: outcome.stepTexts.length,
    finalFinishReason: outcome.finish,
    doStreamCalls: marks.count('mock:doStream'),
    onErrorErrors,
    runError,
    marks,
    durationMs: Date.now() - t0,
  };
}

/** Force the session to start its transport and wait until it is attached. */
export async function attach(gm: Graphmind): Promise<void> {
  void gm.session.gate('after', { nodeId: '__warmup', kind: 'custom', name: '__warmup' });
  await waitUntil(() => gm.session.attached, 8000, 'session attach');
}
