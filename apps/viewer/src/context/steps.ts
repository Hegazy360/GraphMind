/**
 * LLM steps of a run, in the order they were called, and the facts the
 * Context & cost view derives from them: the previous step of the same agent
 * (what the prompt diff compares against), the time the provider last saw
 * the prompt (the cache-gap note), the steps of the run so far (its cost)
 * and the tool definitions recorded anywhere in the run.
 */
import { unionMs, type HeldInterval } from '../lib/duration.js';
import type { NodeExecution, NodeState, RunState } from '../store/types.js';

// ── tool definitions ──────────────────────────────────────────────────────

/**
 * The tool definition recorded for `hash` anywhere in the run (contract C1:
 * each definition travels once per run, as `toolSchemas` on the first LLM
 * step that used it). Undefined when no step of this run carries it — a
 * run attached mid-way, or a sender that does not record definitions.
 */
export function toolSchemaOf(run: RunState, hash: string): unknown {
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined || node.kind !== 'llm') continue;
    for (const exec of node.executions) {
      const input = exec.input;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) continue;
      const schemas = (input as Record<string, unknown>)['toolSchemas'];
      if (schemas === null || typeof schemas !== 'object' || Array.isArray(schemas)) continue;
      if (Object.hasOwn(schemas, hash)) return (schemas as Record<string, unknown>)[hash];
    }
  }
  return undefined;
}

export interface StepRef {
  nodeId: string;
  node: NodeState;
  index: number;
  exec: NodeExecution;
}

/** Call order: envelope seq of `node.started` when known, else its timestamp. */
function orderKey(exec: NodeExecution): [number, number] {
  return [exec.startedTs, exec.seq ?? Number.MAX_SAFE_INTEGER];
}

function before(x: NodeExecution, y: NodeExecution): boolean {
  if (x.seq !== undefined && y.seq !== undefined) return x.seq < y.seq;
  const [xt, xs] = orderKey(x);
  const [yt, ys] = orderKey(y);
  return xt < yt || (xt === yt && xs < ys);
}

/** Every LLM execution in the run, optionally only those under `parentId`. */
export function llmSteps(run: RunState, filter?: { parentId: string | undefined }): StepRef[] {
  const out: StepRef[] = [];
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined || node.kind !== 'llm') continue;
    if (filter !== undefined && node.parentId !== filter.parentId) continue;
    node.executions.forEach((exec, index) => out.push({ nodeId, node, index, exec }));
  }
  out.sort((x, y) => (before(x.exec, y.exec) ? -1 : before(y.exec, x.exec) ? 1 : 0));
  return out;
}

/** The LLM step of the same agent (same parent) called right before this one. */
export function previousLlmStep(run: RunState, nodeId: string, execIndex: number): StepRef | undefined {
  const node = run.nodes[nodeId];
  const exec = node?.executions[execIndex];
  if (node === undefined || exec === undefined) return undefined;
  let best: StepRef | undefined;
  for (const step of llmSteps(run, { parentId: node.parentId })) {
    if (step.exec === exec) continue;
    if (!before(step.exec, exec)) continue;
    if (best === undefined || before(best.exec, step.exec)) best = step;
  }
  return best;
}

/** Steps up to and including `exec`, across the whole run (for "run so far"). */
export function stepsSoFar(run: RunState, exec: NodeExecution): StepRef[] {
  return llmSteps(run).filter((step) => step.exec === exec || before(step.exec, exec));
}

// ── cache gap ─────────────────────────────────────────────────────────────

/** Anthropic's default (and OpenAI's typical) prompt-cache lifetime. */
export const CACHE_TTL_MS = 5 * 60_000;

export interface GapNote {
  kind: 'held' | 'idle';
  /** From the previous step's finish to this call going out. */
  gapMs: number;
  /** Part of the gap during which a gate held the run. */
  heldMs: number;
  text: string;
}

function fmtMinutes(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes >= 10) return `${Math.round(minutes)} min`;
  return `${Number(minutes.toFixed(1))} min`;
}

/**
 * When this step's request actually left: after any `before` hold on this
 * very execution (the adapters emit `node.started`, THEN hold the gate, then
 * call the provider). A hold still open means the call has not gone out yet
 * — measured to `now`.
 */
export function callTimeOf(run: RunState, nodeId: string, exec: NodeExecution, now: number): number {
  let at = exec.startedTs;
  for (const pauseId of Object.keys(run.pauses)) {
    const pause = run.pauses[pauseId];
    if (pause === undefined || pause.nodeId !== nodeId || pause.point !== 'before') continue;
    if (pause.ts < exec.startedTs) continue;
    const mine = pause.heldBy?.some((h) => h.nodeId === nodeId && h.instanceId === exec.instanceId) ?? false;
    if (!mine) continue;
    at = Math.max(at, pause.resolvedTs ?? now);
  }
  return at;
}

/**
 * "Held 7 min before this call — the provider's 5-minute prompt cache has
 * likely expired": more than five minutes between the previous step's end
 * and this call, blamed on the debugger when gate holds account for it
 * (without them the gap would have been inside the cache lifetime).
 */
export function cacheGapNote(
  run: RunState,
  prev: StepRef,
  cur: { nodeId: string; exec: NodeExecution },
  now: number,
): GapNote | undefined {
  const lastSeen = prev.exec.finishedTs;
  if (lastSeen === undefined) return undefined;
  const callAt = callTimeOf(run, cur.nodeId, cur.exec, now);
  const gapMs = callAt - lastSeen;
  if (!(gapMs > CACHE_TTL_MS)) return undefined;
  const intervals: HeldInterval[] = [];
  for (const pauseId of Object.keys(run.pauses)) {
    const pause = run.pauses[pauseId];
    if (pause === undefined) continue;
    const start = Math.max(pause.ts, lastSeen);
    const end = Math.min(pause.resolvedTs ?? now, callAt);
    if (end > start) intervals.push({ start, end });
  }
  const heldMs = unionMs(intervals);
  if (heldMs > 0 && gapMs - heldMs <= CACHE_TTL_MS) {
    return {
      kind: 'held',
      gapMs,
      heldMs,
      text: `Held ${fmtMinutes(heldMs)} before this call — the provider's 5-minute prompt cache has likely expired`,
    };
  }
  return {
    kind: 'idle',
    gapMs,
    heldMs,
    text: `${fmtMinutes(gapMs)} since the previous call — the prompt cache has likely expired`,
  };
}
