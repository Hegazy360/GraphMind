/**
 * Insights over the local recordings: one behaviour trend and a ranked list
 * of recommendations per app (agent), computed by @graphmind-ai/analyze.
 *
 * The one loader behind every surface, so they all report the same thing:
 * `graphmind insights` (terminal), the MCP tools `get_insights` and
 * `suggest_improvements` (coding agents), and `GET /api/insights` (the
 * viewer's Insights page).
 *
 * The store knows what events alone cannot: a run's reconciled status
 * (`abandoned`) and its source (`demo`, `live`, `import`; `replay` in older
 * databases). Both are passed into the samples, so abandoned runs are
 * reported as such and replays stay out of behaviour unless asked for.
 */
import {
  groupByApp,
  recommend,
  sampleFromEvents,
  type BehaviorTrend,
  type Recommendation,
  type RunSample,
} from '@graphmind-ai/analyze';
import type { Storage } from './storage.js';

export interface InsightsOptions {
  /** Only this app. */
  app?: string;
  /** Newest runs analyzed per app. Default 200. */
  maxRuns?: number;
  /** Count replays as behaviour. Default false. */
  includeReplays?: boolean;
  /** Most recommendations per app. Default 10. */
  limit?: number;
}

export interface AppInsights {
  app: string;
  trend: BehaviorTrend;
  recommendations: Recommendation[];
}

export const DEFAULT_MAX_RUNS = 200;

export function loadInsights(storage: Storage, opts: InsightsOptions = {}): AppInsights[] {
  const maxRuns = Math.max(1, Math.floor(opts.maxRuns ?? DEFAULT_MAX_RUNS));
  // listRuns is newest first; keep the newest `maxRuns` per app.
  const perApp = new Map<string, number>();
  const samples: RunSample[] = [];
  for (const run of storage.listRuns()) {
    if (opts.app !== undefined && run.app !== opts.app) continue;
    const seen = perApp.get(run.app) ?? 0;
    if (seen >= maxRuns) continue;
    perApp.set(run.app, seen + 1);
    const sample = sampleFromEvents(storage.listEvents(run.id).events, run.id);
    sample.app = run.app;
    sample.status = run.status;
    sample.source = run.source;
    samples.push(sample);
  }
  const out: AppInsights[] = [];
  for (const [app, group] of groupByApp(samples)) {
    const { trend, recommendations } = recommend(group, {
      ...(opts.includeReplays ? { includeReplays: true } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    out.push({ app, trend, recommendations });
  }
  // Most urgent app first.
  const rank = (a: AppInsights) => (a.recommendations.some((r) => r.severity === 'high') ? 0 : a.recommendations.length > 0 ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b) || b.trend.runs - a.trend.runs);
  return out;
}

/** The trend without its per-run series: what a terminal or a coding agent needs. */
export function trendSummary(trend: BehaviorTrend) {
  const { points: _points, ...rest } = trend;
  return { ...rest, tools: rest.tools.slice(0, 10) };
}

/** A verify value, by its metric's name: rates and shares as percentages, `-ms` in ms, counts as numbers. */
export function fmtVerify(metric: string, n: number): string {
  if (metric.endsWith('-ms')) return `${Math.round(n)}ms`;
  if (/rate|share/.test(metric)) return `${Math.round(n * 100)}%`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The terminal rendering: verdict, then each recommendation with its evidence and how to verify it. */
export function formatInsights(apps: readonly AppInsights[]): string {
  if (apps.length === 0) return 'No runs recorded yet. Run your agent with GraphMind attached, then try again.\n';
  const lines: string[] = [];
  for (const { app, trend, recommendations } of apps) {
    lines.push(`${app || '(no app name)'} — ${trend.verdict}`);
    for (const note of trend.notes) lines.push(`  note: ${note}`);
    if (recommendations.length === 0) lines.push('  No recommendations: nothing the recordings prove needs changing.');
    for (const r of recommendations) {
      lines.push('', `  [${r.severity}] ${r.title}`);
      lines.push(`    ${r.change}`);
      const runs = r.evidence.runIds.length > 0 ? ` (e.g. ${r.evidence.runIds.join(', ')})` : '';
      lines.push(`    evidence: ${r.evidence.runs} run(s)${runs}`);
      if (r.evidence.example !== undefined) lines.push(`    example:  ${r.evidence.example}`);
      lines.push(`    verify:   ${r.verify.metric} is ${fmtVerify(r.verify.metric, r.verify.now)} now; expect ${r.verify.expect}`);
      lines.push(`    rule:     ${r.id}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
