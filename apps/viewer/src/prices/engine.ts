/**
 * Price lookup over the bundled genai-prices snapshot (`data_slim.json`).
 *
 * Mirrors the upstream JS engine (pydantic/genai-prices, packages/js/src/
 * engine.ts) wherever the data demands it, so a model prices here the way it
 * prices in every other tool that reads the same table:
 *
 *  - match clauses: `equals` / `starts_with` / `ends_with` / `contains` are
 *    CASE-INSENSITIVE; `regex` runs as written; `or` / `and` nest.
 *  - provider: by id (lower-cased, trimmed), then the provider's
 *    `provider_match`; failing that, the first provider whose `model_match`
 *    accepts the model id.
 *  - model: first entry of the provider whose `match` accepts the id, then
 *    the same with a compact date normalised (`-20251211` → `-2025-12-11`),
 *    then each `fallback_model_providers` entry (one level, no cascade).
 *  - conditional prices: the LAST entry whose constraint holds wins
 *    (`start_date`: at or after; `start_time`/`end_time`: UTC time of day,
 *    ranges may wrap midnight); none → the first entry.
 *  - tiers are cliffs: once the TOTAL input tokens exceed a tier's `start`,
 *    every token of that unit is charged at the tier's price.
 *  - leaf units: a priced sub-unit is carved out of its parent. Cache reads
 *    and writes are part of `input_tokens`, a 1-hour cache write is part of
 *    the cache writes, reasoning is part of the output — each is charged at
 *    its own price when the model has one, and at the parent's otherwise.
 *
 * GraphMind-specific on top (the hints come from SDK names and recorded
 * inputs, not from the provider's own response): an AI SDK provider string
 * like `xai.chat` is also tried as `xai`; a `vendor/model` id is also tried
 * as provider `vendor` + model `model`; and a provider hint whose table has
 * no such model falls back to matching by model id alone. No match at all →
 * `undefined`, and the caller shows no dollar figure (never a guess).
 */

export type MatchClause =
  | { equals: string }
  | { starts_with: string }
  | { ends_with: string }
  | { contains: string }
  | { regex: string }
  | { or: MatchClause[] }
  | { and: MatchClause[] };

export interface TieredPrice {
  base: number;
  tiers: { start: number; price: number }[];
}

export type PriceValue = number | TieredPrice;

/** One set of unit prices, e.g. `{ input_mtok: 3, output_mtok: 15 }`. */
export type ModelPrice = Partial<Record<string, PriceValue>>;

export interface PriceConstraint {
  start_date?: string;
  start_time?: string;
  end_time?: string;
}

export interface ConditionalPrice {
  constraint?: PriceConstraint;
  prices: ModelPrice;
}

export interface ModelInfo {
  id: string;
  match: MatchClause;
  prices: ModelPrice | ConditionalPrice[];
  context_window?: number;
  deprecated?: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  api_pattern?: string;
  model_match?: MatchClause | null;
  provider_match?: MatchClause | null;
  fallback_model_providers?: string[];
  models: ModelInfo[];
}

export type PriceTable = readonly ProviderInfo[];

// ── matching ──────────────────────────────────────────────────────────────

const regexCache = new Map<string, RegExp | null>();

function compiled(pattern: string): RegExp | null {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern);
    } catch {
      re = null; // an unparseable pattern matches nothing
    }
    regexCache.set(pattern, re);
  }
  return re;
}

export function matchClause(clause: MatchClause | null | undefined, text: string): boolean {
  if (clause === null || clause === undefined || typeof clause !== 'object') return false;
  if ('or' in clause) return Array.isArray(clause.or) && clause.or.some((c) => matchClause(c, text));
  if ('and' in clause) return Array.isArray(clause.and) && clause.and.every((c) => matchClause(c, text));
  const lower = text.toLowerCase();
  if ('equals' in clause) return lower === String(clause.equals).toLowerCase();
  if ('starts_with' in clause) return lower.startsWith(String(clause.starts_with).toLowerCase());
  if ('ends_with' in clause) return lower.endsWith(String(clause.ends_with).toLowerCase());
  if ('contains' in clause) return lower.includes(String(clause.contains).toLowerCase());
  if ('regex' in clause) return compiled(String(clause.regex))?.test(text) === true;
  return false;
}

export function findProviderById(table: PriceTable, providerId: string): ProviderInfo | undefined {
  const normalized = providerId.toLowerCase().trim();
  if (normalized === '') return undefined;
  return (
    table.find((p) => p.id === normalized) ??
    table.find((p) => matchClause(p.provider_match, normalized))
  );
}

const COMPACT_DATE_RE = /(-)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?=-|:|$)/g;

/** `claude-x-20251211` → `claude-x-2025-12-11` (real calendar dates only). */
export function normalizeCompactDatedRef(modelId: string): string {
  return modelId.replace(COMPACT_DATE_RE, (match, prefix: string, year: string, month: string, day: string) => {
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      parsed.getUTCFullYear() !== Number(year) ||
      parsed.getUTCMonth() !== Number(month) - 1 ||
      parsed.getUTCDate() !== Number(day)
    ) {
      return match;
    }
    return `${prefix}${year}-${month}-${day}`;
  });
}

function matchInProvider(provider: ProviderInfo, modelId: string): ModelInfo | undefined {
  const direct = provider.models.find((m) => matchClause(m.match, modelId));
  if (direct !== undefined) return direct;
  const normalized = normalizeCompactDatedRef(modelId);
  return normalized === modelId ? undefined : provider.models.find((m) => matchClause(m.match, normalized));
}

export function findModel(table: PriceTable, provider: ProviderInfo, modelId: string): ModelInfo | undefined {
  const own = matchInProvider(provider, modelId);
  if (own !== undefined) return own;
  for (const fallbackId of provider.fallback_model_providers ?? []) {
    const fallback = findProviderById(table, fallbackId);
    if (fallback === undefined) continue;
    const model = matchInProvider(fallback, modelId);
    if (model !== undefined) return model;
  }
  return undefined;
}

export interface ModelHints {
  /** Model id as the SDK / provider named it (`claude-sonnet-4-5`, `openai/gpt-4o`, …). */
  model?: string | undefined;
  /** Provider hint (`anthropic`, `openai.chat`, `google_genai`, `amazon-bedrock`, …). */
  provider?: string | undefined;
}

export interface ResolvedModel {
  provider: ProviderInfo;
  model: ModelInfo;
  /** The id the match was made on (after any vendor-prefix split). */
  modelRef: string;
}

/** Provider hint → provider, trying the whole string, then the part before the first `.`. */
function providerFromHint(table: PriceTable, hint: string | undefined): ProviderInfo | undefined {
  if (hint === undefined) return undefined;
  const whole = findProviderById(table, hint);
  if (whole !== undefined) return whole;
  const dot = hint.indexOf('.');
  return dot > 0 ? findProviderById(table, hint.slice(0, dot)) : undefined;
}

export function resolveModel(table: PriceTable, hints: ModelHints): ResolvedModel | undefined {
  const ref = hints.model?.trim();
  if (ref === undefined || ref === '') return undefined;
  const slash = ref.indexOf('/');
  const vendor = slash > 0 ? ref.slice(0, slash) : undefined;
  const rest = slash > 0 ? ref.slice(slash + 1) : undefined;

  const attempts: { provider: ProviderInfo | undefined; modelRef: string }[] = [];
  const hinted = providerFromHint(table, hints.provider);
  if (hinted !== undefined) {
    attempts.push({ provider: hinted, modelRef: ref });
    if (rest !== undefined) attempts.push({ provider: hinted, modelRef: rest });
  }
  if (vendor !== undefined && rest !== undefined) {
    const byVendor = findProviderById(table, vendor);
    if (byVendor !== undefined) {
      attempts.push({ provider: byVendor, modelRef: ref });
      attempts.push({ provider: byVendor, modelRef: rest });
    }
  }
  attempts.push({ provider: table.find((p) => matchClause(p.model_match, ref)), modelRef: ref });
  if (rest !== undefined) {
    attempts.push({ provider: table.find((p) => matchClause(p.model_match, rest)), modelRef: rest });
  }

  for (const { provider, modelRef } of attempts) {
    if (provider === undefined) continue;
    const model = findModel(table, provider, modelRef);
    if (model !== undefined) return { provider, model, modelRef };
  }
  return undefined;
}

// ── active prices ─────────────────────────────────────────────────────────

/** `HH:MM[:SS[.sss]]Z` → seconds since UTC midnight; NaN when malformed. */
function utcTimeOfDaySeconds(text: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?Z?$/.exec(text.trim());
  if (m === null) return Number.NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + (m[3] !== undefined ? Number(m[3]) : 0);
}

function constraintHolds(constraint: PriceConstraint, at: Date): boolean {
  if (typeof constraint.start_date === 'string') {
    const start = new Date(constraint.start_date);
    return !Number.isNaN(start.getTime()) && at.getTime() >= start.getTime();
  }
  if (typeof constraint.start_time === 'string' && typeof constraint.end_time === 'string') {
    const time =
      at.getUTCHours() * 3600 + at.getUTCMinutes() * 60 + at.getUTCSeconds() + at.getUTCMilliseconds() / 1000;
    const start = utcTimeOfDaySeconds(constraint.start_time);
    const end = utcTimeOfDaySeconds(constraint.end_time);
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    return end < start ? time >= start || time < end : time >= start && time < end;
  }
  return false; // unknown constraint kind: never selected
}

/** The unit prices in force at `at` (the step's own timestamp). */
export function activePrices(model: ModelInfo, at: Date): ModelPrice | undefined {
  if (!Array.isArray(model.prices)) return model.prices;
  if (Number.isNaN(at.getTime())) return model.prices[0]?.prices;
  for (let i = model.prices.length - 1; i >= 0; i--) {
    const cond = model.prices[i];
    if (cond === undefined) continue;
    if (cond.constraint === undefined) return cond.prices;
    if (constraintHolds(cond.constraint, at)) return cond.prices;
  }
  return model.prices[0]?.prices;
}

// ── cost ──────────────────────────────────────────────────────────────────

/** Token counts in the table's own units. `inputTokens` INCLUDES cached tokens. */
export interface PricedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  /** Part of `cacheWriteTokens` written with a 1-hour TTL (Anthropic), when reported. */
  cacheWrite1hTokens?: number | undefined;
  /** Part of `outputTokens` spent on reasoning. */
  reasoningTokens?: number | undefined;
}

export interface CostBreakdown {
  total: number;
  /** Uncached input. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Per-request fee, when the model has one. */
  requests: number;
  /** A carved-out sub-count exceeded its parent (the usage was inconsistent); clamped at 0. */
  clamped: boolean;
}

function hasPrice(prices: ModelPrice, key: string): boolean {
  const value = prices[key];
  return typeof value === 'number' || (typeof value === 'object' && value !== null);
}

function unitCost(price: PriceValue | undefined, count: number, totalInputTokens: number, per: number): number {
  if (price === undefined || count <= 0) return 0;
  if (typeof price === 'number') return (price * count) / per;
  let applicable = price.base;
  for (const tier of price.tiers) {
    if (totalInputTokens > tier.start) applicable = tier.price;
  }
  return (applicable * count) / per;
}

const nonNeg = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;

/**
 * Dollar cost of one call. `undefined` when the model's prices cannot price
 * these tokens (no token price at all, or tokens on a side with no price) —
 * a partial figure would read as the whole bill.
 */
export function calcCost(usage: PricedUsage, prices: ModelPrice): CostBreakdown | undefined {
  const input = nonNeg(usage.inputTokens);
  const output = nonNeg(usage.outputTokens);
  const hasIn = hasPrice(prices, 'input_mtok');
  const hasOut = hasPrice(prices, 'output_mtok');
  const hasReason = hasPrice(prices, 'output_reasoning_mtok');
  if (!hasIn && !hasOut) return undefined;
  if (input > 0 && !hasIn) return undefined;
  if (output > 0 && !hasOut && !hasReason) return undefined;

  let clamped = false;
  const carve = (parent: number, part: number): number => {
    if (part > parent) {
      clamped = true;
      return parent;
    }
    return part;
  };

  const cacheWriteAll = carve(input, nonNeg(usage.cacheWriteTokens));
  const leaf1h = hasPrice(prices, 'cache_write_1h_mtok')
    ? carve(cacheWriteAll, nonNeg(usage.cacheWrite1hTokens))
    : 0;
  const leafCacheWrite = hasPrice(prices, 'cache_write_mtok') ? cacheWriteAll - leaf1h : 0;
  const leafCacheRead = hasPrice(prices, 'cache_read_mtok')
    ? carve(input - leafCacheWrite - leaf1h, nonNeg(usage.cacheReadTokens))
    : 0;
  const leafInput = input - leafCacheRead - leafCacheWrite - leaf1h;
  const leafReason = hasReason ? carve(output, nonNeg(usage.reasoningTokens)) : 0;
  const leafOutput = output - leafReason;

  const tiered = Object.values(prices).some((p) => typeof p === 'object' && p !== null);
  const totalIn = tiered ? input : 0;
  const M = 1_000_000;
  const breakdown: CostBreakdown = {
    input: unitCost(prices['input_mtok'], leafInput, totalIn, M),
    cacheRead: unitCost(prices['cache_read_mtok'], leafCacheRead, totalIn, M),
    cacheWrite:
      unitCost(prices['cache_write_mtok'], leafCacheWrite, totalIn, M) +
      unitCost(prices['cache_write_1h_mtok'], leaf1h, totalIn, M),
    output:
      unitCost(prices['output_mtok'], leafOutput, totalIn, M) +
      unitCost(prices['output_reasoning_mtok'], leafReason, totalIn, M),
    requests: unitCost(prices['requests_kcount'], 1, totalIn, 1000),
    total: 0,
    clamped,
  };
  breakdown.total =
    breakdown.input + breakdown.cacheRead + breakdown.cacheWrite + breakdown.output + breakdown.requests;
  return breakdown;
}
