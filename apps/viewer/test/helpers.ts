import { createEnvelope, type EventEnvelope, type EventType, type MessagePayloadMap } from '@graphmind-ai/schema';

export const RUN = 'run-test-1';

let autoSeq = 1;
let autoTs = 1000;

export function resetCounters(): void {
  autoSeq = 1;
  autoTs = 1000;
}

export function ev<T extends EventType>(
  type: T,
  payload: MessagePayloadMap[T],
  opts: { seq?: number; ts?: number; runId?: string } = {},
): EventEnvelope {
  return createEnvelope({
    type,
    payload,
    seq: opts.seq ?? autoSeq++,
    runId: opts.runId ?? RUN,
    ts: opts.ts ?? autoTs++,
  }) as EventEnvelope;
}

export function started(
  nodeId: string,
  kind: 'agent' | 'llm' | 'tool' | 'custom',
  extra: {
    parentId?: string;
    instanceId?: string;
    name?: string;
    input?: unknown;
    seq?: number;
    ts?: number;
    runId?: string;
  } = {},
): EventEnvelope {
  return ev(
    'node.started',
    {
      nodeId,
      kind,
      name: extra.name ?? nodeId.split(':')[1] ?? nodeId,
      instanceId: extra.instanceId ?? `${nodeId}#1`,
      input: extra.input ?? {},
      ...(extra.parentId !== undefined ? { parentId: extra.parentId } : {}),
    },
    {
      ...(extra.seq !== undefined ? { seq: extra.seq } : {}),
      ...(extra.ts !== undefined ? { ts: extra.ts } : {}),
      ...(extra.runId !== undefined ? { runId: extra.runId } : {}),
    },
  );
}
