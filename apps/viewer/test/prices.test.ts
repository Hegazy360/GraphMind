/**
 * Price lookup against the REAL bundled genai-prices snapshot: provider and
 * model matching per the table's own rules, conditional and tiered prices,
 * cache read / write / 1-hour write carving, and "unknown model → no $".
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PRICES_ELEMENT_ID, getPriceTableState, loadPriceTable, setPriceTableForTests } from '../src/prices/loader.js';
import {
  activePrices,
  calcCost,
  matchClause,
  normalizeCompactDatedRef,
  resolveModel,
  type ModelPrice,
  type PriceTable,
} from '../src/prices/engine.js';
import { PRICE_SNAPSHOT } from '../src/prices/snapshot.js';

const DATA_URL = new URL('../src/prices/data_slim.json', import.meta.url);
const TABLE = JSON.parse(readFileSync(fileURLToPath(DATA_URL), 'utf8')) as PriceTable;

function resolve(model: string, provider?: string): string | undefined {
  const hit = resolveModel(TABLE, { model, ...(provider !== undefined ? { provider } : {}) });
  return hit === undefined ? undefined : `${hit.provider.id}/${hit.model.id}`;
}

function pricesFor(model: string, provider?: string, at = '2026-09-01T12:00:00Z'): ModelPrice {
  const hit = resolveModel(TABLE, { model, ...(provider !== undefined ? { provider } : {}) });
  if (hit === undefined) throw new Error(`no match for ${model}`);
  const prices = activePrices(hit.model, new Date(at));
  if (prices === undefined) throw new Error('no prices');
  return prices;
}

describe('snapshot provenance', () => {
  it('the bundled bytes are the ones the recorded date describes', () => {
    const sha = createHash('sha256').update(readFileSync(fileURLToPath(DATA_URL))).digest('hex');
    expect(sha).toBe(PRICE_SNAPSHOT.sha256);
    expect(PRICE_SNAPSHOT.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('ships the MIT license next to the data and in the built viewer', () => {
    const license = readFileSync(fileURLToPath(new URL('../src/prices/LICENSE', import.meta.url)), 'utf8');
    expect(license).toContain('Pydantic Services Inc.');
    const notice = readFileSync(fileURLToPath(new URL('../public/THIRD_PARTY_NOTICES.txt', import.meta.url)), 'utf8');
    expect(notice).toContain('genai-prices');
    expect(notice).toContain('Permission is hereby granted');
  });
});

describe('match clauses', () => {
  it('equals / starts_with / ends_with / contains ignore case; regex does not', () => {
    expect(matchClause({ equals: 'gpt-4o' }, 'GPT-4o')).toBe(true);
    expect(matchClause({ starts_with: 'claude-' }, 'Claude-X')).toBe(true);
    expect(matchClause({ ends_with: '-fast' }, 'grok-FAST')).toBe(true);
    expect(matchClause({ contains: 'anthropic' }, 'Vertex.Anthropic')).toBe(true);
    expect(matchClause({ regex: '^o[134]' }, 'O3')).toBe(false);
    expect(matchClause({ regex: '^o[134]' }, 'o3')).toBe(true);
    expect(matchClause({ or: [{ equals: 'a' }, { equals: 'b' }] }, 'b')).toBe(true);
    expect(matchClause({ and: [{ starts_with: 'a' }, { ends_with: 'z' }] }, 'abz')).toBe(true);
    expect(matchClause({ and: [{ starts_with: 'a' }, { ends_with: 'z' }] }, 'aby')).toBe(false);
    expect(matchClause({ regex: '(' }, 'x')).toBe(false); // bad pattern matches nothing
  });

  it('normalizes a compact date the way upstream does', () => {
    expect(normalizeCompactDatedRef('gpt-4o-20240806')).toBe('gpt-4o-2024-08-06');
    expect(normalizeCompactDatedRef('model-20241399')).toBe('model-20241399'); // not a date
  });
});

describe('model matching across providers', () => {
  it('Anthropic: SDK provider string, bare model id, dated id', () => {
    expect(resolve('claude-sonnet-4-5', 'anthropic.messages')).toBe('anthropic/claude-sonnet-4-5');
    expect(resolve('claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5'); // model_match "claude"
    expect(resolve('claude-haiku-4-5-20251001', 'anthropic')).toBe('anthropic/claude-haiku-4-5');
  });

  it('OpenAI: chat / responses provider strings and the dated snapshot id', () => {
    expect(resolve('gpt-4o', 'openai.chat')).toBe('openai/gpt-4o');
    expect(resolve('gpt-4o-2024-08-06', 'openai.responses')).toBe('openai/gpt-4o');
    expect(resolve('gpt-4o-20240806', 'openai')).toBe('openai/gpt-4o'); // compact date
    expect(resolve('o3')).toBe('openai/o3'); // model_match regex
  });

  it('Google, xAI, DeepSeek, Bedrock', () => {
    expect(resolve('gemini-2.5-pro', 'google.generative-ai')).toBe('google/gemini-2.5-pro');
    expect(resolve('Gemini-2.5-Flash', 'google_genai')).toBe('google/gemini-2.5-flash');
    expect(resolve('grok-4', 'xai.chat')).toBe('x-ai/grok-4-0709'); // `xai.chat` tried as `xai`
    expect(resolve('deepseek-chat', 'deepseek.chat')).toBe('deepseek/deepseek-chat');
    expect(resolve('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'amazon-bedrock')).toBe(
      'aws/regional.anthropic.claude-sonnet-4-5-20250929-v1:0',
    );
  });

  it('a vendor/model id through a gateway resolves by the vendor prefix', () => {
    expect(resolve('anthropic/claude-sonnet-4.5', 'gateway')).toBe('anthropic/claude-sonnet-4-5');
    expect(resolve('openai/gpt-4o-mini')).toBe('openai/gpt-4o-mini');
  });

  it('a provider hint without the model falls back to matching by model id', () => {
    // An OpenAI client pointed at DeepSeek: the SDK says "openai".
    expect(resolve('deepseek-chat', 'openai')).toBe('deepseek/deepseek-chat');
  });

  it('unknown model → undefined (the viewer shows no $)', () => {
    expect(resolve('mock-model-id', 'mock-provider')).toBeUndefined();
    expect(resolve('my-finetune-v3')).toBeUndefined();
    expect(resolve('')).toBeUndefined();
  });
});

describe('active prices', () => {
  it('start_date constraints: the last one in force wins', () => {
    expect(pricesFor('o3', 'openai', '2025-05-01T00:00:00Z')['input_mtok']).toBe(10);
    expect(pricesFor('o3', 'openai', '2025-07-01T00:00:00Z')['input_mtok']).toBe(2);
  });

  it('time-of-day constraints (UTC)', () => {
    expect(pricesFor('deepseek-chat', 'deepseek', '2026-09-01T12:00:00Z')['input_mtok']).toBe(0.27);
    expect(pricesFor('deepseek-chat', 'deepseek', '2026-09-01T20:00:00Z')['input_mtok']).toBe(0.135);
  });
});

describe('cost math', () => {
  it('carves cache reads and writes out of the inclusive input total', () => {
    const cost = calcCost(
      { inputTokens: 10_000, cacheReadTokens: 6_000, cacheWriteTokens: 2_000, outputTokens: 500 },
      pricesFor('claude-sonnet-4-5', 'anthropic'),
    );
    expect(cost).toBeDefined();
    if (cost === undefined) return;
    expect(cost.input).toBeCloseTo((2_000 * 3) / 1e6, 10);
    expect(cost.cacheRead).toBeCloseTo((6_000 * 0.3) / 1e6, 10);
    expect(cost.cacheWrite).toBeCloseTo((2_000 * 3.75) / 1e6, 10);
    expect(cost.output).toBeCloseTo((500 * 15) / 1e6, 10);
    expect(cost.total).toBeCloseTo(0.0228, 10);
    expect(cost.clamped).toBe(false);
  });

  it('tiers are cliffs on the TOTAL input: past 200k every token pays the tier price', () => {
    const cost = calcCost({ inputTokens: 250_000, outputTokens: 1_000 }, pricesFor('claude-sonnet-4-5', 'anthropic'));
    expect(cost?.input).toBeCloseTo((250_000 * 6) / 1e6, 10);
    expect(cost?.output).toBeCloseTo((1_000 * 22.5) / 1e6, 10);
  });

  it('a 1-hour cache write is charged at its own price when reported', () => {
    const prices = pricesFor('claude-haiku-4-5', 'anthropic');
    expect(prices['cache_write_1h_mtok']).toBe(2);
    const cost = calcCost(
      { inputTokens: 1_000, cacheWriteTokens: 1_000, cacheWrite1hTokens: 400, outputTokens: 0 },
      prices,
    );
    expect(cost?.cacheWrite).toBeCloseTo((600 * 1.25 + 400 * 2) / 1e6, 12);
    expect(cost?.input).toBe(0);
  });

  it('without a cache-write price the written tokens pay the input price', () => {
    const prices = pricesFor('gpt-4o', 'openai');
    expect(prices['cache_write_mtok']).toBeUndefined();
    const cost = calcCost({ inputTokens: 1_000, cacheReadTokens: 400, cacheWriteTokens: 100, outputTokens: 0 }, prices);
    expect(cost?.cacheRead).toBeCloseTo((400 * 1.25) / 1e6, 12);
    expect(cost?.cacheWrite).toBe(0);
    expect(cost?.input).toBeCloseTo((600 * 2.5) / 1e6, 12);
  });

  it('inconsistent usage is clamped, never negative', () => {
    const cost = calcCost({ inputTokens: 100, cacheReadTokens: 500, outputTokens: 0 }, pricesFor('gpt-4o', 'openai'));
    expect(cost?.clamped).toBe(true);
    expect(cost?.input).toBe(0);
    expect(cost?.cacheRead).toBeCloseTo((100 * 1.25) / 1e6, 12);
  });

  it('refuses to price tokens on a side the model has no price for', () => {
    expect(calcCost({ inputTokens: 10, outputTokens: 10 }, { input_mtok: 1 })).toBeUndefined();
    expect(calcCost({ inputTokens: 10, outputTokens: 0 }, { input_mtok: 1 })?.total).toBeCloseTo(1e-5, 12);
    expect(calcCost({ inputTokens: 10, outputTokens: 0 }, { audio_hours: 1 })).toBeUndefined();
  });
});

describe('loading the table', () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    setPriceTableForTests(undefined);
  });

  /** A page whose only element is the exporter's JSON block. */
  function pageWithBlock(text: string): void {
    (globalThis as { document?: unknown }).document = {
      getElementById: (id: string) => (id === PRICES_ELEMENT_ID ? { textContent: text } : null),
    };
  }

  it('an exported run reads the table it carries, and never imports a chunk from beside the file', async () => {
    const small = [{ id: 'anthropic', name: 'Anthropic', models: [] }];
    pageWithBlock(JSON.stringify(small));
    setPriceTableForTests(undefined);
    expect(await loadPriceTable()).toEqual(small);
    expect(getPriceTableState()).toEqual({ status: 'ready', table: small });
  });

  it('a malformed block is an error (no dollar figures), not a fallback to the import', async () => {
    pageWithBlock('{"not":"a table"}');
    setPriceTableForTests(undefined);
    expect(await loadPriceTable()).toBeUndefined();
    expect(getPriceTableState()).toEqual({ status: 'error' });
  });

  it('with no block (a served viewer), the lazy chunk is the table', async () => {
    setPriceTableForTests(undefined);
    const table = await loadPriceTable();
    expect(table?.length).toBe(TABLE.length);
  });
});
