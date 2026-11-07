/**
 * The analyzer's input model, and the fold that builds it from stored events.
 *
 * Every surface that wants a behaviour report brings its run in a different
 * shape — the CLI and MCP server hold `StoredEvent` rows from SQLite, the
 * viewer holds its reducer's `RunState` — so the metrics are written once,
 * against this minimal `RunSample`, and each surface produces one:
 *
 *   - `sampleFromEvents(events)` here, for anything that has the envelopes;
 *   - the viewer's `sampleFromRunState` (apps/viewer src/lib/behavior.ts),
 *     a direct mapping of state it already derived from the same envelopes.
 *
 * The fold mirrors the CLI's run-model (packages/cli/src/mcp/run-model.ts):
 * `nodeId` is the stable logical node, `instanceId` the execution, and a
 * completion without an `instanceId` attaches to the most recent still-open
 * instance of its node. Payloads are read defensively, never trusted:
 * everything in them is data the user's agent produced.
 *
 * Platform-neutral on purpose (the viewer bundles this package): no Node
 * APIs, no I/O, nothing thrown.
 */
import { EventPayloadSchemas, type NodeKind, type RunStatus } from '@graphmind-ai/schema';

/** One execution of one logical node, in the order it started. */
export interface ExecutionSample {
  nodeId: string;
  kind: NodeKind;
  name: string;
  parentId?: string;
  instanceId?: string;
  /** Envelope seq of its `node.started`, when the source knows it. */
  seq?: number;
  /** Epoch ms of its `node.started`, when the source knows it. */
  startedTs?: number;
  /** `running` until a completion arrives (a crashed run never completes). */
  status: 'running' | RunStatus;
  input?: unknown;
  output?: unknown;
  /** A stored `TokenUsage`, read later with `readUsage` — never trusted raw. */
  usage?: unknown;
  /** Wall-clock duration INCLUDING debugger hold time; see `heldMs`. */
  durationMs?: number;
  /** The debugger's share of `durationMs` (0.5+ senders). */
  heldMs?: number;
  /** `node.error`'s message, when one was recorded for this execution. */
  errorMessage?: string;
}

export interface RunSample {
  runId?: string;
  app?: string;
  status?: 'running' | RunStatus;
  /** Executions in start order. */
  executions: ExecutionSample[];
}

/** The slice of a stored envelope the fold needs (`StoredEvent` satisfies it). */
export interface SampleEvent {
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

/** Most recent still-running execution of `list`, or undefined. */
function openExecution(list: ExecutionSample[]): ExecutionSample | undefined {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const execution = list[i];
    if (execution !== undefined && execution.status === 'running') return execution;
  }
  return undefined;
}

/** The execution a completion names, else the most recent open one, else the last. */
function attachable(list: ExecutionSample[], instanceId: string | undefined): ExecutionSample | undefined {
  if (instanceId !== undefined) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const execution = list[i];
      if (execution !== undefined && execution.instanceId === instanceId) return execution;
    }
  }
  return openExecution(list) ?? list[list.length - 1];
}

/**
 * Fold a run's events into a `RunSample`. Events must be in ascending `seq`
 * order (as `Storage.listEvents` returns them). Unknown event types and
 * payloads that do not parse are skipped — an analysis never fails on a
 * stream a newer or older sender wrote, it just sees less.
 */
export function sampleFromEvents(events: Iterable<SampleEvent>, runId?: string): RunSample {
  const sample: RunSample = { executions: [] };
  if (runId !== undefined) sample.runId = runId;
  /** Executions per nodeId, for completion attachment. */
  const byNode = new Map<string, ExecutionSample[]>();

  for (const event of events) {
    switch (event.type) {
      case 'run.started': {
        const parsed = EventPayloadSchemas['run.started'].safeParse(event.payload);
        if (parsed.success) sample.app = parsed.data.app;
        if (sample.status === undefined) sample.status = 'running';
        break;
      }
      case 'run.finished': {
        const parsed = EventPayloadSchemas['run.finished'].safeParse(event.payload);
        if (parsed.success) sample.status = parsed.data.status;
        break;
      }
      case 'node.started': {
        const parsed = EventPayloadSchemas['node.started'].safeParse(event.payload);
        if (!parsed.success) break;
        const payload = parsed.data;
        const execution: ExecutionSample = {
          nodeId: payload.nodeId,
          kind: payload.kind,
          name: payload.name,
          instanceId: payload.instanceId,
          seq: event.seq,
          startedTs: event.ts,
          status: 'running',
        };
        if (payload.parentId !== undefined) execution.parentId = payload.parentId;
        if (payload.input !== undefined) execution.input = payload.input;
        sample.executions.push(execution);
        const list = byNode.get(payload.nodeId);
        if (list === undefined) byNode.set(payload.nodeId, [execution]);
        else list.push(execution);
        break;
      }
      case 'node.finished': {
        const parsed = EventPayloadSchemas['node.finished'].safeParse(event.payload);
        if (!parsed.success) break;
        const payload = parsed.data;
        const execution = attachable(byNode.get(payload.nodeId) ?? [], payload.instanceId);
        if (execution === undefined) break;
        execution.status = payload.status;
        if (payload.output !== undefined) execution.output = payload.output;
        if (payload.usage !== undefined) execution.usage = payload.usage;
        execution.durationMs = payload.durationMs;
        if (payload.heldMs !== undefined) execution.heldMs = payload.heldMs;
        break;
      }
      case 'node.error': {
        const parsed = EventPayloadSchemas['node.error'].safeParse(event.payload);
        if (!parsed.success) break;
        const payload = parsed.data;
        const execution = attachable(byNode.get(payload.nodeId) ?? [], payload.instanceId);
        if (execution !== undefined) execution.errorMessage = payload.error.message;
        break;
      }
      default:
        break;
    }
  }

  return sample;
}
