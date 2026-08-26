/**
 * Viewer-side derived state. Everything here is a projection of the event
 * stream — one reducer (`applyEvent`) builds it from envelopes, whether they
 * arrive live over the socket, from a fixture replay, or from an import.
 */
import type {
  ErrorInfo,
  NodeKind,
  PausePoint,
  ResumeAction,
  RunStatus,
  SdkInfo,
  TokenUsage,
} from '@graphmind-ai/schema';

/** Where a run's events came from. */
export type RunSource = 'live' | 'fixture';

/** Visual lifecycle state of a logical node. */
export type NodeLifeStatus = 'ghost' | 'running' | 'paused' | 'ok' | 'error' | 'aborted';

/** One execution (instance) of a logical node. */
export interface NodeExecution {
  instanceId: string;
  input: unknown;
  output?: unknown;
  status: 'running' | RunStatus;
  error?: ErrorInfo;
  usage?: TokenUsage;
  durationMs?: number;
  startedTs: number;
  finishedTs?: number;
  /** The debugger substituted this result (`exec.resume` action `inject`). */
  injected?: boolean;
  /** Streaming tool execute (AsyncIterable) — observed, not gated mid-stream. */
  streaming?: boolean;
  chunks?: number;
}

/**
 * A logical node (decisions.md #1): one entry per stable `nodeId`; repeated
 * executions land in `executions` and light the same node up.
 */
export interface NodeState {
  nodeId: string;
  kind: NodeKind;
  name: string;
  parentId?: string;
  /** True when the node is only known from `graph.hint` (never executed). */
  ghost: boolean;
  /**
   * Provider-executed / MCP tool (decisions #4): observed via stream tee,
   * cannot be paused — breakpoints on it never fire.
   */
  ungated?: boolean;
  executions: NodeExecution[];
  /** Set while an `exec.paused` gate on this node is unresolved. */
  activePauseId?: string;
  lastError?: ErrorInfo;
}

export interface Pause {
  pauseId: string;
  nodeId: string;
  point: PausePoint;
  ts: number;
  active: boolean;
  resolvedAction?: ResumeAction;
}

export interface RunMeta {
  runId: string;
  app: string;
  sdk?: SdkInfo;
  meta?: Record<string, unknown>;
  startedTs?: number;
  finishedTs?: number;
  /** `pending` = events seen before `run.started` (out-of-order tolerance). */
  status: 'pending' | 'running' | RunStatus;
  error?: ErrorInfo;
  source: RunSource;
  /**
   * The server's registered origin for the run (`RunInfo.source`: 'live' |
   * 'import' | 'demo'), when known. Drives the run-list badge — a 'demo'
   * run shows as a recorded session.
   */
  serverSource?: string;
}

export interface RunState {
  runId: string;
  meta: RunMeta;
  nodes: Record<string, NodeState>;
  /** nodeIds in first-seen order (stable layout + step chaining). */
  order: string[];
  pauses: Record<string, Pause>;
  /**
   * Seen envelope seqs for `(runId, seq)` dedup (decisions.md #5).
   * Mutable bookkeeping — never rendered, so mutated in place.
   */
  seqSeen: Set<number>;
  /** Bumps only when the graph shape changes (node/edge/pause) → re-layout. */
  structureVersion: number;
  /** Bumps on any lifecycle change → cheap restyle (edges, lists). */
  statusVersion: number;
}

/** Derived: the visual status of a logical node. */
export function nodeStatus(node: NodeState): NodeLifeStatus {
  if (node.activePauseId !== undefined) return 'paused';
  if (node.executions.some((e) => e.status === 'running')) return 'running';
  const last = node.executions[node.executions.length - 1];
  if (last === undefined) return 'ghost';
  return last.status === 'running' ? 'running' : last.status;
}

/** Derived: latest execution of a node, if any. */
export function latestExecution(node: NodeState): NodeExecution | undefined {
  return node.executions[node.executions.length - 1];
}

/** Derived: does the run have any unresolved pause? */
export function runHasActivePause(run: RunState): boolean {
  for (const id of Object.keys(run.pauses)) {
    const pause = run.pauses[id];
    if (pause !== undefined && pause.active) return true;
  }
  return false;
}

/** Derived: overall run badge status (pauses win over `running`). */
export type RunBadgeStatus = 'pending' | 'running' | 'paused' | RunStatus;

export function runBadgeStatus(run: RunState): RunBadgeStatus {
  if (run.meta.status === 'running' && runHasActivePause(run)) return 'paused';
  return run.meta.status;
}
