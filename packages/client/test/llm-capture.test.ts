/**
 * LLM-step capture helpers (contract C1): the shared conformance fixture
 * (test/fixtures/llm.json — finish reasons, tool calls, tool-schema hashes,
 * the sampling allow-list) plus the parts only TypeScript has: the usage
 * builder every TS adapter goes through, the per-run schema memory, and the
 * binary placeholders for AI SDK prompts.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_SCHEMA_HASHES_PER_RUN,
  MAX_SCHEMA_RUNS,
  SAMPLING_PARAM_KEYS,
  captureTools,
  makeUsage,
  normalizeFinishReason,
  pickParams,
  resetToolSchemaMemory,
  schemaHash,
  sumReported,
  tokenCount,
  toolCall,
  toolCalls,
  withBinaryPlaceholders,
} from '../src/llm-capture.js';
import { canonicalize } from '../src/loop-guard.js';

interface LlmFixture {
  finishReasons: [unknown, boolean, string | null][];
  toolCalls: { in: { id?: unknown; name?: unknown; args?: unknown }; out: unknown }[];
  schemaHashes: { in: unknown; hash: string }[];
  samplingParams: string[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/llm.json', import.meta.url), 'utf8'),
) as LlmFixture;

describe('conformance fixture (shared with the Python and Ruby ports)', () => {
  it.each(fixture.finishReasons.map((row) => [JSON.stringify(row[0]), row] as const))(
    'finish reason %s',
    (_label, [raw, hasToolCalls, expected]) => {
      expect(normalizeFinishReason(raw, hasToolCalls) ?? null).toBe(expected);
    },
  );

  it.each(fixture.toolCalls.map((row) => [JSON.stringify(row.in), row] as const))(
    'tool call %s',
    (_label, row) => {
      const out = toolCall(row.in.id, row.in.name, row.in.args) ?? null;
      expect(JSON.parse(JSON.stringify(out))).toEqual(row.out);
    },
  );

  it.each(fixture.schemaHashes.map((row, i) => [i, row] as const))('schema hash #%s', (_i, row) => {
    expect(schemaHash(row.in)).toBe(row.hash);
    expect(row.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(row.hash).toBe(
      createHash('sha256').update(canonicalize(row.in), 'utf8').digest('hex').slice(0, 16),
    );
  });

  it('key order never changes a hash', () => {
    expect(fixture.schemaHashes[0]?.hash).toBe(fixture.schemaHashes[1]?.hash);
  });

  it('pins the sampling-parameter allow-list', () => {
    expect([...SAMPLING_PARAM_KEYS]).toEqual(fixture.samplingParams);
  });

  it('is not vacuous', () => {
    expect(fixture.finishReasons.length).toBeGreaterThan(20);
    expect(new Set(fixture.finishReasons.map((r) => r[2])).size).toBe(7); // six values + null
    expect(fixture.toolCalls.some((r) => r.out === null)).toBe(true);
    expect(fixture.toolCalls.some((r) => (r.out as { inputText?: string } | null)?.inputText)).toBe(true);
  });
});

describe('makeUsage', () => {
  it('stamps inclusive and keeps only the reported optional counts', () => {
    expect(makeUsage({ input: 10, output: 2 })).toEqual({ inputTokens: 10, outputTokens: 2, inclusive: true });
    expect(makeUsage({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      inclusive: true,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('is undefined when neither count was reported; a missing required count is 0', () => {
    expect(makeUsage({})).toBeUndefined();
    expect(makeUsage({ cacheRead: 5 })).toBeUndefined();
    expect(makeUsage({ output: 3 })).toEqual({ inputTokens: 0, outputTokens: 3, inclusive: true });
  });

  it('appends extras after the canonical fields, skipping unreported ones', () => {
    const usage = makeUsage({ input: 5, output: 1, cacheWrite: 4 }, { cacheCreationTokens: 4, totalTokens: undefined });
    expect(Object.keys(usage ?? {})).toEqual([
      'inputTokens',
      'outputTokens',
      'inclusive',
      'cacheWriteTokens',
      'cacheCreationTokens',
    ]);
  });

  it('rounds fractions and rejects negatives, NaN, strings', () => {
    expect(tokenCount(1.6)).toBe(2);
    expect(tokenCount(-1)).toBeUndefined();
    expect(tokenCount(Number.NaN)).toBeUndefined();
    expect(tokenCount(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(tokenCount('3')).toBeUndefined();
    expect(sumReported(undefined, undefined)).toBeUndefined();
    expect(sumReported(undefined, 0)).toBe(0);
    expect(sumReported(1, undefined, 2)).toBe(3);
  });
});

describe('toolCalls', () => {
  it('drops unnamed entries and keeps order', () => {
    expect(
      toolCalls([
        { id: 'a', name: 'x', args: '{"k":1}' },
        { id: 'b', args: '{}' },
        { name: 'y', args: { k: 2 } },
      ]),
    ).toEqual([
      { id: 'a', name: 'x', input: { k: 1 } },
      { name: 'y', input: { k: 2 } },
    ]);
  });
});

describe('captureTools', () => {
  const def = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    input_schema: { type: 'object', properties: {}, ...extra },
  });
  const nameOf = (d: unknown): string | undefined => (d as { name?: string }).name;

  it('sends each definition once per run, by hash', () => {
    const session = {};
    const first = captureTools(session, 'run-1', [def('a'), def('b')], nameOf);
    const hashA = schemaHash(def('a'));
    const hashB = schemaHash(def('b'));
    expect(first).toEqual({
      tools: [
        { name: 'a', schemaHash: hashA },
        { name: 'b', schemaHash: hashB },
      ],
      toolSchemas: { [hashA]: def('a'), [hashB]: def('b') },
    });
    // Same tools on the next step: references only.
    expect(captureTools(session, 'run-1', [def('a'), def('b')], nameOf)).toEqual({
      tools: first?.tools,
    });
    // A changed schema is a new hash, sent once.
    const changed = def('a', { required: ['q'] });
    const next = captureTools(session, 'run-1', [changed, def('b')], nameOf);
    expect(next?.toolSchemas).toEqual({ [schemaHash(changed)]: changed });
    // Another run starts from scratch; another session too.
    expect(captureTools(session, 'run-2', [def('a')], nameOf)?.toolSchemas).toEqual({ [hashA]: def('a') });
    expect(captureTools({}, 'run-1', [def('a')], nameOf)?.toolSchemas).toEqual({ [hashA]: def('a') });
  });

  it('skips definitions without a name and returns undefined when nothing is left', () => {
    const session = {};
    expect(captureTools(session, 'r', [], nameOf)).toBeUndefined();
    expect(captureTools(session, 'r', undefined, nameOf)).toBeUndefined();
    expect(captureTools(session, 'r', [{ type: 'x' }], nameOf)).toBeUndefined();
    expect(
      captureTools(session, 'r', [def('a')], () => {
        throw new Error('boom');
      }),
    ).toBeUndefined();
  });

  it('is bounded: least recently used runs are forgotten, a run past its hash cap restarts', () => {
    const session = {};
    captureTools(session, 'keep', [def('a')], nameOf);
    for (let i = 0; i < MAX_SCHEMA_RUNS - 1; i += 1) captureTools(session, `r${i}`, [def('a')], nameOf);
    // Touch `keep` so it is the most recent, then push one more run.
    expect(captureTools(session, 'keep', [def('a')], nameOf)?.toolSchemas).toBeUndefined();
    captureTools(session, 'overflow', [def('a')], nameOf);
    expect(captureTools(session, 'keep', [def('a')], nameOf)?.toolSchemas).toBeUndefined();
    // r0 was the least recently used and is gone: its schema is sent again.
    expect(captureTools(session, 'r0', [def('a')], nameOf)?.toolSchemas).toBeDefined();

    const many = Array.from({ length: MAX_SCHEMA_HASHES_PER_RUN + 1 }, (_, i) => def(`t${i}`));
    const big = captureTools(session, 'big', many, nameOf);
    expect(Object.keys(big?.toolSchemas ?? {}).length).toBe(MAX_SCHEMA_HASHES_PER_RUN + 1);
    resetToolSchemaMemory(session);
    expect(captureTools(session, 'keep', [def('a')], nameOf)?.toolSchemas).toBeDefined();
  });
});

describe('pickParams', () => {
  it('copies allow-listed keys only, in allow-list order, skipping undefined', () => {
    const body = {
      model: 'm',
      messages: [],
      temperature: 0.2,
      max_tokens: 100,
      top_k: undefined,
      metadata: { user_id: 'u' },
      mcp_servers: [{ authorization_token: 'SECRET' }],
      stop_sequences: ['\n'],
    };
    expect(pickParams(body)).toEqual({ temperature: 0.2, max_tokens: 100, stop_sequences: ['\n'] });
    expect(JSON.stringify(pickParams(body))).not.toContain('SECRET');
    expect(pickParams(null)).toEqual({});
    const throwing = Object.defineProperty({}, 'temperature', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(pickParams(throwing)).toEqual({});
  });

  it('never allow-lists a field known to carry credentials or identities', () => {
    for (const key of ['providerOptions', 'headers', 'abortSignal', 'mcp_servers', 'metadata', 'user', 'api_key']) {
      expect(SAMPLING_PARAM_KEYS).not.toContain(key);
    }
  });
});

describe('withBinaryPlaceholders', () => {
  it('replaces byte buffers and copies only the path to them', () => {
    const shared = { type: 'text', text: 'hi' };
    const prompt = [
      { role: 'user', content: [shared, { type: 'file', data: new Uint8Array(12), mediaType: 'image/png' }] },
      { role: 'user', content: [{ type: 'text', text: 'no bytes' }] },
    ];
    const out = withBinaryPlaceholders(prompt) as typeof prompt;
    expect(JSON.parse(JSON.stringify(out))).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'file', data: { type: 'binary', bytes: 12 }, mediaType: 'image/png' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'no bytes' }] },
    ]);
    expect(out).not.toBe(prompt);
    expect(out[1]).toBe(prompt[1]); // untouched branch shared, not copied
    expect(out[0]?.content[0]).toBe(shared);
    expect((prompt[0]?.content[1] as { data: unknown }).data).toBeInstanceOf(Uint8Array); // host's object untouched
  });

  it('handles Buffer, ArrayBuffer, class instances, cycles and primitives', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const url = new URL('https://example.com/x.png');
    expect(withBinaryPlaceholders(Buffer.from('abc'))).toEqual({ type: 'binary', bytes: 3 });
    expect(withBinaryPlaceholders(new ArrayBuffer(5))).toEqual({ type: 'binary', bytes: 5 });
    expect(withBinaryPlaceholders({ url })).toEqual({ url });
    expect(withBinaryPlaceholders(cyclic)).toBe(cyclic);
    expect(withBinaryPlaceholders('s')).toBe('s');
    expect(withBinaryPlaceholders(undefined)).toBeUndefined();
  });
});
