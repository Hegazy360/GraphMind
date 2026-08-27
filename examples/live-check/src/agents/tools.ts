/**
 * The tools every suite's agent uses. Deterministic and offline on purpose:
 * the only real network traffic in this suite is the model call itself, so an
 * assertion about "no HTTP request went out during the hold" is unambiguous.
 */

const WEATHER: Record<string, { tempC: number; sky: string }> = {
  cairo: { tempC: 34, sky: 'clear' },
  tokyo: { tempC: 21, sky: 'rain' },
};

export interface WeatherResult {
  city: string;
  tempC: number;
  sky: string;
}

/** Deterministic weather lookup. */
export function getWeather(input: { city?: unknown }): WeatherResult {
  const city = String(input?.city ?? '').trim();
  const hit = WEATHER[city.toLowerCase()] ?? { tempC: 15, sky: 'unknown' };
  return { city, tempC: hit.tempC, sky: hit.sky };
}

/** A tool that always fails — the pause-on-error scenario's trigger. */
export function getRate(_input: { from?: unknown; to?: unknown }): never {
  throw new Error('FX rate service returned HTTP 503');
}

/** The value the debugger injects when `getRate` blows up. */
export const INJECTED_RATE = { from: 'EUR', to: 'USD', rate: 42.4242 };
export const INJECTED_NEEDLE = '42.4242';

export const WEATHER_TOOL_DESCRIPTION =
  'Look up the current weather for one city. Call it once per city.';
export const RATE_TOOL_DESCRIPTION = 'Look up the exchange rate between two currencies.';

export const WEATHER_JSON_SCHEMA = {
  type: 'object' as const,
  properties: { city: { type: 'string' as const, description: 'City name' } },
  required: ['city'],
  additionalProperties: false,
};

export const RATE_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    from: { type: 'string' as const },
    to: { type: 'string' as const },
  },
  required: ['from', 'to'],
  additionalProperties: false,
};

/** Reliably provokes two parallel tool calls of the SAME logical tool. */
export const PARALLEL_PROMPT =
  'Call getWeather for Cairo and getWeather for Tokyo, both in the same turn, ' +
  'then reply with one short sentence giving both temperatures in Celsius.';

/** Provokes exactly one failing tool call, then an answer quoting the result. */
export const RATE_PROMPT =
  'Call getRate to convert EUR to USD. Then reply with exactly one line of the ' +
  'form "RATE=<value>" using the numeric rate the tool returned, copied digit for digit.';

/** A prompt with a long answer, so the response is still streaming when aborted. */
export const LONG_PROMPT =
  'Write a 250-word plain-text description of the water cycle. No lists, no headings.';
