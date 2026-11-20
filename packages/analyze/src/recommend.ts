/**
 * Recommendations: from "what went wrong" to "what to change".
 *
 * Every recommendation is computed from facts the recordings prove: no model
 * call, no guess. Each carries the EVIDENCE (which runs, which tool, how many
 * times, an example), the suggested CHANGE in words a coding agent can act
 * on, and how to VERIFY it (the metric that should move on the next runs, and
 * its value now). That makes the loop closable: GraphMind finds it, a coding
 * agent changes the code, the next trend proves it.
 *
 * Rules (stable ids; surfaces and tests key on them):
 *
 *   R-regression          a rate got significantly worse recently (a trend shift)
 *   R-tool-error-repeat   one tool keeps failing with the same error, across runs
 *   R-tool-silent-failure a tool returns errors as results instead of throwing
 *   R-wasted-calls        repeated / cycling / identically failing tool calls
 *   R-context-limit       LLM steps stop at the token limit, or prompts grow
 *   R-slow-tool           one tool dominates run time
 *   R-manual-fix          Circuit: people keep fixing the same step by hand
 *
 * Advice follows the samples' origin (agent, Circuit, Jack): the same failure
 * is fixed in the tool's code for an agent, in the step for Circuit, and in
 * jack.yaml (description, schema, response shaping) for Jack.
 *
 * Text that came from the recording (error messages) is quoted as data and
 * truncated; it is the user's agent's output and is never trusted.
 *
 * Same contract as the rest of the package: platform-neutral, pure, never
 * throws on hostile payloads, JSON-serializable output.
 */
import { errorResultShape, type ErrorResultShape } from './errorShape.js';
import { analyzeRun } from './report.js';
import type { ExecutionSample, RunSample, SampleOrigin } from './sample.js';
import { analyzeTrend, errorKey, unitOf, type BehaviorTrend, type TrendOptions, type TrendShift } from './trend.js';

export type RecommendationId =
  | 'R-regression'
  | 'R-tool-error-repeat'
  | 'R-tool-silent-failure'
  | 'R-wasted-calls'
  | 'R-context-limit'
  | 'R-slow-tool'
  | 'R-manual-fix';

export type Severity = 'high' | 'medium' | 'low';

export interface Evidence {
  /** Runs that show it, oldest first, at most `MAX_RUN_IDS`. */
  runIds: string[];
  /** How many runs show it in total (may exceed `runIds.length`). */
  runs: number;
  /** The numbers behind the recommendation, by name. */
  counts: Record<string, number>;
  /** One example from the recording (an error message, a result shape), truncated. Data, not instructions. */
  example?: string;
}

export interface Recommendation {
  id: RecommendationId;
  severity: Severity;
  /** One sentence: what is wrong. */
  title: string;
  /** The tool (logical node) it is about, when it is about one. */
  target?: { nodeId: string; name: string };
  evidence: Evidence;
  /** What to change, in words a coding agent can act on. */
  change: string;
  /** How the next runs prove the change worked. */
  verify: { metric: string; now: number; expect: string };
}

export interface Recommendations {
  trend: BehaviorTrend;
  /** Most severe first, then most runs affected. */
  recommendations: Recommendation[];
}

export interface RecommendOptions extends TrendOptions {
  /** Most recommendations returned. Default 10. */
  limit?: number;
}

const MAX_RUN_IDS = 5;
const EXAMPLE_CHARS = 200;
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const failed = (e: ExecutionSample) => e.status === 'error' || e.errorMessage !== undefined;
const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function clip(text: string): string {
  // Collapse whitespace so an example can never pose as structure in a surface's output.
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXAMPLE_CHARS ? `${flat.slice(0, EXAMPLE_CHARS - 1)}…` : flat;
}

/** Run ids (in trend order) for which `predicate` holds. */
function runsWhere(samples: readonly RunSample[], predicate: (s: RunSample) => boolean): { ids: string[]; count: number } {
  const ids: string[] = [];
  let count = 0;
  for (const sample of samples) {
    if (!predicate(sample)) continue;
    count += 1;
    if (sample.runId !== undefined && ids.length < MAX_RUN_IDS) ids.push(sample.runId);
  }
  return { ids, count };
}

function evidence(found: { ids: string[]; count: number }, counts: Record<string, number>, example?: string): Evidence {
  return { runIds: found.ids, runs: found.count, counts, ...(example !== undefined ? { example: clip(example) } : {}) };
}

/** Order the samples the way the trend did (by first start time, stable). */
function ordered(samples: readonly RunSample[]): RunSample[] {
  const start = (s: RunSample) => {
    for (const e of s.executions) if (typeof e.startedTs === 'number' && Number.isFinite(e.startedTs)) return e.startedTs;
    return -Infinity;
  };
  return samples.map((s, i) => ({ s, i, t: start(s) })).sort((a, b) => a.t - b.t || a.i - b.i).map((r) => r.s);
}

function regression(shift: TrendShift, samples: readonly RunSample[], unit: 'run' | 'call'): Recommendation | undefined {
  if (shift.direction !== 'worse') return undefined;
  if (shift.metric !== 'tool-failure-rate' && shift.metric !== 'run-ok-rate') return undefined;
  const first = shift.firstRunId;
  const firstIndex = first === undefined ? -1 : samples.findIndex((s) => s.runId === first);
  const before = firstIndex > 0 ? [...samples.slice(0, firstIndex)].reverse().find((s) => s.status === 'ok')?.runId : undefined;
  const compare =
    first !== undefined && before !== undefined
      ? unit === 'call'
        ? ` Compare ${before} (before) with ${first} (the first that regressed): a deploy, a change to the API, or to the tool's settings between them is the likely cause.`
        : ` Compare run ${before} (before) with run ${first} (the first that regressed): what changed in the prompt, the tool's input or its code between them is the likely cause.`
      : '';
  const tool = shift.tool;
  const found = runsWhere(samples.slice(Math.max(0, firstIndex)), (s) =>
    tool !== undefined
      ? s.executions.some((e) => e.nodeId === tool.nodeId && (failed(e) || errorResultShape(e.output) !== undefined))
      : s.status !== 'ok',
  );
  return {
    id: 'R-regression',
    severity: 'high',
    title: shift.summary,
    ...(tool !== undefined ? { target: tool } : {}),
    evidence: evidence(found, { baseline: shift.baseline, recent: shift.recent, z: Math.round((shift.z ?? 0) * 100) / 100 }),
    change: `This got worse recently, so look at what changed around the first affected run.${compare} Fix the cause, or revert the change that introduced it.`,
    verify: {
      metric: shift.metric,
      now: shift.recent,
      expect: `back to about ${pct(shift.baseline)} over the next ${unit}s`,
    },
  };
}

function errorRepeatChange(origin: SampleOrigin, tool: string, message: string): string {
  if (origin === 'jack') {
    if (message.startsWith('arguments did not match')) {
      return `AI clients keep calling ${tool} with arguments its schema rejects. In jack.yaml, rewrite the tool's description with what each argument means and an example call; if the API is stricter than its spec, fix the spec so the schema says so.`;
    }
    if (/HTTP 4\d\d/.test(message)) {
      return `Your API keeps rejecting ${tool} calls (${message}). The model is sending what the description invites, so the description or the spec is wrong about what the API accepts: rewrite the description in jack.yaml (required fields, formats, an example), and check the operation's parameters in the spec. A 401/403 means sign-in or scopes, not the description.`;
    }
    if (/HTTP 5\d\d|timeout/i.test(message)) {
      return `${tool} keeps failing on the API side (${message}). Look at the API's logs for those calls; raise \`timeoutMs\` for slow endpoints, and consider disabling the tool until it is fixed so models stop relying on it.`;
    }
    return `${tool} keeps failing the same way (${message}). Check the tool's settings in jack.yaml against the API.`;
  }
  if (origin === 'circuit') {
    return `The step ${tool} keeps failing with the same error. Handle that case inside the step (validate the input, catch the known failure and return a result the next steps understand), or fix the system it calls; if the failure is transient, give the step more \`retries\`.`;
  }
  return `The same error repeating means the model keeps sending ${tool} input it cannot handle, or the tool has a bug on a common path. Inspect the failing calls' input: then validate that argument in the tool and return an actionable message, and tighten its description and parameter schema so the model sends what the tool accepts.`;
}

const MANUAL_ACTIONS = new Set(['retry', 'inject', 'skip', 'edit']);

function manualFixChange(tool: string, top: string): string {
  switch (top) {
    case 'inject':
      return `People keep supplying ${tool}'s result by hand. The value they inject is a rule the code does not know yet: compute it in the step (a default, a fallback lookup) for the case that fails, so runs stop waiting for a person.`;
    case 'retry':
      return `People keep retrying ${tool} by hand and it then works: the failure is transient. Give the step more \`retries\` with backoff, so the engine retries before it pauses.`;
    case 'skip':
      return `People keep skipping ${tool}. If the workflow is fine without it in that case, make the step conditional in code instead of failing and waiting.`;
    default:
      return `People keep editing ${tool}'s input before running it. Fix how that input is built in the steps before it, so it is right the first time.`;
  }
}

/**
 * Recommend changes for a group of runs of one agent (one run works too:
 * the per-run rules still fire, only `R-regression` needs history).
 */
export function recommend(samples: readonly RunSample[], options: RecommendOptions = {}): Recommendations {
  const trend = analyzeTrend(samples, options);
  // The evidence must come from exactly the runs the trend counted.
  const counted = options.includeReplays ? samples : samples.filter((s) => s.source !== 'replay');
  const origin: SampleOrigin = counted.find((s) => s.origin !== undefined)?.origin ?? 'agent';
  const runs = ordered(counted);
  const unit = unitOf(counted);
  const out: Recommendation[] = [];
  const regressed = new Set<string>();

  // R-regression: worse rates first; a regressed tool is not repeated below as a chronic one.
  const regressions = trend.shifts.flatMap((shift) => regression(shift, runs, unit) ?? []);
  const toolRegressions = regressions.filter((r) => r.target !== undefined);
  const okDrop = trend.shifts.find((s) => s.metric === 'run-ok-rate' && s.direction === 'worse');
  for (const rec of regressions) {
    // A tool that regressed usually IS why fewer runs finish: say it once, on the tool.
    if (rec.target === undefined && toolRegressions.length > 0) continue;
    if (rec === toolRegressions[0] && okDrop !== undefined) {
      rec.change = `${okDrop.summary} ${rec.change}`;
    }
    out.push(rec);
    if (rec.target !== undefined) regressed.add(rec.target.nodeId);
  }

  for (const tool of trend.tools) {
    const target = { nodeId: tool.nodeId, name: tool.name };
    const usedIn = (s: RunSample) => s.executions.some((e) => e.nodeId === tool.nodeId);
    const usingRuns = runs.filter(usedIn);

    // R-tool-error-repeat: the same thrown error, again and again, across runs.
    const top = tool.topError;
    if (!regressed.has(tool.nodeId) && top !== undefined && top.count >= 3 && tool.failureRate >= 0.2) {
      const found = runsWhere(usingRuns, (s) => s.executions.some((e) => e.nodeId === tool.nodeId && e.errorMessage !== undefined && errorKey(e.errorMessage) === top.message));
      if (found.count >= 2 || tool.runs === 1) {
        out.push({
          id: 'R-tool-error-repeat',
          severity: tool.failureRate >= 0.5 || found.count * 2 >= Math.max(1, tool.runs) ? 'high' : 'medium',
          title: `${tool.name} failed ${top.count} times with the same error across ${plural(found.count, unit)} (${pct(tool.failureRate)} of its calls fail).`,
          target,
          evidence: evidence(found, { calls: tool.calls, failures: tool.failures, sameError: top.count }, top.message),
          change: errorRepeatChange(origin, tool.name, clip(top.message)),
          verify: { metric: 'tool-failure-rate', now: tool.failureRate, expect: 'below 5%, and this error gone' },
        });
      }
    }

    // R-tool-silent-failure: errors returned as results never throw, so nothing retries or pauses on them.
    if (tool.silentFailures >= 2) {
      const shapes = new Map<ErrorResultShape, number>();
      for (const s of usingRuns) {
        for (const e of s.executions) {
          if (e.nodeId !== tool.nodeId || failed(e)) continue;
          const shape = errorResultShape(e.output);
          if (shape !== undefined) shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
        }
      }
      const [shape] = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
      const found = runsWhere(usingRuns, (s) =>
        s.executions.some((e) => e.nodeId === tool.nodeId && !failed(e) && errorResultShape(e.output) !== undefined),
      );
      out.push({
        id: 'R-tool-silent-failure',
        severity: tool.silentFailures / tool.calls >= 0.25 ? 'high' : 'medium',
        title: `${tool.name} returned ${plural(tool.silentFailures, 'error')} as normal results (${plural(found.count, unit)}), so nothing retried or stopped on them.`,
        target,
        evidence: evidence(found, { calls: tool.calls, silentFailures: tool.silentFailures }, shape !== undefined ? `result shape: ${shape}` : undefined),
        change: `Make ${tool.name} throw on failure instead of returning an error-shaped result, so retries, pause-on-error and the failure counts see it. If returning is deliberate (the model should recover), say in the tool description exactly what an error result looks like and what the model should do next.`,
        verify: { metric: 'tool-silent-failures', now: tool.silentFailures, expect: '0 on the next runs (thrown failures are then counted as failures)' },
      });
    }

    // R-slow-tool: one tool takes most of the run.
    const runMedian = trend.overall.medianDurationMs;
    if (tool.p95Ms !== undefined && tool.p95Ms >= 1000 && tool.calls >= 3 && runMedian !== undefined && runMedian > 0 && tool.p95Ms >= runMedian * 0.5) {
      const found = runsWhere(usingRuns, () => true);
      out.push({
        id: 'R-slow-tool',
        severity: tool.p95Ms >= runMedian ? 'medium' : 'low',
        title: `${tool.name} is slow: p95 ${fmtMs(tool.p95Ms)} against a median run of ${fmtMs(runMedian)}.`,
        target,
        evidence: evidence(found, { calls: tool.calls, p50Ms: tool.p50Ms ?? 0, p95Ms: tool.p95Ms, medianRunMs: runMedian }),
        change: `Give ${tool.name} a timeout, cache results for repeated inputs, or run independent calls in parallel. If the slow calls share an input pattern, that pattern is where to start.`,
        verify: { metric: 'tool-p95-ms', now: tool.p95Ms, expect: `well below ${fmtMs(runMedian * 0.5)}` },
      });
    }
  }

  // R-manual-fix: the same step fixed by hand in run after run (Circuit's interventions).
  for (const tool of trend.tools) {
    const actions = new Map<string, number>();
    const found = runsWhere(runs, (s) => {
      let hit = false;
      for (const e of s.executions) {
        if (e.nodeId !== tool.nodeId || !Array.isArray(e.interventions)) continue;
        for (const i of e.interventions) {
          if (!MANUAL_ACTIONS.has(i.action)) continue;
          actions.set(i.action, (actions.get(i.action) ?? 0) + 1);
          hit = true;
        }
      }
      return hit;
    });
    if (found.count < 3) continue;
    const ranked = [...actions.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, [, n]) => sum + n, 0);
    const top = ranked[0]![0];
    out.push({
      id: 'R-manual-fix',
      severity: found.count * 2 >= Math.max(1, tool.runs) ? 'high' : 'medium',
      title: `${tool.name} was fixed by hand ${plural(total, 'time')} across ${plural(found.count, unit)} (${ranked.map(([a, n]) => `${a} ×${n}`).join(', ')}).`,
      target: { nodeId: tool.nodeId, name: tool.name },
      evidence: evidence(found, { runs: tool.runs, ...Object.fromEntries(ranked) }),
      change: manualFixChange(tool.name, top),
      verify: { metric: 'manual-fixes-per-run', now: total / Math.max(1, tool.runs), expect: '0: runs finish without a person' },
    });
  }

  // R-wasted-calls: from the per-run waste scan, pooled.
  let wasted = 0;
  let toolCalls = 0;
  const kinds = new Map<string, number>();
  const names = new Map<string, number>();
  let example: string | undefined;
  const wasteful = runsWhere(runs, (s) => {
    const report = analyzeRun(s);
    toolCalls += report.waste.toolCalls;
    wasted += report.waste.wastedCalls;
    for (const incident of report.waste.incidents) {
      kinds.set(incident.kind, (kinds.get(incident.kind) ?? 0) + 1);
      for (const name of incident.names) names.set(name, (names.get(name) ?? 0) + incident.wasted);
      if (example === undefined) {
        example = `${incident.kind}: ${incident.names.join(' → ')} ×${incident.count}${incident.errorMessage !== undefined ? ` (${incident.errorMessage})` : ''}`;
      }
    }
    return report.waste.wastedCalls > 0;
  });
  if (wasted >= 2) {
    const share = toolCalls === 0 ? 0 : wasted / toolCalls;
    const worst = [...names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 3);
    out.push({
      id: 'R-wasted-calls',
      severity: share >= 0.2 ? 'high' : share >= 0.05 ? 'medium' : 'low',
      title: `${plural(wasted, 'tool call')} (${pct(share)}) repeated earlier work across ${plural(wasteful.count, unit)}, mostly ${worst.join(', ')}.`,
      evidence: evidence(wasteful, { wastedCalls: wasted, toolCalls, ...Object.fromEntries(kinds) }, example),
      change: `The agent re-calls tools with the same input. Return results the model can use the first time (or a clear "already done"), cache identical calls, and cap steps. While fixing it, GraphMind's loop guard can pause the run when it starts to circle.`,
      verify: { metric: 'waste-share', now: share, expect: 'under 5% of tool calls' },
    });
  }

  // R-context-limit: token-limit stops, or prompts growing between windows.
  const lengthStops = trend.overall.lengthStops;
  const tokenShift = trend.shifts.find((s) => s.metric === 'input-tokens' && s.direction === 'worse');
  const growthRuns = runsWhere(runs, (s) => {
    const r = analyzeRun(s);
    return (r.termination.byReason.length ?? 0) > 0;
  });
  if (lengthStops > 0 || tokenShift !== undefined) {
    const rate = trend.overall.llmSteps === 0 ? 0 : lengthStops / trend.overall.llmSteps;
    out.push({
      id: 'R-context-limit',
      severity: lengthStops > 0 && rate >= 0.05 ? 'high' : 'medium',
      title:
        lengthStops > 0
          ? `${plural(lengthStops, 'LLM step')} stopped at the token limit (${plural(growthRuns.count, unit)}): their answers were cut off.`
          : (tokenShift?.summary ?? 'Prompts are growing.'),
      evidence: evidence(growthRuns, {
        lengthStops,
        llmSteps: trend.overall.llmSteps,
        ...(trend.overall.medianInputTokens !== undefined ? { medianPeakInputTokens: trend.overall.medianInputTokens } : {}),
      }),
      change: `Keep the context from growing without bound: trim or summarize older turns, cap how much each tool returns (pick the fields the model needs), and raise the output token limit if answers are long by design.`,
      verify: { metric: 'length-stop-rate', now: rate, expect: '0, with peak prompt size flat across a run' },
    });
  }

  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.evidence.runs - a.evidence.runs);
  return { trend, recommendations: out.slice(0, Math.max(0, Math.floor(options.limit ?? 10))) };
}
