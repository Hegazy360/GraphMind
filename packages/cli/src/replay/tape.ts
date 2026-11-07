/**
 * Turning a stored run into a tape (the answer table hermetic replay reads;
 * the format and the matching rules live in `@graphmind-ai/client`'s
 * replay.ts).
 *
 * One entry per completed execution, in start order, carrying what the call
 * returned or threw plus the canonical `[nodeId, input]` key the live call
 * is checked against. Three things are deliberately NOT in a tape:
 *
 *  - executions that never finished (the run was killed mid-call): there is
 *    no answer to give, so the entry is omitted and replay reports a miss
 *    rather than inventing one;
 *  - the run's own agent/chain spans: they are not calls anything waits on,
 *    they are the shape the calls happened inside;
 *  - anything from an imported trace — `graphmind import` produces history,
 *    not a recording of gated calls, and a tape from one would claim a
 *    fidelity it does not have.
 *
 * A value that was shrunk when it was recorded (over MAX_PAYLOAD_BYTES, so
 * the database holds a preview marker) is kept but flagged `lossy`: the
 * tape says "I cannot reproduce this" instead of handing an agent a
 * truncated result that looks whole.
 */
import {
  canonicalCall,
  DEFAULT_LOOP_IGNORE_KEYS,
  TAPE_VERSION,
  type Tape,
  type TapeEntry,
} from '@graphmind-ai/client';
import { EventPayloadSchemas, isTruncatedPayload, type NodeKind } from '@graphmind-ai/schema';
import type { StoredEvent } from '../storage.js';

/** Node kinds a tape answers for. Agents and chains are spans, not calls. */
const REPLAYABLE: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'llm',
  'tool',
  'retriever',
  'resource',
  'prompt',
]);

export interface BuildTapeResult {
  tape: Tape;
  /** Executions started but never completed — omitted from the tape. */
  unfinished: number;
  /** Entries whose recorded value was shrunk and cannot be reproduced. */
  lossy: number;
}

interface Open {
  entry: TapeEntry;
  /** Index into `entries`, so a completion can fill the entry in place. */
  index: number;
}

/** Does any part of this recorded value carry the shrink marker? */
function isLossy(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  if (isTruncatedPayload(value)) return true;
  if (Array.isArray(value)) return value.some((item) => isLossy(item, depth + 1));
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (isLossy(item, depth + 1)) return true;
  }
  return false;
}

/** The canonical key of a recorded call, or undefined when it was not recorded. */
function keyOf(nodeId: string, input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    return canonicalCall(nodeId, input, new Set(DEFAULT_LOOP_IGNORE_KEYS));
  } catch {
    return undefined;
  }
}

export function buildTape(runId: string, events: readonly StoredEvent[]): BuildTapeResult {
  const entries: TapeEntry[] = [];
  /** Open executions by instanceId, plus a per-node fallback for senders without one. */
  const open = new Map<string, Open>();
  const openByNode = new Map<string, Open[]>();
  const ordinals = new Map<string, number>();
  let app: string | undefined;
  let lossy = 0;

  const attach = (nodeId: string, instanceId: string | undefined): Open | undefined => {
    if (instanceId !== undefined) {
      const direct = open.get(instanceId);
      if (direct !== undefined) {
        open.delete(instanceId);
        const list = openByNode.get(nodeId);
        if (list !== undefined) openByNode.set(nodeId, list.filter((item) => item !== direct));
        return direct;
      }
    }
    // No instanceId (or an unknown one): the oldest still-open call of this
    // node, which is how every other reader attributes a completion.
    const list = openByNode.get(nodeId);
    const first = list?.shift();
    if (first !== undefined && first.entry.nodeId === nodeId) {
      for (const [id, item] of open) if (item === first) open.delete(id);
      return first;
    }
    return undefined;
  };

  for (const event of events) {
    switch (event.type) {
      case 'run.started': {
        const parsed = EventPayloadSchemas['run.started'].safeParse(event.payload);
        if (parsed.success) app = parsed.data.app;
        break;
      }
      case 'node.started': {
        const parsed = EventPayloadSchemas['node.started'].safeParse(event.payload);
        if (!parsed.success) break;
        const payload = parsed.data;
        if (!REPLAYABLE.has(payload.kind)) break;
        const ordinal = ordinals.get(payload.nodeId) ?? 0;
        ordinals.set(payload.nodeId, ordinal + 1);
        const key = keyOf(payload.nodeId, payload.input);
        const entry: TapeEntry = {
          nodeId: payload.nodeId,
          kind: payload.kind,
          name: payload.name,
          ordinal,
          seq: event.seq,
          ...(key !== undefined ? { key } : {}),
          // Filled by the completion; an execution that never completes is
          // dropped at the end rather than shipped as a false 'ok'.
          status: 'aborted',
        };
        const record: Open = { entry, index: entries.length };
        entries.push(entry);
        open.set(payload.instanceId, record);
        const list = openByNode.get(payload.nodeId);
        if (list === undefined) openByNode.set(payload.nodeId, [record]);
        else list.push(record);
        break;
      }
      case 'node.finished': {
        const parsed = EventPayloadSchemas['node.finished'].safeParse(event.payload);
        if (!parsed.success) break;
        const payload = parsed.data;
        const record = attach(payload.nodeId, payload.instanceId);
        if (record === undefined) break;
        const entry = entries[record.index];
        if (entry === undefined) break;
        entry.status = payload.status;
        if (payload.output !== undefined) entry.output = payload.output;
        if (payload.usage !== undefined) entry.usage = payload.usage;
        if (isLossy(payload.output)) {
          entry.lossy = true;
          lossy += 1;
        }
        break;
      }
      case 'node.error': {
        const parsed = EventPayloadSchemas['node.error'].safeParse(event.payload);
        if (!parsed.success) break;
        const payload = parsed.data;
        // The error arrives before this execution's node.finished, so look
        // without consuming: the completion still needs its record.
        const record =
          (payload.instanceId !== undefined ? open.get(payload.instanceId) : undefined) ??
          openByNode.get(payload.nodeId)?.[0];
        const entry = record === undefined ? undefined : entries[record.index];
        if (entry === undefined) break;
        entry.error = {
          name: payload.error.name,
          message: payload.error.message,
          ...(payload.error.stack !== undefined ? { stack: payload.error.stack } : {}),
        };
        break;
      }
      default:
        break;
    }
  }

  // An execution with no completion has no answer to give.
  const finished = entries.filter((entry) => entry.status !== 'aborted' || entry.error !== undefined);
  const unfinished = entries.length - finished.length;
  // A recorded error is a failure to replay, whatever the completion said.
  for (const entry of finished) if (entry.error !== undefined) entry.status = 'error';

  return {
    tape: {
      graphmindTape: TAPE_VERSION,
      runId,
      ...(app !== undefined ? { app } : {}),
      recordedAt: new Date().toISOString(),
      entries: finished,
    },
    unfinished,
    lossy,
  };
}

/** The trajectory a tape expects: every call, in order, with its arguments. */
export interface TrajectoryStep {
  nodeId: string;
  name: string;
  kind: NodeKind;
  ordinal: number;
  status: TapeEntry['status'];
  /** Canonical `[nodeId, input]`, when the step is compared on its arguments. */
  key?: string;
}

/**
 * The trajectory, as `--assert` compares it: every call AND every model
 * step, in order.
 *
 * Model steps are in the list but carry no `key`, so they are compared on
 * their position and outcome, never on their arguments. Both halves of that
 * are deliberate:
 *
 *  - IN the list, because the number of model turns is a real part of the
 *    behaviour. An agent whose step cap drops makes the same tool calls and
 *    then stops without its final answer — a trajectory of tool calls alone
 *    calls that identical, which it plainly is not.
 *  - WITHOUT a key, because a step's "arguments" are the whole conversation
 *    so far, which grows with every reply. Comparing it would flag every
 *    run as divergent for the most ordinary reason there is.
 */
export function trajectoryOf(entries: readonly TapeEntry[]): TrajectoryStep[] {
  return entries.map((entry) => ({
    nodeId: entry.nodeId,
    name: entry.name,
    kind: entry.kind,
    ordinal: entry.ordinal,
    status: entry.status,
    ...(entry.kind !== 'llm' && entry.key !== undefined ? { key: entry.key } : {}),
  }));
}
