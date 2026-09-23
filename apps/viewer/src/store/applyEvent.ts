/**
 * The one reducer. Every envelope — live, replayed, imported — flows through
 * here. It is pure over the `runs` map (returns the same reference when an
 * envelope changes nothing) with one deliberate exception: `seqSeen` sets are
 * mutated in place (write-only dedup bookkeeping, never rendered).
 *
 * `node.token` envelopes are ACCEPTED here only for bookkeeping symmetry —
 * their deltas are routed to the token buffer registry by `ingest()` before
 * the store is touched, so the reducer treats them as a no-op. This keeps the
 * React Flow state referentially stable on the streaming hot path.
 */
import type { EventEnvelope, EventPayloadMap, GraphNodeHint } from '@graphmind-ai/schema';
import { derivedHeldMs } from '../lib/duration.js';
import type {
  LoopInfo,
  NodeExecution,
  NodeState,
  Pause,
  PauseReason,
  RunSource,
  RunState,
} from './types.js';

export type RunsMap = Record<string, RunState>;

function ensureRun(runs: RunsMap, runId: string, source: RunSource): { runs: RunsMap; run: RunState } {
  const existing = runs[runId];
  if (existing !== undefined) return { runs, run: existing };
  const run: RunState = {
    runId,
    meta: { runId, app: runId, status: 'pending', source },
    nodes: {},
    order: [],
    pauses: {},
    seqSeen: new Set<number>(),
    structureVersion: 0,
    statusVersion: 0,
  };
  return { runs: { ...runs, [runId]: run }, run };
}


/**
 * Set one node without copying the whole record.
 *
 * `{ ...run.nodes, [id]: node }` is O(number of nodes) on EVERY lifecycle
 * event, which makes a run with many nodes quadratic — CI measured per-event
 * cost rising 2.4x across one run. It is also unnecessary: nothing compares
 * `nodes` by reference. Consumers either re-read through the store at call
 * time, subscribe to a single node (`s.runs[id].nodes[nodeId]`, which still
 * sees a fresh object because callers pass one), or memoize on the
 * `structureVersion` / `statusVersion` counters. The record therefore belongs
 * to the run and is mutated in place; the RunState wrapper is still replaced,
 * so the store's own change detection is unaffected.
 */
function setNode(run: RunState, nodeId: string, node: NodeState): Record<string, NodeState> {
  run.nodes[nodeId] = node;
  return run.nodes;
}

function putRun(runs: RunsMap, run: RunState): RunsMap {
  return { ...runs, [run.runId]: run };
}

/** Latest execution still marked running, else undefined. */
function latestRunningIndex(node: NodeState): number {
  for (let i = node.executions.length - 1; i >= 0; i--) {
    const exec = node.executions[i];
    if (exec !== undefined && exec.status === 'running') return i;
  }
  return -1;
}

/** Read the adapter's loose-schema `ungated`/`providerExecuted` markers. */
function isUngated(payload: Record<string, unknown>): boolean {
  return payload['ungated'] === true || payload['providerExecuted'] === true;
}

/** The loose `heldMs` field, when it is a usable number. */
function heldMsField(payload: Record<string, unknown>): number | undefined {
  const held = payload['heldMs'];
  return typeof held === 'number' && Number.isFinite(held) && held >= 0 ? held : undefined;
}

/** Oldest execution still marked running, else -1. */
function oldestRunningIndex(node: NodeState): number {
  for (let i = 0; i < node.executions.length; i++) {
    const exec = node.executions[i];
    if (exec !== undefined && exec.status === 'running') return i;
  }
  return -1;
}

/** `exec.paused.reason`, when it is one of the documented values. */
function pauseReasonField(payload: Record<string, unknown>): PauseReason | undefined {
  const reason = payload['reason'];
  return reason === 'breakpoint' || reason === 'error' || reason === 'step' || reason === 'loop'
    ? reason
    : undefined;
}

/** `exec.paused.loop`, only when every field is usable (a malformed one is ignored, not rendered). */
function loopField(payload: Record<string, unknown>): LoopInfo | undefined {
  const raw = payload['loop'];
  if (raw === null || typeof raw !== 'object') return undefined;
  const loop = raw as Record<string, unknown>;
  const int = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  const repeats = int(loop['repeats']);
  const firstSeq = int(loop['firstSeq']);
  const lastSeq = int(loop['lastSeq']);
  const fingerprint = typeof loop['fingerprint'] === 'string' ? loop['fingerprint'] : undefined;
  if (repeats === undefined || firstSeq === undefined || lastSeq === undefined || fingerprint === undefined) {
    return undefined;
  }
  if (lastSeq < firstSeq) return undefined;
  return { repeats, firstSeq, lastSeq, fingerprint };
}

const MAX_ANCESTOR_HOPS = 64;

/**
 * Which executions a gate hold sits inside — mirrors the SDK ledgers so a
 * derived `heldMs` agrees with an emitted one: the held node's instance
 * (`after` gates: the oldest running one; otherwise the newest), the newest
 * running instance of each ancestor up the `parentId` chain, and the run's
 * root node (the instance whose id is the runId — how every SDK emits the
 * `agent:` node), even when the held node declared no parent.
 */
function heldByFor(
  run: RunState,
  payload: EventPayloadMap['exec.paused'],
): NonNullable<Pause['heldBy']> {
  const out: { nodeId: string; instanceId: string }[] = [];
  const push = (nodeId: string, exec: NodeExecution | undefined): void => {
    if (exec === undefined) return;
    if (out.some((h) => h.nodeId === nodeId && h.instanceId === exec.instanceId)) return;
    out.push({ nodeId, instanceId: exec.instanceId });
  };
  const node = run.nodes[payload.nodeId];
  // Nothing of the held node running (LangGraph's after/error gates fire
  // AFTER node.finished): the hold is outside every instance of THIS node's
  // durationMs — but still inside the open ancestors' and the run root's,
  // which keep running while the developer looks.
  if (node !== undefined) {
    const targetIndex = payload.point === 'after' ? oldestRunningIndex(node) : latestRunningIndex(node);
    if (targetIndex >= 0) push(node.nodeId, node.executions[targetIndex]);
  }

  const seen = new Set<string>([payload.nodeId]);
  let parentId = node?.parentId;
  for (let hops = 0; parentId !== undefined && hops < MAX_ANCESTOR_HOPS; hops++) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = run.nodes[parentId];
    if (parent === undefined) break;
    const index = latestRunningIndex(parent);
    if (index >= 0) push(parent.nodeId, parent.executions[index]);
    parentId = parent.parentId;
  }

  for (const nodeId of run.order) {
    const candidate = run.nodes[nodeId];
    if (candidate === undefined) continue;
    const root = candidate.executions.find((e) => e.instanceId === run.runId && e.status === 'running');
    if (root !== undefined) {
      push(nodeId, root);
      break;
    }
  }
  return out;
}

/** Recompute the derived held time of every execution a pause was pinned to. */
function refreshDerivedHeld(run: RunState, heldBy: Pause['heldBy'], now: number): RunState {
  if (heldBy === undefined || heldBy.length === 0) return run;
  let next = run;
  for (const { nodeId, instanceId } of heldBy) {
    const node = next.nodes[nodeId];
    if (node === undefined) continue;
    const index = node.executions.findIndex((e) => e.instanceId === instanceId);
    const exec = node.executions[index];
    if (exec === undefined) continue;
    const executions = node.executions.slice();
    executions[index] = { ...exec, derivedHeldMs: derivedHeldMs(next, nodeId, exec, now) };
    next = { ...next, nodes: setNode(next, nodeId, { ...node, executions }) };
  }
  return next;
}

function upsertHintNode(run: RunState, hint: GraphNodeHint): RunState {
  const existing = run.nodes[hint.nodeId];
  const ungated = isUngated(hint as Record<string, unknown>);
  if (existing !== undefined) {
    // A hint never downgrades an executed node; it may fill a missing parent.
    if (existing.parentId === undefined && hint.parentId !== undefined) {
      const node: NodeState = {
        ...existing,
        parentId: hint.parentId,
        ...(ungated ? { ungated: true } : {}),
      };
      return {
        ...run,
        nodes: setNode(run, hint.nodeId, node),
        structureVersion: run.structureVersion + 1,
      };
    }
    return run;
  }
  const node: NodeState = {
    nodeId: hint.nodeId,
    kind: hint.kind,
    name: hint.name,
    ...(hint.parentId !== undefined ? { parentId: hint.parentId } : {}),
    ...(ungated ? { ungated: true } : {}),
    ghost: true,
    executions: [],
  };
  return {
    ...run,
    nodes: setNode(run, hint.nodeId, node),
    order: [...run.order, hint.nodeId],
    structureVersion: run.structureVersion + 1,
  };
}

function applyNodeStarted(
  run: RunState,
  payload: EventPayloadMap['node.started'],
  ts: number,
  seq: number,
): RunState {
  const existing = run.nodes[payload.nodeId];
  const structural = existing === undefined || existing.ghost || existing.parentId !== payload.parentId;
  const base: NodeState =
    existing ??
    ({
      nodeId: payload.nodeId,
      kind: payload.kind,
      name: payload.name,
      ghost: false,
      executions: [],
    } satisfies NodeState);
  const node: NodeState = {
    ...base,
    kind: payload.kind,
    name: payload.name,
    ...(payload.parentId !== undefined
      ? { parentId: payload.parentId }
      : base.parentId !== undefined
        ? { parentId: base.parentId }
        : {}),
    ...(isUngated(payload as Record<string, unknown>) ? { ungated: true } : {}),
    // Sender hint (`node.started.collapsed`, 0.5.0): open this node folded.
    // Sticky once seen — a later execution without the flag does not un-hint
    // it; the user's own unfold lives in the UI store, not here.
    ...(payload.collapsed === true || base.collapsed === true ? { collapsed: true } : {}),
    ghost: false,
    executions: [
      ...base.executions,
      {
        instanceId: payload.instanceId,
        input: payload.input,
        status: 'running',
        startedTs: ts,
        seq,
      },
    ],
  };
  return {
    ...run,
    nodes: setNode(run, payload.nodeId, node),
    order: existing === undefined ? [...run.order, payload.nodeId] : run.order,
    structureVersion: structural ? run.structureVersion + 1 : run.structureVersion,
    statusVersion: run.statusVersion + 1,
  };
}

function applyNodeFinished(
  run: RunState,
  payload: EventPayloadMap['node.finished'],
  ts: number,
): RunState {
  const node = run.nodes[payload.nodeId];
  if (node === undefined) return run; // finish for a node we never saw start — tolerate
  const loose = payload as Record<string, unknown>;
  // The adapter includes `instanceId` on node.finished — use it to target
  // the exact execution; fall back to the latest running one.
  const instanceId = typeof loose['instanceId'] === 'string' ? loose['instanceId'] : undefined;
  let target = instanceId !== undefined
    ? node.executions.findIndex((e) => e.instanceId === instanceId)
    : -1;
  if (target < 0) target = latestRunningIndex(node);
  if (target < 0) target = node.executions.length - 1;
  const exec = node.executions[target];
  if (exec === undefined) return run;
  const executions = node.executions.slice();
  const heldMs = heldMsField(loose);
  const finished: NodeExecution = {
    ...exec,
    output: payload.output,
    status: payload.status,
    durationMs: payload.durationMs,
    finishedTs: ts,
    ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
    ...(loose['injected'] === true ? { injected: true } : {}),
    ...(loose['streaming'] === true ? { streaming: true } : {}),
    ...(typeof loose['chunks'] === 'number' ? { chunks: loose['chunks'] } : {}),
    // The SDK's measurement wins; otherwise derive from the pauses that sat
    // inside this execution, now that its finish time is known.
    ...(heldMs !== undefined ? { heldMs } : {}),
  };
  finished.derivedHeldMs = derivedHeldMs(run, payload.nodeId, finished, ts);
  executions[target] = finished;
  return {
    ...run,
    nodes: setNode(run, payload.nodeId, { ...node, executions }),
    statusVersion: run.statusVersion + 1,
  };
}

function applyNodeError(run: RunState, payload: EventPayloadMap['node.error']): RunState {
  const node = run.nodes[payload.nodeId];
  if (node === undefined) return run;
  const idx = latestRunningIndex(node);
  let executions = node.executions;
  if (idx >= 0) {
    const exec = node.executions[idx];
    if (exec !== undefined) {
      executions = node.executions.slice();
      const heldMs = heldMsField(payload as Record<string, unknown>);
      executions[idx] = { ...exec, error: payload.error, ...(heldMs !== undefined ? { heldMs } : {}) };
    }
  }
  return {
    ...run,
    nodes: setNode(run, payload.nodeId, { ...node, executions, lastError: payload.error }),
    statusVersion: run.statusVersion + 1,
  };
}

function applyExecPaused(
  run: RunState,
  payload: EventPayloadMap['exec.paused'],
  ts: number,
): RunState {
  const reason = pauseReasonField(payload);
  const loop = loopField(payload);
  let next: RunState = {
    ...run,
    pauses: {
      ...run.pauses,
      [payload.pauseId]: {
        pauseId: payload.pauseId,
        nodeId: payload.nodeId,
        point: payload.point,
        ts,
        active: true,
        heldBy: heldByFor(run, payload),
        // Loop hold (W5): why the SDK's built-in breakpoint fired.
        ...(reason !== undefined ? { reason } : {}),
        ...(loop !== undefined ? { loop } : {}),
      },
    },
    // A pause changes the paused node's rendered height → structural.
    structureVersion: run.structureVersion + 1,
    statusVersion: run.statusVersion + 1,
  };
  const node = next.nodes[payload.nodeId];
  if (node !== undefined) {
    next = {
      ...next,
      nodes: setNode(next, payload.nodeId, { ...node, activePauseId: payload.pauseId }),
    };
  }
  return next;
}

function applyExecResumed(
  run: RunState,
  payload: EventPayloadMap['exec.resumed'],
  ts: number,
): RunState {
  const pause = run.pauses[payload.pauseId];
  if (pause === undefined || !pause.active) return run;
  // Audit (0.6): who released it — stamped by the server, never by the app.
  const record = payload as Record<string, unknown>;
  const by = typeof record['principal'] === 'string' ? record['principal'] : undefined;
  const operator = typeof record['operator'] === 'string' ? record['operator'].slice(0, 64) : undefined;
  const edited = typeof record['edited'] === 'object' && record['edited'] !== null;
  let next: RunState = {
    ...run,
    pauses: {
      ...run.pauses,
      [payload.pauseId]: {
        ...pause,
        active: false,
        resolvedAction: payload.action,
        resolvedTs: ts,
        ...(by === undefined ? {} : { resolvedBy: by }),
        ...(operator === undefined ? {} : { resolvedOperator: operator }),
        ...(edited ? { resolvedEdited: true } : {}),
      },
    },
    structureVersion: run.structureVersion + 1,
    statusVersion: run.statusVersion + 1,
  };
  const node = next.nodes[pause.nodeId];
  if (node !== undefined && node.activePauseId === payload.pauseId) {
    const { activePauseId: _drop, ...rest } = node;
    next = { ...next, nodes: setNode(next, pause.nodeId, { ...rest }) };
  }
  // The hold is over: every execution it sat inside now knows how long.
  return refreshDerivedHeld(next, pause.heldBy, ts);
}

/**
 * Apply one event envelope. Returns the same `runs` reference when nothing
 * changed (duplicate seq, unknown node, token no-op).
 */
export function applyEvent(runs: RunsMap, envelope: EventEnvelope, source: RunSource): RunsMap {
  const ensured = ensureRun(runs, envelope.runId, source);
  const run = ensured.run;

  // Dedup on (runId, seq) — replay-on-attach re-sends with original seq.
  if (run.seqSeen.has(envelope.seq)) return runs;
  run.seqSeen.add(envelope.seq);

  switch (envelope.type) {
    case 'run.started': {
      const payload = envelope.payload;
      return putRun(ensured.runs, {
        ...run,
        meta: {
          ...run.meta,
          app: payload.app,
          sdk: payload.sdk,
          ...(payload.meta !== undefined ? { meta: payload.meta } : {}),
          startedTs: envelope.ts,
          status: 'running',
        },
        statusVersion: run.statusVersion + 1,
      });
    }
    case 'run.finished': {
      const payload = envelope.payload;
      return putRun(ensured.runs, {
        ...run,
        meta: {
          ...run.meta,
          status: payload.status,
          finishedTs: envelope.ts,
          ...(payload.error !== undefined ? { error: payload.error } : {}),
        },
        statusVersion: run.statusVersion + 1,
      });
    }
    case 'graph.hint': {
      let next = run;
      for (const hint of envelope.payload.nodes) next = upsertHintNode(next, hint);
      return putRun(ensured.runs, next);
    }
    case 'node.started':
      return putRun(ensured.runs, applyNodeStarted(run, envelope.payload, envelope.ts, envelope.seq));
    case 'node.finished':
      return putRun(ensured.runs, applyNodeFinished(run, envelope.payload, envelope.ts));
    case 'node.error':
      return putRun(ensured.runs, applyNodeError(run, envelope.payload));
    case 'exec.paused':
      return putRun(ensured.runs, applyExecPaused(run, envelope.payload, envelope.ts));
    case 'exec.resumed':
      return putRun(ensured.runs, applyExecResumed(run, envelope.payload, envelope.ts));
    case 'node.token':
      // Deltas live in the token buffer registry (see ingest.ts); seq was
      // recorded above so a replayed batch is still deduped consistently.
      return putRun(ensured.runs, run);
    default:
      // Unknown event types on a KnownEnvelope can't happen today, but keep
      // the reducer future-proof: tolerate silently.
      return putRun(ensured.runs, run);
  }
}
