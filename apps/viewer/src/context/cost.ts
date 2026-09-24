/**
 * Dollar cost of LLM executions from the bundled price snapshot — the one
 * cost implementation in the viewer (it replaced the flat $3/$15 rate).
 *
 * Token counts are read with the same rules as every other usage display
 * (lib/usage.ts → `readUsage` in @graphmind-ai/schema, contract C1): an
 * `inclusive` usage is the whole prompt, cache included; a 0.5 Anthropic TS
 * usage is recomputed into a total; anything else is "as reported" and the
 * estimate says it may be low. The price engine charges cache reads and
 * writes at their own rates out of that total.
 *
 * Model hints, in order of trust: the model the provider says answered
 * (`output.model`, e.g. OpenAI's dated snapshot id), then what the call
 * asked for (`input.modelId` from the AI SDK, `input.model` from the
 * Anthropic / OpenAI / Python / Ruby adapters), then the top-level
 * `node.started` fields (LangGraph's `ls_model_name`, imports). Provider
 * hints: `input.provider` (AI SDK `anthropic.messages`, Python `openai`),
 * then the top-level `provider` (LangGraph's `ls_provider`).
 *
 * Unknown model → `unknown-model`, and the UI shows no dollar figure.
 */
import { usageView, type UsageView } from '../lib/usage.js';
import {
  activePrices,
  calcCost,
  resolveModel,
  type CostBreakdown,
  type ModelHints,
  type ModelPrice,
  type PriceTable,
  type PricedUsage,
  type ResolvedModel,
} from '../prices/engine.js';
import type { NodeExecution } from '../store/types.js';

export type StepCost =
  | { status: 'priced'; cost: CostBreakdown; usage: UsageView; resolved: ResolvedModel; prices: ModelPrice }
  | { status: 'no-usage' }
  | { status: 'unknown-model'; usage: UsageView; hints: ModelHints };

function hintString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= 200 ? trimmed : undefined;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function modelHintsOf(exec: NodeExecution): ModelHints {
  const model =
    hintString(field(exec.output, 'model')) ??
    hintString(field(exec.output, 'modelId')) ??
    hintString(field(exec.input, 'modelId')) ??
    hintString(field(exec.input, 'model')) ??
    exec.modelHint?.model;
  const provider =
    hintString(field(exec.input, 'provider')) ?? exec.modelHint?.provider ?? hintString(field(exec.output, 'provider'));
  return { ...(model !== undefined ? { model } : {}), ...(provider !== undefined ? { provider } : {}) };
}

/** The counts the price engine charges (`inputTokens` includes the cached share). */
export function pricedUsage(usage: UsageView): PricedUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}

const caches = new WeakMap<PriceTable, WeakMap<NodeExecution, StepCost>>();

/** Price one execution. Memoized per (table, execution object). */
export function priceExecution(table: PriceTable, exec: NodeExecution): StepCost {
  let perTable = caches.get(table);
  if (perTable === undefined) {
    perTable = new WeakMap();
    caches.set(table, perTable);
  }
  const hit = perTable.get(exec);
  if (hit !== undefined) return hit;
  const result = priceUncached(table, exec);
  perTable.set(exec, result);
  return result;
}

function priceUncached(table: PriceTable, exec: NodeExecution): StepCost {
  const usage = usageView(exec.usage);
  if (usage === undefined) return { status: 'no-usage' };
  const hints = modelHintsOf(exec);
  const resolved = resolveModel(table, hints);
  if (resolved === undefined) return { status: 'unknown-model', usage, hints };
  const prices = activePrices(resolved.model, new Date(exec.startedTs));
  const cost = prices === undefined ? undefined : calcCost(pricedUsage(usage), prices);
  if (prices === undefined || cost === undefined) return { status: 'unknown-model', usage, hints };
  return { status: 'priced', cost, usage, resolved, prices };
}

export interface CostTotal {
  total: number;
  /** Executions with usage and a known price. */
  priced: number;
  /** Executions with usage but no price (unknown model). */
  unpriced: number;
  /** Priced executions whose input count is "as reported" (pre-0.6: may exclude cache). */
  reported: number;
}

export function sumCosts(table: PriceTable, execs: Iterable<NodeExecution>): CostTotal {
  const out: CostTotal = { total: 0, priced: 0, unpriced: 0, reported: 0 };
  for (const exec of execs) {
    const cost = priceExecution(table, exec);
    if (cost.status === 'priced') {
      out.total += cost.cost.total;
      out.priced++;
      if (cost.usage.basis === 'reported') out.reported++;
    } else if (cost.status === 'unknown-model') {
      out.unpriced++;
    }
  }
  return out;
}
