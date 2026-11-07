/**
 * The Behaviour section of the run place: one verdict line that unfolds into
 * the evidence. The numbers come from @graphmind-ai/analyze via
 * `sampleFromRunState`, so this strip, `graphmind runs --behavior` and the
 * MCP `get_behavior` tool never disagree; the only thing computed here is
 * the dollar figure on waste spans, because the price table lives with the
 * viewer.
 *
 * Collapsed by default and absent entirely while there is nothing to say
 * (no tool calls and no LLM steps yet) — the run place belongs to the graph.
 */
import { useMemo, useState } from 'react';
import { analyzeRun, type BehaviorReport, type ToolHealth, type WasteIncident } from '@graphmind-ai/analyze';
import { sumCosts, type CostTotal } from '../context/cost.js';
import { sampleFromRunState, wasteSpanExecutions } from '../lib/behavior.js';
import { fmtCostExact, fmtDuration, fmtTokens } from '../lib/format.js';
import { usePriceTable } from '../prices/loader.js';
import { EST_LABEL } from '../prices/snapshot.js';
import { useRunStore } from '../store/runStore.js';

function IncidentRow({ incident }: { incident: WasteIncident }) {
  const chain = incident.names.join(' → ');
  const detail =
    incident.kind === 'cycle'
      ? `×${incident.laps} laps`
      : incident.kind === 'error-repeat'
        ? `×${incident.count} identical failures`
        : `×${incident.count}`;
  return (
    <li className="gm-behavior-incident">
      <span className={`gm-behavior-kind gm-behavior-kind--${incident.kind}`}>{incident.kind}</span>
      <span className="gm-behavior-chain">{chain}</span>
      <span className="gm-behavior-detail">
        {detail}, {incident.wasted} wasted call{incident.wasted === 1 ? '' : 's'}
        {incident.errorMessage !== undefined ? ` — “${incident.errorMessage}”` : ''}
      </span>
    </li>
  );
}

function ToolRow({ tool }: { tool: ToolHealth }) {
  return (
    <tr>
      <td className="gm-behavior-tool-name">{tool.name}</td>
      <td>{tool.calls}</td>
      <td className={tool.failures > 0 ? 'gm-behavior-bad' : ''}>{tool.failures}</td>
      <td className={tool.silentFailures > 0 ? 'gm-behavior-bad' : ''}>{tool.silentFailures}</td>
      <td>{tool.p50Ms === undefined ? '–' : fmtDuration(tool.p50Ms)}</td>
      <td>{tool.p95Ms === undefined ? '–' : fmtDuration(tool.p95Ms)}</td>
    </tr>
  );
}

/** Priced LLM cost inside incident spans; undefined until the table is loaded. */
function useWasteCost(runId: string, report: BehaviorReport | undefined): CostTotal | undefined {
  const wanted =
    report !== undefined && report.waste.incidents.length > 0 && (report.waste.spanLlmSteps ?? 0) > 0;
  const prices = usePriceTable(wanted);
  return useMemo(() => {
    if (!wanted || prices.status !== 'ready' || report === undefined) return undefined;
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return undefined;
    const total = sumCosts(prices.table, wasteSpanExecutions(run, report.waste.incidents));
    return total.priced > 0 ? total : undefined;
  }, [wanted, prices, runId, report]);
}

export function BehaviorSummary({ runId }: { runId: string }) {
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? 0);
  const [open, setOpen] = useState(false);

  const report = useMemo(() => {
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return undefined;
    return analyzeRun(sampleFromRunState(run));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusVersion is the change signal
  }, [runId, statusVersion]);

  const wasteCost = useWasteCost(runId, report);

  if (report === undefined || (report.toolCalls === 0 && report.llmSteps === 0)) return null;

  const { waste, termination } = report;
  const reasons = Object.entries(termination.byReason).sort((a, b) => b[1] - a[1]);
  const contextPoints = report.context.points;
  const first = contextPoints[0];
  const last = contextPoints[contextPoints.length - 1];

  return (
    <section className="gm-behavior" aria-label="Run behaviour">
      <button
        type="button"
        className="gm-behavior-strip"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="gm-behavior-label">Behaviour</span>
        <span className="gm-behavior-verdict">{report.verdict}</span>
        <span className="gm-behavior-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="gm-behavior-body">
          {waste.incidents.length > 0 && (
            <div className="gm-behavior-block">
              <h3>Wasted work</h3>
              <ul className="gm-behavior-incidents">
                {waste.incidents.map((incident, index) => (
                  <IncidentRow key={`${incident.fingerprint}-${index}`} incident={incident} />
                ))}
              </ul>
              <p className="gm-behavior-span">
                {waste.wastedDurationMs > 0 && <>Together: {fmtDuration(waste.wastedDurationMs)} of tool time. </>}
                {waste.spanLlmSteps !== undefined && (
                  <>
                    While these ran, {waste.spanLlmSteps} LLM step{waste.spanLlmSteps === 1 ? '' : 's'} consumed{' '}
                    {fmtTokens(waste.spanInputTokens ?? 0)} tokens in / {fmtTokens(waste.spanOutputTokens ?? 0)} out
                    {wasteCost !== undefined && (
                      <>
                        {' '}
                        (<span title={EST_LABEL}>≈ {fmtCostExact(wasteCost.total)}</span>)
                      </>
                    )}
                    .
                  </>
                )}
              </p>
            </div>
          )}

          {report.tools.length > 0 && (
            <div className="gm-behavior-block">
              <h3>Tools</h3>
              <table className="gm-behavior-tools">
                <thead>
                  <tr>
                    <th>name</th>
                    <th>calls</th>
                    <th>failed</th>
                    <th>silent</th>
                    <th>p50</th>
                    <th>p95</th>
                  </tr>
                </thead>
                <tbody>
                  {report.tools.map((tool) => (
                    <ToolRow key={tool.nodeId} tool={tool} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {termination.llmSteps > 0 && (
            <div className="gm-behavior-block">
              <h3>LLM steps</h3>
              <p>
                {termination.llmSteps} step{termination.llmSteps === 1 ? '' : 's'}
                {reasons.length > 0 && <> — {reasons.map(([reason, count]) => `${reason} ${count}`).join(', ')}</>}
                {termination.unreported > 0 && <>, unreported {termination.unreported}</>}
                {first !== undefined && last !== undefined && contextPoints.length >= 2 && (
                  <>
                    . Input tokens {fmtTokens(first.inputTokens)} → {fmtTokens(last.inputTokens)}
                    {report.context.growthFactor !== undefined && (
                      <> (×{Number(report.context.growthFactor.toFixed(1))})</>
                    )}
                  </>
                )}
              </p>
            </div>
          )}

          {report.notes.length > 0 && (
            <div className="gm-behavior-block gm-behavior-notes">
              {report.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
