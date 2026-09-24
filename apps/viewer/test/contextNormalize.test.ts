/**
 * Recorded LLM input → {system?, messages[], tools?, model?, params} for
 * every shape the adapters record, on REAL recordings
 * (test/fixtures/recorded-llm-inputs.json — its $comment says how each was
 * captured: the 0.6 adapters driven through their own test fakes, plus what
 * the 0.5 senders left in old histories), and the refusals.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_PREVIEW_NOTE_PREFIX, TRUNCATION_SUFFIX } from '@graphmind-ai/schema';
import { canonicalJson, identityOf } from '../src/context/canonical.js';
import { normalizePrompt, readableMessage, type NormPrompt, type NormalizeResult } from '../src/context/normalizePrompt.js';
import { computeDiffOutcome, refusalText } from '../src/context/diffOutcome.js';

interface RecordedStep {
  instanceId: string;
  ts: number;
  input: unknown;
  usage?: unknown;
  output?: unknown;
}

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/recorded-llm-inputs.json', import.meta.url)), 'utf8'),
) as Record<string, RecordedStep[]>;

function steps(name: string): RecordedStep[] {
  const list = FIXTURE[name];
  if (list === undefined) throw new Error(`fixture ${name} missing`);
  return list;
}

function ok(result: NormalizeResult): NormPrompt {
  if (!result.ok) throw new Error(`refused: ${result.code} ${result.detail ?? ''}`);
  return result.prompt;
}

const labels = (prompt: NormPrompt): string[] => prompt.messages.map((m) => m.label);
const at = (name: string, i: number): NormPrompt => ok(normalizePrompt(steps(name)[i]?.input));

const CURRENT = [
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
] as const;

describe('normalizers — 0.6 recordings (contract C1 shapes)', () => {
  it('every current adapter: system split out, one user turn, then the tool round trip', () => {
    for (const name of CURRENT) {
      const [first, second] = [at(name, 0), at(name, 1)];
      expect(first.system, name).toMatch(/^You plan trips\./);
      expect(first.messages.map((m) => [m.role, m.kind]), name).toEqual([['user', 'text']]);
      expect(second.messages.map((m) => m.kind), name).toEqual(['text', 'tool-call', 'tool-result']);
      expect(second.messages[1]?.role, name).toBe('assistant');
    }
  });

  it('AI SDK middleware: {prompt, modelId, provider, sampling, tools by hash}', () => {
    const prompt = at('aiSdk', 2);
    expect(prompt.shape).toBe('ai-sdk');
    expect(prompt.system).toBe('You plan trips.\nAlways check the weather.');
    expect(labels(prompt)).toEqual([
      'user: "Plan my trip from Vienna to Lisbon with a 100 EUR budget check."',
      'assistant → searchFlights',
      'tool result: searchFlights',
      'assistant → checkWeather, convertCurrency',
      'tool results: checkWeather, convertCurrency',
    ]);
    expect(prompt.model).toBe('claude-sonnet-4-5');
    expect(prompt.params).toEqual({ maxOutputTokens: 1024, temperature: 0.2, toolChoice: { type: 'auto' } });
    expect(prompt.tools).toEqual({
      basis: 'hash',
      list: [
        { name: 'searchFlights', hash: '2504a1140b95b9b6' },
        { name: 'checkWeather', hash: 'dea0f76fa9c41aa8' },
        { name: 'convertCurrency', hash: '9a9f8d7605137da9' },
      ],
    });
  });

  it('Anthropic TS: system blocks, tool_use / tool_result (a user message), the request params', () => {
    const prompt = at('anthropicTs', 1);
    expect(prompt.shape).toBe('anthropic');
    expect(prompt.system).toBe('You plan trips.\nAlways check the weather.');
    expect(labels(prompt).slice(1)).toEqual(['assistant → searchFlights', 'tool result: searchFlights']);
    expect(prompt.messages[2]?.role).toBe('user'); // tool results ride in a user turn
    expect(prompt.params).toEqual({ temperature: 0.2, max_tokens: 1024 }); // `stream` is framing, not a param
    expect(prompt.tools?.basis).toBe('hash');
  });

  it('a moved cache breakpoint does not change a message: "x" ≡ [{type:text, text:x, cache_control}]', () => {
    // anthropicTs step 0 sent the first user turn as a marked text block,
    // step 1 as a plain string (the breakpoint moved to the newest message).
    const raw0 = (steps('anthropicTs')[0]?.input as { messages: unknown[] }).messages[0];
    const raw1 = (steps('anthropicTs')[1]?.input as { messages: unknown[] }).messages[0];
    expect(raw0).not.toEqual(raw1);
    expect(at('anthropicTs', 0).messages[0]?.key).toBe(at('anthropicTs', 1).messages[0]?.key);
    // …but two text parts, or a part with more than text, stay distinct.
    const two = { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
    expect(identityOf(two).key).not.toBe(identityOf({ role: 'user', content: 'ab' }).key);
    const cited = { role: 'user', content: [{ type: 'text', text: 'a', citations: [{ x: 1 }] }] };
    expect(canonicalJson(cited)).not.toBe(canonicalJson({ role: 'user', content: 'a' }));
  });

  it('OpenAI chat and responses (instructions → system, function_call items, reasoning param)', () => {
    const chat = at('openaiChat', 1);
    expect(chat.shape).toBe('chat');
    expect(chat.model).toBe('gpt-4o');
    expect(chat.params).toEqual({ temperature: 0.2, max_completion_tokens: 1024 });
    const responses = at('openaiResponses', 1);
    expect(responses.shape).toBe('openai-responses');
    expect(responses.system).toBe('You plan trips.');
    expect(labels(responses)).toEqual([
      'user: "Plan my trip from Vienna to Lisbon."',
      'assistant → searchFlights',
      'tool result: searchFlights',
    ]);
    expect(responses.params).toEqual({ reasoning: { effort: 'low' } });
  });

  it('LangGraph TS: one list per prompt, human / ai / tool roles, invocation params and tools', () => {
    const prompt = at('langgraphTs', 1);
    expect(prompt.shape).toBe('langchain');
    expect(prompt.messages.map((m) => [m.rawRole, m.role])).toEqual([
      ['human', 'user'],
      ['ai', 'assistant'],
      ['tool', 'tool'],
    ]);
    expect(prompt.params).toEqual({ temperature: 0.2, max_tokens: 1024 });
    expect(prompt.tools).toEqual({ basis: 'hash', list: [{ name: 'searchFlights', hash: '87cd8f5e6e3bad91' }] });
    expect(prompt.model).toBeUndefined(); // LangGraph names the model at the top level of node.started
  });

  it('Python: provider-tagged Anthropic / OpenAI requests; LangChain model_dump messages (`type` roles)', () => {
    expect(at('pythonAnthropic', 0)).toMatchObject({ shape: 'anthropic', model: 'claude-sonnet-4-5', params: { max_tokens: 1024 } });
    expect(at('pythonOpenAIResponses', 1).shape).toBe('openai-responses');
    const lc = at('pythonLangchain', 1);
    expect(lc.messages.map((m) => m.rawRole)).toEqual(['human', 'ai', 'tool']);
    expect(labels(lc)).toEqual(['user: "Plan my trip."', 'assistant → searchFlights', 'tool result: searchFlights']);
  });

  it('Ruby: ruby-openai chat and ruby_llm (tool_calls as {id, name, input})', () => {
    expect(at('rubyOpenAI', 0)).toMatchObject({ shape: 'chat', model: 'gpt-4o-mini', params: { temperature: 0.2 } });
    const llm = at('rubyLlm', 1);
    expect(labels(llm)).toEqual(['user: "Weather in Lisbon?"', 'assistant → weather', 'tool result: weather']);
    expect(llm.params).toEqual({ temperature: 0.2 }); // `hook` is framing
  });

  it('readable rendering keeps text and shows tool traffic', () => {
    const prompt = at('aiSdk', 1);
    expect(readableMessage(prompt.messages[1]?.raw)).toContain('→ searchFlights {"from":"VIE","to":"LIS"}');
    expect(readableMessage(prompt.messages[2]?.raw)).toContain('← searchFlights {"flights":[{"id":"TP1234"');
    expect(readableMessage(at('anthropicTs', 1).messages[2]?.raw)).toContain('← {"flights"');
    expect(readableMessage(at('openaiResponses', 1).messages[1]?.raw)).toContain('→ searchFlights {"from":"VIE","to":"LIS"}');
  });

  it('is memoized per recorded input object', () => {
    const input = steps('aiSdk')[0]?.input;
    expect(normalizePrompt(input)).toBe(normalizePrompt(input));
  });
});

describe('normalizers — 0.5 recordings and imports (old histories)', () => {
  it('the demo recording (AI SDK, no params) and the 0.5 names-only Anthropic tool list', () => {
    const demo = ok(normalizePrompt(steps('legacyDemoAiSdk')[1]?.input));
    expect(labels(demo)).toEqual([
      expect.stringMatching(/^user: "Plan a 5-day trip to Tokyo/),
      'assistant → searchFlights, getWeather',
      'tool results: searchFlights, getWeather',
    ]);
    expect(demo.params).toEqual({});
    const anthropic = ok(normalizePrompt(steps('legacyAnthropicTs')[0]?.input));
    expect(anthropic.tools).toEqual({
      basis: 'names',
      list: [{ name: 'searchFlights' }, { name: 'checkWeather' }, { name: 'convertCurrency' }],
    });
  });

  it('OTLP and OpenInference imports (bare array, {messages})', () => {
    expect(ok(normalizePrompt(steps('otlpImport')[0]?.input)).messages[0]?.label).toBe('user: "Find me a flight from SFO to JFK"');
    expect(ok(normalizePrompt(steps('openInference')[0]?.input)).messages).toHaveLength(1);
  });
});

describe('normalizers — refusals', () => {
  const refused = (input: unknown): { code: string; detail?: string } => {
    const result = normalizePrompt(input);
    if (result.ok) throw new Error('expected a refusal');
    return result.detail !== undefined ? { code: result.code, detail: result.detail } : { code: result.code };
  };
  const real = <T>(name: string, i = 0): T => structuredClone(steps(name)[i]?.input) as T;

  it('redacted: the whole input (GRAPHMIND_HIDE_INPUTS), or any value inside the prompt', () => {
    expect(refused('__REDACTED__')).toEqual({ code: 'redacted' });
    const input = real<{ messages: { content: unknown }[] }>('openaiChat', 1);
    input.messages[1]!.content = '__REDACTED__';
    expect(refused(input)).toEqual({ code: 'redacted' });
  });

  it('a redacted value in a tool DEFINITION does not block the prompt diff', () => {
    // A schema property named like a secret is redacted by the recorder.
    const input = real<{ toolSchemas: Record<string, { input_schema: { properties: Record<string, unknown> } }> }>('anthropicTs', 0);
    const schema = Object.values(input.toolSchemas)[0]!;
    schema.input_schema.properties['api_key'] = '__REDACTED__';
    expect(normalizePrompt(input).ok).toBe(true);
  });

  it('shrunk: the 512 KB payload marker, a shrunk field, or the truncation suffix', () => {
    expect(refused({ __graphmindTruncated: true, bytes: 900_000, preview: '{"messages":[' })).toEqual({
      code: 'shrunk',
      detail: 'payload',
    });
    const field = real<Record<string, unknown>>('anthropicTs', 1);
    field['messages'] = { __graphmindTruncated: true, bytes: 800_000, preview: '[{"role":"user"' };
    expect(refused(field)).toEqual({ code: 'shrunk', detail: 'payload' });
    const cut = real<{ messages: { content: unknown }[] }>('rubyOpenAI', 1);
    cut.messages[1]!.content = `Plan my${TRUNCATION_SUFFIX}`;
    expect(refused(cut)).toEqual({ code: 'shrunk', detail: 'string' });
  });

  it('a shrunk TOOL LIST only drops the tools from the comparison', () => {
    const input = real<Record<string, unknown>>('aiSdk', 1);
    input['tools'] = { __graphmindTruncated: true, bytes: 1, preview: '' };
    const prompt = ok(normalizePrompt(input));
    expect(prompt.tools).toBeUndefined();
    expect(prompt.messages).toHaveLength(3);
  });

  it('incomplete by a port: 0.5 Python previews / Ruby trims, 0.6 cycle and depth markers', () => {
    expect(refused(steps('legacyPythonTrimmed')[0]?.input)).toEqual({ code: 'shrunk', detail: 'python' });
    expect(refused({ messages: ['a', '…[3 more]'] })).toEqual({ code: 'shrunk', detail: 'python' });
    expect(refused({ messages: [{ role: 'user', content: 'x', '…': '[2 more keys]' }] })).toEqual({ code: 'shrunk', detail: 'python' });
    const [t0, t1] = steps('legacyRubyTrimmed');
    expect(refused(t0?.input)).toEqual({ code: 'shrunk', detail: 'ruby' });
    expect(refused(t1?.input)).toEqual({ code: 'shrunk', detail: 'ruby' });
    expect(refused({ messages: [{ role: 'user', content: [{ type: 'text', text: '…[depth limit]' }] }] }).detail).toBe('python');
    expect(refused({ messages: [{ role: 'user', content: '[Circular]' }] }).detail).toBe('python');
    expect(refused({ messages: [{ role: 'user', content: '[circular]' }] }).detail).toBe('ruby');
  });

  it('preview: a string where the messages should be (the bundled demo), LangGraph and MCP previews', () => {
    const demo = JSON.parse(
      readFileSync(fileURLToPath(new URL('../src/fixtures/demo-run.json', import.meta.url)), 'utf8'),
    ) as { type: string; payload: { kind?: string; input?: unknown } }[];
    const inputs = demo.filter((e) => e.type === 'node.started' && e.payload.kind === 'llm').map((e) => e.payload.input);
    expect(normalizePrompt(inputs[0]).ok).toBe(true);
    expect(refused(inputs[1])).toEqual({ code: 'preview', detail: 'messages' });
    expect(refused({ __graphmind: 'truncated', preview: '{"messages"', chars: 40_000 })).toEqual({
      code: 'preview',
      detail: 'langgraph',
    });
    expect(refused({ truncated: true, note: `${MCP_PREVIEW_NOTE_PREFIX}2000 of 90000 JSON characters`, preview: '{' })).toEqual({
      code: 'preview',
      detail: 'mcp',
    });
    expect(refused('a prompt as text')).toEqual({ code: 'preview', detail: 'input' });
  });

  it('batched, server-side state (both spellings), unknown shape, missing input', () => {
    expect(refused({ messages: [[{ role: 'user', content: 'a' }], [{ role: 'user', content: 'b' }]] })).toEqual({
      code: 'batched',
      detail: '2',
    });
    const responses = real<Record<string, unknown>>('openaiResponses', 1);
    expect(refused({ ...responses, previousResponseId: 'resp_1' })).toEqual({ code: 'server-state' });
    const python = real<Record<string, unknown>>('pythonOpenAIResponses', 1);
    expect(refused({ ...python, previous_response_id: 'resp_1' })).toEqual({ code: 'server-state' });
    expect(refused({ foo: 1 })).toEqual({ code: 'unknown' });
    expect(refused({ hook: 'provider_completion' })).toEqual({ code: 'unknown' }); // ruby_llm describe() fell back
    expect(refused({ messages: [42] })).toEqual({ code: 'unknown', detail: 'message' });
    expect(refused({ __graphmind: 'unserializable', preview: 'x' })).toEqual({ code: 'unknown', detail: 'unserializable' });
    expect(refused(undefined)).toEqual({ code: 'missing' });
  });

  it('the diff refuses when EITHER side is not the real prompt, saying which and why', () => {
    const good = steps('openaiChat')[1]?.input;
    const bad = { __graphmindTruncated: true, bytes: 1, preview: '' };
    const prevBad = computeDiffOutcome(bad, good);
    expect(prevBad).toMatchObject({ status: 'refused', side: 'prev', code: 'shrunk' });
    if (prevBad.status === 'refused') expect(prevBad.text).toMatch(/^The previous step's recorded prompt was shrunk to fit the 512 KB/);
    const curBad = computeDiffOutcome(good, '__REDACTED__');
    expect(curBad).toMatchObject({ status: 'refused', side: 'cur', code: 'redacted' });
    if (curBad.status === 'refused') expect(curBad.text).toMatch(/^This step's recorded prompt contains redacted values/);
    expect(refusalText('preview', 'prev', 'messages')).toBe('The previous step recorded a preview string instead of the messages.');
    expect(refusalText('preview', 'cur', 'mcp')).toMatch(/graphmind mcp/);
    expect(refusalText('server-state', 'cur')).toMatch(/previous_response_id/);
  });
});
