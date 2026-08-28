/**
 * Node-kind identity.
 *
 * Every kind the wire contract can carry gets one place that answers: what do
 * we call it, which card renders it, does it own a subtree, and which of the
 * two colour families it belongs to. Before this existed the answers were
 * spread across `runStateToFlow`, four card components, the timeline, the
 * filter popover and a `switch` in the inspector — which is exactly why the
 * three MCP kinds (`server`, `resource`, `prompt`) rendered as anonymous
 * "TOOL" cards the moment the schema gained them.
 *
 * Colour rule (taste guardrail): green means *alive* and red means *failed*.
 * Neither is available to say "this is a resource". Kind identity is carried
 * by an icon and a label, with a low-saturation tint that reads as a family
 * marker rather than as status.
 */
import type { NodeKind } from '@graphmind-ai/schema';

/** Which card component draws a kind. */
export type KindCard = 'invocation' | 'llmStep' | 'tool';

export interface KindMeta {
  kind: NodeKind;
  /** The word on the card. */
  label: string;
  /** One line, for tooltips and the filter popover. */
  hint: string;
  /** Kinds that own a subtree: they get a fold chevron and a group summary. */
  container: boolean;
  /** Part of the Model Context Protocol vocabulary. */
  mcp: boolean;
  card: KindCard;
}

const META: Record<NodeKind, KindMeta> = {
  agent: {
    kind: 'agent',
    label: 'agent',
    hint: 'One agent invocation — its steps and tool calls hang beneath it',
    container: true,
    mcp: false,
    card: 'invocation',
  },
  llm: {
    kind: 'llm',
    label: 'llm',
    hint: 'A model call: streamed tokens, usage and latency',
    container: true,
    mcp: false,
    card: 'llmStep',
  },
  tool: {
    kind: 'tool',
    label: 'tool',
    hint: 'A tool call the agent made',
    container: false,
    mcp: false,
    card: 'tool',
  },
  chain: {
    kind: 'chain',
    label: 'chain',
    hint: 'A composed sequence of steps',
    container: true,
    mcp: false,
    card: 'invocation',
  },
  retriever: {
    kind: 'retriever',
    label: 'retriever',
    hint: 'A retrieval / vector lookup',
    container: false,
    mcp: false,
    card: 'tool',
  },
  server: {
    kind: 'server',
    label: 'server',
    hint: 'An MCP server session — the client requests it handled',
    container: true,
    mcp: true,
    card: 'invocation',
  },
  resource: {
    kind: 'resource',
    label: 'resource',
    hint: 'An MCP resources/read',
    container: false,
    mcp: true,
    card: 'tool',
  },
  prompt: {
    kind: 'prompt',
    label: 'prompt',
    hint: 'An MCP prompts/get',
    container: false,
    mcp: true,
    card: 'tool',
  },
  custom: {
    kind: 'custom',
    label: 'span',
    hint: 'A custom span the app opened itself',
    container: false,
    mcp: false,
    card: 'tool',
  },
};

/**
 * A kind the viewer has never heard of (a future v1.x sender) still has to
 * render as *something* honest: a leaf card labelled with whatever arrived.
 */
export function kindMeta(kind: NodeKind): KindMeta {
  return (
    META[kind] ?? {
      kind,
      label: String(kind),
      hint: `A "${String(kind)}" node — this viewer does not know the kind yet`,
      container: false,
      mcp: false,
      card: 'tool',
    }
  );
}

export function kindLabel(kind: NodeKind): string {
  return kindMeta(kind).label;
}

export function isContainerKind(kind: NodeKind): boolean {
  return kindMeta(kind).container;
}

export function isMcpKind(kind: NodeKind): boolean {
  return kindMeta(kind).mcp;
}

/** Filter-popover order: the everyday kinds first, then the MCP family. */
export const KIND_ORDER: readonly NodeKind[] = [
  'agent',
  'llm',
  'tool',
  'chain',
  'retriever',
  'server',
  'resource',
  'prompt',
  'custom',
];

export const MCP_KINDS: readonly NodeKind[] = KIND_ORDER.filter((kind) => kindMeta(kind).mcp);
