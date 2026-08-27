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
import type { NodeState, RunSource, RunState } from './types.js';

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
    ghost: false,
    executions: [
      ...base.executions,
      {
        instanceId: payload.instanceId,
        input: payload.input,
        status: 'running',
        startedTs: ts,
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
  executions[target] = {
    ...exec,
    output: payload.output,
    status: payload.status,
    durationMs: payload.durationMs,
    finishedTs: ts,
    ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
    ...(loose['injected'] === true ? { injected: true } : {}),
    ...(loose['streaming'] === true ? { streaming: true } : {}),
    ...(typeof loose['chunks'] === 'number' ? { chunks: loose['chunks'] } : {}),
  };
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
      executions[idx] = { ...exec, error: payload.error };
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

function applyExecResumed(run: RunState, payload: EventPayloadMap['exec.resumed']): RunState {
  const pause = run.pauses[payload.pauseId];
  if (pause === undefined || !pause.active) return run;
  let next: RunState = {
    ...run,
    pauses: {
      ...run.pauses,
      [payload.pauseId]: { ...pause, active: false, resolvedAction: payload.action },
    },
    structureVersion: run.structureVersion + 1,
    statusVersion: run.statusVersion + 1,
  };
  const node = next.nodes[pause.nodeId];
  if (node !== undefined && node.activePauseId === payload.pauseId) {
    const { activePauseId: _drop, ...rest } = node;
    next = { ...next, nodes: setNode(next, pause.nodeId, { ...rest }) };
  }
  return next;
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
      return putRun(ensured.runs, applyNodeStarted(run, envelope.payload, envelope.ts));
    case 'node.finished':
      return putRun(ensured.runs, applyNodeFinished(run, envelope.payload, envelope.ts));
    case 'node.error':
      return putRun(ensured.runs, applyNodeError(run, envelope.payload));
    case 'exec.paused':
      return putRun(ensured.runs, applyExecPaused(run, envelope.payload, envelope.ts));
    case 'exec.resumed':
      return putRun(ensured.runs, applyExecResumed(run, envelope.payload));
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
