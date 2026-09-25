/**
 * Recorded LLM input → `{ system?, messages[], tools?, params, model? }`, or a
 * plain refusal.
 *
 * The shapes, as the 0.6 adapters record them (contract C1: the request as
 * sent, sampling parameters under the SDK's own names, `tools: [{name,
 * schemaHash}]`, each definition once per run as `toolSchemas`) — see
 * test/fixtures/recorded-llm-inputs.json for real recordings of every one:
 *  - AI SDK middleware (TS):  `{ prompt: LanguageModelV3/V4Prompt, modelId, provider, …params, tools }`
 *    — system as `{role:'system', content: string}`, parts `text` / `file` /
 *    `reasoning` / `tool-call` / `tool-result`.
 *  - Anthropic (TS + Python): `{ model, messages, system?, …params, tools, stream }`
 *    (Python adds `provider`) — `system` a string or text blocks, blocks
 *    `text` / `tool_use` / `tool_result` / `thinking`.
 *  - OpenAI chat (TS + Python + Ruby ruby-openai): `{ api|operation?, model, messages, …params, tools }`
 *    — `system` / `developer` messages, `tool_calls`, `tool` messages with `tool_call_id`.
 *  - OpenAI responses (TS + Python + Ruby): `{ model, input, instructions?,
 *    previousResponseId? | previous_response_id?, …params, tools }` — `input`
 *    a string or items (`message`, `function_call`, `function_call_output`, `reasoning`, …).
 *  - LangChain / LangGraph (TS): `{ messages: [[{role, content, tool_calls?, name?}]], …params, tools }`
 *    (one list per prompt of a batch); `{ prompts: string[] }` for text LLMs.
 *  - LangChain (Python): `{ messages: [[BaseMessage.model_dump()]] }` — `type`
 *    is the role (`human` / `ai` / `system` / `tool`).
 *  - ruby_llm: `{ hook, model, messages: [{role, content, tool_calls?, tool_call_id?}], …params, tools }`.
 *  - OTLP / OpenInference imports: a bare message array, or `{ messages }`.
 *  - 0.5 senders (still in old histories): the same without params, with a
 *    names-only `tools: string[]` (Anthropic TS) or none.
 *
 * REFUSES (contract C5) instead of guessing when the record is not the prompt
 * that was sent: shrunk to the 512 KB budget (`__graphmindTruncated`, the
 * truncation suffix), trimmed by a 0.5 port (Python `…[truncated]` /
 * `…[N more]`, Ruby `N earlier messages` / `… (N chars)`) or past a port's
 * depth limit, redacted (`__REDACTED__` anywhere — two hidden values cannot
 * be compared), a preview (a string where the messages should be, a LangGraph
 * `maxPayloadChars` preview, an MCP `get_node` preview), a batch of several
 * prompts, a server-side conversation (`previous_response_id`: only the new
 * items were sent), or a shape this file does not know.
 */
import { MCP_PREVIEW_NOTE_PREFIX, TRUNCATION_SUFFIX } from '@graphmind-ai/schema';
import { canonicalJson, identityOf, isVolatileKey } from './canonical.js';

export type RefusalCode =
  | 'redacted'
  | 'shrunk'
  | 'preview'
  | 'batched'
  | 'server-state'
  | 'unknown'
  | 'missing';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'other';
export type MessageKind = 'text' | 'tool-call' | 'tool-result' | 'reasoning' | 'other';

export interface NormMessage {
  role: MessageRole;
  /** The role as recorded (`human`, `ai`, `developer`, `function_call_output`, …). */
  rawRole: string;
  kind: MessageKind;
  /** One line: `user: "Plan a trip…"`, `tool result: searchFlights`, … */
  label: string;
  /** Identity for comparison (hash of the canonical JSON). */
  key: string;
  /** Canonical JSON length — a size hint for the UI. */
  size: number;
  /** The message as recorded. */
  raw: unknown;
  /** Tool names this message calls / answers, when any. */
  tools?: string[];
}

export interface NormTool {
  name: string;
  /** `schemaHash` as recorded (W1), or a local hash of a full definition. */
  hash?: string;
}

export interface NormTools {
  /** `hash`: every entry carries a schema hash; `names`: names only. */
  basis: 'hash' | 'names';
  list: NormTool[];
}

export interface NormPrompt {
  shape: string;
  system?: string;
  messages: NormMessage[];
  tools?: NormTools;
  /** The model the call asked for (`model` / `modelId`), when recorded. */
  model?: string;
  /**
   * Every other top-level field of the recorded request: the sampling
   * parameters (C1 records them under the SDK's own names — `temperature`,
   * `max_tokens`, `maxOutputTokens`, `tool_choice`, `reasoning`, …).
   */
  params: Record<string, unknown>;
}

export type NormalizeResult =
  | { ok: true; prompt: NormPrompt }
  | { ok: false; code: RefusalCode; detail?: string };

// ── refusal scan ──────────────────────────────────────────────────────────

const REDACTED = '__REDACTED__';
const PY_TRUNCATED = '…[truncated]';
const PY_DEPTH = '…[depth limit]';
const PY_MORE = /^…\[\d+ more(?: keys)?\]$/;
const RUBY_CHARS = /… \(\d+ chars\)$/;
/** What the 0.6 Python / Ruby prompt recorders write for a cycle (the value is not there). */
const RECORD_CIRCULAR_PY = '[Circular]';
const RECORD_CIRCULAR_RB = '[circular]';

/** An object that stands in for a value: a shrink / preview / trim marker. */
function markerOf(record: Record<string, unknown>): { code: RefusalCode; detail?: string } | undefined {
  if (record['__graphmindTruncated'] === true) return { code: 'shrunk', detail: 'payload' };
  if (record['__graphmind'] === 'truncated') return { code: 'preview', detail: 'langgraph' };
  if (record['__graphmind'] === 'unserializable') return { code: 'unknown', detail: 'unserializable' };
  if (typeof record['note'] === 'string' && record['note'].startsWith(MCP_PREVIEW_NOTE_PREFIX)) {
    return { code: 'preview', detail: 'mcp' };
  }
  if (Object.hasOwn(record, '…')) return { code: 'shrunk', detail: 'python' };
  if (record['role'] === '…') return { code: 'shrunk', detail: 'ruby' };
  return undefined;
}

/** The fields of a recorded request that carry the prompt itself. */
const PROMPT_FIELDS = ['prompt', 'messages', 'system', 'input', 'instructions', 'prompts'] as const;

/**
 * Scan what the diff compares: the input's own marker, then the prompt
 * fields. Tool definitions (`toolSchemas`) are not scanned — a schema
 * property named like a secret is redacted by the recorder without touching
 * the prompt — and a shrunk tool list only makes the tools "not compared".
 */
export function scanInput(input: Record<string, unknown>): { code: RefusalCode; detail?: string } | undefined {
  const marker = markerOf(input);
  if (marker !== undefined) return marker;
  for (const key of PROMPT_FIELDS) {
    if (!Object.hasOwn(input, key)) continue;
    const hit = scanRecord(input[key], 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Walk a recorded value once; the first sign it is not the real prompt wins. */
export function scanRecord(value: unknown, depth = 0): { code: RefusalCode; detail?: string } | undefined {
  if (depth > 64) return undefined;
  if (typeof value === 'string') {
    if (value === REDACTED) return { code: 'redacted' };
    if (value.endsWith(TRUNCATION_SUFFIX)) return { code: 'shrunk', detail: 'string' };
    if (value.endsWith(PY_TRUNCATED) || value === PY_DEPTH || PY_MORE.test(value) || value === RECORD_CIRCULAR_PY) {
      return { code: 'shrunk', detail: 'python' };
    }
    if (RUBY_CHARS.test(value) || value === RECORD_CIRCULAR_RB) return { code: 'shrunk', detail: 'ruby' };
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = scanRecord(item, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const marker = markerOf(record);
  if (marker !== undefined) return marker;
  for (const key of Object.keys(record)) {
    // Cache and SDK metadata (a LangChain dump's `response_metadata.
    // token_usage`, redacted by an export for its "token" segment) is never
    // compared, so what it holds cannot make the diff refuse.
    if (isVolatileKey(key)) continue;
    const hit = scanRecord(record[key], depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// ── helpers ───────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function compactJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    return '';
  }
}

const ROLE_MAP: Record<string, MessageRole> = {
  system: 'system',
  developer: 'system',
  user: 'user',
  human: 'user',
  assistant: 'assistant',
  ai: 'assistant',
  model: 'assistant',
  tool: 'tool',
  function: 'tool',
};

/** Text of a content value (string or parts), for labels and the system prompt. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') texts.push(part);
    else if (isRec(part)) {
      const type = str(part['type']);
      if ((type === undefined || type === 'text' || type === 'input_text' || type === 'output_text') && typeof part['text'] === 'string') {
        texts.push(part['text']);
      }
    }
  }
  return texts.join('\n');
}

interface Traits {
  calls: string[];
  results: string[];
  reasoning: boolean;
}

/** Tool calls, tool results and reasoning inside one message, across shapes. */
function traitsOf(msg: Rec, callNames: Map<string, string>): Traits {
  const traits: Traits = { calls: [], results: [], reasoning: false };
  const noteCall = (id: unknown, name: unknown): void => {
    const n = str(name) ?? 'tool';
    traits.calls.push(n);
    if (typeof id === 'string') callNames.set(id, n);
  };
  const noteResult = (id: unknown, name: unknown): void => {
    traits.results.push(str(name) ?? (typeof id === 'string' ? callNames.get(id) : undefined) ?? 'tool');
  };

  // Responses API items carry their kind in `type`, not in `role`.
  const itemType = str(msg['type']);
  if (itemType === 'function_call' || itemType === 'custom_tool_call') noteCall(msg['call_id'], msg['name']);
  if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') noteResult(msg['call_id'], undefined);
  if (itemType === 'reasoning') traits.reasoning = true;

  // OpenAI chat / LangChain `tool_calls`.
  if (Array.isArray(msg['tool_calls'])) {
    for (const call of msg['tool_calls']) {
      if (!isRec(call)) continue;
      const fn = isRec(call['function']) ? call['function'] : undefined;
      noteCall(call['id'], fn?.['name'] ?? call['name']);
    }
  }
  const role = str(msg['role']) ?? str(msg['type']);
  if ((role === 'tool' || role === 'function') && typeof msg['tool_call_id'] === 'string') {
    noteResult(msg['tool_call_id'], msg['name']);
  } else if (role === 'tool' && !Array.isArray(msg['content'])) {
    noteResult(undefined, msg['name']);
  }

  if (Array.isArray(msg['content'])) {
    for (const part of msg['content']) {
      if (!isRec(part)) continue;
      switch (part['type']) {
        case 'tool-call': // AI SDK
          noteCall(part['toolCallId'], part['toolName']);
          break;
        case 'tool_use': // Anthropic
        case 'server_tool_use':
          noteCall(part['id'], part['name']);
          break;
        case 'tool-result': // AI SDK
          noteResult(part['toolCallId'], part['toolName']);
          break;
        case 'tool_result': // Anthropic
          noteResult(part['tool_use_id'], undefined);
          break;
        case 'reasoning':
        case 'thinking':
        case 'redacted_thinking':
          traits.reasoning = true;
          break;
        default:
          break;
      }
    }
  }
  return traits;
}

function describe(role: MessageRole, rawRole: string, msg: Rec, traits: Traits): { kind: MessageKind; label: string } {
  const text = contentText(msg['content']);
  const names = (list: string[]): string => {
    const unique = [...new Set(list)];
    return unique.length > 3 ? `${unique.slice(0, 3).join(', ')} +${unique.length - 3}` : unique.join(', ');
  };
  // A provider-executed tool (a web search) comes back INSIDE the assistant
  // turn that called it (AI SDK): that turn is still the model's calls.
  if (role === 'assistant' && traits.calls.length > 0) {
    return { kind: 'tool-call', label: `assistant → ${names(traits.calls)}` };
  }
  if (traits.results.length > 0) {
    return {
      kind: 'tool-result',
      label: `${traits.results.length > 1 ? 'tool results' : 'tool result'}: ${names(traits.results)}`,
    };
  }
  if (traits.calls.length > 0) {
    return { kind: 'tool-call', label: `${role === 'other' ? rawRole : role} → ${names(traits.calls)}` };
  }
  if (traits.reasoning && text.trim() === '') return { kind: 'reasoning', label: `${role} reasoning` };
  if (text.trim() !== '') {
    return { kind: 'text', label: `${role === 'other' ? rawRole : role}: "${oneLine(text)}"` };
  }
  return { kind: 'other', label: role === 'other' ? rawRole : role };
}

function normMessage(raw: unknown, callNames: Map<string, string>): NormMessage | undefined {
  if (typeof raw === 'string') {
    // A bare string message (text LLM prompts) is a user turn.
    const { key, size } = identityOf({ role: 'user', content: raw });
    return { role: 'user', rawRole: 'user', kind: 'text', label: `user: "${oneLine(raw)}"`, key, size, raw };
  }
  if (!isRec(raw)) return undefined;
  const itemType = str(raw['type']);
  const rawRole =
    str(raw['role']) ??
    (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'reasoning'
      ? 'assistant'
      : itemType === 'function_call_output' || itemType === 'custom_tool_call_output'
        ? 'tool'
        : itemType) ??
    'other';
  const lowered = rawRole.toLowerCase();
  const role = Object.hasOwn(ROLE_MAP, lowered) ? (ROLE_MAP[lowered] ?? 'other') : 'other';
  const traits = traitsOf(raw, callNames);
  const { kind, label } = describe(role, rawRole, raw, traits);
  const { key, size } = identityOf(raw);
  const tools = [...traits.calls, ...traits.results];
  return { role, rawRole, kind, label, key, size, raw, ...(tools.length > 0 ? { tools } : {}) };
}

function systemText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = contentText(value);
    return text === '' ? compactJson(value) : text;
  }
  return undefined;
}

/** Leading system/developer messages become the system prompt. */
function splitSystem(messages: NormMessage[]): { system?: string; rest: NormMessage[] } {
  let i = 0;
  const parts: string[] = [];
  while (i < messages.length && messages[i]?.role === 'system') {
    const raw = messages[i]?.raw;
    parts.push(isRec(raw) ? contentText(raw['content']) : String(raw));
    i++;
  }
  return i === 0 ? { rest: messages } : { system: parts.join('\n\n'), rest: messages.slice(i) };
}

function normTools(value: unknown): NormTools | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: NormTool[] = [];
  let hashed = true;
  for (const entry of value) {
    if (typeof entry === 'string') {
      list.push({ name: entry });
      hashed = false;
    } else if (isRec(entry)) {
      const fn = isRec(entry['function']) ? entry['function'] : undefined;
      const name = str(entry['name']) ?? str(fn?.['name']);
      if (name === undefined) continue;
      const recorded = str(entry['schemaHash']);
      list.push({ name, hash: recorded ?? identityOf(entry).key });
    }
  }
  return { basis: hashed ? 'hash' : 'names', list };
}

/** Top-level fields that are the prompt, its framing or bookkeeping — not parameters. */
const NOT_PARAMS = new Set([
  'prompt',
  'messages',
  'system',
  'input',
  'instructions',
  'prompts',
  'tools',
  'toolSchemas',
  'model',
  'modelId',
  'provider',
  'api',
  'operation',
  'hook',
  'stream',
  'previousResponseId',
  'previous_response_id',
]);

interface Framing {
  tools?: NormTools | undefined;
  model?: string | undefined;
  params: Record<string, unknown>;
}

function framingOf(input: Rec | undefined): Framing {
  if (input === undefined) return { params: {} };
  const params: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!NOT_PARAMS.has(key) && input[key] !== undefined) params[key] = input[key];
  }
  const model = str(input['modelId']) ?? str(input['model']);
  // A tool list the shrink or a redactor touched cannot be compared: leave it out.
  const tools = scanRecord(input['tools'], 1) === undefined ? normTools(input['tools']) : undefined;
  return { tools, model, params };
}

function fromMessages(shape: string, rawMessages: unknown[], system: string | undefined, framing: Framing): NormalizeResult {
  const callNames = new Map<string, string>();
  const messages: NormMessage[] = [];
  for (const raw of rawMessages) {
    const msg = normMessage(raw, callNames);
    if (msg === undefined) return { ok: false, code: 'unknown', detail: 'message' };
    messages.push(msg);
  }
  const split = splitSystem(messages);
  const systemParts = [system, split.system].filter((s): s is string => s !== undefined && s !== '');
  return {
    ok: true,
    prompt: {
      shape,
      ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
      messages: split.rest,
      ...(framing.tools !== undefined ? { tools: framing.tools } : {}),
      ...(framing.model !== undefined ? { model: framing.model } : {}),
      params: framing.params,
    },
  };
}

function normalizeUncached(input: unknown): NormalizeResult {
  if (input === undefined || input === null) return { ok: false, code: 'missing' };
  const gap = isRec(input) ? scanInput(input) : scanRecord(input);
  if (gap !== undefined) return { ok: false, ...gap };
  if (typeof input === 'string') return { ok: false, code: 'preview', detail: 'input' };
  if (Array.isArray(input)) return fromMessages('messages', input, undefined, framingOf(undefined));
  if (!isRec(input)) return { ok: false, code: 'unknown' };

  const framing = framingOf(input);

  // AI SDK middleware: params.prompt (V3/V4 message array).
  if ('prompt' in input) {
    const prompt = input['prompt'];
    if (Array.isArray(prompt)) return fromMessages('ai-sdk', prompt, undefined, framing);
    return { ok: false, code: typeof prompt === 'string' ? 'preview' : 'unknown', detail: 'prompt' };
  }

  // OpenAI responses: input + instructions.
  if ('input' in input && !('messages' in input)) {
    if (input['previousResponseId'] !== undefined || input['previous_response_id'] !== undefined) {
      return { ok: false, code: 'server-state' };
    }
    const instructions = systemText(input['instructions']);
    const items = input['input'];
    if (typeof items === 'string') {
      return fromMessages('openai-responses', [{ role: 'user', content: items }], instructions, framing);
    }
    if (Array.isArray(items)) return fromMessages('openai-responses', items, instructions, framing);
    return { ok: false, code: 'unknown', detail: 'input' };
  }

  if ('messages' in input) {
    const messages = input['messages'];
    if (typeof messages === 'string') return { ok: false, code: 'preview', detail: 'messages' };
    if (!Array.isArray(messages)) return { ok: false, code: 'unknown', detail: 'messages' };
    // LangChain: one message list per prompt of a batch.
    if (messages.length > 0 && messages.every((m) => Array.isArray(m))) {
      if (messages.length > 1) return { ok: false, code: 'batched', detail: String(messages.length) };
      return fromMessages('langchain', messages[0] as unknown[], undefined, framing);
    }
    const system = systemText(input['system']);
    if (input['system'] !== undefined && system === undefined) return { ok: false, code: 'unknown', detail: 'system' };
    return fromMessages(input['system'] !== undefined ? 'anthropic' : 'chat', messages, system, framing);
  }

  // LangChain text LLM: handleLLMStart(prompts).
  if (Array.isArray(input['prompts'])) {
    const prompts = input['prompts'];
    if (prompts.length > 1) return { ok: false, code: 'batched', detail: String(prompts.length) };
    return fromMessages('langchain-text', prompts, undefined, framing);
  }

  return { ok: false, code: 'unknown' };
}

const cache = new WeakMap<object, NormalizeResult>();

/** Memoized per recorded input object (executions keep their input by reference). */
export function normalizePrompt(input: unknown): NormalizeResult {
  if (input === null || typeof input !== 'object') return normalizeUncached(input);
  const hit = cache.get(input);
  if (hit !== undefined) return hit;
  const result = normalizeUncached(input);
  cache.set(input, result);
  return result;
}

/**
 * A readable rendering of one recorded message: text with real line breaks,
 * tool calls as `→ name {args}`, results as `← name …`. Used for the
 * expanded view and the line diff of a changed message.
 */
export function readableMessage(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!isRec(raw)) return canonicalJson(raw);
  const lines: string[] = [];
  const itemType = str(raw['type']);
  if (itemType === 'function_call' || itemType === 'custom_tool_call') {
    lines.push(`→ ${str(raw['name']) ?? 'tool'} ${compactJson(raw['arguments'] ?? raw['input'])}`);
  } else if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
    lines.push(`← ${compactJson(raw['output'])}`);
  }
  const content = raw['content'];
  if (typeof content === 'string') lines.push(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') {
        lines.push(part);
        continue;
      }
      if (!isRec(part)) continue;
      const type = str(part['type']);
      if ((type === 'text' || type === 'input_text' || type === 'output_text' || type === undefined) && typeof part['text'] === 'string') {
        lines.push(part['text']);
      } else if (type === 'tool-call') {
        lines.push(`→ ${str(part['toolName']) ?? 'tool'} ${compactJson(part['input'] ?? part['args'])}`);
      } else if (type === 'tool_use' || type === 'server_tool_use') {
        lines.push(`→ ${str(part['name']) ?? 'tool'} ${compactJson(part['input'])}`);
      } else if (type === 'tool-result') {
        const output = part['output'] ?? part['result'];
        const value = isRec(output) && 'value' in output ? output['value'] : output;
        lines.push(`← ${str(part['toolName']) ?? 'tool'} ${compactJson(value)}`);
      } else if (type === 'tool_result') {
        const inner = part['content'];
        lines.push(`← ${contentText(inner) || compactJson(inner)}`);
      } else if (type === 'reasoning' || type === 'thinking') {
        lines.push(`(reasoning) ${str(part['text']) ?? str(part['thinking']) ?? ''}`);
      } else {
        lines.push(canonicalJson(part));
      }
    }
  }
  if (Array.isArray(raw['tool_calls'])) {
    for (const call of raw['tool_calls']) {
      if (!isRec(call)) continue;
      const fn = isRec(call['function']) ? call['function'] : undefined;
      lines.push(`→ ${str(fn?.['name']) ?? str(call['name']) ?? 'tool'} ${compactJson(fn?.['arguments'] ?? call['args'])}`);
    }
  }
  if (lines.length === 0) return canonicalJson(raw);
  return lines.join('\n');
}
