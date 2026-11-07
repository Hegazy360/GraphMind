/**
 * The behaviour report: one JSON-serializable verdict over one recorded run,
 * computed the same way wherever it is asked for (`graphmind runs
 * --behavior`, the MCP `get_behavior` tool, the viewer's Behaviour section).
 *
 * Scope is deliberate: this is a per-run verdict from facts the recording
 * proves — wasted calls, returned-not-thrown failures, token-limit stops,
 * input-token growth — not fleet analytics. Dollar figures are also not
 * computed here: the price table lives with the viewer (and the HTML
 * export), and a surface that has one can price the executions an incident
 * names. Tokens and durations are the shared currency.
 */
import { normalizeFinishReason, readUsage, type FinishReason } from '@graphmind-ai/schema';
import { errorResultShape } from './errorShape.js';
import type { ExecutionSample, RunSample } from './sample.js';
import { scanWaste, type WasteIncident } from './waste.js';

export interface ToolHealth {
  nodeId: string;
  name: string;
  calls: number;
  /** Executions that ended in `error` status or recorded a `node.error`. */
  failures: number;
  /** Ok executions whose result was error-shaped (returned, not thrown). */
  silentFailures: number;
  /** `(failures + silentFailures) / calls`. */
  failureRate: number;
  /** Failures that a later call of the same tool followed with a success. */
  recovered: number;
  /** Run time (durationMs - heldMs) percentiles over completed executions. */
  p50Ms?: number;
  p95Ms?: number;
}

export interface TerminationSummary {
  llmSteps: number;
  /** Normalized finish reasons of the steps that reported one. */
  byReason: Partial<Record<FinishReason, number>>;
  /** Steps whose output carried no readable finish reason. */
  unreported: number;
}

/** One LLM step's prompt size, in step order — the context-growth curve. */
export interface ContextPoint {
  /** 0-based position among the run's LLM steps. */
  step: number;
  inputTokens: number;
}

export interface ContextPressure {
  points: ContextPoint[];
  maxInputTokens?: number;
  /** `last / first` over the curve; only present with 2+ points and first > 0. */
  growthFactor?: number;
  /** True when any counted usage predates 0.6 (may exclude cached tokens). */
  reportedBasis: boolean;
}

export interface WasteSummary {
  toolCalls: number;
  /** Union over incidents — overlapping incidents never double-count. */
  wastedCalls: number;
  /** `wastedCalls / toolCalls`; 0 when there are no tool calls. */
  share: number;
  /** Run time (durationMs - heldMs) of the wasted executions. */
  wastedDurationMs: number;
  /** Tool calls whose input was unreadable and sat out duplicate matching. */
  unreadableCalls: number;
  incidents: WasteIncident[];
  /** LLM steps that ran inside incident spans (seq-based, when seqs are known). */
  spanLlmSteps?: number;
  spanInputTokens?: number;
  spanOutputTokens?: number;
}

export interface BehaviorReport {
  runId?: string;
  app?: string;
  status?: string;
  executions: number;
  llmSteps: number;
  toolCalls: number;
  waste: WasteSummary;
  /** Worst first (failure rate, then call count). Tools with calls only. */
  tools: ToolHealth[];
  termination: TerminationSummary;
  context: ContextPressure;
  /** The one-line verdict every surface prints. Composed by `verdictOf`. */
  verdict: string;
  /** Caveats a reader needs before trusting the numbers. */
  notes: string[];
}

/**
 * The normalized finish reason of a recorded LLM output. 0.6 senders already
 * write it; older ones wrote the provider's string (`finishReason`, or
 * `stopReason` from the 0.5 Anthropic TS adapter) — normalized here with the
 * same rules (this is the same read as the MCP server's get_node).
 */
export function outputFinishReason(output: unknown): FinishReason | undefined {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  const calls = record['toolCalls'];
  const hasCalls = Array.isArray(calls) && calls.length > 0;
  return normalizeFinishReason(record['finishReason'] ?? record['stopReason'], hasCalls);
}

/** `durationMs - heldMs`, clamped at 0: the time the code actually ran. */
function ranMs(execution: ExecutionSample): number | undefined {
  if (execution.durationMs === undefined) return undefined;
  return Math.max(0, execution.durationMs - (execution.heldMs ?? 0));
}

/** Nearest-rank percentile of an UNSORTED list; undefined when empty. */
function percentile(values: number[], rank: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
  return sorted[index];
}

function failed(execution: ExecutionSample): boolean {
  return execution.status === 'error' || execution.errorMessage !== undefined;
}

function toolHealth(executions: readonly ExecutionSample[]): ToolHealth[] {
  const byNode = new Map<string, { name: string; executions: ExecutionSample[] }>();
  for (const execution of executions) {
    if (execution.kind !== 'tool') continue;
    const entry = byNode.get(execution.nodeId);
    if (entry === undefined) byNode.set(execution.nodeId, { name: execution.name, executions: [execution] });
    else entry.executions.push(execution);
  }
  const health: ToolHealth[] = [];
  for (const [nodeId, entry] of byNode) {
    let failures = 0;
    let silentFailures = 0;
    let recovered = 0;
    const durations: number[] = [];
    let pendingFailure = false;
    for (const execution of entry.executions) {
      if (failed(execution)) {
        failures += 1;
        pendingFailure = true;
      } else {
        if (execution.status === 'ok' && errorResultShape(execution.output) !== undefined) {
          silentFailures += 1;
        } else if (execution.status === 'ok' && pendingFailure) {
          recovered += 1;
          pendingFailure = false;
        }
      }
      const ran = ranMs(execution);
      if (ran !== undefined) durations.push(ran);
    }
    const calls = entry.executions.length;
    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    health.push({
      nodeId,
      name: entry.name,
      calls,
      failures,
      silentFailures,
      failureRate: calls === 0 ? 0 : (failures + silentFailures) / calls,
      recovered,
      ...(p50 !== undefined ? { p50Ms: p50 } : {}),
      ...(p95 !== undefined ? { p95Ms: p95 } : {}),
    });
  }
  health.sort((a, b) => b.failureRate - a.failureRate || b.calls - a.calls);
  return health;
}

function termination(llm: readonly ExecutionSample[]): TerminationSummary {
  const byReason: Partial<Record<FinishReason, number>> = {};
  let unreported = 0;
  for (const execution of llm) {
    if (execution.status === 'running') continue;
    const reason = outputFinishReason(execution.output);
    if (reason === undefined) unreported += 1;
    else byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return { llmSteps: llm.length, byReason, unreported };
}

function contextPressure(llm: readonly ExecutionSample[]): ContextPressure {
  const points: ContextPoint[] = [];
  let reportedBasis = false;
  let max: number | undefined;
  for (let step = 0; step < llm.length; step += 1) {
    const view = readUsage(llm[step]?.usage);
    if (view === undefined) continue;
    points.push({ step, inputTokens: view.inputTokens });
    if (view.basis === 'reported') reportedBasis = true;
    if (max === undefined || view.inputTokens > max) max = view.inputTokens;
  }
  const first = points[0]?.inputTokens;
  const last = points[points.length - 1]?.inputTokens;
  const growth = points.length >= 2 && first !== undefined && first > 0 && last !== undefined ? last / first : undefined;
  return {
    points,
    ...(max !== undefined ? { maxInputTokens: max } : {}),
    ...(growth !== undefined ? { growthFactor: growth } : {}),
    reportedBasis,
  };
}

/** Tokens the model spent while incident spans were running (seq-based). */
function spanUsage(
  llm: readonly ExecutionSample[],
  incidents: readonly WasteIncident[],
): { steps: number; inputTokens: number; outputTokens: number } | undefined {
  const spans = incidents
    .filter((incident) => incident.firstSeq !== undefined && incident.lastSeq !== undefined)
    .map((incident) => [incident.firstSeq!, incident.lastSeq!] as const);
  if (spans.length === 0) return undefined;
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const execution of llm) {
    const seq = execution.seq;
    if (seq === undefined) continue;
    if (!spans.some(([first, last]) => seq >= first && seq <= last)) continue;
    steps += 1;
    const view = readUsage(execution.usage);
    if (view !== undefined) {
      inputTokens += view.inputTokens;
      outputTokens += view.outputTokens;
    }
  }
  return steps === 0 ? undefined : { steps, inputTokens, outputTokens };
}

const PERCENT = (share: number): string => `${Math.round(share * 100)}%`;

/**
 * The one-line verdict, composed from the report's own numbers so every
 * surface says the same thing. Complete sentences, worst news first.
 */
export function verdictOf(report: Omit<BehaviorReport, 'verdict'>): string {
  if (report.toolCalls === 0 && report.llmSteps === 0) {
    return 'Nothing to analyze: the run recorded no LLM steps and no tool calls.';
  }
  const parts: string[] = [];
  const { waste, tools, termination: term } = report;
  if (waste.wastedCalls > 0) {
    const kinds = new Map<string, number>();
    for (const incident of waste.incidents) kinds.set(incident.kind, (kinds.get(incident.kind) ?? 0) + 1);
    const kindList = [...kinds.entries()].map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`).join(', ');
    parts.push(
      `${waste.wastedCalls} of ${waste.toolCalls} tool calls (${PERCENT(waste.share)}) repeated earlier work (${kindList})`,
    );
  }
  const worst = tools.find((tool) => tool.calls >= 2 && tool.failureRate >= 0.5);
  if (worst !== undefined) {
    parts.push(`${worst.name} failed ${worst.failures + worst.silentFailures} of ${worst.calls} calls`);
  }
  const silent = tools.reduce((sum, tool) => sum + tool.silentFailures, 0);
  if (silent > 0) {
    parts.push(
      `${silent} ${silent === 1 ? 'failure was returned as a result' : 'failures were returned as results'}, not thrown`,
    );
  }
  const lengthStops = term.byReason.length ?? 0;
  if (lengthStops > 0) {
    parts.push(`${lengthStops} LLM step${lengthStops === 1 ? '' : 's'} stopped at the token limit`);
  }
  const filtered = term.byReason['content-filter'] ?? 0;
  if (filtered > 0) {
    parts.push(`${filtered} step${filtered === 1 ? '' : 's'} hit a content filter`);
  }
  if (parts.length === 0) {
    return `No wasted work detected across ${report.toolCalls} tool call${report.toolCalls === 1 ? '' : 's'} and ${report.llmSteps} LLM step${report.llmSteps === 1 ? '' : 's'}.`;
  }
  return `${parts.join('; ')}.`;
}

/** Analyze one run. Pure; never throws on hostile payloads. */
export function analyzeRun(sample: RunSample): BehaviorReport {
  const executions = sample.executions;
  const llm = executions.filter((execution) => execution.kind === 'llm');
  const scan = scanWaste(executions);

  let wastedDurationMs = 0;
  for (const index of scan.wastedIndices) {
    const ran = ranMs(executions[index]!);
    if (ran !== undefined) wastedDurationMs += ran;
  }
  const span = spanUsage(llm, scan.incidents);
  const waste: WasteSummary = {
    toolCalls: scan.toolCalls,
    wastedCalls: scan.wastedIndices.size,
    share: scan.toolCalls === 0 ? 0 : scan.wastedIndices.size / scan.toolCalls,
    wastedDurationMs,
    unreadableCalls: scan.unreadableCalls,
    incidents: scan.incidents,
    ...(span !== undefined
      ? { spanLlmSteps: span.steps, spanInputTokens: span.inputTokens, spanOutputTokens: span.outputTokens }
      : {}),
  };

  const tools = toolHealth(executions);
  const term = termination(llm);
  const context = contextPressure(llm);

  const notes: string[] = [];
  if (scan.unreadableCalls > 0) {
    notes.push(
      `${scan.unreadableCalls} tool call(s) had inputs that could not be read and were excluded from duplicate detection.`,
    );
  }
  if (context.reportedBasis) {
    notes.push('Some token counts were recorded before GraphMind 0.6 and may exclude cached tokens.');
  }
  if (sample.status === 'running' || sample.status === undefined) {
    notes.push('The run has not finished (or its end was never recorded); every number is a so-far.');
  }

  const base: Omit<BehaviorReport, 'verdict'> = {
    ...(sample.runId !== undefined ? { runId: sample.runId } : {}),
    ...(sample.app !== undefined ? { app: sample.app } : {}),
    ...(sample.status !== undefined ? { status: sample.status } : {}),
    executions: executions.length,
    llmSteps: llm.length,
    toolCalls: scan.toolCalls,
    waste,
    tools,
    termination: term,
    context,
    notes,
  };
  return { ...base, verdict: verdictOf(base) };
}
