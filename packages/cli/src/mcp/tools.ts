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

function nodeSummaryJson(node: NodeModel, runId: string, baseUrl: string) {
  const durationMs = nodeDurationMs(node);
  const lastError = nodeLastError(node);
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    status: nodeStatus(node),
    executions: node.instances.length,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(lastError === undefined ? {} : { errorMessage: lastError.message }),
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
      ? { note: 'no runs recorded yet — instrument the app with @graphmind/ai-sdk and run it while `graphmind` is serving' }
      : {}),
  };
}

/** get_run({runId}) — run summary + per-logical-node list. */
export function getRun(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = readString(args, 'runId');
  const run = requireRun(ctx, runId);
  const model = buildRunModel(ctx.storage.listEvents(runId).events);
  return {
    run: runSummaryJson(run, ctx.viewerBaseUrl),
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
  const instances = node.instances.slice(omitted).map((instance) => ({
    instanceId: instance.instanceId,
    startedAt: iso(instance.startedAt),
    status: instance.status,
    ...(instance.durationMs === undefined ? {} : { durationMs: instance.durationMs }),
    input: compactPayload(instance.input, PAYLOAD_PREVIEW_CHARS),
    ...(instance.output === undefined
      ? {}
      : { output: compactPayload(instance.output, PAYLOAD_PREVIEW_CHARS) }),
    ...(instance.usage === undefined ? {} : { usage: instance.usage }),
    ...(instance.error === undefined ? {} : { error: instance.error }),
  }));

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
