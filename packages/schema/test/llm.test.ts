/**
 * Reader-side LLM conventions: how a stored TokenUsage is interpreted, and
 * finish-reason normalization (which senders share through @graphmind-ai/client;
 * the full table is the cross-language fixture packages/client/test/fixtures/llm.json).
 */
import { describe, expect, it } from 'vitest';
import { FINISH_REASONS, TokenUsageSchema, normalizeFinishReason, readUsage } from '../src/index.js';

describe('readUsage', () => {
  it('trusts inclusive usage and reads the new optional counts', () => {
    expect(
      readUsage({
        inputTokens: 1205,
        outputTokens: 100,
        inclusive: true,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        reasoningTokens: 7,
        cacheCreationTokens: 200,
      }),
    ).toEqual({
      inputTokens: 1205,
      outputTokens: 100,
      basis: 'inclusive',
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      reasoningTokens: 7,
    });
  });

  it('recomputes a 0.5 Anthropic TS event (cacheCreationTokens, no marker)', () => {
    expect(
      readUsage({ inputTokens: 5, outputTokens: 100, cacheReadTokens: 1000, cacheCreationTokens: 200 }),
    ).toEqual({
      inputTokens: 1205,
      outputTokens: 100,
      basis: 'recomputed',
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
    });
    expect(readUsage({ inputTokens: 5, outputTokens: 1, cacheCreationTokens: 0 })).toMatchObject({
      inputTokens: 5,
      basis: 'recomputed',
    });
  });

  it('labels anything else as reported, reading the 0.5 OpenAI alias', () => {
    expect(readUsage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 64, totalTokens: 120 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      basis: 'reported',
      cacheReadTokens: 64,
    });
    expect(readUsage({ inputTokens: 3, outputTokens: 4 })).toEqual({ inputTokens: 3, outputTokens: 4, basis: 'reported' });
    expect(readUsage({ inputTokens: 3, outputTokens: 4, inclusive: false })?.basis).toBe('reported');
  });

  it('prefers the new names over the aliases and ignores invalid counts', () => {
    expect(
      readUsage({
        inputTokens: 9,
        outputTokens: 1,
        inclusive: true,
        cacheReadTokens: -1,
        cachedInputTokens: 4,
        cacheWriteTokens: 'x',
        cacheCreationTokens: 2,
        reasoningTokens: Number.NaN,
      }),
    ).toEqual({ inputTokens: 9, outputTokens: 1, basis: 'inclusive', cacheReadTokens: 4, cacheWriteTokens: 2 });
  });

  it('is undefined for anything that is not a usage', () => {
    for (const value of [undefined, null, 3, 'x', [], {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }]) {
      expect(readUsage(value)).toBeUndefined();
    }
    const hostile = Object.defineProperty({}, 'inputTokens', {
      get() {
        throw new Error('nope');
      },
    });
    expect(readUsage(hostile)).toBeUndefined();
  });

  it('the new fields validate on the wire; unreported ones are simply absent', () => {
    expect(
      TokenUsageSchema.safeParse({
        inputTokens: 1,
        outputTokens: 1,
        inclusive: true,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      }).success,
    ).toBe(true);
    expect(TokenUsageSchema.safeParse({ inputTokens: 1, outputTokens: 1, cacheReadTokens: -1 }).success).toBe(false);
  });
});

describe('normalizeFinishReason', () => {
  it('maps to the six values, never throws', () => {
    expect([...FINISH_REASONS]).toEqual(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'other']);
    expect(normalizeFinishReason('end_turn')).toBe('stop');
    expect(normalizeFinishReason('end_turn', true)).toBe('tool-calls');
    expect(normalizeFinishReason('max_tokens', true)).toBe('length');
    expect(normalizeFinishReason('Content Filter')).toBe('content-filter');
    expect(normalizeFinishReason('whatever')).toBe('other');
    expect(normalizeFinishReason(undefined)).toBeUndefined();
    expect(normalizeFinishReason({ unified: 'stop' })).toBeUndefined();
  });
});
