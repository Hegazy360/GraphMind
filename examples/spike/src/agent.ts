/**
 * The agent under test: streamText with a scripted MockLanguageModelV4.
 *
 * Scripted conversation:
 *   step 0: text intro + tool-call searchFlights(VIE->LIS)      [1 tool call]
 *   step 1: TWO PARALLEL tool-calls: checkWeather + convertCurrency
 *   step 2: final text answer that echoes the tool results found in the
 *           incoming prompt (so injected values provably reach the answer)
 */

import {
  streamText,
  wrapLanguageModel,
  stepCountIs,
  tool,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { Trace, now, sleep } from './trace.js';
import { GateEngine } from './gate.js';
import { debuggerMiddleware } from './middleware.js';
import { wrapToolsForDebug } from './wrap-tools.js';

const usage: LanguageModelV4Usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

const finish = (unified: 'stop' | 'tool-calls'): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage,
  finishReason: { unified, raw: unified },
});

function textParts(id: string, chunks: string[]): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id },
    ...chunks.map(delta => ({ type: 'text-delta', id, delta }) as const),
    { type: 'text-end', id },
  ];
}

/** Split a string into fixed-size deltas to exercise the tee under streaming. */
function chunked(text: string, size = 17): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Pull every tool result out of an incoming provider prompt, by tool name. */
export function collectToolResults(prompt: LanguageModelV4Prompt): Record<string, unknown> {
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

export function makeMockModel(trace: Trace): MockLanguageModelV4 {
  let call = 0;

  return new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      const index = call++;
      trace.mark('mock:doStream', { call: index });

      let parts: LanguageModelV4StreamPart[];
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
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: parts,
          initialDelayInMs: 5,
          chunkDelayInMs: 2,
        }),
      };
    },
  });
}

export interface AgentFlags {
  currencyThrows?: boolean;
}

export function makeTools(trace: Trace, flags: AgentFlags) {
  return {
    searchFlights: tool({
      description: 'Search for flights between two airports',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async ({ from, to }) => {
        trace.mark('tool:body-start', { toolName: 'searchFlights' });
        await sleep(25);
        trace.mark('tool:body-end', { toolName: 'searchFlights' });
        return { flights: [{ id: 'TP1234', from, to, priceEUR: 199 }] };
      },
    }),

    checkWeather: tool({
      description: 'Get the weather forecast for a city',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        trace.mark('tool:body-start', { toolName: 'checkWeather' });
        await sleep(25);
        trace.mark('tool:body-end', { toolName: 'checkWeather' });
        return { city, forecast: 'sunny', tempC: 31 };
      },
    }),

    convertCurrency: tool({
      description: 'Convert an amount between currencies',
      inputSchema: z.object({ amount: z.number(), from: z.string(), to: z.string() }),
      execute: async ({ amount, to }) => {
        trace.mark('tool:body-start', { toolName: 'convertCurrency' });
        if (flags.currencyThrows === true) {
          trace.mark('tool:body-throw', { toolName: 'convertCurrency' });
          throw new Error('FX rate service returned HTTP 500');
        }
        await sleep(25);
        trace.mark('tool:body-end', { toolName: 'convertCurrency' });
        return { amount, converted: Math.round(amount * 0.913 * 100) / 100, currency: to };
      },
    }),
  };
}

export interface AgentRunResult {
  text: string;
  stepTexts: string[];
  stepCount: number;
  finalFinishReason: string;
  mock: MockLanguageModelV4;
  durationMs: number;
}

export async function runAgent(
  engine: GateEngine,
  flags: AgentFlags = {},
): Promise<AgentRunResult> {
  const trace = engine.trace;
  const mock = makeMockModel(trace);
  const model = wrapLanguageModel({ model: mock, middleware: debuggerMiddleware(engine) });
  const tools = wrapToolsForDebug(makeTools(trace, flags), engine);

  const t0 = now();
  trace.mark('run:start');
  const result = streamText({
    model,
    tools,
    prompt: 'Plan my trip from Vienna to Lisbon with a 100 EUR budget check.',
    stopWhen: stepCountIs(5),
    onError: ({ error }) => {
      trace.mark('run:onError', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  await result.consumeStream();
  const text = await result.text;
  const steps = await result.steps;
  await engine.drainObservers();
  trace.mark('run:end');

  const last = steps[steps.length - 1];
  return {
    text,
    stepTexts: steps.map(s => s.text),
    stepCount: steps.length,
    finalFinishReason: last === undefined ? 'none' : JSON.stringify(last.finishReason),
    mock,
    durationMs: now() - t0,
  };
}
