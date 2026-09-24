/**
 * The prompt diff on REAL recordings (every 0.6 adapter's agent loop, plus
 * variants derived from them: trimmed history, compaction, a changed system
 * prompt, a tool whose schema changed, changed sampling params / model) and
 * the edit-script core with its budget — plus per-step cost on recorded
 * executions (usage read by the same rules as every usage display).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@graphmind-ai/schema';
import { modelHintsOf, priceExecution, sumCosts } from '../src/context/cost.js';
import { normalizePrompt, type NormPrompt } from '../src/context/normalizePrompt.js';
import { diffLines, diffPrompts, diffSequences, type PromptDiff } from '../src/context/promptDiff.js';
import type { PriceTable } from '../src/prices/engine.js';
import type { NodeExecution } from '../src/store/types.js';

interface RecordedStep {
  instanceId: string;
  ts: number;
  input: unknown;
  usage?: TokenUsage;
  output?: unknown;
  startedExtra?: { model?: string; modelId?: string; provider?: string };
}
const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/recorded-llm-inputs.json', import.meta.url)), 'utf8'),
) as Record<string, RecordedStep[]>;
const TABLE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/prices/data_slim.json', import.meta.url)), 'utf8'),
) as PriceTable;

function prompt(input: unknown): NormPrompt {
  const result = normalizePrompt(input);
  if (!result.ok) throw new Error(`refused ${result.code}`);
  return result.prompt;
}

function diffOf(prev: unknown, cur: unknown): PromptDiff {
  return diffPrompts(prompt(prev), prompt(cur));
}

function recorded(name: string, i: number): RecordedStep {
  const step = FIXTURE[name]?.[i];
  if (step === undefined) throw new Error(`${name}[${i}] missing`);
  return step;
}

/** A deep copy of a recorded input, to derive a variant from. */
function input<T = Record<string, unknown>>(name: string, i: number): T {
  return structuredClone(recorded(name, i).input) as T;
}

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

describe('edit script (Myers)', () => {
  const lcsLength = (a: string[], b: string[]): number => {
    const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
    return dp[a.length]![b.length]!;
  };

  it('is a shortest script that replays a into b (randomized against an LCS table)', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abcd'[Math.floor(rnd() * 4)] ?? 'a');
      const b = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abcd'[Math.floor(rnd() * 4)] ?? 'a');
      const { ops, approximate } = diffSequences(a, b);
      expect(approximate).toBe(false);
      const same = ops.filter((o) => o.type === 'same');
      expect(same.length).toBe(lcsLength(a, b));
      // Replaying keeps the order of both sequences.
      expect(ops.filter((o) => o.type !== 'ins').map((o) => a[o.a])).toEqual(a);
      expect(ops.filter((o) => o.type !== 'del').map((o) => b[o.b])).toEqual(b);
    }
  });

  it('gives up honestly past its budget: the middle becomes removed + added', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    const { ops, approximate } = diffSequences(a, b, undefined, 100);
    expect(approximate).toBe(true);
    expect(ops.filter((o) => o.type === 'del')).toHaveLength(50);
    expect(ops.filter((o) => o.type === 'ins')).toHaveLength(50);
  });

  it('line diff of a changed system prompt', () => {
    const { lines } = diffLines('You are helpful.\nBe brief.\nUse tools.', 'You are helpful.\nBe thorough.\nUse tools.');
    expect(lines).toEqual([
      { type: 'same', text: 'You are helpful.' },
      { type: 'del', text: 'Be brief.' },
      { type: 'ins', text: 'Be thorough.' },
      { type: 'same', text: 'Use tools.' },
    ]);
  });
});

describe('prompt diff — real agent loops of every 0.6 adapter', () => {
  const LOOPS = [
    'aiSdk',
    'anthropicTs',
    'openaiChat',
    'openaiResponses',
    'langgraphTs',
    'pythonAnthropic',
    'pythonOpenAIChat',
    'pythonOpenAIResponses',
    'pythonLangchain',
    'rubyOpenAI',
    'rubyLlm',
  ];

  it('each step appends the tool round trip; system, tools and params unchanged; no cache break', () => {
    for (const name of LOOPS) {
      const diff = diffOf(recorded(name, 0).input, recorded(name, 1).input);
      expect(diff.appendOnly, name).toBe(true);
      expect(diff.identical, name).toBe(false);
      expect(diff.firstDivergence, name).toEqual({ cur: 1, prev: 1 });
      expect(diff.counts, name).toEqual({ same: 1, added: 2, removed: 0, changed: 0 });
      expect(diff.system.status, name).toBe('same');
      expect(diff.params, name).toEqual([]);
      expect(diff.prefixBreak, name).toBeUndefined();
      if (diff.tools !== undefined) {
        expect(diff.tools, name).toMatchObject({ status: 'compared', basis: 'hash', added: [], removed: [], changed: [] });
      }
    }
  });

  it('three-step loops (AI SDK, Anthropic with a moving cache breakpoint): the second step appends too', () => {
    for (const name of ['aiSdk', 'anthropicTs']) {
      const diff = diffOf(recorded(name, 1).input, recorded(name, 2).input);
      expect(diff.appendOnly, name).toBe(true);
      expect(diff.firstDivergence, name).toEqual({ cur: 3, prev: 3 });
      expect(diff.hunks.map((h) => h.type), name).toEqual(['same', 'added']);
      expect(diff.hunks[1]?.rows.map((r) => r.cur?.label), name).toEqual([
        'assistant → checkWeather, convertCurrency',
        expect.stringMatching(/^tool results: checkWeather, convertCurrency$/),
      ]);
    }
  });

  it('the demo recording: a re-run whose last tool result differs reads as ONE changed message', () => {
    // inv_1:s3 (the debugger injected a corrected checkBudget result) vs inv_2:s3 (the error).
    const diff = diffOf(recorded('legacyDemoAiSdk', 3).input, recorded('legacyDemoAiSdk', 4).input);
    expect(diff.counts).toEqual({ same: 6, added: 0, removed: 0, changed: 1 });
    expect(diff.firstDivergence).toEqual({ cur: 6, prev: 6 });
    expect(diff.hunks[1]?.rows[0]?.cur?.label).toBe('tool result: checkBudget');
    expect(diff.appendOnly).toBe(false);
    expect(diff.prefixBreak).toEqual({ at: 'message', index: 6 });
  });

  it('0.5 names-only tool lists still compare by name', () => {
    const diff = diffOf(recorded('legacyAnthropicTs', 0).input, recorded('legacyAnthropicTs', 1).input);
    expect(diff.tools).toEqual({ status: 'compared', basis: 'names', added: [], removed: [], changed: [], changedHashes: [], same: 3 });
  });
});

describe('prompt diff — variants of real recordings', () => {
  it('trim: messages dropped from the front of the history (OpenAI chat)', () => {
    const prev = input<{ messages: unknown[] }>('openaiChat', 1);
    const cur = input<{ messages: unknown[] }>('openaiChat', 1);
    cur.messages.splice(1, 2); // keep the system prompt, drop the user turn + tool call
    cur.messages.push(assistant('Booked TP1234.'));
    const diff = diffOf(prev, cur);
    expect(diff.counts).toEqual({ same: 1, added: 1, removed: 2, changed: 0 });
    expect(diff.firstDivergence).toEqual({ cur: 0, prev: 0 });
    expect(diff.hunks.map((h) => h.type)).toEqual(['removed', 'same', 'added']);
    expect(diff.prefixBreak).toEqual({ at: 'message', index: 0 });
  });

  it('compaction: history folded into one summary stays removed + added (AI SDK)', () => {
    const prev = input<{ prompt: unknown[] }>('aiSdk', 2);
    const cur = input<{ prompt: unknown[] }>('aiSdk', 2);
    cur.prompt.splice(1, 5, { role: 'user', content: [{ type: 'text', text: 'Summary: flights and weather checked.' }] });
    const diff = diffOf(prev, cur);
    expect(diff.counts).toEqual({ same: 0, added: 1, removed: 5, changed: 0 });
  });

  it('system prompt change (Anthropic system blocks) breaks the prefix at the system prompt', () => {
    const cur = input<{ system: { text: string }[] }>('anthropicTs', 1);
    cur.system[0]!.text = 'You plan trips.\nNever book red-eye flights.';
    const diff = diffOf(recorded('anthropicTs', 1).input, cur);
    expect(diff.system.status).toBe('changed');
    if (diff.system.status === 'changed') {
      expect(diff.system.lines.filter((l) => l.type !== 'same').map((l) => [l.type, l.text])).toEqual([
        ['del', 'Always check the weather.'],
        ['ins', 'Never book red-eye flights.'],
      ]);
    }
    expect(diff.counts.added + diff.counts.removed + diff.counts.changed).toBe(0);
    expect(diff.identical).toBe(false);
    expect(diff.prefixBreak).toEqual({ at: 'system' });
  });

  it('tools: added, removed and a schema change by hash (W1 {name, schemaHash}), with both hashes', () => {
    const prev = input<{ tools: { name: string; schemaHash: string }[] }>('aiSdk', 1);
    const cur = input<{ tools: { name: string; schemaHash: string }[] }>('aiSdk', 1);
    cur.tools[0]!.schemaHash = 'ffffffffffffffff'; // searchFlights: same name, new schema
    cur.tools.splice(1, 1); // checkWeather gone
    cur.tools.push({ name: 'bookHotel', schemaHash: '0123456789abcdef' });
    const diff = diffOf(prev, cur);
    expect(diff.tools).toEqual({
      status: 'compared',
      basis: 'hash',
      added: ['bookHotel'],
      removed: ['checkWeather'],
      changed: ['searchFlights'],
      changedHashes: [{ name: 'searchFlights', before: '2504a1140b95b9b6', after: 'ffffffffffffffff' }],
      same: 1,
    });
    expect(diff.identical).toBe(false);
    expect(diff.prefixBreak).toEqual({ at: 'tools' });
    const oneSide = { ...input<Record<string, unknown>>('aiSdk', 1) };
    delete oneSide['tools'];
    expect(diffOf(oneSide, recorded('aiSdk', 1).input).tools).toEqual({ status: 'one-side', side: 'cur' });
  });

  it('sampling params and model: changed, added, dropped (the "silently dropped param" class)', () => {
    const prev = input<Record<string, unknown>>('anthropicTs', 1);
    const cur = input<Record<string, unknown>>('anthropicTs', 1);
    cur['temperature'] = 0.9;
    delete cur['max_tokens'];
    cur['thinking'] = { type: 'enabled', budget_tokens: 2048 };
    const diff = diffOf(prev, cur);
    expect(diff.params).toEqual([
      { key: 'max_tokens', before: 1024 },
      { key: 'temperature', before: 0.2, after: 0.9 },
      { key: 'thinking', after: { type: 'enabled', budget_tokens: 2048 } },
    ]);
    expect(diff.identical).toBe(false);
    expect(diff.appendOnly).toBe(false); // nothing was appended
    expect(diff.prefixBreak).toBeUndefined();

    const model = input<Record<string, unknown>>('aiSdk', 1);
    model['modelId'] = 'claude-haiku-4-5';
    const switched = diffOf(recorded('aiSdk', 1).input, model);
    expect(switched.params).toEqual([{ key: 'model', before: 'claude-sonnet-4-5', after: 'claude-haiku-4-5' }]);
    expect(switched.prefixBreak).toEqual({ at: 'model' });
  });

  it('identical prompts (equal content, different objects) — and a param alone makes them differ', () => {
    const diff = diffOf(input('rubyLlm', 1), input('rubyLlm', 1));
    expect(diff.identical).toBe(true);
    expect(diff.counts.same).toBe(3);
    const warmer = input<Record<string, unknown>>('rubyLlm', 1);
    warmer['temperature'] = 1;
    expect(diffOf(input('rubyLlm', 1), warmer).identical).toBe(false);
  });

  it('messages removed from the end: divergence is after the last kept message', () => {
    const prev = input<{ messages: unknown[] }>('pythonOpenAIChat', 1);
    const cur = input<{ messages: unknown[] }>('pythonOpenAIChat', 1);
    cur.messages.splice(2);
    const diff = diffOf(prev, cur);
    expect(diff.firstDivergence).toEqual({ cur: 1, prev: 1 });
    expect(diff.counts.removed).toBe(2);
    expect(diff.prefixBreak).toEqual({ at: 'message', index: 1 });
  });

  it('stays fast on a long history (2,000 messages, one appended)', () => {
    const long = Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? user(`q${i} ${'x'.repeat(200)}`) : assistant(`a${i}`)));
    const base = input<Record<string, unknown>>('openaiChat', 0);
    const t0 = performance.now();
    const diff = diffOf({ ...base, messages: long }, { ...base, messages: [...long, user('next')] });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(diff.counts).toMatchObject({ same: 2000, added: 1 });
    expect(diff.appendOnly).toBe(true);
  });
});

describe('cost per execution', () => {
  const exec = (step: RecordedStep, extra: Partial<NodeExecution> = {}): NodeExecution => ({
    instanceId: step.instanceId,
    input: step.input,
    ...(step.output !== undefined ? { output: step.output } : {}),
    ...(step.usage !== undefined ? { usage: step.usage } : {}),
    status: 'ok',
    startedTs: Date.parse('2026-09-01T12:00:00Z'),
    ...(step.startedExtra?.modelId !== undefined || step.startedExtra?.provider !== undefined
      ? {
          modelHint: {
            ...(step.startedExtra.modelId !== undefined ? { model: step.startedExtra.modelId } : {}),
            ...(step.startedExtra.provider !== undefined ? { provider: step.startedExtra.provider } : {}),
          },
        }
      : {}),
    ...extra,
  });

  it('prices every current recording whose model the snapshot knows, at its cache rates', () => {
    const anthropic = priceExecution(TABLE, exec(recorded('anthropicTs', 1)));
    expect(anthropic.status).toBe('priced');
    if (anthropic.status === 'priced') {
      // 2,070 inclusive: 150 fresh × $3 + 1,800 read × $0.30 + 120 written × $3.75, + 90 out × $15 (per Mtok).
      expect(anthropic.usage).toMatchObject({ inputTokens: 2070, basis: 'inclusive', cacheReadTokens: 1800, cacheWriteTokens: 120 });
      expect(anthropic.cost.input).toBeCloseTo((150 * 3) / 1e6, 12);
      expect(anthropic.cost.cacheRead).toBeCloseTo((1800 * 0.3) / 1e6, 12);
      expect(anthropic.cost.cacheWrite).toBeCloseTo((120 * 3.75) / 1e6, 12);
      expect(anthropic.cost.output).toBeCloseTo((90 * 15) / 1e6, 12);
      expect(anthropic.resolved.model.id).toBe('claude-sonnet-4-5');
    }
    const resolvedIds: Record<string, string | undefined> = {};
    for (const name of ['aiSdk', 'openaiChat', 'openaiResponses', 'langgraphTs', 'pythonAnthropic', 'pythonOpenAIChat', 'pythonOpenAIResponses', 'rubyOpenAI', 'rubyLlm']) {
      const cost = priceExecution(TABLE, exec(recorded(name, 1)));
      resolvedIds[name] = cost.status === 'priced' ? `${cost.resolved.provider.id}/${cost.resolved.model.id}` : cost.status;
    }
    expect(resolvedIds).toEqual({
      aiSdk: 'anthropic/claude-sonnet-4-5', // provider 'anthropic.messages'
      openaiChat: 'openai/gpt-4o', // output.model 'gpt-4o-2024-08-06' wins over the request's 'gpt-4o'
      openaiResponses: 'openai/gpt-5-mini',
      langgraphTs: 'anthropic/claude-sonnet-4-5', // top-level modelId / provider (ls_model_name / ls_provider)
      pythonAnthropic: 'anthropic/claude-sonnet-4-5',
      pythonOpenAIChat: 'openai/gpt-4o-mini',
      pythonOpenAIResponses: 'openai/gpt-5-mini',
      rubyOpenAI: 'openai/gpt-4o-mini',
      rubyLlm: 'openai/gpt-4o-mini',
    });
  });

  it('an OpenAI cache read is priced at the model cache-read rate out of the inclusive prompt', () => {
    const chat = priceExecution(TABLE, exec(recorded('openaiChat', 1)));
    expect(chat.status).toBe('priced');
    if (chat.status !== 'priced') return;
    // gpt-4o: $2.50 in, $1.25 cached, $10 out; 1,420 inclusive with 1,280 cached, 55 out.
    expect(chat.cost.input).toBeCloseTo((140 * 2.5) / 1e6, 12);
    expect(chat.cost.cacheRead).toBeCloseTo((1280 * 1.25) / 1e6, 12);
    expect(chat.cost.output).toBeCloseTo((55 * 10) / 1e6, 12);
  });

  it('0.5 usage: the Anthropic TS uncached tail is recomputed; unmarked counts are "as reported"', () => {
    const legacy = priceExecution(TABLE, exec(recorded('legacyAnthropicTs', 0)));
    expect(legacy.status).toBe('priced');
    if (legacy.status === 'priced') {
      expect(legacy.usage).toMatchObject({ inputTokens: 27, basis: 'recomputed', cacheReadTokens: 5, cacheWriteTokens: 2 });
      expect(legacy.cost.input).toBeCloseTo((20 * 3) / 1e6, 12);
    }
    const reported = priceExecution(TABLE, exec(recorded('legacyOpenaiChat', 0)));
    expect(reported.status === 'priced' && reported.usage.basis).toBe('reported');
    const total = sumCosts(TABLE, [exec(recorded('legacyAnthropicTs', 0)), exec(recorded('legacyOpenaiChat', 0))]);
    expect(total).toMatchObject({ priced: 2, unpriced: 0, reported: 1 });
  });

  it('inclusive vs recomputed usage price differently for the same raw counts', () => {
    const base = { instanceId: 'a', ts: 0, input: { model: 'claude-sonnet-4-5', messages: [user('hi')] } };
    const inclusive = priceExecution(TABLE, exec({ ...base, usage: { inputTokens: 1_000, outputTokens: 100, inclusive: true, cacheReadTokens: 800, cacheWriteTokens: 0 } }));
    const legacy = priceExecution(TABLE, exec({ ...base, instanceId: 'b', usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 0 } as TokenUsage }));
    if (inclusive.status !== 'priced' || legacy.status !== 'priced') throw new Error('not priced');
    // inclusive: 200 fresh + 800 cached; legacy: the 1,000 were the fresh tail, + 800 cached on top.
    expect(inclusive.cost.input).toBeCloseTo((200 * 3) / 1e6, 12);
    expect(legacy.cost.input).toBeCloseTo((1_000 * 3) / 1e6, 12);
    expect(inclusive.cost.cacheRead).toBeCloseTo(legacy.cost.cacheRead, 12);
  });

  it('model hints from each adapter shape', () => {
    expect(modelHintsOf(exec(recorded('aiSdk', 0)))).toEqual({ model: 'claude-sonnet-4-5', provider: 'anthropic.messages' });
    expect(modelHintsOf(exec(recorded('anthropicTs', 0)))).toEqual({ model: 'claude-sonnet-4-5' });
    expect(modelHintsOf(exec(recorded('openaiChat', 0)))).toEqual({ model: 'gpt-4o-2024-08-06' }); // output.model wins
    expect(modelHintsOf(exec(recorded('pythonAnthropic', 0)))).toEqual({ model: 'claude-sonnet-4-5', provider: 'anthropic' });
    expect(modelHintsOf(exec(recorded('langgraphTs', 0)))).toEqual({ model: 'claude-sonnet-4-5', provider: 'anthropic' });
    expect(modelHintsOf(exec(recorded('pythonLangchain', 0)))).toEqual({});
  });

  it('unknown model → no $: the demo mock, a fake chat model; usage without a model', () => {
    const mock = priceExecution(TABLE, exec(recorded('legacyDemoAiSdk', 0)));
    expect(mock).toMatchObject({ status: 'unknown-model', hints: { model: 'mock-model-id' } });
    expect(priceExecution(TABLE, exec(recorded('pythonLangchain', 0)))).toMatchObject({ status: 'unknown-model', hints: {} });
    const total = sumCosts(TABLE, [
      exec(recorded('anthropicTs', 0)),
      exec(recorded('legacyDemoAiSdk', 0)),
      exec(recorded('aiSdk', 1), { usage: undefined } as never),
    ]);
    expect(total.priced).toBe(1);
    expect(total.unpriced).toBe(1);
    expect(total.total).toBeGreaterThan(0);
  });
});
