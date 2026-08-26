/**
 * ImportedNode[] -> synthetic, schema-valid envelope sequence:
 *
 *   run.started -> node.started / (node.error) / node.finished interleaved
 *   by span timestamps -> run.finished
 *
 * Mirroring the live adapter, an errored span emits `node.error` immediately
 * followed by `node.finished` with status "error" (both at the span's end
 * time). Ordering at equal timestamps: starts before finishes, outer spans
 * start first, inner spans finish first. `seq` is assigned 0..n-1 in final
 * order; envelope `ts` is the span timestamp, so the viewer replays the
 * trace on its original timeline.
 */
import {
  createEnvelope,
  type ErrorInfo,
  type EventEnvelope,
  type NodeKind,
  type RunStatus,
  type SdkInfo,
} from '@graphmind/schema';
import type { ImportedNode, RawSpan } from './types.js';

export interface ConvertOptions {
  runId: string;
  /** App name for run.started (e.g. OTLP `service.name`); best-effort. */
  app: string;
  sdk: SdkInfo;
  /** Import provenance recorded in run.started meta. */
  format: string;
  file: string;
}

export interface ImportSummary {
  runId: string;
  app: string;
  format: string;
  status: RunStatus;
  /** Node executions (spans) per kind, e.g. `{ agent: 1, llm: 2, tool: 1 }`. */
  nodeCounts: Partial<Record<NodeKind, number>>;
  nodeCount: number;
  errorCount: number;
  eventCount: number;
  skippedCount: number;
  /** Distinct descriptions of skipped spans (for the CLI summary). */
  skippedReasons: string[];
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

export interface ConvertResult {
  envelopes: EventEnvelope[];
  summary: ImportSummary;
}

interface Moment {
  ts: number;
  /** 0 = start, 1 = finish — at equal ts, starts come first. */
  phase: 0 | 1;
  /** Outer spans start first; inner spans finish first. */
  depthKey: number;
  index: number;
  node: ImportedNode;
}

/** Depth in the raw span tree (skipped ancestors count; cycles guard). */
function spanDepth(span: RawSpan, spanById: Map<string, RawSpan>): number {
  let depth = 0;
  const seen = new Set<string>([span.spanId]);
  let parent = span.parentSpanId;
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    parent = spanById.get(parent)?.parentSpanId;
  }
  return depth;
}

/** Logical nodeId of the nearest ancestor span that mapped to a node. */
function mappedParentId(
  span: RawSpan,
  spanById: Map<string, RawSpan>,
  nodeBySpanId: Map<string, ImportedNode>,
): string | undefined {
  const seen = new Set<string>([span.spanId]);
  let parent = span.parentSpanId;
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent);
    const node = nodeBySpanId.get(parent);
    if (node !== undefined) return node.nodeId;
    parent = spanById.get(parent)?.parentSpanId;
  }
  return undefined;
}

export function buildEnvelopes(
  nodes: ImportedNode[],
  allSpans: RawSpan[],
  skippedReasons: string[],
  options: ConvertOptions,
): ConvertResult {
  const spanById = new Map<string, RawSpan>();
  for (const span of allSpans) {
    if (!spanById.has(span.spanId)) spanById.set(span.spanId, span);
  }
  const nodeBySpanId = new Map<string, ImportedNode>();
  for (const node of nodes) {
    if (!nodeBySpanId.has(node.span.spanId)) nodeBySpanId.set(node.span.spanId, node);
  }
  // Duplicate span ids: only the first mapping is emitted.
  const uniqueNodes = [...nodeBySpanId.values()];

  const depths = new Map<string, number>();
  for (const node of uniqueNodes) {
    depths.set(node.span.spanId, spanDepth(node.span, spanById));
  }

  const ordered = [...uniqueNodes].sort(
    (a, b) =>
      a.span.startMs - b.span.startMs ||
      (depths.get(a.span.spanId) ?? 0) - (depths.get(b.span.spanId) ?? 0) ||
      a.span.endMs - b.span.endMs,
  );

  const moments: Moment[] = [];
  ordered.forEach((node, index) => {
    const depth = depths.get(node.span.spanId) ?? 0;
    moments.push({ ts: node.span.startMs, phase: 0, depthKey: depth, index, node });
    moments.push({ ts: node.span.endMs, phase: 1, depthKey: -depth, index, node });
  });
  moments.sort(
    (a, b) => a.ts - b.ts || a.phase - b.phase || a.depthKey - b.depthKey || a.index - b.index,
  );

  const startedAt = Math.min(...ordered.map((n) => n.span.startMs));
  const finishedAt = Math.max(...ordered.map((n) => n.span.endMs));

  // Run status: a single root span decides; otherwise any error errors the run.
  const roots = ordered.filter(
    (node) => mappedParentId(node.span, spanById, nodeBySpanId) === undefined,
  );
  const errored = ordered.filter((node) => node.span.error !== undefined);
  const runError: ErrorInfo | undefined =
    roots.length === 1 ? roots[0]?.span.error : errored[0]?.span.error;
  const status: RunStatus = runError !== undefined ? 'error' : 'ok';

  const envelopes: EventEnvelope[] = [];
  let seq = 0;
  const push = (envelope: EventEnvelope): void => {
    envelopes.push(envelope);
    seq += 1;
  };

  push(
    createEnvelope({
      type: 'run.started',
      runId: options.runId,
      seq,
      ts: startedAt,
      payload: {
        app: options.app,
        sdk: options.sdk,
        meta: { source: 'import', format: options.format, file: options.file },
      },
    }),
  );

  for (const moment of moments) {
    const { node } = moment;
    if (moment.phase === 0) {
      const parentId = mappedParentId(node.span, spanById, nodeBySpanId);
      push(
        createEnvelope({
          type: 'node.started',
          runId: options.runId,
          seq,
          ts: moment.ts,
          payload: {
            nodeId: node.nodeId,
            ...(parentId !== undefined ? { parentId } : {}),
            kind: node.kind,
            name: node.name,
            instanceId: node.instanceId,
            input: node.input,
            ...(node.model !== undefined ? { model: node.model } : {}),
          },
        }),
      );
      continue;
    }
    if (node.span.error !== undefined) {
      push(
        createEnvelope({
          type: 'node.error',
          runId: options.runId,
          seq,
          ts: moment.ts,
          payload: { nodeId: node.nodeId, error: node.span.error },
        }),
      );
    }
    push(
      createEnvelope({
        type: 'node.finished',
        runId: options.runId,
        seq,
        ts: moment.ts,
        payload: {
          nodeId: node.nodeId,
          output: node.output,
          ...(node.usage !== undefined ? { usage: node.usage } : {}),
          durationMs: Math.max(0, node.span.endMs - node.span.startMs),
          status: node.span.error !== undefined ? 'error' : 'ok',
          instanceId: node.instanceId,
        },
      }),
    );
  }

  push(
    createEnvelope({
      type: 'run.finished',
      runId: options.runId,
      seq,
      ts: finishedAt,
      payload: { status, ...(runError !== undefined ? { error: runError } : {}) },
    }),
  );

  const nodeCounts: Partial<Record<NodeKind, number>> = {};
  for (const node of ordered) {
    nodeCounts[node.kind] = (nodeCounts[node.kind] ?? 0) + 1;
  }

  return {
    envelopes,
    summary: {
      runId: options.runId,
      app: options.app,
      format: options.format,
      status,
      nodeCounts,
      nodeCount: ordered.length,
      errorCount: errored.length,
      eventCount: envelopes.length,
      skippedCount: skippedReasons.length,
      skippedReasons: [...new Set(skippedReasons)],
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
    },
  };
}
