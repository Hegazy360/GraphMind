/**
 * The four MCP tools, as pure functions over the storage boundary. Each
 * returns a JSON-serializable object; user-facing failures (unknown run,
 * bad argument) throw `ToolError`, which the server surfaces as an
 * `isError` tool result rather than a protocol error.
 *
 * Reads the SQLite DB directly — no GraphMind server required. Every
 * result carries viewer deep links (see links.ts) so coding agents can
 * cite the exact run/node.
 */
import { normalizeFinishReason, readUsage, type UsageView } from '@graphmind-ai/schema';
import type { RunSummary, Storage } from '../storage.js';
import { nodeLink, runLink } from './links.js';
import {
  buildRunModel,
  compactPayload,
  nodeDurationMs,
  nodeLastError,
  nodeStatus,
  type NodeModel,
} from './run-model.js';

export class ToolError extends Error {}

export interface ToolContext {
  storage: Storage;
  /** `http://127.0.0.1:<port>` — the viewer the deep links point at. */
  viewerBaseUrl: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** JSON-characters cap for a single input/output payload in get_node. */
const PAYLOAD_PREVIEW_CHARS = 4000;
/** Instances listed per node in get_node (most recent kept). */
const MAX_INSTANCES = 25;

export function readLimit(args: Record<string, unknown>, fallback = DEFAULT_LIMIT): number {
  const raw = args['limit'];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new ToolError(`"limit" must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return Math.min(raw, MAX_LIMIT);
}

export function readString(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  if (typeof raw !== 'string' || raw === '') {
    throw new ToolError(`"${key}" must be a non-empty string (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function runSummaryJson(run: RunSummary, baseUrl: string) {
  return {
    id: run.id,
    app: run.app,
    status: run.status,
    source: run.source,
    startedAt: iso(run.startedAt),
    finishedAt: run.finishedAt === null ? null : iso(run.finishedAt),
    eventCount: run.eventCount,
    errorCount: run.errorCount,
    link: runLink(baseUrl, run.id),
  };
}

// -- token usage (contract C1) ------------------------------------------------
//
// A 0.6 sender stamps `usage.inclusive: true` (inputTokens counts cached
// tokens too). Older events are passed on "as reported", except the 0.5
// Anthropic TS adapter's (`cacheCreationTokens`), whose uncached tail is
// recomputed into a total. Coding agents read `basis` instead of guessing.

type UsageBasisLabel = 'inclusive' | 'inclusive (recomputed)' | 'as reported' | 'mixed';

const BASIS_NOTES: Partial<Record<UsageBasisLabel, string>> = {
  'inclusive (recomputed)':
    'recorded by a 0.5 Anthropic adapter: inputTokens recomputed as uncached + cache read + cache write',
  'as reported': 'recorded before GraphMind 0.6: inputTokens is as the SDK reported it and may exclude cached tokens',
  mixed: 'some executions were recorded before GraphMind 0.6; their inputTokens may exclude cached tokens',
};

function basisLabel(view: UsageView): UsageBasisLabel {
  if (view.basis === 'inclusive') return 'inclusive';
  return view.basis === 'recomputed' ? 'inclusive (recomputed)' : 'as reported';
}

function usageJson(view: UsageView, basis: UsageBasisLabel) {
  const note = BASIS_NOTES[basis];
  return {
    inputTokens: view.inputTokens,
    outputTokens: view.outputTokens,
    ...(view.cacheReadTokens !== undefined ? { cacheReadTokens: view.cacheReadTokens } : {}),
    ...(view.cacheWriteTokens !== undefined ? { cacheWriteTokens: view.cacheWriteTokens } : {}),
    ...(view.reasoningTokens !== undefined ? { reasoningTokens: view.reasoningTokens } : {}),
    basis,
    ...(note !== undefined ? { note } : {}),
  };
}

/** One stored usage as get_node reports it; undefined when it is not a usage. */
export function instanceUsageJson(usage: unknown) {
  const view = readUsage(usage);
  return view === undefined ? undefined : usageJson(view, basisLabel(view));
}

/** Summed usage over many stored usages; undefined when none was a usage. */
export function totalUsageJson(usages: unknown[]) {
  let total: UsageView | undefined;
  let basis: UsageBasisLabel | undefined;
  for (const raw of usages) {
    const view = readUsage(raw);
    if (view === undefined) continue;
    const label: UsageBasisLabel = view.basis === 'reported' ? 'as reported' : 'inclusive';
    basis = basis === undefined || basis === label ? label : 'mixed';
    if (total === undefined) {
      total = { ...view };
      continue;
    }
    total.inputTokens += view.inputTokens;
    total.outputTokens += view.outputTokens;
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
      const value = view[key];
      if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
  }
  return total === undefined || basis === undefined ? undefined : usageJson(total, basis);
}

/**
 * The normalized finish reason of an LLM output: 0.6 senders already write it;
 * older ones wrote the provider's string (`finishReason`, or `stopReason` from
 * the 0.5 Anthropic TS adapter), normalized here the same way.
 */
export function outputFinishReason(output: unknown): string | undefined {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  const calls = record['toolCalls'];
  const hasCalls = Array.isArray(calls) && calls.length > 0;
  return normalizeFinishReason(record['finishReason'] ?? record['stopReason'], hasCalls);
}

function nodeSummaryJson(node: NodeModel, runId: string, baseUrl: string) {
  const durationMs = nodeDurationMs(node);
  const lastError = nodeLastError(node);
  const tokens = totalUsageJson(node.instances.map((instance) => instance.usage));
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    status: nodeStatus(node),
    executions: node.instances.length,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(lastError === undefined ? {} : { errorMessage: lastError.message }),
    ...(tokens === undefined ? {} : { tokens }),
    link: nodeLink(baseUrl, runId, node.nodeId),
  };
}

function requireRun(ctx: ToolContext, runId: string): RunSummary {
  const run = ctx.storage.getRun(runId);
  if (run === undefined) {
    throw new ToolError(`run "${runId}" not found — call list_runs to see what exists`);
  }
  return run;
}

/** list_runs({limit?}) — recent runs, most recently started first. */
export function listRuns(ctx: ToolContext, args: Record<string, unknown>) {
  const limit = readLimit(args);
  const all = ctx.storage.listRuns();
  return {
    total: all.length,
    runs: all.slice(0, limit).map((run) => runSummaryJson(run, ctx.viewerBaseUrl)),
    ...(all.length === 0
      ? { note: 'no runs recorded yet — instrument the app with @graphmind-ai/sdk and run it while `graphmind` is serving' }
      : {}),
  };
}

/** get_run({runId}) — run summary + per-logical-node list. */
export function getRun(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = readString(args, 'runId');
  const run = requireRun(ctx, runId);
  const model = buildRunModel(ctx.storage.listEvents(runId).events);
  const tokens = totalUsageJson(
    [...model.nodes.values()].flatMap((node) => node.instances.map((instance) => instance.usage)),
  );
  return {
    run: { ...runSummaryJson(run, ctx.viewerBaseUrl), ...(tokens === undefined ? {} : { tokens }) },
    nodes: [...model.nodes.values()].map((node) => nodeSummaryJson(node, runId, ctx.viewerBaseUrl)),
  };
}

/** get_node({runId, nodeId}) — full detail for one logical node. */
export function getNode(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = readString(args, 'runId');
  const nodeId = readString(args, 'nodeId');
  const run = requireRun(ctx, runId);
  const model = buildRunModel(ctx.storage.listEvents(runId).events);
  const node = model.nodes.get(nodeId);
  if (node === undefined) {
    const known = [...model.nodes.keys()];
    throw new ToolError(
      `node "${nodeId}" not found in run "${runId}" — known nodeIds: ${
        known.length === 0 ? '(none)' : known.join(', ')
      }`,
    );
  }

  const omitted = Math.max(0, node.instances.length - MAX_INSTANCES);
  const instances = node.instances.slice(omitted).map((instance) => {
    const usage = instanceUsageJson(instance.usage);
    const finishReason = node.kind === 'llm' ? outputFinishReason(instance.output) : undefined;
    return {
      instanceId: instance.instanceId,
      startedAt: iso(instance.startedAt),
      status: instance.status,
      ...(instance.durationMs === undefined ? {} : { durationMs: instance.durationMs }),
      input: compactPayload(instance.input, PAYLOAD_PREVIEW_CHARS),
      ...(instance.output === undefined
        ? {}
        : { output: compactPayload(instance.output, PAYLOAD_PREVIEW_CHARS) }),
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined ? {} : { usage }),
      ...(instance.error === undefined ? {} : { error: instance.error }),
    };
  });

  const durationMs = nodeDurationMs(node);
  const lastError = nodeLastError(node);
  return {
    runId,
    runStatus: run.status,
    app: run.app,
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    status: nodeStatus(node),
    executions: node.instances.length,
    ...(durationMs === undefined ? {} : { totalDurationMs: durationMs }),
    ...(lastError === undefined ? {} : { error: lastError }),
    instances,
    ...(omitted === 0 ? {} : { instancesOmitted: omitted }),
    link: nodeLink(ctx.viewerBaseUrl, runId, node.nodeId),
  };
}

/** find_errors({limit?}) — recent failed nodes across runs (newest runs first). */
export function findErrors(ctx: ToolContext, args: Record<string, unknown>) {
  const limit = readLimit(args);
  const errors: object[] = [];
  let scannedRuns = 0;

  for (const run of ctx.storage.listRuns()) {
    if (errors.length >= limit) break;
    scannedRuns += 1;
    if (run.errorCount === 0) continue;
    const model = buildRunModel(ctx.storage.listEvents(run.id).events);
    // Newest error first within the run.
    for (let i = model.errors.length - 1; i >= 0 && errors.length < limit; i -= 1) {
      const entry = model.errors[i];
      if (entry === undefined) continue;
      const node = model.nodes.get(entry.nodeId);
      errors.push({
        runId: run.id,
        app: run.app,
        runStatus: run.status,
        nodeId: entry.nodeId,
        ...(node === undefined ? {} : { nodeKind: node.kind, nodeName: node.name }),
        message: entry.error.message,
        errorName: entry.error.name,
        at: iso(entry.at),
        link: nodeLink(ctx.viewerBaseUrl, run.id, entry.nodeId),
      });
    }
  }

  return {
    errors,
    scannedRuns,
    ...(errors.length === 0 ? { note: 'no failed nodes recorded in any run' } : {}),
  };
}
