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
  /**
   * Wall-clock duration as the adapter measured it — INCLUDING time the
   * debugger held the node at a gate. Never show this raw: see lib/duration.
   */
  durationMs?: number;
  /** The debugger's share of `durationMs`, as emitted by the SDK (0.5+). */
  heldMs?: number;
  /** Held time derived from exec.paused/exec.resumed timestamps (older streams). */
  derivedHeldMs?: number;
  startedTs: number;
  finishedTs?: number;
  /** The debugger substituted this result (`exec.resume` action `inject`). */
  injected?: boolean;
  /** Streaming tool execute (AsyncIterable) — observed, not gated mid-stream. */
  streaming?: boolean;
  chunks?: number;
  /**
   * Envelope seq of this execution's `node.started`. Lets a loop hold
   * (`Pause.loop.firstSeq..lastSeq`) name exactly which executions were the
   * identical calls.
   */
  seq?: number;
  /**
   * The debugger ran this call with edited arguments (`exec.resumed.edited`,
   * 0.6.0). `after` is the input it actually ran with — redacted like the
   * node's own input; `input` above stays what the model asked for.
   */
  edited?: EditedInput;
}

/** `exec.resumed.edited`: the effective input of an edited call. */
export interface EditedInput {
  after: unknown;
}

/** Why a gate held (0.5.0+ senders; older streams omit it). */
export type PauseReason = 'breakpoint' | 'error' | 'step' | 'loop';

/** Which loop detector held (0.6.0; absent = `repeat`, the only 0.5 kind). */
export type LoopKind = 'repeat' | 'cycle' | 'error-repeat';

/** `exec.paused.loop`: the streak of calls that tripped the loop hold. */
export interface LoopInfo {
  /**
   * `repeat`: consecutive identical calls so far, the held one included.
   * `error-repeat`: consecutive failures with the same error.
   */
  repeats: number;
  /** Envelope seq of the first `node.started` in the streak. */
  firstSeq: number;
  /** Envelope seq of the held call's `node.started`. */
  lastSeq: number;
  /** Fingerprint of (nodeId, canonical input) they all share. */
  fingerprint: string;
  /** Which detector held; absent on 0.5 streams (= `repeat`). */
  kind?: LoopKind;
  /** `cycle`: calls per lap. */
  period?: number;
  /** `cycle`: identical laps seen before this hold. */
  laps?: number;
}

/** `exec.paused.smart`: a smart breakpoint raised the hold (with reason `breakpoint`). */
export interface SmartInfo {
  rule: 'error-result' | 'truncated-tool-call';
  /** Short, value-free explanation from the app. Rendered as text only. */
  detail?: string;
}

/** One `exec.refused`: an input edit the app turned down; the gate is still held. */
export interface RefusalRecord {
  /** `schema` | `shape` | `placeholder` | `truncated` | `disabled` | `unsupported` (open for newer codes). */
  code: string;
  message?: string;
  /** Echo of the `exec.resume.requestId` it answers. */
  requestId?: string;
  ts: number;
  seq: number;
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
  /** The sender asked for this node to open folded (`node.started.collapsed`, 0.5.0). */
  collapsed?: boolean;
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
  /** Envelope ts of the `exec.resumed` that released it. */
  resolvedTs?: number;
  /**
   * Who released it, as the debugger stamped it on `exec.resumed.principal`
   * (0.6): `viewer`, `agent` (a coding agent via `graphmind resume`) or
   * `anonymous` (a tokenless viewer socket). Absent: the app released it on
   * its own (timeout, detach), or an older server.
   */
  resolvedBy?: string;
  /** The resumer's display-only label (`exec.resumed.operator`), already sanitized by the server. */
  resolvedOperator?: string;
  /** The call ran with an edited input (`exec.resumed.edited`). */
  resolvedEdited?: boolean;
  /**
   * The executions this hold sat inside: the held node's instance, every
   * open ancestor's, and the run's root node — the same attribution the SDK
   * ledgers use for `heldMs`. Drives derived held time and the timeline hatch.
   */
  heldBy?: { nodeId: string; instanceId: string }[];
  /** Why the gate held. `loop` = the SDK's built-in loop breakpoint. */
  reason?: PauseReason;
  /** Present when `reason` is `loop`. */
  loop?: LoopInfo;
  /** Present when a smart breakpoint raised the hold (0.6.0). */
  smart?: SmartInfo;
  /** The app can run this call with edited arguments (`exec.paused.editable`, 0.6.0). */
  editable?: boolean;
  /** Edits the app refused while this gate stayed held, oldest first (bounded). */
  refusals?: RefusalRecord[];
  /** The gate was released with edited arguments (`exec.resumed.edited`). */
  edited?: EditedInput;
  /** `exec.resumed.requestId`: which resume request released it. */
  resolvedRequestId?: string;
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

/**
 * How the audit line names who released a pause (`Pause.resolvedBy`):
 * "resumed by agent" is the line a human watching a coding agent needs.
 */
export function resumerLabel(principal: string): string {
  if (principal === 'agent') return 'agent';
  if (principal === 'viewer') return 'viewer';
  if (principal === 'anonymous') return 'tokenless viewer';
  return 'unknown';
}
