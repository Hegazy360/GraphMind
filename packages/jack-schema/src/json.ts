/**
 * JSON value type + schema, and a canonical serialisation. Manifests are
 * hashed by their canonical form so that two deployments with the same tools
 * (in any key order) produce the same `manifestHash` and an empty diff.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

/** Recursively sort object keys so JSON.stringify is order-independent. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
