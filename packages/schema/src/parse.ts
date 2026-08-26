/**
 * Version-negotiating envelope parser.
 *
 * Decision order:
 *   1. Not shaped like an envelope at all      -> `invalid`
 *   2. `gm` differs from PROTOCOL_VERSION      -> `version-mismatch` (reject)
 *   3. `type` unknown                          -> `unknown-type` (tolerate:
 *      the envelope is structurally valid; the payload is opaque)
 *   4. Known type, payload fails its schema    -> `invalid`
 *   5. Otherwise                               -> `ok`
 *
 * Unknown payload FIELDS on known types never fail (loose objects), and
 * unknown TYPES are surfaced as `unknown-type` rather than errors — that is
 * the forward-compatibility contract of protocol v1.
 *
 * `parseEnvelope` never throws.
 */
import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants.js';
import { EnvelopeSchemas, isMessageType, type KnownEnvelope } from './envelope.js';

/** A structurally valid envelope whose `type` this package does not know. */
export interface RawEnvelope {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: unknown;
}

const RawEnvelopeSchema = z.looseObject({
  gm: z.number().int(),
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  runId: z.string(),
  type: z.string(),
  payload: z.unknown(),
});

export interface ParseIssue {
  path: string;
  message: string;
}

export type EnvelopeParseResult =
  | { kind: 'ok'; envelope: KnownEnvelope }
  | { kind: 'unknown-type'; envelope: RawEnvelope }
  | { kind: 'version-mismatch'; received: number; supported: number }
  | { kind: 'invalid'; reason: string; issues?: ParseIssue[] };

function toIssues(error: z.ZodError): ParseIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** Parse an already-JSON-decoded value. Never throws. */
export function parseEnvelope(value: unknown): EnvelopeParseResult {
  const raw = RawEnvelopeSchema.safeParse(value);
  if (!raw.success) {
    return {
      kind: 'invalid',
      reason: 'not a structurally valid GraphMind envelope',
      issues: toIssues(raw.error),
    };
  }
  if (raw.data.gm !== PROTOCOL_VERSION) {
    return { kind: 'version-mismatch', received: raw.data.gm, supported: PROTOCOL_VERSION };
  }
  // NB: own-property check, not a bare index — a type like "constructor"
  // must resolve to unknown-type, not to something off Object.prototype.
  if (!isMessageType(raw.data.type)) {
    return { kind: 'unknown-type', envelope: raw.data as RawEnvelope };
  }
  const schema = EnvelopeSchemas[raw.data.type];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      reason: `invalid payload for message type "${raw.data.type}"`,
      issues: toIssues(parsed.error),
    };
  }
  return { kind: 'ok', envelope: parsed.data as KnownEnvelope };
}

/** Parse a raw text frame (JSON decode + parseEnvelope). Never throws. */
export function parseEnvelopeJson(text: string): EnvelopeParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'invalid',
      reason: `frame is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return parseEnvelope(value);
}
