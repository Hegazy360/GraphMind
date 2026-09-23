/**
 * Token usage as the viewer shows it (contract C1, 0.6.0).
 *
 * A 0.6 sender stamps `usage.inclusive: true`: `inputTokens` is the whole
 * prompt, cached tokens included, and the cache/reasoning counts are present
 * only when the provider reported them. Older events carry no marker and are
 * shown "as reported" — their `inputTokens` may exclude cached tokens — except
 * the 0.5 Anthropic TypeScript adapter's, recognisable by `cacheCreationTokens`,
 * whose uncached tail is recomputed into a total (`readUsage` in
 * @graphmind-ai/schema does the reading).
 *
 * Pure functions, so the rules are unit-tested without a renderer; the
 * inspector, the LLM card, the top bar and the folded-group badge use them.
 */
import { readUsage, type UsageBasis, type UsageView } from '@graphmind-ai/schema';
import { fmtTokens } from './format.js';

export type { UsageView };

/** How a sum of usages was obtained: every part inclusive, none, or a mix. */
export type TotalBasis = 'inclusive' | 'reported' | 'mixed';

/** Running totals over many executions. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Present only when at least one execution reported it. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Undefined until one usage has been added. */
  basis?: TotalBasis;
}

export function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0 };
}

/** The display view of one stored usage; undefined when it is not one. */
export function usageView(usage: unknown): UsageView | undefined {
  return readUsage(usage);
}

function basisOf(view: UsageView): TotalBasis {
  // A recomputed 0.5 Anthropic total is a true total too.
  return view.basis === 'reported' ? 'reported' : 'inclusive';
}

/** Add one stored usage to `totals` (mutates and returns it). */
export function addUsage(totals: UsageTotals, usage: unknown): UsageTotals {
  const view = readUsage(usage);
  if (view === undefined) return totals;
  totals.inputTokens += view.inputTokens;
  totals.outputTokens += view.outputTokens;
  if (view.cacheReadTokens !== undefined) {
    totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + view.cacheReadTokens;
  }
  if (view.cacheWriteTokens !== undefined) {
    totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + view.cacheWriteTokens;
  }
  if (view.reasoningTokens !== undefined) {
    totals.reasoningTokens = (totals.reasoningTokens ?? 0) + view.reasoningTokens;
  }
  const basis = basisOf(view);
  totals.basis = totals.basis === undefined || totals.basis === basis ? basis : 'mixed';
  return totals;
}

/** Merge `from` into `into` (mutates and returns `into`). */
export function mergeTotals(into: UsageTotals, from: UsageTotals): UsageTotals {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    const value = from[key];
    if (value !== undefined) into[key] = (into[key] ?? 0) + value;
  }
  if (from.basis !== undefined) {
    into.basis = into.basis === undefined || into.basis === from.basis ? from.basis : 'mixed';
  }
  return into;
}

/** The label the input-token count carries. */
export function inputLabel(basis: UsageBasis | TotalBasis | undefined): string {
  if (basis === 'reported') return 'tokens in (as reported)';
  if (basis === 'mixed') return 'tokens in (partly as reported)';
  return 'tokens in';
}

/** A tooltip saying what the input count means. */
export function inputTitle(basis: UsageBasis | TotalBasis | undefined): string {
  switch (basis) {
    case 'inclusive':
      return 'Total prompt tokens, cached tokens included.';
    case 'recomputed':
      return 'Total prompt tokens, recomputed from the uncached count plus cache reads and writes (recorded by a 0.5 SDK).';
    case 'reported':
      return 'As the SDK reported it: recorded before 0.6, so it may not include cached tokens.';
    case 'mixed':
      return 'Some executions were recorded before 0.6 and counted as reported (they may exclude cached tokens).';
    default:
      return '';
  }
}

export interface UsageCell {
  label: string;
  value: string;
  title?: string;
}

/**
 * The extra cells for one usage or a total: cache read / cache write /
 * reasoning, each only when reported.
 */
export function detailCells(usage: {
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  reasoningTokens?: number | undefined;
}): UsageCell[] {
  const cells: UsageCell[] = [];
  if (usage.cacheReadTokens !== undefined) {
    cells.push({ label: 'cache read', value: fmtTokens(usage.cacheReadTokens), title: 'Prompt tokens served from the provider cache (part of tokens in).' });
  }
  if (usage.cacheWriteTokens !== undefined) {
    cells.push({ label: 'cache write', value: fmtTokens(usage.cacheWriteTokens), title: 'Prompt tokens written to the provider cache (part of tokens in).' });
  }
  if (usage.reasoningTokens !== undefined) {
    cells.push({ label: 'reasoning', value: fmtTokens(usage.reasoningTokens), title: 'Output tokens spent reasoning (part of tokens out).' });
  }
  return cells;
}

/** The one-line hover text of an LLM card's token counts. */
export function usageSummary(view: UsageView): string {
  const parts = [`${view.inputTokens} in`];
  if (view.cacheReadTokens !== undefined) parts.push(`${view.cacheReadTokens} cache read`);
  if (view.cacheWriteTokens !== undefined) parts.push(`${view.cacheWriteTokens} cache write`);
  parts.push(`${view.outputTokens} out`);
  if (view.reasoningTokens !== undefined) parts.push(`${view.reasoningTokens} reasoning`);
  const text = parts.join(' · ');
  return view.basis === 'reported' ? `${text} (as reported)` : text;
}
