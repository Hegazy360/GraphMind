/**
 * Generates src/fixtures/demo-run.json — a realistic trip-planner run using
 * the ai-sdk adapter's exact wire conventions:
 *  - agent:<runName> (instanceId = runId)
 *  - llm:step — ONE node per invocation; steps are executions
 *    (instanceId `<invocationId>:sN`), parented to the agent
 *  - tool:<name> (instanceId = toolCallId), parented to llm:step
 *  - graph.hint once on the first step (agent + llm:step + tool roster)
 *  - node.finished carries instanceId; provider-executed tools carry
 *    providerExecuted/ungated; streaming tools carry streaming + chunks
 * Includes streaming tokens, parallel tool calls, an ungated provider tool,
 * and one tool error → exec.paused. Run with `pnpm gen:fixture`.
 *
 * 0.6 (contract C1): every LLM step records the request as the adapter does —
 * `{prompt, modelId, provider, tools: [{name, schemaHash}]}`, each tool
 * definition once per run (`toolSchemas`, on the first step) — so the demo's
 * Context & cost view shows what changed between steps; and every usage
 * carries `inclusive: true`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RUN_ID = 'run-lisbon-7f2e';
const BASE_TS = 1787702400000;

let seq = 1;
const events = [];

function emit(type, payload, atMs) {
  events.push({ gm: 1, seq: seq++, ts: BASE_TS + atMs, runId: RUN_ID, type, payload });
}

/** Stream `text` as node.token batches of a few words each (~30/sec pacing). */
function stream(nodeId, text, startMs, { cadence = 90, wordsPerBatch = 4, channel = 'text' } = {}) {
  const words = text.split(/(?<= )/); // keep trailing spaces
  let at = startMs;
  for (let i = 0; i < words.length; i += wordsPerBatch) {
    const chunk = words.slice(i, i + wordsPerBatch).join('');
    emit('node.token', { nodeId, deltas: [{ t: channel, v: chunk }] }, at);
    at += cadence;
  }
  return at;
}

// ── what each LLM step was sent (contract C1, the AI SDK adapter's shape) ──
const SYSTEM = 'You are a meticulous travel planner. Use tools for live data.';
const ASK = 'Plan a 4-day trip to Lisbon in October for 2 people, budget €1,800.';
const objectSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const TOOL_DEFS = {
  '3b9e61c0d4a27f15': {
    type: 'function',
    name: 'searchFlights',
    description: 'Search return flights between two airports',
    inputSchema: objectSchema(
      { from: { type: 'string' }, to: { type: 'string' }, depart: { type: 'string' }, return: { type: 'string' }, pax: { type: 'number' } },
      ['from', 'to', 'depart', 'return', 'pax'],
    ),
  },
  'a70c2e94f81b3d6e': {
    type: 'function',
    name: 'searchHotels',
    description: 'Search hotels in a city',
    inputSchema: objectSchema(
      { city: { type: 'string' }, checkIn: { type: 'string' }, nights: { type: 'number' }, guests: { type: 'number' } },
      ['city', 'checkIn', 'nights', 'guests'],
    ),
  },
  '5d18f3b27ce0a946': {
    type: 'function',
    name: 'getWeather',
    description: 'Weather forecast for a city over a date range',
    inputSchema: objectSchema({ city: { type: 'string' }, range: { type: 'string' } }, ['city', 'range']),
  },
  'e2f4a61b9038c7d5': {
    type: 'function',
    name: 'currencyConvert',
    description: 'Convert an amount between currencies at the live rate',
    inputSchema: objectSchema(
      { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
      ['amount', 'from', 'to'],
    ),
  },
  '91c7d05e3fa2b684': { type: 'provider-defined', id: 'anthropic.web_search_20250305', name: 'webSearch', args: {} },
};
const TOOL_REFS = Object.entries(TOOL_DEFS).map(([schemaHash, def]) => ({ name: def.name, schemaHash }));

function llmInput(prompt, first = false) {
  return {
    prompt,
    modelId: 'claude-sonnet-4-5',
    provider: 'anthropic.messages',
    maxOutputTokens: 2048,
    tools: TOOL_REFS,
    ...(first ? { toolSchemas: TOOL_DEFS } : {}),
  };
}

const toolCall = (toolCallId, toolName, input, extra = {}) => ({ type: 'tool-call', toolCallId, toolName, input, ...extra });
const toolResult = (toolCallId, toolName, value, extra = {}) => ({
  type: 'tool-result',
  toolCallId,
  toolName,
  output: { type: 'json', value },
  ...extra,
});

// Tool results the model reads back (the same values the tool nodes finish with).
const FLIGHTS = {
  options: [
    { carrier: 'TAP', flight: 'TP1273', price: '€214 pp', stops: 0, depart: '07:05', arrive: '09:10' },
    { carrier: 'Ryanair', flight: 'FR7332', price: '€162 pp', stops: 0, depart: '16:40', arrive: '18:55' },
  ],
  currency: 'EUR',
};
const HOTELS = {
  hotels: [
    { name: 'Memmo Alfama', rating: 4.6, pricePerNight: '€138', neighborhood: 'Alfama' },
    { name: 'Hotel da Baixa', rating: 4.7, pricePerNight: '€152', neighborhood: 'Baixa' },
    { name: 'Casa Balthazar', rating: 4.8, pricePerNight: '€171', neighborhood: 'Chiado' },
  ],
};
const WEATHER_LISBON = { city: 'Lisbon', forecast: 'sunny', highC: 24, lowC: 16, rainChance: 0.05 };
const WEATHER_SINTRA = { city: 'Sintra', forecast: 'mist then sun', highC: 21, lowC: 14, rainChance: 0.2 };
const EVENTS = {
  results: [
    { title: 'Festival Iminente 2026', date: 'Oct 9–11', area: 'Marvila' },
    { title: 'Feira da Ladra', date: 'Tue & Sat', area: 'Alfama' },
  ],
};
const FX = { rate: 1.0834, converted: '$1,486.43', asOf: '2026-10-01T09:12:00Z' };

const STEP1_TEXT =
  "I'll start by finding flight options for October 8–12 and checking hotel availability in Alfama and Baixa in parallel.";
const STEP2_TEXT =
  'TAP at €214 keeps flights at €428 total; Memmo Alfama fits the budget with €1,372 (~76%) left over. Checking the weather window, October events, and converting the remaining budget for the card that bills in dollars.';

const PROMPT_1 = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: [{ type: 'text', text: ASK }] },
];
// Step 2 = step 1 + the model's first turn and both results: append-only.
const PROMPT_2 = [
  ...PROMPT_1,
  {
    role: 'assistant',
    content: [
      { type: 'text', text: STEP1_TEXT },
      toolCall('call_f1', 'searchFlights', { from: 'VIE', to: 'LIS', depart: '2026-10-08', return: '2026-10-12', pax: 2 }),
      toolCall('call_h1', 'searchHotels', { city: 'Lisbon', checkIn: '2026-10-08', nights: 4, guests: 2 }),
    ],
  },
  {
    role: 'tool',
    content: [toolResult('call_f1', 'searchFlights', FLIGHTS), toolResult('call_h1', 'searchHotels', HOTELS)],
  },
];
// Step 3 = step 2 + the fan-out: the provider-executed search comes back
// inside the assistant turn; currencyConvert's result is the retry's.
const PROMPT_3 = [
  ...PROMPT_2,
  {
    role: 'assistant',
    content: [
      { type: 'text', text: STEP2_TEXT },
      toolCall('call_w1', 'getWeather', { city: 'Lisbon', range: 'Oct 8–12' }),
      toolCall('call_w2', 'getWeather', { city: 'Sintra', range: 'Oct 10' }),
      toolCall('call_s1', 'webSearch', { query: 'Lisbon events October 2026' }, { providerExecuted: true }),
      toolResult('call_s1', 'webSearch', EVENTS, { providerExecuted: true }),
      toolCall('call_c1', 'currencyConvert', { amount: 1372, from: 'EUR', to: 'USD' }),
    ],
  },
  {
    role: 'tool',
    content: [
      toolResult('call_w1', 'getWeather', WEATHER_LISBON),
      toolResult('call_w2', 'getWeather', WEATHER_SINTRA),
      toolResult('call_c1', 'currencyConvert', FX),
    ],
  },
];

// ── run start ───────────────────────────────────────────────────────────────
emit(
  'run.started',
  {
    app: 'trip-planner',
    sdk: { name: 'ai', version: '7.0.79' },
    meta: { env: 'dev', entry: 'examples/trip-planner/main.ts' },
  },
  0,
);

// ── agent + step 1 (graph.hint fires on the first step) ─────────────────────
emit(
  'node.started',
  {
    nodeId: 'agent:trip-planner',
    kind: 'agent',
    name: 'trip-planner',
    instanceId: RUN_ID,
    input: { prompt: 'Plan a 4-day trip to Lisbon in October for 2 people, budget €1,800.' },
  },
  320,
);

emit(
  'graph.hint',
  {
    nodes: [
      { nodeId: 'agent:trip-planner', kind: 'agent', name: 'trip-planner' },
      { nodeId: 'llm:step', kind: 'llm', name: 'llm step', parentId: 'agent:trip-planner' },
      { nodeId: 'tool:searchFlights', kind: 'tool', name: 'searchFlights', parentId: 'llm:step' },
      { nodeId: 'tool:searchHotels', kind: 'tool', name: 'searchHotels', parentId: 'llm:step' },
      { nodeId: 'tool:getWeather', kind: 'tool', name: 'getWeather', parentId: 'llm:step' },
      { nodeId: 'tool:currencyConvert', kind: 'tool', name: 'currencyConvert', parentId: 'llm:step' },
      {
        nodeId: 'tool:webSearch',
        kind: 'tool',
        name: 'webSearch',
        parentId: 'llm:step',
        providerExecuted: true,
        ungated: true,
      },
    ],
  },
  460,
);

emit(
  'node.started',
  {
    nodeId: 'llm:step',
    parentId: 'agent:trip-planner',
    kind: 'llm',
    name: 'llm step',
    instanceId: 'inv1:s1',
    input: llmInput(PROMPT_1, true),
  },
  480,
);

let at = stream(
  'llm:step',
  'Budget of €1,800 for two over four days is workable if flights stay under €500 total. I should check flights and hotels in parallel before committing to a neighborhood. ',
  560,
  { channel: 'reasoning', cadence: 70, wordsPerBatch: 5 },
);
at = stream(
  'llm:step',
  STEP1_TEXT,
  at + 60,
  { cadence: 85 },
);

emit(
  'node.finished',
  {
    nodeId: 'llm:step',
    instanceId: 'inv1:s1',
    output: {
      toolCalls: [
        { tool: 'searchFlights', args: { from: 'VIE', to: 'LIS', depart: '2026-10-08', return: '2026-10-12', pax: 2 } },
        { tool: 'searchHotels', args: { city: 'Lisbon', checkIn: '2026-10-08', nights: 4, guests: 2 } },
      ],
    },
    usage: { inputTokens: 612, outputTokens: 187, inclusive: true },
    durationMs: 2450,
    status: 'ok',
  },
  at + 120,
);

// ── parallel tools: flights + hotels ────────────────────────────────────────
const toolsAt = at + 200;
emit(
  'node.started',
  {
    nodeId: 'tool:searchFlights',
    parentId: 'llm:step',
    kind: 'tool',
    name: 'searchFlights',
    instanceId: 'call_f1',
    input: { from: 'VIE', to: 'LIS', depart: '2026-10-08', return: '2026-10-12', pax: 2 },
  },
  toolsAt,
);
emit(
  'node.started',
  {
    nodeId: 'tool:searchHotels',
    parentId: 'llm:step',
    kind: 'tool',
    name: 'searchHotels',
    instanceId: 'call_h1',
    input: { city: 'Lisbon', checkIn: '2026-10-08', nights: 4, guests: 2 },
  },
  toolsAt + 40,
);

emit(
  'node.finished',
  {
    nodeId: 'tool:searchFlights',
    instanceId: 'call_f1',
    output: FLIGHTS,
    durationMs: 1340,
    status: 'ok',
  },
  toolsAt + 1360,
);
emit(
  'node.finished',
  {
    nodeId: 'tool:searchHotels',
    instanceId: 'call_h1',
    output: HOTELS,
    durationMs: 1820,
    status: 'ok',
  },
  toolsAt + 1860,
);

// ── step 2: weather + currency + an ungated provider search ────────────────
const step2At = toolsAt + 2050;
emit(
  'node.started',
  {
    nodeId: 'llm:step',
    parentId: 'agent:trip-planner',
    kind: 'llm',
    name: 'llm step',
    instanceId: 'inv1:s2',
    input: llmInput(PROMPT_2),
  },
  step2At,
);
at = stream(
  'llm:step',
  STEP2_TEXT,
  step2At + 90,
  { cadence: 80, wordsPerBatch: 5 },
);
emit(
  'node.finished',
  {
    nodeId: 'llm:step',
    instanceId: 'inv1:s2',
    output: {
      toolCalls: [
        { tool: 'getWeather', args: { city: 'Lisbon', range: 'Oct 8–12' } },
        { tool: 'getWeather', args: { city: 'Sintra', range: 'Oct 10' } },
        { tool: 'webSearch', args: { query: 'Lisbon events October 2026' } },
        { tool: 'currencyConvert', args: { amount: 1372, from: 'EUR', to: 'USD' } },
      ],
    },
    usage: { inputTokens: 1418, outputTokens: 156, inclusive: true },
    durationMs: 1980,
    status: 'ok',
  },
  at + 100,
);

// ── parallel fan-out: weather ×2, provider webSearch, doomed currency ──────
const fanAt = at + 180;
emit(
  'node.started',
  {
    nodeId: 'tool:getWeather',
    parentId: 'llm:step',
    kind: 'tool',
    name: 'getWeather',
    instanceId: 'call_w1',
    input: { city: 'Lisbon', range: 'Oct 8–12' },
  },
  fanAt,
);
emit(
  'node.started',
  {
    nodeId: 'tool:getWeather',
    parentId: 'llm:step',
    kind: 'tool',
    name: 'getWeather',
    instanceId: 'call_w2',
    input: { city: 'Sintra', range: 'Oct 10' },
  },
  fanAt + 50,
);
emit(
  'node.started',
  {
    nodeId: 'tool:webSearch',
    parentId: 'llm:step',
    kind: 'tool',
    name: 'webSearch',
    instanceId: 'call_s1',
    input: { query: 'Lisbon events October 2026' },
    providerExecuted: true,
    ungated: true,
  },
  fanAt + 70,
);
emit(
  'node.started',
  {
    nodeId: 'tool:currencyConvert',
    parentId: 'llm:step',
    kind: 'tool',
    name: 'currencyConvert',
    instanceId: 'call_c1',
    input: { amount: 1372, from: 'EUR', to: 'USD' },
  },
  fanAt + 90,
);

// streaming-tool chunk previews arrive as text deltas on the tool's node
stream(
  'tool:webSearch',
  'Feira da Ladra flea market (Tue/Sat) · Festival Iminente, Oct 9–11 · Web Summit warm-up talks…',
  fanAt + 300,
  { cadence: 160, wordsPerBatch: 5 },
);

emit(
  'node.finished',
  {
    nodeId: 'tool:getWeather',
    instanceId: 'call_w2',
    output: WEATHER_SINTRA,
    durationMs: 760,
    status: 'ok',
  },
  fanAt + 830,
);
emit(
  'node.finished',
  {
    nodeId: 'tool:webSearch',
    instanceId: 'call_s1',
    output: EVENTS,
    durationMs: 980,
    status: 'ok',
    providerExecuted: true,
    ungated: true,
    streaming: true,
    chunks: 4,
  },
  fanAt + 1060,
);
emit(
  'node.finished',
  {
    nodeId: 'tool:getWeather',
    instanceId: 'call_w1',
    output: WEATHER_LISBON,
    durationMs: 1080,
    status: 'ok',
  },
  fanAt + 1130,
);

// ── the error + pause ───────────────────────────────────────────────────────
const errorAt = fanAt + 1650;
emit(
  'node.error',
  {
    nodeId: 'tool:currencyConvert',
    error: {
      name: 'RateLimitError',
      message: 'fx.live quota exceeded (HTTP 429) — retry after 30s',
      stack:
        'RateLimitError: fx.live quota exceeded (HTTP 429) — retry after 30s\n' +
        '    at FxClient.request (src/lib/fx-client.ts:88:13)\n' +
        '    at FxClient.convert (src/lib/fx-client.ts:41:22)\n' +
        '    at Object.execute (src/tools/currency-convert.ts:19:28)\n' +
        '    at async runToolCall (node_modules/ai/dist/index.mjs:2841:22)',
    },
  },
  errorAt,
);
emit(
  'exec.paused',
  { pauseId: 'pause-8f31', nodeId: 'tool:currencyConvert', point: 'error' },
  errorAt + 60,
);

// ── recorded recovery (plays after the viewer resumes) ─────────────────────
const resumeAt = errorAt + 400;
emit(
  'node.finished',
  { nodeId: 'tool:currencyConvert', instanceId: 'call_c1', output: null, durationMs: 1710, status: 'error' },
  resumeAt,
);
emit(
  'node.started',
  {
    nodeId: 'tool:currencyConvert',
    parentId: 'llm:step',
    kind: 'tool',
    name: 'currencyConvert',
    instanceId: 'call_c2',
    input: { amount: 1372, from: 'EUR', to: 'USD' },
  },
  resumeAt + 180,
);
emit(
  'node.finished',
  {
    nodeId: 'tool:currencyConvert',
    instanceId: 'call_c2',
    output: FX,
    durationMs: 540,
    status: 'ok',
  },
  resumeAt + 740,
);

// ── final compose step ──────────────────────────────────────────────────────
const step3At = resumeAt + 950;
emit(
  'node.started',
  {
    nodeId: 'llm:step',
    parentId: 'agent:trip-planner',
    kind: 'llm',
    name: 'llm step',
    instanceId: 'inv1:s3',
    input: llmInput(PROMPT_3),
  },
  step3At,
);
at = stream(
  'llm:step',
  'Here is your 4-day Lisbon plan. ' +
    'Fly TAP TP1273 on Oct 8 (€428 for two), stay at Memmo Alfama (€552 for 4 nights). ' +
    'Day 1 — Alfama: castle at opening time, miradouros at dusk, fado at Tasca do Chico. ' +
    'Day 2 — Belém: pastéis warm from the oven, MAAT, sunset by the river. ' +
    'Day 3 — Sintra day trip: morning mist burns off by noon; Pena then Quinta da Regaleira. ' +
    'Day 4 — Baixa & Chiado: Time Out Market lunch, Tram 28 loop, Festival Iminente in Marvila. ' +
    'Weather holds at 21–24°C with almost no rain. Remaining budget converts to $1,486.43 for the USD card. Boa viagem!',
  step3At + 110,
  { cadence: 75, wordsPerBatch: 4 },
);
emit(
  'node.finished',
  {
    nodeId: 'llm:step',
    instanceId: 'inv1:s3',
    output: { finishReason: 'stop', text: '« itinerary · 121 words »' },
    usage: { inputTokens: 2034, outputTokens: 412, inclusive: true },
    durationMs: 5320,
    status: 'ok',
  },
  at + 130,
);

emit(
  'node.finished',
  {
    nodeId: 'agent:trip-planner',
    instanceId: RUN_ID,
    output: { steps: 3, toolCalls: 7, result: '4-day Lisbon itinerary within €1,800 budget' },
    usage: { inputTokens: 4064, outputTokens: 755, inclusive: true },
    durationMs: at + 300,
    status: 'ok',
  },
  at + 300,
);
emit('run.finished', { status: 'ok' }, at + 360);

const out = join(dirname(fileURLToPath(import.meta.url)), '../src/fixtures/demo-run.json');
writeFileSync(out, JSON.stringify(events, null, 2) + '\n');
console.log(`wrote ${events.length} envelopes to ${out}`);
