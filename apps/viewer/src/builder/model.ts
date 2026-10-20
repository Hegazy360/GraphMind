/**
 * Pure helpers for the Build page: the starting spec, what each target
 * allows, the checks worth running before asking the server, and the
 * layout of the preview diagram. No DOM, no fetch — all unit-testable.
 */
import type { ParamType, Provider, SpecIssue, TargetId, TargetMeta, ToolParam, ToolSpec, WorkflowSpec } from './types.js';

/** Static copy of the server's target table, so the page renders before the first response. */
export const TARGETS: TargetMeta[] = [
  { id: 'ts-ai-sdk', language: 'typescript', framework: 'Vercel AI SDK', providers: ['anthropic', 'openai'], adapter: '@graphmind-ai/sdk', entry: 'src/main.ts', docs: 'https://graphmind.ai/docs/integrations/vercel-ai-sdk/' },
  { id: 'ts-anthropic', language: 'typescript', framework: 'Anthropic SDK', providers: ['anthropic'], adapter: '@graphmind-ai/anthropic', entry: 'src/main.ts', docs: 'https://graphmind.ai/docs/integrations/anthropic/' },
  { id: 'ts-openai', language: 'typescript', framework: 'OpenAI SDK', providers: ['openai'], adapter: '@graphmind-ai/openai', entry: 'src/main.ts', docs: 'https://graphmind.ai/docs/integrations/openai/' },
  { id: 'py-openai', language: 'python', framework: 'OpenAI SDK', providers: ['openai'], adapter: 'graphmind-ai', entry: 'main.py', docs: 'https://graphmind.ai/docs/integrations/python/' },
  { id: 'py-anthropic', language: 'python', framework: 'Anthropic SDK', providers: ['anthropic'], adapter: 'graphmind-ai', entry: 'main.py', docs: 'https://graphmind.ai/docs/integrations/python/' },
];

export const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.1',
};

export const PROVIDER_LABEL: Record<Provider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };
export const PROVIDER_ENV_KEY: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export const PARAM_TYPES: ParamType[] = ['string', 'number', 'boolean'];

export function targetMeta(id: TargetId): TargetMeta {
  return TARGETS.find((t) => t.id === id) ?? (TARGETS[0] as TargetMeta);
}

/** The spec the page opens with (the server's default, mirrored). */
export function defaultSpec(): WorkflowSpec {
  return {
    name: 'my-agent',
    description: 'A starter agent with two stub tools. Replace the stubs with real code.',
    target: 'ts-ai-sdk',
    provider: 'anthropic',
    model: DEFAULT_MODEL.anthropic,
    systemPrompt: 'You are a concise assistant. Use the tools when they help, then answer in two sentences.',
    prompt: 'What is the weather like in Lisbon this weekend, and should I pack a jacket?',
    maxSteps: 6,
    tools: [
      {
        name: 'getWeather',
        description: 'Typical weather for a city on a given day.',
        params: [
          { name: 'city', type: 'string', description: 'City name', required: true },
          { name: 'day', type: 'string', description: 'ISO date or a word like "saturday"', required: true },
        ],
        returns: '{ "highC": 19, "lowC": 12, "summary": "sunny, breezy in the evening" }',
      },
      {
        name: 'packingAdvice',
        description: 'Whether to pack a jacket for a temperature range.',
        params: [{ name: 'lowC', type: 'number', description: 'Lowest expected temperature', required: true }],
        returns: '{ "jacket": true, "reason": "evenings drop below 15C" }',
      },
    ],
  };
}

export function emptyTool(existing: readonly ToolSpec[]): ToolSpec {
  let n = existing.length + 1;
  let name = `tool${n}`;
  while (existing.some((t) => t.name === name)) name = `tool${++n}`;
  return { name, description: '', params: [], returns: '{ "ok": true }' };
}

export function emptyParam(existing: readonly ToolParam[]): ToolParam {
  let n = existing.length + 1;
  let name = `arg${n}`;
  while (existing.some((p) => p.name === name)) name = `arg${++n}`;
  return { name, type: 'string', required: true };
}

/**
 * Switching target: keep everything, but move the provider (and the model,
 * if it was still the provider's default) onto one the new target can call.
 */
export function withTarget(spec: WorkflowSpec, target: TargetId): WorkflowSpec {
  const meta = targetMeta(target);
  if (meta.providers.includes(spec.provider)) return { ...spec, target };
  const provider = meta.providers[0] as Provider;
  const model = spec.model === DEFAULT_MODEL[spec.provider] ? DEFAULT_MODEL[provider] : spec.model;
  return { ...spec, target, provider, model };
}

export function withProvider(spec: WorkflowSpec, provider: Provider): WorkflowSpec {
  const model = spec.model === DEFAULT_MODEL[spec.provider] ? DEFAULT_MODEL[provider] : spec.model;
  return { ...spec, provider, model };
}

/** "Support Agent v2" -> "support-agent-v2" */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * The checks worth doing before a round trip: they cover what a user is
 * most likely to get wrong while typing. The server has the full rule set
 * (reserved words, provider/target fit) and its issues are shown the same way.
 */
export function localIssues(spec: WorkflowSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (!NAME_RE.test(spec.name)) issues.push({ path: 'name', message: 'lowercase letters, digits and dashes' });
  if (spec.prompt.trim() === '') issues.push({ path: 'prompt', message: 'the agent needs a task' });
  if (spec.model.trim() === '') issues.push({ path: 'model', message: 'pick a model' });
  const toolNames = new Set<string>();
  spec.tools.forEach((tool, ti) => {
    if (!IDENTIFIER_RE.test(tool.name)) issues.push({ path: `tools.${ti}.name`, message: 'letters, digits and underscores' });
    else if (toolNames.has(tool.name)) issues.push({ path: `tools.${ti}.name`, message: 'duplicate tool name' });
    toolNames.add(tool.name);
    if (tool.description.trim() === '') issues.push({ path: `tools.${ti}.description`, message: 'the model reads this; say what the tool does' });
    const paramNames = new Set<string>();
    tool.params.forEach((param, pi) => {
      if (!IDENTIFIER_RE.test(param.name)) issues.push({ path: `tools.${ti}.params.${pi}.name`, message: 'letters, digits and underscores' });
      else if (paramNames.has(param.name)) issues.push({ path: `tools.${ti}.params.${pi}.name`, message: 'duplicate parameter' });
      paramNames.add(param.name);
    });
  });
  return issues;
}

export function issueFor(issues: readonly SpecIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

// ── preview diagram ───────────────────────────────────────────────────────

export const PREVIEW_CARD = { width: 172, height: 60 } as const;
const COLUMN_GAP = 64;
const ROW_GAP = 14;

export interface PreviewNode {
  id: string;
  kind: 'agent' | 'llm' | 'tool';
  title: string;
  subtitle: string;
  x: number;
  y: number;
}

export interface PreviewEdge {
  from: string;
  to: string;
  /** SVG path: a cubic from the source's right edge to the target's left edge. */
  d: string;
}

export interface PreviewGraph {
  width: number;
  height: number;
  nodes: PreviewNode[];
  edges: PreviewEdge[];
}

function edgePath(from: PreviewNode, to: PreviewNode): string {
  const x1 = from.x + PREVIEW_CARD.width;
  const y1 = from.y + PREVIEW_CARD.height / 2;
  const x2 = to.x;
  const y2 = to.y + PREVIEW_CARD.height / 2;
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
}

/**
 * agent -> llm step -> tools, the shape the real run will have on the
 * canvas (one node per logical code location). Tools stack in the third
 * column; the first two columns centre on the stack.
 */
export function previewGraph(spec: WorkflowSpec): PreviewGraph {
  const { width: w, height: h } = PREVIEW_CARD;
  const toolCount = spec.tools.length;
  const stackHeight = toolCount === 0 ? h : toolCount * h + (toolCount - 1) * ROW_GAP;
  const centreY = (stackHeight - h) / 2;
  const agent: PreviewNode = { id: 'agent', kind: 'agent', title: spec.name || 'agent', subtitle: targetMeta(spec.target).framework, x: 0, y: centreY };
  const llm: PreviewNode = { id: 'llm', kind: 'llm', title: 'llm:step', subtitle: spec.model || PROVIDER_LABEL[spec.provider], x: w + COLUMN_GAP, y: centreY };
  const nodes: PreviewNode[] = [agent, llm];
  const edges: PreviewEdge[] = [{ from: 'agent', to: 'llm', d: edgePath(agent, llm) }];
  spec.tools.forEach((tool, index) => {
    const node: PreviewNode = {
      id: `tool:${index}`,
      kind: 'tool',
      title: tool.name || `tool ${index + 1}`,
      subtitle: tool.params.length === 0 ? 'no parameters' : tool.params.map((p) => p.name).join(', '),
      x: 2 * (w + COLUMN_GAP),
      y: index * (h + ROW_GAP),
    };
    nodes.push(node);
    edges.push({ from: 'llm', to: node.id, d: edgePath(llm, node) });
  });
  const width = toolCount === 0 ? 2 * w + COLUMN_GAP : 3 * w + 2 * COLUMN_GAP;
  return { width, height: stackHeight, nodes, edges };
}

/** The run a job produced: same app name, started after the job did. */
export function isJobRun(run: { meta: { app: string; startedTs?: number } }, name: string, jobStartedAt: number): boolean {
  return run.meta.app === name && (run.meta.startedTs ?? 0) >= jobStartedAt - 2_000;
}

interface ErrorLike {
  name: string;
  message: string;
}

/**
 * The error a run is currently sitting on, for the Build page: the one an
 * active error gate holds (the process is paused, so the job log says
 * nothing), or the one the run ended with. `held` = a gate is waiting.
 */
export function runErrorOf(run: {
  meta: { status: string; error?: ErrorLike | undefined };
  nodes: Record<string, { lastError?: ErrorLike | undefined } | undefined>;
  pauses: Record<string, { active: boolean; point: string; nodeId: string } | undefined>;
}): { text: string; held: boolean } | undefined {
  for (const id of Object.keys(run.pauses)) {
    const pause = run.pauses[id];
    if (pause === undefined || !pause.active || pause.point !== 'error') continue;
    const error = run.nodes[pause.nodeId]?.lastError ?? run.meta.error;
    if (error !== undefined) return { text: `${error.name}: ${error.message}`, held: true };
  }
  if (run.meta.status === 'error' && run.meta.error !== undefined) {
    return { text: `${run.meta.error.name}: ${run.meta.error.message}`, held: false };
  }
  return undefined;
}
