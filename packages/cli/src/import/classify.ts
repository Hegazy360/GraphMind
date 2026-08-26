/**
 * Span -> GraphMind node classification. Three attribute dialects are
 * recognized, checked in this order (first hit wins):
 *
 *  1. AI SDK legacy telemetry (`ai.operationId` / `operation.name` starting
 *     with "ai."): `ai.generateText` etc. -> agent node, `.doGenerate` /
 *     `.doStream` -> `llm:step`, `ai.toolCall` -> `tool:<name>`.
 *  2. OTel GenAI semantic conventions (`gen_ai.operation.name`):
 *     invoke_agent -> agent, chat -> `llm:step`, execute_tool -> tool.
 *  3. OpenInference (`openinference.span.kind`): LLM -> `llm:step`,
 *     TOOL -> tool, AGENT -> agent, CHAIN and everything else -> custom.
 *
 * Node identity follows decisions.md #1: `nodeId` is the stable logical id,
 * `instanceId` the per-execution id (tool call id when the trace has one,
 * otherwise the span id). Attribute names come from the AI SDK telemetry
 * docs and the OpenInference spec — see README.md for every assumption.
 */
import {
  attrString,
  parseMaybeJson,
  unflattenPrefix,
  usageFrom,
  type ImportedNode,
  type RawSpan,
} from './types.js';

export type ClassifyResult =
  | { kind: 'node'; node: ImportedNode }
  | { kind: 'skipped'; reason: string };

const LLM_NODE_ID = 'llm:step';
const LLM_NODE_NAME = 'step';

/** AI SDK legacy root operations that map to the run's agent node. */
const AI_SDK_AGENT_OPS = new Set([
  'ai.generateText',
  'ai.streamText',
  'ai.generateObject',
  'ai.streamObject',
]);

export function classifySpan(span: RawSpan): ClassifyResult {
  return classifyAiSdk(span) ?? classifyGenAi(span) ?? classifyOpenInference(span) ?? skipped(span);
}

function skipped(span: RawSpan): ClassifyResult {
  const operation =
    attrString(span.attrs, 'operation.name', 'gen_ai.operation.name') ??
    attrString(span.attrs, 'openinference.span.kind');
  const label = operation !== undefined ? `operation "${operation}"` : `span "${span.name}"`;
  return { kind: 'skipped', reason: label };
}

// -- dialect 1: AI SDK legacy telemetry (`ai.*` attributes) -----------------

function aiSdkOperation(span: RawSpan): string | undefined {
  const operationId = attrString(span.attrs, 'ai.operationId');
  if (operationId !== undefined) return operationId;
  // `operation.name` is "<operationId> <functionId>" — take the first token.
  const operationName = attrString(span.attrs, 'operation.name');
  const first = operationName?.split(/\s+/)[0];
  return first !== undefined && first.startsWith('ai.') ? first : undefined;
}

function classifyAiSdk(span: RawSpan): ClassifyResult | null {
  const op = aiSdkOperation(span);
  if (op === undefined) return null;
  const attrs = span.attrs;

  if (op === 'ai.toolCall') {
    const name = attrString(attrs, 'ai.toolCall.name') ?? span.name;
    return node(span, 'ai-sdk', {
      kind: 'tool',
      nodeId: `tool:${name}`,
      name,
      instanceId: attrString(attrs, 'ai.toolCall.id') ?? span.spanId,
      input: parseMaybeJson(attrs['ai.toolCall.args']),
      output: parseMaybeJson(attrs['ai.toolCall.result']),
    });
  }

  const usage = usageFrom(
    attrs,
    ['ai.usage.promptTokens', 'ai.usage.inputTokens', 'gen_ai.usage.input_tokens'],
    ['ai.usage.completionTokens', 'ai.usage.outputTokens', 'gen_ai.usage.output_tokens'],
  );
  const model = attrString(attrs, 'ai.response.model', 'ai.model.id', 'gen_ai.request.model');
  const output =
    attrString(attrs, 'ai.response.text') ??
    parseMaybeJson(attrs['ai.response.object'] ?? attrs['ai.response.toolCalls']);

  if (op.endsWith('.doGenerate') || op.endsWith('.doStream')) {
    return node(span, 'ai-sdk', {
      kind: 'llm',
      nodeId: LLM_NODE_ID,
      name: LLM_NODE_NAME,
      instanceId: span.spanId,
      input: parseMaybeJson(attrs['ai.prompt.messages'] ?? attrs['ai.prompt']),
      output,
      ...(usage !== undefined ? { usage } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }

  if (AI_SDK_AGENT_OPS.has(op)) {
    const runName =
      attrString(attrs, 'ai.telemetry.functionId', 'resource.name') ?? op.slice('ai.'.length);
    return node(span, 'ai-sdk', {
      kind: 'agent',
      nodeId: `agent:${runName}`,
      name: runName,
      instanceId: span.spanId,
      input: parseMaybeJson(attrs['ai.prompt']),
      output,
      ...(usage !== undefined ? { usage } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }

  // Other ai.* operations (embed, rerank, transcription, ...): keep them
  // on the canvas as custom nodes rather than dropping data.
  return node(span, 'ai-sdk', {
    kind: 'custom',
    nodeId: `custom:${op}`,
    name: op,
    instanceId: span.spanId,
    input: parseMaybeJson(attrs['ai.value'] ?? attrs['ai.values']),
    output,
    ...(model !== undefined ? { model } : {}),
  });
}

// -- dialect 2: OTel GenAI semantic conventions -----------------------------

const GENAI_LLM_OPS = new Set(['chat', 'generate_content', 'text_completion']);

function classifyGenAi(span: RawSpan): ClassifyResult | null {
  const op = attrString(span.attrs, 'gen_ai.operation.name');
  if (op === undefined) return null;
  const attrs = span.attrs;
  const usage = usageFrom(attrs, ['gen_ai.usage.input_tokens'], ['gen_ai.usage.output_tokens']);
  const model = attrString(attrs, 'gen_ai.response.model', 'gen_ai.request.model');

  if (op === 'execute_tool') {
    const name =
      attrString(attrs, 'gen_ai.tool.name') ?? span.name.replace(/^execute_tool\s+/, '');
    return node(span, 'genai', {
      kind: 'tool',
      nodeId: `tool:${name}`,
      name,
      instanceId: attrString(attrs, 'gen_ai.tool.call.id') ?? span.spanId,
      input: parseMaybeJson(attrs['gen_ai.tool.call.arguments']),
      output: parseMaybeJson(attrs['gen_ai.tool.call.result']),
    });
  }

  if (GENAI_LLM_OPS.has(op)) {
    return node(span, 'genai', {
      kind: 'llm',
      nodeId: LLM_NODE_ID,
      name: LLM_NODE_NAME,
      instanceId: span.spanId,
      input: parseMaybeJson(attrs['gen_ai.input.messages']),
      output: parseMaybeJson(attrs['gen_ai.output.messages']),
      ...(usage !== undefined ? { usage } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }

  if (op === 'invoke_agent') {
    const runName = attrString(attrs, 'gen_ai.agent.name') ?? span.name;
    return node(span, 'genai', {
      kind: 'agent',
      nodeId: `agent:${runName}`,
      name: runName,
      instanceId: span.spanId,
      input: parseMaybeJson(attrs['gen_ai.input.messages']),
      output: parseMaybeJson(attrs['gen_ai.output.messages']),
      ...(usage !== undefined ? { usage } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }

  return node(span, 'genai', {
    kind: 'custom',
    nodeId: `custom:${op}`,
    name: op,
    instanceId: span.spanId,
    input: undefined,
    output: undefined,
    ...(usage !== undefined ? { usage } : {}),
    ...(model !== undefined ? { model } : {}),
  });
}

// -- dialect 3: OpenInference -----------------------------------------------

function classifyOpenInference(span: RawSpan): ClassifyResult | null {
  const spanKind = attrString(span.attrs, 'openinference.span.kind')?.toUpperCase();
  if (spanKind === undefined) return null;
  const attrs = span.attrs;
  const input =
    parseMaybeJson(attrs['input.value']) ?? unflattenPrefix(attrs, 'llm.input_messages');
  const output =
    parseMaybeJson(attrs['output.value']) ?? unflattenPrefix(attrs, 'llm.output_messages');

  if (spanKind === 'LLM') {
    const usage = usageFrom(attrs, ['llm.token_count.prompt'], ['llm.token_count.completion']);
    const model = attrString(attrs, 'llm.model_name');
    return node(span, 'openinference', {
      kind: 'llm',
      nodeId: LLM_NODE_ID,
      name: LLM_NODE_NAME,
      instanceId: span.spanId,
      input,
      output,
      ...(usage !== undefined ? { usage } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }

  if (spanKind === 'TOOL') {
    const name = attrString(attrs, 'tool.name') ?? span.name;
    return node(span, 'openinference', {
      kind: 'tool',
      nodeId: `tool:${name}`,
      name,
      instanceId: span.spanId,
      input: input ?? parseMaybeJson(attrs['tool.parameters']),
      output,
    });
  }

  if (spanKind === 'AGENT') {
    const name = span.name === '' ? 'agent' : span.name;
    return node(span, 'openinference', {
      kind: 'agent',
      nodeId: `agent:${name}`,
      name,
      instanceId: span.spanId,
      input,
      output,
    });
  }

  // CHAIN and the remaining kinds (RETRIEVER, EMBEDDING, RERANKER, ...):
  // custom nodes named after the span.
  const name = span.name === '' ? spanKind.toLowerCase() : span.name;
  return node(span, 'openinference', {
    kind: 'custom',
    nodeId: `custom:${name}`,
    name,
    instanceId: span.spanId,
    input,
    output,
  });
}

// -- shared ------------------------------------------------------------------

function node(
  span: RawSpan,
  dialect: ImportedNode['dialect'],
  rest: Omit<ImportedNode, 'span' | 'dialect' | 'usage' | 'model'> &
    Partial<Pick<ImportedNode, 'usage' | 'model'>>,
): ClassifyResult {
  return {
    kind: 'node',
    node: {
      span,
      dialect,
      usage: undefined,
      model: undefined,
      ...rest,
    },
  };
}
