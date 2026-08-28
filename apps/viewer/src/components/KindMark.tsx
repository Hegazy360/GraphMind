/**
 * The kind marker: a glyph plus the kind's name, tinted by family.
 *
 * It replaces the bare uppercase word that used to sit in the corner of every
 * card. That word was fine while there were three kinds; with the MCP
 * vocabulary there are eight, and "SERVER" in the same grey as "TOOL" tells
 * you nothing at a glance. The glyph does the work, the tint reinforces it,
 * and neither borrows green or red.
 */
import type { NodeKind } from '@graphmind-ai/schema';
import { kindMeta } from '../lib/kinds.js';
import {
  IconKindAgent,
  IconKindChain,
  IconKindCustom,
  IconKindLlm,
  IconKindPrompt,
  IconKindResource,
  IconKindRetriever,
  IconKindServer,
  IconKindTool,
} from './Icons.js';

const GLYPHS: Record<string, (p: { width: number; height: number }) => React.ReactElement> = {
  agent: IconKindAgent,
  llm: IconKindLlm,
  tool: IconKindTool,
  chain: IconKindChain,
  retriever: IconKindRetriever,
  server: IconKindServer,
  resource: IconKindResource,
  prompt: IconKindPrompt,
  custom: IconKindCustom,
};

export function KindGlyph({ kind, size = 11 }: { kind: NodeKind; size?: number }) {
  const Glyph = GLYPHS[kind] ?? IconKindCustom;
  return <Glyph width={size} height={size} />;
}

/**
 * `label` overrides the kind's own word — the tool card uses it to say
 * "ungated" for a provider-executed call, which is the more important fact
 * about that node than the fact that it is a tool.
 */
export function KindMark({
  kind,
  label,
  title,
  className,
}: {
  kind: NodeKind;
  label?: string;
  title?: string;
  className?: string;
}) {
  const meta = kindMeta(kind);
  return (
    <span
      className={`gm-node-kind gm-kind--${kind}${className === undefined ? '' : ` ${className}`}`}
      title={title ?? meta.hint}
    >
      <KindGlyph kind={kind} />
      {label ?? meta.label}
    </span>
  );
}
