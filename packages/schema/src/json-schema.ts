/**
 * JSON Schema export of the wire contract, for adapter authors working in
 * other languages. The build writes this to `schema.json` at the package
 * root, and a golden-file test pins its exact content so accidental contract
 * drift fails CI.
 */
import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants.js';
import { KnownEnvelopeSchema } from './envelope.js';

/** The wire contract as a JSON Schema (draft 2020-12) document. */
export function exportJsonSchema(): Record<string, unknown> {
  const core = z.toJSONSchema(KnownEnvelopeSchema, {
    target: 'draft-2020-12',
    reused: 'ref',
  }) as Record<string, unknown>;
  delete core['$schema'];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://graphmind.dev/wire/v${PROTOCOL_VERSION}/envelope.schema.json`,
    title: `GraphMind wire envelope (protocol v${PROTOCOL_VERSION})`,
    description:
      'Every frame exchanged between an instrumented app and a GraphMind viewer ' +
      'is one JSON envelope matching this schema. Receivers must tolerate ' +
      'unknown message types and unknown payload fields (forward compatibility) ' +
      'and must reject envelopes whose "gm" differs from theirs.',
    ...core,
  };
}

/** Deterministic, pretty-printed string form of `exportJsonSchema()`. */
export function exportJsonSchemaString(): string {
  return `${JSON.stringify(exportJsonSchema(), null, 2)}\n`;
}
