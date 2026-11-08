/**
 * JSON value type + schema. Everything Circuit persists — step inputs and
 * outputs, run inputs, event data — must be a JsonValue: a step's recorded
 * output has to deserialize to exactly what the live call returned, or
 * memoized re-invocation would silently diverge from the first execution.
 */
import { z } from 'zod';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

export class NotJsonSerializableError extends Error {
  override name = 'NotJsonSerializableError';
  constructor(
    public readonly where: string,
    detail: string,
  ) {
    super(`${where} is not JSON-serializable: ${detail}. Step results are recorded and replayed; only JSON round-trippable values keep a re-invocation identical to the live run.`);
  }
}

/**
 * Normalize a live value to what the journal will replay: a JSON round-trip.
 * Throws NotJsonSerializableError instead of silently recording something
 * different from what the caller got (undefined, functions, cycles, BigInt).
 * `undefined` itself is allowed (a void step) and round-trips to null-less
 * absence — represented as `undefined` by callers, stored as missing output.
 */
export function toJsonValue(value: unknown, where: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new NotJsonSerializableError(where, err instanceof Error ? err.message : String(err));
  }
  if (text === undefined) {
    throw new NotJsonSerializableError(where, `value of type ${typeof value} serializes to undefined`);
  }
  return JSON.parse(text) as JsonValue;
}
