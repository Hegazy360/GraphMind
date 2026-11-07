/**
 * The Build page's model: a small graph of nodes an engineer places, and
 * the spec it compiles to.
 *
 * The canvas is the source of truth, not a view of a form. A node is one
 * thing you can test — the agent, a tool, an MCP server, a sub-agent — and
 * an edge means "this agent can use that". Compiling is mechanical: the
 * root agent's outgoing edges become `attach`, each sub-agent's outgoing
 * edges become its own lists, and the node bodies become the definitions.
 *
 * Everything here is pure: no DOM, no fetch, no React. The server validates
 * the compiled spec and generates the code; `pathToNode` maps the issues it
 * reports back onto the node that caused them, so an error lands on the
 * card rather than in a list at the bottom of the page.
 */
import { PROVIDER_META, type ProviderMeta } from '@workflow/providers.js';
import { TARGETS_BY_ID, targetMeta } from '@workflow/spec.js';
import type {
  AttachSpec,
  McpServerSpec,
  McpTransport,
  ParamType,
  Provider,
  SpecIssue,
  TargetId,
  TargetMeta,
  ToolParam,
  ToolSpec,
  WorkflowSpec,
} from './types.js';

/**
 * The provider and target tables, and the generator's own view of a spec,
 * come from the one place that defines them (`@workflow`, aliased to the
 * CLI's builder source in vite.config.ts). The page used to keep a hand
 * copy "so it renders before the first response" — it needs no response
 * now, and a copy was one more thing to drift.
 */
export { PROVIDER_META, providerMeta, type ProviderMeta } from '@workflow/providers.js';
export { TARGETS_BY_ID as TARGET_TABLE, targetMeta } from '@workflow/spec.js';

/** Every provider, in table order. */
export const PROVIDERS: ProviderMeta[] = Object.values(PROVIDER_META);

/** Every target, in table order. */
export const TARGETS: TargetMeta[] = Object.values(TARGETS_BY_ID);

export const DEFAULT_MODEL: Record<Provider, string> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p.defaultModel]),
) as Record<Provider, string>;

export const PROVIDER_LABEL: Record<Provider, string> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p.label]),
) as Record<Provider, string>;

export const PROVIDER_ENV_KEY: Record<Provider, string> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p.envKey]),
) as Record<Provider, string>;

export const PARAM_TYPES: ParamType[] = ['string', 'number', 'boolean'];

// ── nodes ─────────────────────────────────────────────────────────────────

export type NodeKind = 'agent' | 'subagent' | 'tool' | 'mcp';

interface NodeBase {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
}

/** The root agent. Exactly one, and it cannot be deleted. */
export interface AgentNode extends NodeBase {
  kind: 'agent';
  systemPrompt: string;
  prompt: string;
  maxSteps: number;
}

export interface SubAgentNode extends NodeBase {
  kind: 'subagent';
  name: string;
  /** What the root agent reads to decide when to delegate. */
  description: string;
  systemPrompt: string;
  /** Empty = the project's model. */
  model: string;
  maxSteps: number;
}

export interface ToolNode extends NodeBase {
  kind: 'tool';
  name: string;
  description: string;
  params: ToolParam[];
  returns: string;
}

export interface McpNode extends NodeBase {
  kind: 'mcp';
  name: string;
  transport: McpTransport;
  command: string;
  /** One argument per line, as typed. */
  argsText: string;
  url: string;
  /** The variable holding the bearer token; empty for a server that needs none. */
  headerEnv: string;
  /** Comma-separated allow-list; empty = every tool the server lists. */
  toolsText: string;
}

export type GraphNode = AgentNode | SubAgentNode | ToolNode | McpNode;

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
}

/** The whole canvas, plus the project-level choices the header carries. */
export interface WorkflowGraph {
  name: string;
  description: string;
  target: TargetId;
  provider: Provider;
  model: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const ROOT_ID = 'agent';

export const NODE_LABEL: Record<NodeKind, string> = {
  agent: 'Agent',
  subagent: 'Sub-agent',
  tool: 'Tool',
  mcp: 'MCP server',
};

/** What each node kind is for, one line, shown in the palette. */
export const NODE_BLURB: Record<NodeKind, string> = {
  agent: 'The run itself: a model, a prompt and a step cap.',
  subagent: 'A nested agent the root can delegate a task to.',
  tool: 'A function the model can call. Starts as a stub you replace.',
  mcp: 'An MCP server to connect to; its tools join the agent.',
};

/** Only these edges mean anything, so only these can be drawn. */
export function canConnect(from: NodeKind, to: NodeKind): boolean {
  if (from !== 'agent' && from !== 'subagent') return false;
  if (to === 'agent') return false;
  // A sub-agent owns tools and MCP servers, but not another sub-agent: one
  // level of delegation is what the generators emit.
  if (to === 'subagent') return from === 'agent';
  return true;
}

let counter = 0;
function nextId(kind: NodeKind): string {
  counter += 1;
  return `${kind}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** A name not already taken by another node (names share one namespace). */
export function freeName(graph: WorkflowGraph, base: string): string {
  const taken = new Set(graph.nodes.map((node) => (node.kind === 'agent' ? '' : node.name)));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

export function makeNode(kind: Exclude<NodeKind, 'agent'>, graph: WorkflowGraph, at: { x: number; y: number }): GraphNode {
  const id = nextId(kind);
  if (kind === 'tool') {
    return {
      id,
      kind,
      x: at.x,
      y: at.y,
      name: freeName(graph, 'myTool'),
      description: 'What this tool does, in the words the model will read.',
      params: [{ name: 'input', type: 'string', description: '', required: true }],
      returns: '{ "ok": true }',
    };
  }
  if (kind === 'mcp') {
    return {
      id,
      kind,
      x: at.x,
      y: at.y,
      name: freeName(graph, 'mcp'),
      transport: 'stdio',
      command: 'npx',
      argsText: '-y\n@modelcontextprotocol/server-everything',
      url: '',
      headerEnv: '',
      toolsText: '',
    };
  }
  return {
    id,
    kind,
    x: at.x,
    y: at.y,
    name: freeName(graph, 'helper'),
    description: 'When the root agent should hand work to this one.',
    systemPrompt: '',
    model: '',
    maxSteps: 4,
  };
}

/** The graph the page opens with: an agent, two stub tools, both wired. */
export function defaultGraph(): WorkflowGraph {
  const agent: AgentNode = {
    id: ROOT_ID,
    kind: 'agent',
    x: 0,
    y: 120,
    systemPrompt: 'You are a concise assistant. Use the tools when they help, then answer in two sentences.',
    prompt: 'What is the weather like in Lisbon this weekend, and should I pack a jacket?',
    maxSteps: 6,
  };
  const weather: ToolNode = {
    id: 'tool-weather',
    kind: 'tool',
    x: 360,
    y: 0,
    name: 'getWeather',
    description: 'Typical weather for a city on a given day.',
    params: [
      { name: 'city', type: 'string', description: 'City name', required: true },
      { name: 'day', type: 'string', description: 'ISO date or a word like "saturday"', required: true },
    ],
    returns: '{ "highC": 19, "lowC": 12, "summary": "sunny, breezy in the evening" }',
  };
  const packing: ToolNode = {
    id: 'tool-packing',
    kind: 'tool',
    x: 360,
    y: 220,
    name: 'packingAdvice',
    description: 'Whether to pack a jacket for a temperature range.',
    params: [{ name: 'lowC', type: 'number', description: 'Lowest expected temperature', required: true }],
    returns: '{ "jacket": true, "reason": "evenings drop below 15C" }',
  };
  return {
    name: 'my-agent',
    description: 'A starter agent with two stub tools. Replace the stubs with real code.',
    target: 'ts-ai-sdk',
    provider: 'anthropic',
    model: DEFAULT_MODEL.anthropic,
    nodes: [agent, weather, packing],
    edges: [
      { id: 'e-weather', from: ROOT_ID, to: weather.id },
      { id: 'e-packing', from: ROOT_ID, to: packing.id },
    ],
  };
}

export function emptyParam(existing: readonly ToolParam[]): ToolParam {
  let n = existing.length + 1;
  let name = `arg${n}`;
  while (existing.some((p) => p.name === name)) name = `arg${++n}`;
  return { name, type: 'string', required: true, description: '' };
}

// ── editing ───────────────────────────────────────────────────────────────

export function nodeById(graph: WorkflowGraph, id: string | undefined): GraphNode | undefined {
  return id === undefined ? undefined : graph.nodes.find((node) => node.id === id);
}

export function patchNode<T extends GraphNode>(graph: WorkflowGraph, id: string, patch: Partial<T>): WorkflowGraph {
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? ({ ...node, ...patch } as GraphNode) : node)) };
}

/** Delete a node and every edge touching it. The root agent stays. */
export function removeNode(graph: WorkflowGraph, id: string): WorkflowGraph {
  if (id === ROOT_ID) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== id),
    edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
  };
}

export function addEdge(graph: WorkflowGraph, from: string, to: string): WorkflowGraph {
  if (from === to) return graph;
  const source = nodeById(graph, from);
  const target = nodeById(graph, to);
  if (source === undefined || target === undefined || !canConnect(source.kind, target.kind)) return graph;
  if (graph.edges.some((edge) => edge.from === from && edge.to === to)) return graph;
  return { ...graph, edges: [...graph.edges, { id: `e-${from}-${to}`, from, to }] };
}

export function removeEdge(graph: WorkflowGraph, id: string): WorkflowGraph {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== id) };
}

/**
 * Switching target: keep the graph, but move the provider (and the model, if
 * it was still the provider's default) onto one the new target can call.
 */
export function withTarget(graph: WorkflowGraph, target: TargetId): WorkflowGraph {
  const meta = targetMeta(target);
  if (meta.providers.includes(graph.provider)) return { ...graph, target };
  const provider = meta.providers[0] as Provider;
  const model = graph.model === DEFAULT_MODEL[graph.provider] ? DEFAULT_MODEL[provider] : graph.model;
  return { ...graph, target, provider, model };
}

export function withProvider(graph: WorkflowGraph, provider: Provider): WorkflowGraph {
  const model = graph.model === DEFAULT_MODEL[graph.provider] ? DEFAULT_MODEL[provider] : graph.model;
  return { ...graph, provider, model };
}

/** "Support Agent v2" -> "support-agent-v2" */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * The same, for a field being typed into.
 *
 * `slugify` trims a trailing dash, which is right for a finished name and
 * wrong on every keystroke: typing "trip-bot" went t-r-i-p-, and the dash
 * was deleted the moment it arrived, so the field could only ever produce
 * "tripbot". The project name a reader is shown by default — "my-agent" —
 * was one they could not type.
 *
 * A trailing dash is left alone, which `PROJECT_NAME_RE` accepts, so every
 * intermediate value is still a valid name rather than merely a tolerated
 * one. `slugify` remains the right thing for a name arriving whole.
 */
export function slugifyWhileTyping(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48);
}

/**
 * The agent a new node should be wired to, given what is selected: the
 * selected agent itself, or — when a tool or MCP server is selected — the
 * agent that owns it. Adding a tool to a sub-agent selects the new tool, so
 * without this the NEXT addition would fall back to the root agent and the
 * engineer would have to re-select the sub-agent every time.
 */
export function ownerOf(graph: WorkflowGraph, selectedId: string | undefined): string {
  const selected = nodeById(graph, selectedId);
  if (selected === undefined) return ROOT_ID;
  if (selected.kind === 'agent' || selected.kind === 'subagent') return selected.id;
  // Prefer a sub-agent owner over the root when a tool is shared by both.
  const owners = graph.edges.filter((edge) => edge.to === selected.id).map((edge) => edge.from);
  const sub = owners.find((id) => nodeById(graph, id)?.kind === 'subagent');
  return sub ?? owners[0] ?? ROOT_ID;
}

// ── compiling ─────────────────────────────────────────────────────────────

/** Edges out of `id`, in node order, as nodes. */
function childrenOf(graph: WorkflowGraph, id: string): GraphNode[] {
  const targets = new Set(graph.edges.filter((edge) => edge.from === id).map((edge) => edge.to));
  return graph.nodes.filter((node) => targets.has(node.id));
}

/** The MCP node as the server will read it: trimmed, split, transport-pruned. */
export function mcpOf(node: McpNode): McpServerSpec {
  const args = node.argsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const tools = node.toolsText
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return {
    name: node.name,
    transport: node.transport,
    command: node.transport === 'stdio' ? node.command.trim() : '',
    args: node.transport === 'stdio' ? args : [],
    url: node.transport === 'http' ? node.url.trim() : '',
    ...(node.transport === 'http' && node.headerEnv.trim() !== '' ? { headerEnv: node.headerEnv.trim() } : {}),
    tools,
  };
}

export interface Compiled {
  spec: WorkflowSpec;
  /**
   * `tools.1`, `mcpServers.0`, `subAgents.2` -> the node that produced it,
   * so a server issue can be shown on the card it belongs to.
   */
  nodeByPath: Record<string, string>;
}

export function compile(graph: WorkflowGraph): Compiled {
  const root = (graph.nodes.find((node) => node.kind === 'agent') as AgentNode | undefined) ?? {
    id: ROOT_ID,
    kind: 'agent',
    x: 0,
    y: 0,
    systemPrompt: '',
    prompt: '',
    maxSteps: 6,
  };
  const toolNodes = graph.nodes.filter((node): node is ToolNode => node.kind === 'tool');
  const mcpNodes = graph.nodes.filter((node): node is McpNode => node.kind === 'mcp');
  const subNodes = graph.nodes.filter((node): node is SubAgentNode => node.kind === 'subagent');

  const nodeByPath: Record<string, string> = {};
  toolNodes.forEach((node, index) => (nodeByPath[`tools.${index}`] = node.id));
  mcpNodes.forEach((node, index) => (nodeByPath[`mcpServers.${index}`] = node.id));
  subNodes.forEach((node, index) => (nodeByPath[`subAgents.${index}`] = node.id));

  const attach: AttachSpec = { tools: [], mcpServers: [], subAgents: [] };
  for (const child of childrenOf(graph, root.id)) {
    if (child.kind === 'tool') attach.tools.push(child.name);
    else if (child.kind === 'mcp') attach.mcpServers.push(child.name);
    else if (child.kind === 'subagent') attach.subAgents.push(child.name);
  }

  const tools: ToolSpec[] = toolNodes.map((node) => ({
    name: node.name,
    description: node.description,
    params: node.params,
    returns: node.returns,
  }));

  const spec: WorkflowSpec = {
    name: graph.name,
    ...(graph.description.trim() === '' ? {} : { description: graph.description }),
    target: graph.target,
    provider: graph.provider,
    model: graph.model,
    ...(root.systemPrompt.trim() === '' ? {} : { systemPrompt: root.systemPrompt }),
    prompt: root.prompt,
    maxSteps: root.maxSteps,
    tools,
    mcpServers: mcpNodes.map(mcpOf),
    subAgents: subNodes.map((node) => {
      const children = childrenOf(graph, node.id);
      return {
        name: node.name,
        description: node.description,
        ...(node.systemPrompt.trim() === '' ? {} : { systemPrompt: node.systemPrompt }),
        ...(node.model.trim() === '' ? {} : { model: node.model.trim() }),
        maxSteps: node.maxSteps,
        tools: children.filter((child) => child.kind === 'tool').map((child) => (child as ToolNode).name),
        mcpServers: children.filter((child) => child.kind === 'mcp').map((child) => (child as McpNode).name),
      };
    }),
    attach,
  };
  return { spec, nodeByPath };
}

// ── local checks ──────────────────────────────────────────────────────────

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * The checks worth doing while someone types, each pinned to the node that
 * owns it. The server has the full rule set (reserved words, provider fit,
 * MCP shape) and its issues arrive the same way, through `nodeByPath`.
 */
export function localIssues(graph: WorkflowGraph): (SpecIssue & { nodeId?: string })[] {
  const issues: (SpecIssue & { nodeId?: string })[] = [];
  if (!NAME_RE.test(graph.name)) issues.push({ path: 'name', message: 'lowercase letters, digits and dashes' });
  if (graph.model.trim() === '') issues.push({ path: 'model', message: 'pick a model' });

  const meta = targetMeta(graph.target);
  const seen = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === 'agent') {
      if (node.prompt.trim() === '') issues.push({ path: 'prompt', message: 'the agent needs a task', nodeId: node.id });
      continue;
    }
    if (!IDENTIFIER_RE.test(node.name)) {
      issues.push({ path: `${node.id}.name`, message: 'letters, digits and underscores', nodeId: node.id });
    } else if (seen.has(node.name)) {
      issues.push({ path: `${node.id}.name`, message: `another node is already called "${node.name}"`, nodeId: node.id });
    }
    seen.set(node.name, node.id);

    if (node.kind === 'tool' || node.kind === 'subagent') {
      if (node.description.trim() === '') {
        issues.push({ path: `${node.id}.description`, message: 'the model reads this; say what it is for', nodeId: node.id });
      }
    }
    if (node.kind === 'tool') {
      const paramNames = new Set<string>();
      node.params.forEach((param, index) => {
        if (!IDENTIFIER_RE.test(param.name)) {
          issues.push({ path: `${node.id}.params.${index}.name`, message: 'letters, digits and underscores', nodeId: node.id });
        } else if (paramNames.has(param.name)) {
          issues.push({ path: `${node.id}.params.${index}.name`, message: 'duplicate parameter', nodeId: node.id });
        }
        paramNames.add(param.name);
      });
    }
    if (node.kind === 'mcp') {
      if (!meta.supports.mcp) {
        issues.push({
          path: `${node.id}.kind`,
          message: `${meta.framework} (${meta.language}) has no MCP generator yet`,
          nodeId: node.id,
        });
      }
      if (node.transport === 'stdio' && node.command.trim() === '') {
        issues.push({ path: `${node.id}.command`, message: 'a stdio server needs a command', nodeId: node.id });
      }
      if (node.transport === 'http' && !/^https?:\/\/\S+$/.test(node.url.trim())) {
        issues.push({ path: `${node.id}.url`, message: 'an http:// or https:// URL', nodeId: node.id });
      }
      if (node.headerEnv.trim() !== '' && !/^[A-Z][A-Z0-9_]{0,63}$/.test(node.headerEnv.trim())) {
        issues.push({ path: `${node.id}.headerEnv`, message: 'UPPER_CASE letters, digits and underscores', nodeId: node.id });
      }
    }
    if (node.kind === 'subagent' && !meta.supports.subAgents) {
      issues.push({
        path: `${node.id}.kind`,
        message: `${meta.framework} (${meta.language}) has no sub-agent generator yet`,
        nodeId: node.id,
      });
    }
  }
  return issues;
}

/** Server issues, mapped onto node ids through the compile's path index. */
export function attributeIssues(
  issues: readonly SpecIssue[],
  nodeByPath: Record<string, string>,
): (SpecIssue & { nodeId?: string })[] {
  return issues.map((issue) => {
    const parts = issue.path.split('.');
    const prefix = parts.slice(0, 2).join('.');
    const nodeId = nodeByPath[prefix];
    return nodeId === undefined ? issue : { ...issue, nodeId };
  });
}

/** Nodes with at least one problem, for the badge on the card. */
export function issuesByNode(issues: readonly (SpecIssue & { nodeId?: string })[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    if (issue.nodeId === undefined) continue;
    (out[issue.nodeId] ??= []).push(issue.message);
  }
  return out;
}

export function issueFor(issues: readonly SpecIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

/** The variables the generated project reads (the generator's own list). */
export { envKeysFor } from '@workflow/codegen/index.js';

// ── the run a job produced ────────────────────────────────────────────────

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
