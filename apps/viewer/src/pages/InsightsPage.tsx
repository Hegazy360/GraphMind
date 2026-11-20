/**
 * Insights: per app, the behaviour trend across its recorded runs and a
 * ranked list of evidence-backed recommendations, from `GET /api/insights`
 * (computed by @graphmind-ai/analyze, the same list `graphmind insights` and
 * the MCP tool `suggest_improvements` report).
 *
 * Everything shown here that came from a recording — tool names in titles,
 * error messages, `example` — is the user's agent's output and is untrusted:
 * it is rendered as React text only, never as markup.
 */
import { useEffect, useState } from 'react';
import type { BehaviorTrend, Recommendation, ToolTrend } from '@graphmind-ai/analyze';
import { authHeaders } from '../connection/auth.js';
import { resolveHttpBase } from '../connection/ServerConnection.js';
import { fmtDuration } from '../lib/format.js';
import { formatHash } from '../router.js';
import { useUiStore } from '../store/uiStore.js';

/** Mirrors `AppInsights` in packages/cli/src/insights.ts. */
export interface AppInsights {
  app: string;
  trend: BehaviorTrend;
  recommendations: Recommendation[];
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; apps: AppInsights[] }
  | { state: 'no-server' };

export function insightsUrl(search: string, includeReplays: boolean): string {
  return `${resolveHttpBase(search)}/api/insights${includeReplays ? '?includeReplays=1' : ''}`;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** A verify value, by its metric's name: rates and shares as percentages, `-ms` as durations, counts as numbers. */
export function fmtVerify(metric: string, now: number): string {
  if (metric.endsWith('-ms')) return fmtDuration(now);
  if (/rate|share/.test(metric)) return pct(now);
  return Number.isInteger(now) ? String(now) : now.toFixed(1);
}

function RunLink({ runId }: { runId: string }) {
  return (
    <a className="gm-insights-run" href={formatHash(runId, undefined)}>
      {runId}
    </a>
  );
}

function RecommendationCard({ rec }: { rec: Recommendation }) {
  const counts = Object.entries(rec.evidence.counts);
  return (
    <li className="gm-insights-rec" data-testid="insights-rec">
      <div className="gm-insights-rec-head">
        <span className={`gm-insights-sev gm-insights-sev--${rec.severity}`}>{rec.severity}</span>
        <span className="gm-insights-rec-title">{rec.title}</span>
      </div>
      <p className="gm-insights-change">{rec.change}</p>
      <div className="gm-insights-evidence">
        <span>
          {rec.evidence.runs} run{rec.evidence.runs === 1 ? '' : 's'}
        </span>
        {rec.evidence.runIds.length > 0 && (
          <span className="gm-insights-runs">
            {rec.evidence.runIds.map((id) => (
              <RunLink key={id} runId={id} />
            ))}
          </span>
        )}
        {counts.length > 0 && (
          <span className="gm-insights-counts">
            {counts.map(([k, v]) => `${k}: ${v}`).join(' · ')}
          </span>
        )}
      </div>
      {rec.evidence.example !== undefined && (
        <blockquote className="gm-insights-example">“{rec.evidence.example}”</blockquote>
      )}
      <p className="gm-insights-verify">
        verify: {rec.verify.metric} is {fmtVerify(rec.verify.metric, rec.verify.now)} now → {rec.verify.expect}
      </p>
    </li>
  );
}

function ToolTable({ tools }: { tools: ToolTrend[] }) {
  if (tools.length === 0) return null;
  return (
    <table className="gm-behavior-tools gm-insights-tools">
      <thead>
        <tr>
          <th>tool</th>
          <th>calls</th>
          <th>fail rate</th>
          <th>p95</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((t) => (
          <tr key={t.nodeId}>
            <td className="gm-behavior-tool-name">{t.name}</td>
            <td>{t.calls}</td>
            <td className={t.failureRate > 0 ? 'gm-behavior-bad' : ''}>{pct(t.failureRate)}</td>
            <td>{t.p95Ms === undefined ? '–' : fmtDuration(t.p95Ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AppSection({ insights }: { insights: AppInsights }) {
  const { trend, recommendations } = insights;
  const worse = trend.shifts.filter((s) => s.direction === 'worse');
  return (
    <section className="gm-insights-app" data-testid="insights-app">
      <h2>{insights.app}</h2>
      <p className="gm-insights-verdict">{trend.verdict}</p>
      <p className="gm-insights-meta">
        {trend.runs} run{trend.runs === 1 ? '' : 's'} · {pct(trend.overall.okRate)} ok
      </p>
      {trend.notes.map((n, i) => (
        <p key={i} className="gm-insights-note">
          {n}
        </p>
      ))}

      {recommendations.length === 0 ? (
        <p className="gm-runs-empty">Nothing the recordings prove needs changing.</p>
      ) : (
        <ol className="gm-insights-recs">
          {recommendations.map((r, i) => (
            <RecommendationCard key={`${r.id}:${r.target?.nodeId ?? ''}:${i}`} rec={r} />
          ))}
        </ol>
      )}

      {worse.length > 0 && (
        <div className="gm-behavior-block">
          <h3>Getting worse</h3>
          <ul className="gm-insights-shifts">
            {worse.map((s, i) => (
              <li key={i}>
                {s.summary}
                {s.firstRunId !== undefined && (
                  <>
                    {' '}
                    — since <RunLink runId={s.firstRunId} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {trend.tools.length > 0 && (
        <div className="gm-behavior-block">
          <h3>Tools</h3>
          <ToolTable tools={trend.tools} />
        </div>
      )}
    </section>
  );
}

export function InsightsPage() {
  const fixtureActive = useUiStore((s) => s.fixtureActive);
  const [includeReplays, setIncludeReplays] = useState(false);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const search = typeof location === 'undefined' ? '' : location.search;
  const fixtureMode = fixtureActive || new URLSearchParams(search).has('fixture');

  useEffect(() => {
    if (fixtureMode) {
      setLoad({ state: 'no-server' });
      return;
    }
    let cancelled = false;
    setLoad({ state: 'loading' });
    (async () => {
      try {
        const url = insightsUrl(search, includeReplays);
        const res = await fetch(url, { headers: authHeaders(url) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { apps?: unknown };
        if (!Array.isArray(body.apps)) throw new Error('bad payload');
        if (!cancelled) setLoad({ state: 'ready', apps: body.apps as AppInsights[] });
      } catch {
        if (!cancelled) setLoad({ state: 'no-server' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fixtureMode, search, includeReplays]);

  let body: React.ReactNode;
  if (load.state === 'loading') body = <p className="gm-runs-empty">Loading insights…</p>;
  else if (load.state === 'no-server')
    body = (
      <p className="gm-runs-empty" data-testid="insights-no-server">
        Insights need the local GraphMind server, which reads your recorded runs. Start it with{' '}
        <code>graphmind</code> (or <code>npx graphmind-ai</code>) and open the viewer it serves.
      </p>
    );
  else if (load.apps.length === 0 || load.apps.every((a) => a.trend.runs === 0))
    body = (
      <p className="gm-runs-empty" data-testid="insights-empty">
        No recorded runs yet. Run your agent with GraphMind attached, then come back here.
      </p>
    );
  else body = load.apps.map((a) => <AppSection key={a.app} insights={a} />);

  return (
    <div className="gm-runs">
      <div className="gm-runs-inner">
        <header className="gm-runs-head">
          <div className="gm-runs-title">
            <h1>Insights</h1>
            <span className="gm-runs-count">
              What your recorded runs show, and what to change. The same list is available to Claude
              Code through the MCP tool <code>suggest_improvements</code>, and in the terminal as{' '}
              <code>graphmind insights</code>.
            </span>
          </div>
          <label className="gm-insights-toggle">
            <input
              type="checkbox"
              checked={includeReplays}
              disabled={fixtureMode}
              onChange={(e) => setIncludeReplays(e.target.checked)}
            />
            include replays
          </label>
        </header>
        {body}
      </div>
    </div>
  );
}
