#!/usr/bin/env node
/**
 * Regenerates packages/client/test/fixtures/llm.json, the LLM-capture
 * conformance fixture (contract C1) the TypeScript adapters, the Python
 * integrations and the Ruby integrations all check themselves against.
 *
 * The usage cases are the SPEC (hand-written below). The finish reasons, tool
 * calls and tool-schema hashes are computed by the TypeScript reference, so
 * run it against the BUILT client:
 *
 *   pnpm --filter @graphmind-ai/client build
 *   node packages/client/test/fixtures/gen-llm.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const client = await import(new URL('../../dist/index.js', import.meta.url).href);
const out = fileURLToPath(new URL('./llm.json', import.meta.url));

const finishReasons = [
  ['end_turn', false],
  ['end_turn', true],
  ['stop', false],
  ['STOP', true],
  ['stop_sequence', false],
  ['pause_turn', false],
  ['max_tokens', false],
  ['max_tokens', true],
  ['length', true],
  ['MAX_TOKENS', false],
  ['max_output_tokens', false],
  ['model_context_window_exceeded', false],
  ['tool_use', true],
  ['tool_calls', true],
  ['tool-calls', false],
  ['function_call', false],
  ['content_filter', false],
  ['content-filter', true],
  ['refusal', false],
  ['SAFETY', false],
  ['RECITATION', false],
  ['error', false],
  ['failed', false],
  ['MALFORMED_FUNCTION_CALL', false],
  ['other', false],
  ['unknown', false],
  ['FINISH_REASON_UNSPECIFIED', false],
  ['something_new', true],
  ['  End_Turn ', false],
  ['', false],
  [null, false],
  [42, false],
].map(([raw, hasToolCalls]) => [raw, hasToolCalls, client.normalizeFinishReason(raw, hasToolCalls) ?? null]);

const toolCallInputs = [
  { id: 'call_1', name: 'search', args: '{"q":"x"}' },
  { id: 'toolu_1', name: 'lookup', args: { city: 'Cairo' } },
  { id: 'call_2', name: 'write', args: '{"path":"a.txt","content":"hel' },
  { name: 'now', args: '' },
  { name: 'now', args: '  ' },
  { name: 'now' },
  { name: 'now', args: null },
  { name: 'many', args: '[1,2]' },
  { id: '', name: 'x', args: '{}' },
  { id: 'c', args: '{}' },
  { id: 7, name: 'x', args: {} },
  { name: 'x', args: 'null' },
  { name: '', args: '{}' },
];
const toolCalls = toolCallInputs.map((input) => ({
  in: input,
  out: client.toolCall(input.id, input.name, input.args) ?? null,
}));

const schemaInputs = [
  {
    name: 'get_weather',
    description: 'Weather for a city',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  {
    input_schema: { required: ['city'], properties: { city: { type: 'string' } }, type: 'object' },
    description: 'Weather for a city',
    name: 'get_weather',
  },
  { type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } },
  { b: 1.5, a: [true, null, 'é😀'], n: 1.0, z: { y: -0, x: 1e21 } },
];
const schemaHashes = schemaInputs.map((input) => ({ in: input, hash: client.schemaHash(input) }));

// Tool definitions as captureTools records (and hashes) them: the schema
// verbatim, never a credential the definition carries.
const toolDefinitionInputs = [
  {
    name: 'Anthropic function tool: unchanged',
    in: {
      name: 'get_weather',
      description: 'Weather for a city',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      cache_control: { type: 'ephemeral' },
    },
  },
  {
    name: 'a schema property named like a secret is a parameter: kept',
    in: {
      type: 'function',
      function: {
        name: 'login',
        description: 'Log in',
        parameters: {
          type: 'object',
          properties: { api_key: { type: 'string' }, token: { type: 'string' }, password: { type: 'string' } },
          required: ['api_key'],
        },
        strict: true,
      },
    },
  },
  {
    name: 'OpenAI Responses mcp tool: authorization and headers dropped, url cut to scheme://host/path',
    in: {
      type: 'mcp',
      server_label: 'stripe',
      server_url: 'https://user:pw@mcp.stripe.com/v1/sse?api_key=sk_live_QUERY#frag',
      authorization: 'sk_live_OAUTH',
      headers: { Authorization: 'Bearer sk_live_HEADER', 'X-Trace': 'ok' },
      require_approval: 'never',
      allowed_tools: { tool_names: ['refund'], read_only: true },
      server_description: 'Stripe',
    },
  },
  {
    name: 'OpenAI Responses connector: authorization dropped',
    in: { type: 'mcp', server_label: 'gmail', connector_id: 'connector_gmail', authorization: 'ya29.OAUTH' },
  },
  {
    name: 'AI SDK openai.mcp provider tool: credentials in args dropped',
    in: {
      type: 'provider',
      id: 'openai.mcp',
      name: 'mcp',
      args: {
        serverLabel: 'stripe',
        serverUrl: 'https://mcp.stripe.com?token=sk_live_Q',
        authorization: 'sk_live_OAUTH',
        headers: { Authorization: 'Bearer sk_live_HEADER' },
        requireApproval: 'never',
      },
    },
  },
  {
    name: 'AI SDK function tool: unchanged',
    in: {
      type: 'function',
      name: 'search',
      description: 'Search',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
      providerOptions: { openai: { strict: true } },
    },
  },
  {
    name: 'OpenAI custom tool with a grammar format: unchanged',
    in: {
      type: 'custom',
      name: 'apply_patch',
      description: 'Apply a patch',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
    },
  },
  {
    name: 'Anthropic server tool: unchanged',
    in: { type: 'web_search_20250305', name: 'web_search', max_uses: 3, allowed_domains: ['example.com'] },
  },
  {
    name: 'secret-named keys dropped at any depth outside the schema, arrays walked',
    in: {
      type: 'x_tool',
      name: 'x',
      config: {
        client_secret: 's3cret',
        nested: [{ api_key: 'k', region: 'eu' }, { accessToken: 't', mode: 'fast' }],
        endpoint_url: 'wss://host.example/ws?sig=abc',
        count: 2,
      },
      password: 'pw',
    },
  },
];
const toolDefinitions = toolDefinitionInputs.map(({ name, in: input }) => {
  const out = client.sanitizeToolDefinition(input);
  return { name, in: input, out, hash: client.schemaHash(out) };
});

const u = (inputTokens, outputTokens, extra = {}) => ({ inputTokens, outputTokens, inclusive: true, ...extra });

const usage = [
  // -- Anthropic Messages: input_tokens is the UNCACHED tail --------------------
  { provider: 'anthropic', name: 'no cache fields', raw: { input_tokens: 25, output_tokens: 10 }, out: u(25, 10) },
  {
    provider: 'anthropic',
    name: 'cache read and creation add to the input total',
    raw: { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
    out: u(1205, 100, { cacheReadTokens: 1000, cacheWriteTokens: 200 }),
  },
  {
    provider: 'anthropic',
    name: 'reported zeros stay',
    raw: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    out: u(12, 3, { cacheReadTokens: 0, cacheWriteTokens: 0 }),
  },
  {
    provider: 'anthropic',
    name: 'null counts are not reported',
    raw: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    out: u(12, 3),
  },
  {
    provider: 'anthropic',
    name: '5m/1h split with the total: the total is the write count',
    raw: {
      input_tokens: 4,
      output_tokens: 9,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    },
    out: u(3004, 9, { cacheReadTokens: 0, cacheWriteTokens: 3000 }),
  },
  {
    provider: 'anthropic',
    name: '5m/1h split without the total sums into the write count',
    raw: {
      input_tokens: 4,
      output_tokens: 9,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 },
    },
    out: u(154, 9, { cacheWriteTokens: 150 }),
  },
  {
    provider: 'anthropic',
    name: 'a partly reported split sums what was reported',
    raw: { input_tokens: 4, output_tokens: 9, cache_creation: { ephemeral_1h_input_tokens: 50 } },
    out: u(54, 9, { cacheWriteTokens: 50 }),
  },
  {
    provider: 'anthropic',
    name: 'output only (a message_delta seen alone): the required input count is 0',
    raw: { output_tokens: 42 },
    out: u(0, 42),
  },
  {
    provider: 'anthropic',
    name: 'extended thinking: output_tokens_details.thinking_tokens is the reasoning count',
    raw: {
      input_tokens: 100,
      output_tokens: 900,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens_details: { thinking_tokens: 420 },
    },
    out: u(100, 900, { cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 420 }),
  },
  {
    provider: 'anthropic',
    name: 'a reported thinking count of 0 stays 0',
    raw: { input_tokens: 10, output_tokens: 5, output_tokens_details: { thinking_tokens: 0 } },
    out: u(10, 5, { reasoningTokens: 0 }),
  },
  {
    provider: 'anthropic',
    name: 'null output_tokens_details: no reasoning count',
    raw: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, output_tokens_details: null },
    out: u(10, 5),
  },
  { provider: 'anthropic', name: 'nothing reported', raw: {}, out: null },
  {
    provider: 'anthropic',
    name: 'fractions round, negatives are not reported',
    raw: { input_tokens: 10.4, output_tokens: -1 },
    out: u(10, 0),
  },
  { provider: 'anthropic', name: 'strings and booleans are not counts', raw: { input_tokens: '10', output_tokens: true }, out: null },
  // -- OpenAI Chat Completions: prompt_tokens is inclusive ----------------------
  { provider: 'openai-chat', name: 'plain', raw: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, out: u(100, 20) },
  {
    provider: 'openai-chat',
    name: 'cached and reasoning details',
    raw: {
      prompt_tokens: 2000,
      completion_tokens: 300,
      total_tokens: 2300,
      prompt_tokens_details: { cached_tokens: 1536, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 256, audio_tokens: 0 },
    },
    out: u(2000, 300, { cacheReadTokens: 1536, reasoningTokens: 256 }),
  },
  {
    provider: 'openai-chat',
    name: 'cache_write_tokens',
    raw: { prompt_tokens: 5000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4096 } },
    out: u(5000, 10, { cacheReadTokens: 0, cacheWriteTokens: 4096 }),
  },
  {
    provider: 'openai-chat',
    name: 'null details',
    raw: { prompt_tokens: 7, completion_tokens: 1, prompt_tokens_details: null, completion_tokens_details: null },
    out: u(7, 1),
  },
  {
    provider: 'openai-chat',
    name: 'OpenAI-compatible prompt_cache_hit_tokens (DeepSeek)',
    raw: { prompt_tokens: 900, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 100 },
    out: u(900, 50, { cacheReadTokens: 800 }),
  },
  { provider: 'openai-chat', name: 'nothing reported', raw: {}, out: null },
  { provider: 'openai-chat', name: 'only a total', raw: { total_tokens: 5 }, out: null },
  // -- OpenAI Responses: input_tokens is inclusive -----------------------------
  {
    provider: 'openai-responses',
    name: 'reported zero details',
    raw: {
      input_tokens: 328,
      output_tokens: 52,
      total_tokens: 380,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    out: u(328, 52, { cacheReadTokens: 0, reasoningTokens: 0 }),
  },
  {
    provider: 'openai-responses',
    name: 'cache read, cache write and reasoning',
    raw: {
      input_tokens: 9000,
      output_tokens: 400,
      input_tokens_details: { cached_tokens: 8192, cache_write_tokens: 512 },
      output_tokens_details: { reasoning_tokens: 128 },
    },
    out: u(9000, 400, { cacheReadTokens: 8192, cacheWriteTokens: 512, reasoningTokens: 128 }),
  },
  { provider: 'openai-responses', name: 'plain', raw: { input_tokens: 5, output_tokens: 1 }, out: u(5, 1) },
  { provider: 'openai-responses', name: 'nothing reported', raw: { input_tokens_details: { cached_tokens: 3 } }, out: null },
  // -- AI SDK (LanguageModelV2 numbers, V3/V4 nested) --------------------------
  {
    provider: 'ai-sdk',
    name: 'V4 nested, everything reported',
    raw: {
      inputTokens: { total: 1250, noCache: 50, cacheRead: 1000, cacheWrite: 200 },
      outputTokens: { total: 80, text: 60, reasoning: 20 },
    },
    out: u(1250, 80, { cacheReadTokens: 1000, cacheWriteTokens: 200, reasoningTokens: 20 }),
  },
  {
    provider: 'ai-sdk',
    name: 'V4 nested, cache and reasoning not reported',
    raw: { inputTokens: { total: 20, noCache: 20 }, outputTokens: { total: 10, text: 10 } },
    out: u(20, 10),
  },
  {
    provider: 'ai-sdk',
    name: 'V4 nested, reported zeros stay',
    raw: {
      inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    out: u(20, 10, { cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }),
  },
  {
    provider: 'ai-sdk',
    name: 'V4 nested without totals: the parts are summed',
    raw: { inputTokens: { noCache: 30, cacheRead: 70 }, outputTokens: { text: 5, reasoning: 5 } },
    out: u(100, 10, { cacheReadTokens: 70, reasoningTokens: 5 }),
  },
  {
    provider: 'ai-sdk',
    name: 'V2 numbers (as the AI SDK itself converts them: the number is the total)',
    raw: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 100, reasoningTokens: 10 },
    out: u(120, 30, { cacheReadTokens: 100, reasoningTokens: 10 }),
  },
  { provider: 'ai-sdk', name: 'V2 plain numbers', raw: { inputTokens: 3, outputTokens: 4 }, out: u(3, 4) },
  { provider: 'ai-sdk', name: 'nothing reported', raw: { inputTokens: {}, outputTokens: {} }, out: null },
  // -- LangChain usage_metadata and the raw provider shapes it falls back to ---
  {
    provider: 'langchain',
    name: 'usage_metadata (inclusive) with details',
    raw: {
      input_tokens: 1350,
      output_tokens: 40,
      total_tokens: 1390,
      input_token_details: { cache_read: 1000, cache_creation: 300 },
      output_token_details: { reasoning: 12 },
    },
    out: u(1350, 40, { cacheReadTokens: 1000, cacheWriteTokens: 300, reasoningTokens: 12 }),
  },
  {
    provider: 'langchain',
    name: 'usage_metadata from an integration that reported the uncached tail (cache > input): corrected',
    raw: { input_tokens: 50, output_tokens: 40, input_token_details: { cache_read: 1000, cache_creation: 300 } },
    out: u(1350, 40, { cacheReadTokens: 1000, cacheWriteTokens: 300 }),
  },
  {
    // langchain-anthropic (Python, 1.4.x) moves the write count into the
    // 5m/1h split and zeroes cache_creation "to avoid double counting".
    provider: 'langchain',
    name: 'usage_metadata from ChatAnthropic: cache_creation zeroed, 5m/1h split reported',
    raw: {
      input_tokens: 1350,
      output_tokens: 40,
      total_tokens: 1390,
      input_token_details: {
        cache_read: 1000,
        cache_creation: 0,
        ephemeral_5m_input_tokens: 300,
        ephemeral_1h_input_tokens: 0,
      },
    },
    out: u(1350, 40, { cacheReadTokens: 1000, cacheWriteTokens: 300 }),
  },
  {
    provider: 'langchain',
    name: 'usage_metadata with only the 5m/1h split',
    raw: {
      input_tokens: 1350,
      output_tokens: 40,
      input_token_details: { cache_read: 1000, ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
    },
    out: u(1350, 40, { cacheReadTokens: 1000, cacheWriteTokens: 300 }),
  },
  { provider: 'langchain', name: 'usage_metadata without details', raw: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, out: u(10, 2) },
  {
    provider: 'langchain',
    name: 'raw Anthropic usage (response_metadata.usage / llm_output.usage): exclusive, summed',
    raw: { input_tokens: 50, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300 },
    out: u(1350, 40, { cacheReadTokens: 1000, cacheWriteTokens: 300 }),
  },
  {
    provider: 'langchain',
    name: 'raw Anthropic usage with extended thinking: thinking_tokens is the reasoning count',
    raw: { input_tokens: 50, output_tokens: 40, cache_read_input_tokens: 0, output_tokens_details: { thinking_tokens: 12 } },
    out: u(50, 40, { cacheReadTokens: 0, reasoningTokens: 12 }),
  },
  {
    provider: 'langchain',
    name: 'raw OpenAI token_usage',
    raw: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 64 } },
    out: u(100, 5, { cacheReadTokens: 64 }),
  },
  {
    provider: 'langchain',
    name: 'LangChain JS llmOutput.tokenUsage (camelCase)',
    raw: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    out: u(11, 7),
  },
  {
    provider: 'langchain',
    name: 'empty details',
    raw: { input_tokens: 5, output_tokens: 1, input_token_details: {}, output_token_details: {} },
    out: u(5, 1),
  },
  { provider: 'langchain', name: 'nothing reported', raw: { total_tokens: 3 }, out: null },
  // -- ruby_llm (Ruby only): Tokens#input is the non-cached count --------------
  {
    provider: 'ruby_llm',
    name: '2.0 Tokens: cache read and write add to the input total',
    raw: { input: 20, output: 5, cache_read: 1000, cache_write: 100, thinking: 2 },
    out: u(1120, 5, { cacheReadTokens: 1000, cacheWriteTokens: 100, reasoningTokens: 2 }),
  },
  { provider: 'ruby_llm', name: '2.0 Tokens without cache counts', raw: { input: 20, output: 5 }, out: u(20, 5) },
  {
    provider: 'ruby_llm',
    name: 'reported zeros stay',
    raw: { input: 20, output: 5, cache_read: 0, cache_write: 0 },
    out: u(20, 5, { cacheReadTokens: 0, cacheWriteTokens: 0 }),
  },
  {
    provider: 'ruby_llm',
    name: '1.x Tokens names (cached / cache_creation)',
    raw: { input: 20, output: 5, cached: 30, cache_creation: 0 },
    out: u(50, 5, { cacheReadTokens: 30, cacheWriteTokens: 0 }),
  },
  { provider: 'ruby_llm', name: 'nothing reported', raw: {}, out: null },
];

const fixture = {
  $comment:
    'Conformance fixture for LLM-step capture (contract C1, 0.6.0). Shared by the TypeScript adapters, the Python integrations and the Ruby integrations; each runs the parts for the providers it supports. finishReasons: [raw, hasToolCalls, normalized-or-null] — normalizeFinishReason lower-cases, trims and folds `-`/spaces to `_`, maps known provider spellings, anything else is "other", a non-string or empty value is null, and "stop" on a step that requested tool calls is "tool-calls". toolCalls: one requested call {id, name, args} -> {id?, name, input, inputText?} or null (no name): an id is kept only when a non-empty string; args that are a string are JSON-parsed, an empty/blank string or a missing/null value is {}, text that does not parse gives input null plus inputText (the raw text); args that are not a string are the input as they are. schemaHashes: sha256 of the canonical JSON (the loop guard canon: sorted keys by UTF-16 code units, JS number and escape rules) of a tool definition, first 16 hex chars. toolDefinitions: a tool definition as captureTools records and hashes it (out, hash = the schema hash of out): the schema keys (parameters, input_schema, inputSchema, output_schema, outputSchema, schema, format) are kept verbatim; outside them, at any depth (objects and arrays walked, at most 16 levels), a key matching /authori[sz]ation|header|token|secret|passw(or)?d|key|cookie|credential|bearer/i is dropped and a string under a key ending in "url" (any case) is cut before its first "?" or "#" and loses its "user:pass@" part; everything else is kept as it is. usage: provider-reported usage -> the wire TokenUsage (without the legacy aliases a sender may add: cacheCreationTokens, cachedInputTokens, totalTokens). inputTokens is the TOTAL prompt (cached reads and cache writes included), inclusive is always true, cacheReadTokens / cacheWriteTokens / reasoningTokens appear only when the provider reported them (a reported 0 stays 0), a count is a finite number >= 0 rounded to an integer (strings and booleans are not counts), and when neither input nor output was reported the result is null; when only one was, the other is 0 (the wire requires both). samplingParams: the allow-list of request parameters recorded on node.started.input under the SDK\'s own names.',
  finishReasons,
  toolCalls,
  schemaHashes,
  toolDefinitions,
  usage,
  samplingParams: [...client.SAMPLING_PARAM_KEYS],
};

writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log('wrote', out, usage.length, 'usage cases');
