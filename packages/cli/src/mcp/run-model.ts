/**
 * Fold a run's stored events into a per-node execution model.
 *
 * Node identity follows internal/decisions.md #1: `nodeId` is stable per
 * logical node, `instanceId` per execution. `node.finished` / `node.error`
 * payloads carry only `nodeId`, so completions attach to the most recent
 * still-open instance of that node (correct for sequential and nested
 * execution; concurrent same-node instances are rare and degrade gracefully).
 */
import {
  EventPayloadSchemas,
  type ErrorInfo,
  type NodeKind,
  type RunStatus,
  type TokenUsage,
} from '@graphmind-ai/schema';
import type { StoredEvent } from '../storage.js';

export interface NodeInstanceModel {
  instanceId: string;
  /** Epoch ms of the `node.started` event. */
  startedAt: number;
  /** `running` until a `node.finished` for this instance arrives. */
  status: 'running' | RunStatus;
  input: unknown;
  output?: unknown;
  usage?: TokenUsage;
  durationMs?: number;
  error?: ErrorInfo;
}

export interface NodeModel {
  nodeId: string;
  kind: NodeKind;
  name: string;
  parentId?: string;
  /** In start order (oldest first). */
  instances: NodeInstanceModel[];
}

export interface RunErrorModel {
  nodeId: string;
  error: ErrorInfo;
  /** Epoch ms of the `node.error` event. */
  at: number;
}

export interface RunModel {
  /** Keyed by nodeId, in first-seen order. */
  nodes: Map<string, NodeModel>;
  /** All `node.error` events, oldest first. */
  errors: RunErrorModel[];
}

/** Placeholder when a completion event arrives without a matching start. */
const UNKNOWN_INSTANCE = '(unknown)';

function getNode(model: RunModel, nodeId: string): NodeModel {
  let node = model.nodes.get(nodeId);
  if (node === undefined) {
    node = { nodeId, kind: 'custom', name: nodeId, instances: [] };
    model.nodes.set(nodeId, node);
  }
  return node;
}

/** Most recent instance still `running`, else the last instance, else a synthetic one. */
function attachableInstance(node: NodeModel, ts: number): NodeInstanceModel {
  for (let i = node.instances.length - 1; i >= 0; i -= 1) {
    const instance = node.instances[i];
    if (instance !== undefined && instance.status === 'running') return instance;
  }
  const last = node.instances[node.instances.length - 1];
  if (last !== undefined) return last;
  const synthetic: NodeInstanceModel = {
    instanceId: UNKNOWN_INSTANCE,
    startedAt: ts,
    status: 'running',
    input: undefined,
  };
  node.instances.push(synthetic);
  return synthetic;
}

export function buildRunModel(events: readonly StoredEvent[]): RunModel {
  const model: RunModel = { nodes: new Map(), errors: [] };

  for (const event of events) {
    switch (event.type) {
      case 'node.started': {
        const parsed = EventPayloadSchemas['node.started'].safeParse(event.payload);
        if (!parsed.success) break;
        const payload = parsed.data;
        const node = getNode(model, payload.nodeId);
        node.kind = payload.kind;
        node.name = payload.name;
        if (payload.parentId !== undefined) node.parentId = payload.parentId;
        node.instances.push({
          instanceId: payload.instanceId,
          startedAt: event.ts,
          status: 'running',
          input: payload.input,
        });
        break;
      }
      case 'node.finished': {
        const parsed = EventPayloadSchemas['node.finished'].safeParse(event.payload);
        if (!parsed.success) break;
        const payload = parsed.data;
        const instance = attachableInstance(getNode(model, payload.nodeId), event.ts);
        instance.status = payload.status;
        instance.output = payload.output;
        instance.durationMs = payload.durationMs;
        if (payload.usage !== undefined) instance.usage = payload.usage;
        break;
      }
      case 'node.error': {
        const parsed = EventPayloadSchemas['node.error'].safeParse(event.payload);
        if (!parsed.success) break;
        const payload = parsed.data;
        const instance = attachableInstance(getNode(model, payload.nodeId), event.ts);
        instance.error = payload.error;
        model.errors.push({ nodeId: payload.nodeId, error: payload.error, at: event.ts });
        break;
      }
      default:
        break; // run.*, graph.hint, node.token, exec.* — not part of the node model
    }
  }
  return model;
}

/** Derived status of a logical node: its latest instance's status. */
export function nodeStatus(node: NodeModel): 'running' | RunStatus {
  const last = node.instances[node.instances.length - 1];
  return last === undefined ? 'running' : last.status;
}

/** Sum of finished-instance durations, or undefined when none finished. */
export function nodeDurationMs(node: NodeModel): number | undefined {
  let total: number | undefined;
  for (const instance of node.instances) {
    if (instance.durationMs !== undefined) total = (total ?? 0) + instance.durationMs;
  }
  return total;
}

/** The most recent error recorded on any instance of the node. */
export function nodeLastError(node: NodeModel): ErrorInfo | undefined {
  for (let i = node.instances.length - 1; i >= 0; i -= 1) {
    const error = node.instances[i]?.error;
    if (error !== undefined) return error;
  }
  return undefined;
}

export interface TruncatedPayload {
  truncated: true;
  note: string;
  preview: string;
}

/**
 * Cap huge payloads: values whose JSON form exceeds `maxChars` are replaced
 * by a `{ truncated, note, preview }` marker (the full payload stays in the
 * DB and in the viewer — the note says so).
 */
export function compactPayload(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= maxChars) return value;
  return {
    truncated: true,
    note: `payload truncated: showing first ${maxChars} of ${json.length} JSON characters — open the deep link in the GraphMind viewer for the full payload`,
    preview: json.slice(0, maxChars),
  } satisfies TruncatedPayload;
}
