/**
 * Golden-file stability of the exported JSON Schema.
 *
 * If this test fails you changed the wire contract (or bumped zod across a
 * version that changes JSON Schema emission). That may be intentional — then
 * regenerate the golden with:
 *
 *   pnpm --filter @graphmind/schema run build \
 *     && cp schema.json test/fixtures/schema.golden.json
 *
 * ...and treat the diff as a contract review, not noise.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, exportJsonSchema, exportJsonSchemaString } from '../src/index.js';

const goldenUrl = new URL('./fixtures/schema.golden.json', import.meta.url);

describe('schema.json golden file', () => {
  it('exportJsonSchemaString matches the golden file byte-for-byte', () => {
    const golden = readFileSync(goldenUrl, 'utf8');
    expect(exportJsonSchemaString()).toBe(golden);
  });

  it('export is deterministic across calls', () => {
    expect(exportJsonSchemaString()).toBe(exportJsonSchemaString());
  });

  it('has the expected identity fields', () => {
    const schema = exportJsonSchema();
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['$id']).toContain(`/v${PROTOCOL_VERSION}/`);
    expect(Array.isArray(schema['anyOf'])).toBe(true);
    expect((schema['anyOf'] as unknown[]).length).toBe(15);
  });
});
