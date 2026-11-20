/**
 * Behaviour over many runs: how a group of runs (normally every run of one
 * app) behaves as a whole, and what changed between an earlier window and a
 * recent one.
 *
 * `analyzeRun` answers "how did this run go?". This answers "how does this
 * agent usually go, and is it getting worse?": per-tool failure rates and run
 * times pooled over every call, completion rate, wasted work, token-limit
 * stops, prompt size and run length — each as a per-run series and as a
 * baseline-vs-recent comparison.
 *
 * A shift is only reported when the data supports it, never from a handful
 * of runs:
 *
 *   - both windows need `minRuns` runs (default 5);
 *   - a RATE (failures per call, ok runs per run, length stops per LLM step)
 *     must move by at least `minRateDelta` absolute (default 0.15) AND pass a
 *     two-proportion z-test at |z| >= `minZ` (default 2, about 95%);
 *   - a per-run SIZE (input tokens, tool calls, run time) compares medians
 *     and must move by `minRatio` (default 1.5x) either way.
 *
 * Same contract as the rest of the package: platform-neutral, pure, never
 * throws on hostile payloads, JSON-serializable output.
 */
import { errorResultShape } from './errorShape.js';
import { analyzeRun, outputFinishReason, type BehaviorReport } from './report.js';
import type { ExecutionSample, RunSample } from './sample.js';

export interface TrendOptions {
  /** Runs in the recent window. Default: the newer half (at least `minRuns`). */
  recent?: number;
  /** Runs each window needs before any shift is reported. Default 5. */
  minRuns?: number;
  /** Smallest absolute change of a rate worth reporting. Default 0.15. */
  minRateDelta?: number;
  /** Smallest |z| of a two-proportion test for a rate shift. Default 2. */
  minZ?: number;
  /** Smallest ratio between window medians for a size shift. Default 1.5. */
  minRatio?: number;
  /**
   * Count replays (`source: 'replay'`) as behaviour. Default false: a replay
   * re-executes a recorded run for testing, it is not how the agent behaves.
   */
  includeReplays?: boolean;
}

/** One run as the trend sees it: the per-run report plus what it needs to order and size runs. */
export interface TrendPoint {
  runId?: string;
  /** Epoch ms of the run's first recorded execution, when known. */
  startedAt?: number;
  status?: string;
  ok: boolean;
  toolCalls: number;
  llmSteps: number;
  /** Tool calls that failed, thrown or returned, over tool calls. */
  toolFailureRate: number;
  wasteShare: number;
  lengthStops: number;
  maxInputTokens?: number;
  /** Sum of run time (minus debugger holds) of the run's top-level executions. */
  durationMs?: number;
  verdict: string;
}

export interface ToolTrend {
  /** The stable logical node; tools are pooled across runs by it. */
  nodeId: string;
  name: string;
  calls: number;
  failures: number;
  silentFailures: number;
  failureRate: number;
  /** Runs in which the tool was called. */
  runs: number;
  /** Runs in which it failed at least once. */
  runsFailing: number;
  /** Pooled over every completed call in every run. */
  p50Ms?: number;
  p95Ms?: number;
  /** The most common error message, when failures recorded one. */
  topError?: { message: string; count: number };
}

export interface WindowStats {
  runs: number;
  okRate: number;
  toolCalls: number;
  toolFailures: number;
  llmSteps: number;
  lengthStops: number;
  medianInputTokens?: number;
  medianToolCalls?: number;
  medianDurationMs?: number;
}

export type ShiftMetric =
  | 'run-ok-rate'
  | 'tool-failure-rate'
  | 'length-stop-rate'
  | 'input-tokens'
  | 'tool-calls-per-run'
  | 'run-duration';

export interface TrendShift {
  metric: ShiftMetric;
  /** `worse` is the direction someone needs to hear about. */
  direction: 'worse' | 'better';
  /** The tool, for `tool-failure-rate`. */
  tool?: { nodeId: string; name: string };
  baseline: number;
  recent: number;
  /** Rates only: the two-proportion z statistic. */
  z?: number;
  /** The first recent run that showed it (a failure of the tool, a failed run...), when one can be named. */
  firstRunId?: string;
  /** One complete sentence, the same on every surface. */
  summary: string;
}

export interface BehaviorTrend {
  runs: number;
  /** Earliest and latest `startedAt` among the runs. */
  from?: number;
  to?: number;
  /** Oldest first. */
  points: TrendPoint[];
  overall: WindowStats;
  /** Worst first (failure rate, then calls). */
  tools: ToolTrend[];
  /** Present when there were enough runs to split. */
  baseline?: WindowStats;
  recent?: WindowStats;
  /** Worse ones first. Empty when nothing moved, or there was too little data to say. */
  shifts: TrendShift[];
  verdict: string;
  notes: string[];
}

const DEFAULTS = { minRuns: 5, minRateDelta: 0.15, minZ: 2, minRatio: 1.5 };

/**
 * What one sample is, in words: a Jack sample is one tool call, everything
 * else is a run. Every sentence the trend and the recommendations write uses it.
 */
export function unitOf(samples: readonly RunSample[]): 'run' | 'call' {
  return samples.length > 0 && samples.every((s) => s.origin === 'jack') ? 'call' : 'run';
}

/** How errors are grouped: by their first 300 characters (a stack trace's tail is noise). */
export const errorKey = (message: string): string => message.slice(0, 300);

function percentile(values: number[], rank: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
  return sorted[index];
}

const median = (values: number[]) => percentile(values, 50);

function ranMs(execution: ExecutionSample): number | undefined {
  if (execution.durationMs === undefined || !Number.isFinite(execution.durationMs)) return undefined;
  return Math.max(0, execution.durationMs - (execution.heldMs ?? 0));
}

const failed = (e: ExecutionSample) => e.status === 'error' || e.errorMessage !== undefined;
const silent = (e: ExecutionSample) => !failed(e) && e.status === 'ok' && errorResultShape(e.output) !== undefined;

function startedAt(sample: RunSample): number | undefined {
  for (const execution of sample.executions) {
    if (typeof execution.startedTs === 'number' && Number.isFinite(execution.startedTs)) return execution.startedTs;
  }
  return undefined;
}

/** Run time of the top-level executions (children run inside their parents). */
function runDuration(sample: RunSample): number | undefined {
  const ids = new Set(sample.executions.map((e) => e.nodeId));
  let total = 0;
  let any = false;
  for (const execution of sample.executions) {
    if (execution.parentId !== undefined && ids.has(execution.parentId)) continue;
    const ran = ranMs(execution);
    if (ran === undefined) continue;
    total += ran;
    any = true;
  }
  return any ? total : undefined;
}

function point(sample: RunSample, report: BehaviorReport): TrendPoint {
  const tools = sample.executions.filter((e) => e.kind === 'tool');
  const bad = tools.filter((e) => failed(e) || silent(e)).length;
  const at = startedAt(sample);
  const duration = runDuration(sample);
  return {
    ...(sample.runId !== undefined ? { runId: sample.runId } : {}),
    ...(at !== undefined ? { startedAt: at } : {}),
    ...(report.status !== undefined ? { status: report.status } : {}),
    ok: report.status === 'ok',
    toolCalls: report.toolCalls,
    llmSteps: report.llmSteps,
    toolFailureRate: tools.length === 0 ? 0 : bad / tools.length,
    wasteShare: report.waste.share,
    lengthStops: report.termination.byReason.length ?? 0,
    ...(report.context.maxInputTokens !== undefined ? { maxInputTokens: report.context.maxInputTokens } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    verdict: report.verdict,
  };
}

function toolTrends(samples: readonly RunSample[]): ToolTrend[] {
  interface Acc {
    name: string;
    calls: number;
    failures: number;
    silentFailures: number;
    runs: number;
    runsFailing: number;
    durations: number[];
    errors: Map<string, number>;
  }
  const byNode = new Map<string, Acc>();
  for (const sample of samples) {
    const seen = new Set<string>();
    const failing = new Set<string>();
    for (const execution of sample.executions) {
      if (execution.kind !== 'tool') continue;
      let acc = byNode.get(execution.nodeId);
      if (acc === undefined) {
        acc = { name: execution.name, calls: 0, failures: 0, silentFailures: 0, runs: 0, runsFailing: 0, durations: [], errors: new Map() };
        byNode.set(execution.nodeId, acc);
      }
      acc.calls += 1;
      seen.add(execution.nodeId);
      if (failed(execution)) {
        acc.failures += 1;
        failing.add(execution.nodeId);
        if (typeof execution.errorMessage === 'string') {
          const message = errorKey(execution.errorMessage);
          acc.errors.set(message, (acc.errors.get(message) ?? 0) + 1);
        }
      } else if (silent(execution)) {
        acc.silentFailures += 1;
        failing.add(execution.nodeId);
      }
      const ran = ranMs(execution);
      if (ran !== undefined) acc.durations.push(ran);
    }
    for (const id of seen) byNode.get(id)!.runs += 1;
    for (const id of failing) byNode.get(id)!.runsFailing += 1;
  }
  const out: ToolTrend[] = [];
  for (const [nodeId, acc] of byNode) {
    let top: { message: string; count: number } | undefined;
    for (const [message, count] of acc.errors) if (top === undefined || count > top.count) top = { message, count };
    const p50 = percentile(acc.durations, 50);
    const p95 = percentile(acc.durations, 95);
    out.push({
      nodeId,
      name: acc.name,
      calls: acc.calls,
      failures: acc.failures,
      silentFailures: acc.silentFailures,
      failureRate: acc.calls === 0 ? 0 : (acc.failures + acc.silentFailures) / acc.calls,
      runs: acc.runs,
      runsFailing: acc.runsFailing,
      ...(p50 !== undefined ? { p50Ms: p50 } : {}),
      ...(p95 !== undefined ? { p95Ms: p95 } : {}),
      ...(top !== undefined ? { topError: top } : {}),
    });
  }
  out.sort((a, b) => b.failureRate - a.failureRate || b.calls - a.calls);
  return out;
}

function windowStats(samples: readonly RunSample[], points: readonly TrendPoint[]): WindowStats {
  let toolCalls = 0;
  let toolFailures = 0;
  let llmSteps = 0;
  let lengthStops = 0;
  for (const sample of samples) {
    for (const execution of sample.executions) {
      if (execution.kind === 'tool') {
        toolCalls += 1;
        if (failed(execution) || silent(execution)) toolFailures += 1;
      } else if (execution.kind === 'llm' && execution.status !== 'running') {
        llmSteps += 1;
        if (outputFinishReason(execution.output) === 'length') lengthStops += 1;
      }
    }
  }
  const tokens = median(points.flatMap((p) => (p.maxInputTokens !== undefined ? [p.maxInputTokens] : [])));
  const calls = median(points.map((p) => p.toolCalls));
  const duration = median(points.flatMap((p) => (p.durationMs !== undefined ? [p.durationMs] : [])));
  return {
    runs: points.length,
    okRate: points.length === 0 ? 0 : points.filter((p) => p.ok).length / points.length,
    toolCalls,
    toolFailures,
    llmSteps,
    lengthStops,
    ...(tokens !== undefined ? { medianInputTokens: tokens } : {}),
    ...(calls !== undefined ? { medianToolCalls: calls } : {}),
    ...(duration !== undefined ? { medianDurationMs: duration } : {}),
  };
}

/** Two-proportion z statistic of (x2/n2 - x1/n1); undefined when it cannot be computed. */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number | undefined {
  if (n1 <= 0 || n2 <= 0) return undefined;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return undefined;
  return (x2 / n2 - x1 / n1) / se;
}

const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

interface RateCheck {
  x1: number;
  n1: number;
  x2: number;
  n2: number;
  /** True when a HIGHER rate is worse (failures), false when lower is worse (ok rate). */
  higherIsWorse: boolean;
}

function rateShift(check: RateCheck, opts: typeof DEFAULTS): { baseline: number; recent: number; z: number; direction: 'worse' | 'better' } | undefined {
  const { x1, n1, x2, n2 } = check;
  if (n1 === 0 || n2 === 0) return undefined;
  const baseline = x1 / n1;
  const recent = x2 / n2;
  if (Math.abs(recent - baseline) < opts.minRateDelta) return undefined;
  const z = twoProportionZ(x1, n1, x2, n2);
  if (z === undefined || Math.abs(z) < opts.minZ) return undefined;
  const up = recent > baseline;
  return { baseline, recent, z, direction: up === check.higherIsWorse ? 'worse' : 'better' };
}

function sizeShift(baseline: number | undefined, recent: number | undefined, opts: typeof DEFAULTS): 'worse' | 'better' | undefined {
  if (baseline === undefined || recent === undefined || baseline <= 0 || recent <= 0) return undefined;
  if (recent / baseline >= opts.minRatio) return 'worse';
  if (baseline / recent >= opts.minRatio) return 'better';
  return undefined;
}

function shifts(
  base: { samples: RunSample[]; points: TrendPoint[]; stats: WindowStats },
  rec: { samples: RunSample[]; points: TrendPoint[]; stats: WindowStats },
  opts: typeof DEFAULTS,
  unit: 'run' | 'call',
): TrendShift[] {
  const found: TrendShift[] = [];
  const firstRun = (predicate: (sample: RunSample, point: TrendPoint) => boolean): string | undefined => {
    for (let i = 0; i < rec.samples.length; i += 1) {
      if (predicate(rec.samples[i]!, rec.points[i]!)) return rec.points[i]!.runId;
    }
    return undefined;
  };
  const withRun = (id: string | undefined) => (id !== undefined ? { firstRunId: id } : {});

  const ok = rateShift(
    { x1: Math.round(base.stats.okRate * base.stats.runs), n1: base.stats.runs, x2: Math.round(rec.stats.okRate * rec.stats.runs), n2: rec.stats.runs, higherIsWorse: false },
    opts,
  );
  if (ok !== undefined) {
    const id = ok.direction === 'worse' ? firstRun((_, p) => !p.ok) : undefined;
    found.push({
      metric: 'run-ok-rate',
      direction: ok.direction,
      baseline: ok.baseline,
      recent: ok.recent,
      z: ok.z,
      ...withRun(id),
      summary: `${unit === 'call' ? 'Calls succeeding' : 'Runs finishing ok'} went from ${pct(ok.baseline)} to ${pct(ok.recent)}.`,
    });
  }

  // Per tool, pooled per window.
  const perWindow = (samples: RunSample[]) => {
    const map = new Map<string, { name: string; calls: number; bad: number }>();
    for (const sample of samples) {
      for (const execution of sample.executions) {
        if (execution.kind !== 'tool') continue;
        const entry = map.get(execution.nodeId) ?? { name: execution.name, calls: 0, bad: 0 };
        entry.calls += 1;
        if (failed(execution) || silent(execution)) entry.bad += 1;
        map.set(execution.nodeId, entry);
      }
    }
    return map;
  };
  const before = perWindow(base.samples);
  const after = perWindow(rec.samples);
  for (const [nodeId, now] of after) {
    const then = before.get(nodeId);
    if (then === undefined) continue; // a new tool has no baseline; the tool table still shows it
    const shift = rateShift({ x1: then.bad, n1: then.calls, x2: now.bad, n2: now.calls, higherIsWorse: true }, opts);
    if (shift === undefined) continue;
    const id =
      shift.direction === 'worse'
        ? firstRun((sample) => sample.executions.some((e) => e.nodeId === nodeId && (failed(e) || silent(e))))
        : undefined;
    found.push({
      metric: 'tool-failure-rate',
      direction: shift.direction,
      tool: { nodeId, name: now.name },
      baseline: shift.baseline,
      recent: shift.recent,
      z: shift.z,
      ...withRun(id),
      summary: `${now.name} failed ${pct(shift.recent)} of calls recently, against ${pct(shift.baseline)} before (${now.bad} of ${now.calls}).`,
    });
  }

  const length = rateShift(
    { x1: base.stats.lengthStops, n1: base.stats.llmSteps, x2: rec.stats.lengthStops, n2: rec.stats.llmSteps, higherIsWorse: true },
    opts,
  );
  if (length !== undefined) {
    const id = length.direction === 'worse' ? firstRun((_, p) => p.lengthStops > 0) : undefined;
    found.push({
      metric: 'length-stop-rate',
      direction: length.direction,
      baseline: length.baseline,
      recent: length.recent,
      z: length.z,
      ...withRun(id),
      summary: `LLM steps stopping at the token limit went from ${pct(length.baseline)} to ${pct(length.recent)}.`,
    });
  }

  const sizes: Array<[ShiftMetric, number | undefined, number | undefined, (n: number) => string, string]> = [
    ['input-tokens', base.stats.medianInputTokens, rec.stats.medianInputTokens, fmtTokens, 'Median peak prompt size'],
    ['tool-calls-per-run', base.stats.medianToolCalls, rec.stats.medianToolCalls, (n) => String(Math.round(n)), 'Median tool calls per run'],
    ['run-duration', base.stats.medianDurationMs, rec.stats.medianDurationMs, fmtMs, 'Median run time'],
  ];
  for (const [metric, b, r, fmt, label] of sizes) {
    const direction = sizeShift(b, r, opts);
    if (direction === undefined) continue;
    found.push({ metric, direction, baseline: b!, recent: r!, summary: `${label} went from ${fmt(b!)} to ${fmt(r!)}.` });
  }

  found.sort((a, b) => (a.direction === b.direction ? Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0) : a.direction === 'worse' ? -1 : 1));
  return found;
}

function trendVerdict(trend: Omit<BehaviorTrend, 'verdict'>, unit: 'run' | 'call'): string {
  if (trend.runs === 0) return `Nothing to analyze: no ${unit}s.`;
  const parts: string[] = [];
  const worse = trend.shifts.filter((s) => s.direction === 'worse');
  for (const shift of worse.slice(0, 3)) parts.push(shift.summary.replace(/\.$/, ''));
  if (worse.length === 0) {
    const worst = trend.tools.find((t) => t.calls >= 5 && t.failureRate >= 0.2);
    if (worst !== undefined) {
      parts.push(unit === 'call' ? `${worst.name} fails ${pct(worst.failureRate)} of its ${worst.calls} calls` : `${worst.name} fails ${pct(worst.failureRate)} of its ${worst.calls} calls across ${worst.runs} runs`);
    }
  }
  const head = `${trend.runs} ${unit}${trend.runs === 1 ? '' : 's'}, ${pct(trend.overall.okRate)} ok`;
  if (parts.length === 0) {
    return trend.baseline !== undefined ? `${head}; nothing changed between the earlier and the recent ${unit}s.` : `${head}; too few ${unit}s to compare earlier and recent behaviour.`;
  }
  return `${head}; ${parts.join('; ')}.`;
}

/**
 * Analyze a group of runs (normally every run of one app). Order does not
 * matter: runs are sorted by `startedAt` (unknown times keep their relative
 * order, first). Pure; never throws on hostile payloads.
 */
export function analyzeTrend(samples: readonly RunSample[], options: TrendOptions = {}): BehaviorTrend {
  const unit = unitOf(samples);
  const opts = {
    minRuns: Math.max(1, Math.floor(options.minRuns ?? DEFAULTS.minRuns)),
    minRateDelta: options.minRateDelta ?? DEFAULTS.minRateDelta,
    minZ: options.minZ ?? DEFAULTS.minZ,
    minRatio: options.minRatio ?? DEFAULTS.minRatio,
  };
  const excluded = options.includeReplays ? 0 : samples.filter((s) => s.source === 'replay').length;
  const rows = samples
    .filter((s) => options.includeReplays || s.source !== 'replay')
    .map((sample, index) => ({ sample, index, report: analyzeRun(sample) }))
    .map((row) => ({ ...row, point: point(row.sample, row.report) }))
    .sort((a, b) => (a.point.startedAt ?? -Infinity) - (b.point.startedAt ?? -Infinity) || a.index - b.index);
  const ordered = rows.map((r) => r.sample);
  const points = rows.map((r) => r.point);
  const notes: string[] = [];

  const times = points.flatMap((p) => (p.startedAt !== undefined ? [p.startedAt] : []));
  const base: Omit<BehaviorTrend, 'verdict'> = {
    runs: points.length,
    ...(times.length > 0 ? { from: Math.min(...times), to: Math.max(...times) } : {}),
    points,
    overall: windowStats(ordered, points),
    tools: toolTrends(ordered),
    shifts: [],
    notes,
  };
  if (times.length < points.length && points.length > 0) {
    notes.push(`${points.length - times.length} run(s) have no start time; they are treated as the oldest.`);
  }
  if (excluded > 0) notes.push(`${excluded} replay run(s) left out: a replay re-runs a recording for testing.`);
  const abandoned = points.filter((p) => p.status === 'abandoned').length;
  if (abandoned > 0) notes.push(`${abandoned} run(s) were abandoned (never finished: the process stopped, or they were left paused); they count as not ok.`);
  const running = points.filter((p) => p.status === undefined || p.status === 'running').length;
  if (running > 0) notes.push(`${running} run(s) are still running or never recorded an end; they count as not ok.`);

  const recentCount = Math.floor(options.recent ?? Math.max(opts.minRuns, Math.floor(points.length / 2)));
  const baselineCount = points.length - recentCount;
  if (recentCount >= opts.minRuns && baselineCount >= opts.minRuns) {
    const split = (from: number, to: number) => ({
      samples: ordered.slice(from, to),
      points: points.slice(from, to),
      stats: windowStats(ordered.slice(from, to), points.slice(from, to)),
    });
    const before = split(0, baselineCount);
    const after = split(baselineCount, points.length);
    base.baseline = before.stats;
    base.recent = after.stats;
    base.shifts = shifts(before, after, opts, unit);
  } else {
    if (points.length > 0) notes.push(`Comparing earlier and recent ${unit}s needs ${opts.minRuns} in each window; there are ${points.length} ${unit}(s).`);
  }
  return { ...base, verdict: trendVerdict(base, unit) };
}

/** Group samples by `app` (runs without one go under `''`), for one trend per agent. */
export function groupByApp(samples: Iterable<RunSample>): Map<string, RunSample[]> {
  const groups = new Map<string, RunSample[]>();
  for (const sample of samples) {
    const key = sample.app ?? '';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [sample]);
    else list.push(sample);
  }
  return groups;
}
