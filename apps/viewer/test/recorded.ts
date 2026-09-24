/**
 * The real LLM recordings (fixtures/recorded-llm-inputs.json) replayed as
 * envelopes, so store-level tests run on what the adapters actually sent.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, TokenUsage } from '@graphmind-ai/schema';
import { RUN, ev, started } from './helpers.js';

export interface RecordedStep {
  nodeId?: string;
  parentId?: string;
  instanceId: string;
  ts: number;
  finishedTs?: number;
  input: unknown;
  usage?: TokenUsage;
  output?: unknown;
  status?: string;
  startedExtra?: Record<string, unknown>;
}

export const RECORDED = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/recorded-llm-inputs.json', import.meta.url)), 'utf8'),
) as Record<string, RecordedStep[]>;

export function recordedSteps(name: string): RecordedStep[] {
  const list = RECORDED[name];
  if (list === undefined) throw new Error(`fixture ${name} missing`);
  return list;
}

/**
 * `run.started`, the agent parent, and each recorded step's `node.started` /
 * `node.finished`, re-timed to start at `t0` with `gapMs` between steps.
 */
export function recordedRun(name: string, t0: number, gapMs = 1_000): EventEnvelope[] {
  const steps = recordedSteps(name);
  const parentId = steps[0]?.parentId ?? 'agent:trip-planner';
  const events: EventEnvelope[] = [
    ev('run.started', { app: name, sdk: { name: 'fixture', version: '0.6.0' } }, { ts: t0 }),
    started(parentId, 'agent', { instanceId: RUN, ts: t0 }),
  ];
  steps.forEach((step, i) => {
    const at = t0 + 10 + i * gapMs;
    const nodeId = step.nodeId ?? 'llm:step';
    events.push(
      ev(
        'node.started',
        {
          nodeId,
          kind: 'llm',
          name: nodeId.split(':')[1] ?? nodeId,
          instanceId: step.instanceId,
          parentId,
          input: step.input,
          ...(step.startedExtra ?? {}),
        } as never,
        { ts: at },
      ),
    );
    events.push(
      ev(
        'node.finished',
        {
          nodeId,
          instanceId: step.instanceId,
          output: step.output ?? null,
          durationMs: 100,
          status: 'ok',
          ...(step.usage !== undefined ? { usage: step.usage } : {}),
        } as never,
        { ts: at + 100 },
      ),
    );
  });
  return events;
}
