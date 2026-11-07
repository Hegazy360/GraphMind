/**
 * `graphmind runs --behavior <runId|last>` — the terminal rendering of a
 * behaviour report. The numbers come from @graphmind-ai/analyze (the same
 * `analyzeRun` the MCP `get_behavior` tool and the viewer's Behaviour
 * section call), so this file only decides what a terminal shows: the
 * verdict first, then the evidence, then the caveats.
 */
import {
  analyzeRun,
  sampleFromEvents,
  type BehaviorReport,
  type ToolHealth,
  type WasteIncident,
} from '@graphmind-ai/analyze';
import type { Storage } from './storage.js';

export class BehaviorError extends Error {}

/** `last` picks the most recently started run (as `listRuns` orders them). */
export function resolveBehaviorRunId(storage: Storage, arg: string): string {
  if (arg !== 'last') return arg;
  const runs = storage.listRuns();
  const newest = runs[0];
  if (newest === undefined) throw new BehaviorError('no runs stored yet — nothing to analyze.');
  return newest.id;
}

export function loadBehaviorReport(storage: Storage, runId: string): BehaviorReport {
  const page = storage.listEvents(runId);
  if (page.events.length === 0) {
    throw new BehaviorError(`no run "${runId}" (graphmind runs lists what is stored).`);
  }
  return analyzeRun(sampleFromEvents(page.events, runId));
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function incidentLine(incident: WasteIncident): string {
  const chain = incident.names.join(' → ');
  const laps = incident.kind === 'cycle' ? ` ×${incident.laps} laps` : ` ×${incident.count}`;
  const seqs =
    incident.firstSeq !== undefined && incident.lastSeq !== undefined
      ? `   (events ${incident.firstSeq}–${incident.lastSeq})`
      : '';
  const error = incident.errorMessage !== undefined ? ` — "${incident.errorMessage.slice(0, 60)}"` : '';
  return `    ${incident.kind.padEnd(12)} ${chain}${laps}, ${incident.wasted} wasted call${incident.wasted === 1 ? '' : 's'}${error}${seqs}`;
}

function toolLine(tool: ToolHealth, nameWidth: number): string {
  const p50 = tool.p50Ms === undefined ? '-' : fmtMs(tool.p50Ms);
  const p95 = tool.p95Ms === undefined ? '-' : fmtMs(tool.p95Ms);
  return (
    `    ${tool.name.slice(0, nameWidth).padEnd(nameWidth)} ` +
    `${String(tool.calls).padStart(5)} ${String(tool.failures).padStart(5)} ` +
    `${String(tool.silentFailures).padStart(7)} ${p50.padStart(8)} ${p95.padStart(8)}`
  );
}

/** The report as `graphmind runs --behavior` prints it (one string per line). */
export function behaviorLines(report: BehaviorReport, viewerUrl?: string): string[] {
  const lines: string[] = [];
  const title = [report.app, report.runId === undefined ? undefined : `(${report.runId})`]
    .filter((part) => part !== undefined)
    .join(' ');
  lines.push(`Behaviour — ${title === '' ? 'run' : title}${report.status === undefined ? '' : `, ${report.status}`}`);
  lines.push('');
  lines.push(`  ${report.verdict}`);

  if (report.waste.incidents.length > 0) {
    lines.push('');
    lines.push('  Wasted work');
    for (const incident of report.waste.incidents) lines.push(incidentLine(incident));
    if (report.waste.wastedDurationMs > 0) {
      lines.push(`    together: ${fmtMs(report.waste.wastedDurationMs)} of tool time re-doing earlier work`);
    }
    if (report.waste.spanLlmSteps !== undefined) {
      lines.push(
        `    while these ran, ${report.waste.spanLlmSteps} LLM step${report.waste.spanLlmSteps === 1 ? '' : 's'} consumed ` +
          `${fmtTokens(report.waste.spanInputTokens ?? 0)} tokens in / ${fmtTokens(report.waste.spanOutputTokens ?? 0)} out`,
      );
    }
  }

  if (report.tools.length > 0) {
    const nameWidth = Math.min(28, Math.max(4, ...report.tools.map((tool) => tool.name.length)));
    lines.push('');
    lines.push('  Tools');
    lines.push(`    ${'NAME'.padEnd(nameWidth)} ${'CALLS'.padStart(5)} ${'FAIL'.padStart(5)} ${'SILENT'.padStart(7)} ${'P50'.padStart(8)} ${'P95'.padStart(8)}`);
    for (const tool of report.tools) lines.push(toolLine(tool, nameWidth));
  }

  if (report.termination.llmSteps > 0) {
    const reasons = Object.entries(report.termination.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason} ${count}`)
      .join(', ');
    const unreported = report.termination.unreported > 0 ? `, unreported ${report.termination.unreported}` : '';
    lines.push('');
    lines.push(`  LLM steps: ${report.termination.llmSteps}${reasons === '' ? '' : ` — ${reasons}`}${unreported}`);
    const points = report.context.points;
    const first = points[0];
    const last = points[points.length - 1];
    if (first !== undefined && last !== undefined && points.length >= 2) {
      const growth =
        report.context.growthFactor === undefined ? '' : ` (×${Number(report.context.growthFactor.toFixed(1))})`;
      lines.push(
        `  Context: input tokens ${fmtTokens(first.inputTokens)} → ${fmtTokens(last.inputTokens)} over ${points.length} steps${growth}`,
      );
    }
  }

  if (report.notes.length > 0) {
    lines.push('');
    for (const note of report.notes) lines.push(`  Note: ${note}`);
  }

  if (viewerUrl !== undefined && report.runId !== undefined) {
    lines.push('');
    lines.push(`Open it: ${viewerUrl}/#/run/${encodeURIComponent(report.runId)}`);
  }
  return lines;
}
