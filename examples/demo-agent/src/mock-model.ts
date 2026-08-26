/**
 * A scripted MockLanguageModelV4 ('ai/test'): a deterministic four-step
 * trip-planner conversation with streamed tokens — no API key required.
 *
 * The script *reads its tool results from the prompt*, so the run reacts to
 * whatever actually happened downstream: the planted convertCurrency bug
 * produces the absurd checkBudget input, and a debugger that injects a
 * corrected budget-check result flips the final step from an apology to a
 * happy itinerary. That reactivity is what makes the recorded demo branches
 * (continue vs inject) genuinely different captures of the same script.
 */
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const USAGE = { inputTokens: 184, outputTokens: 52, totalTokens: 236 };

type StreamPart = Record<string, unknown>;

const finish = (unified: 'stop' | 'tool-calls'): StreamPart => ({
  type: 'finish',
  usage: USAGE,
  finishReason: { unified, raw: unified },
});

/** Stream `text` as word-ish deltas so the viewer shows live tokens. */
function textParts(id: string, text: string, wordsPerDelta = 3): StreamPart[] {
  const words = text.split(/(?<= )/);
  const parts: StreamPart[] = [{ type: 'text-start', id }];
  for (let i = 0; i < words.length; i += wordsPerDelta) {
    parts.push({ type: 'text-delta', id, delta: words.slice(i, i + wordsPerDelta).join('') });
  }
  parts.push({ type: 'text-end', id });
  return parts;
}

const toolCall = (toolCallId: string, toolName: string, input: unknown): StreamPart => ({
  type: 'tool-call',
  toolCallId,
  toolName,
  input: JSON.stringify(input),
});

/** Pull the latest result of `toolName` out of the conversation so far. */
function toolResult(prompt: unknown, toolName: string): { value: unknown; isError: boolean } | undefined {
  let found: { value: unknown; isError: boolean } | undefined;
  for (const message of prompt as { role: string; content: unknown }[]) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as Record<string, any>[]) {
      if (part['type'] !== 'tool-result' || part['toolName'] !== toolName) continue;
      const output = part['output'] as Record<string, any> | undefined;
      const isError =
        typeof output?.['type'] === 'string' && (output['type'] as string).startsWith('error');
      found = { value: output?.['value'] ?? output, isError };
    }
  }
  return found;
}

export function makeMockTripPlannerModel(): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async (options: any) => {
      const step = call++;
      let parts: StreamPart[];

      if (step === 0) {
        parts = [
          { type: 'stream-start', warnings: [] },
          ...textParts(
            't0',
            'Planning a 5-day Tokyo trip for two in November on a $3,800 budget. Let me check flights and the weather. ',
          ),
          toolCall('call-flights-1', 'searchFlights', {
            from: 'San Francisco',
            to: 'Tokyo',
            month: 'November',
            travelers: 2,
          }),
          toolCall('call-weather-1', 'getWeather', { city: 'Tokyo', month: 'November' }),
          finish('tool-calls'),
        ];
      } else if (step === 1) {
        parts = [
          { type: 'stream-start', warnings: [] },
          ...textParts(
            't1',
            'Flights: ANA round trip at ¥118,500 per person — ¥237,000 for two. November in Tokyo is 9–16°C and mostly dry. With ¥165,000 for hotels, food and transit, the trip totals ¥402,000. Converting to USD to check the budget. ',
          ),
          toolCall('call-fx-1', 'convertCurrency', { amount: 402000, from: 'JPY', to: 'USD' }),
          finish('tool-calls'),
        ];
      } else if (step === 2) {
        const fx = toolResult(options.prompt, 'convertCurrency');
        const converted =
          fx !== undefined && !fx.isError && typeof (fx.value as any)?.converted === 'number'
            ? ((fx.value as any).converted as number)
            : 2693.4;
        parts = [
          { type: 'stream-start', warnings: [] },
          ...textParts('t2', `That converts to $${converted.toLocaleString('en-US')}. Checking it against the budget. `),
          toolCall('call-budget-1', 'checkBudget', { totalUsd: converted, budgetUsd: 3800 }),
          finish('tool-calls'),
        ];
      } else {
        const budget = toolResult(options.prompt, 'checkBudget');
        const happy =
          budget !== undefined && !budget.isError && (budget.value as any)?.ok === true;
        const remaining = happy ? ((budget!.value as any).remainingUsd as number) : 0;
        const text = happy
          ? `Great news — the trip fits the budget with $${remaining.toLocaleString('en-US')} to spare. Itinerary: fly SFO→NRT on ANA, base in Shinjuku, day trips to Kamakura and Hakone, and keep an evening free for Shibuya. Pack layers for 9–16°C days. `
          : 'I could not finish planning: the budget check failed with the total wildly over budget. The currency conversion looks wrong — ¥402,000 should be roughly $2,700, not tens of millions. Please review the convertCurrency tool. ';
        parts = [
          { type: 'stream-start', warnings: [] },
          ...textParts('t3', text),
          finish('stop'),
        ];
      }

      return {
        stream: simulateReadableStream({
          chunks: parts as any[],
          initialDelayInMs: 220,
          chunkDelayInMs: 40,
        }),
      };
    },
  });
}
