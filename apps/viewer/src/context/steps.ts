/**
 * LLM steps of a run, in the order they were called, and the facts the
 * Context & cost view derives from them: the previous step of the same agent
 * (what the prompt diff compares against), the time the provider last saw
 * the prompt (the cache-gap note), the steps of the run so far (its cost)
 * and the tool definitions recorded anywhere in the run.
 */
import { unionMs, type HeldInterval } from '../lib/duration.js';
import type { NodeExecution, NodeState, RunState } from '../store/types.js';
import { contentText, normalizePrompt } from './normalizePrompt.js';

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

/**
 * The AI SDK adapter's step id is `<invocation>:s<k>`: every call it makes
 * is `llm:step` under `agent:<run>`, so a generateText run inside a tool
 * shares the agent's node and parent — only this prefix tells them apart.
 */
const AI_SDK_STEP_ID = /^(.+):s\d+$/;

function invocationOf(instanceId: string): string | undefined {
  return AI_SDK_STEP_ID.exec(instanceId)?.[1];
}

interface Lineage {
  /** Role and text of the first non-system message. */
  lead?: string;
  /** Identity keys of the non-system messages. */
  keys: Set<string>;
}

const lineageCache = new WeakMap<object, Lineage | null>();

/** What a prompt's conversation is: its first message and its messages (null when unreadable). */
function lineageOf(input: unknown): Lineage | null {
  if (input === null || typeof input !== 'object') return null;
  const cached = lineageCache.get(input);
  if (cached !== undefined) return cached;
  const normalized = normalizePrompt(input);
  let lineage: Lineage | null = null;
  if (normalized.ok) {
    const messages = normalized.prompt.messages.filter((m) => m.role !== 'system');
    const first = messages[0];
    const raw = first?.raw;
    const content = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)['content'] : raw;
    const text = contentText(content);
    lineage = {
      ...(first !== undefined && text !== '' ? { lead: `${first.role}|${text}` } : {}),
      keys: new Set(messages.map((m) => m.key)),
    };
  }
  lineageCache.set(input, lineage);
  return lineage;
}

/** Same conversation: the same first message, or at least one message in common. */
function sameConversation(a: Lineage, b: Lineage): boolean {
  if (a.lead !== undefined && a.lead === b.lead) return true;
  for (const key of a.keys) if (b.keys.has(key)) return true;
  return false;
}

/**
 * The LLM step of the same agent (same parent) called right before this one.
 * For AI SDK step ids, also of the same invocation: a step with no earlier
 * step in its own invocation is a first step.
 */
export function previousLlmStep(run: RunState, nodeId: string, execIndex: number): StepRef | undefined {
  const node = run.nodes[nodeId];
  const exec = node?.executions[execIndex];
  if (node === undefined || exec === undefined) return undefined;
  const earlier = llmSteps(run, { parentId: node.parentId }).filter(
    (step) => step.exec !== exec && before(step.exec, exec),
  );
  const latest = (steps: StepRef[]): StepRef | undefined => steps[steps.length - 1];
  const invocation = invocationOf(exec.instanceId);
  if (invocation === undefined) return latest(earlier);
  // AI SDK step ids: the previous step of the same invocation, when there is one.
  const own = earlier.filter((step) => invocationOf(step.exec.instanceId) === invocation);
  if (own.length > 0) return latest(own);
  // A new invocation is a new conversation — a generateText inside a tool —
  // or the same one the adapter split (it keys an invocation by the first
  // message's exact form). Only a step of the same conversation compares.
  const mine = lineageOf(exec.input);
  if (mine === null) return latest(earlier);
  for (let i = earlier.length - 1; i >= 0; i -= 1) {
    const step = earlier[i];
    const theirs = step === undefined ? null : lineageOf(step.exec.input);
    if (step !== undefined && theirs !== null && sameConversation(mine, theirs)) return step;
  }
  return undefined;
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

/** A `before` hold on this very execution that is still open: its call has not gone out. */
export function callHeldOpen(run: RunState, nodeId: string, exec: NodeExecution): boolean {
  for (const pauseId of Object.keys(run.pauses)) {
    const pause = run.pauses[pauseId];
    if (pause === undefined || !pause.active || pause.nodeId !== nodeId || pause.point !== 'before') continue;
    if (pause.ts < exec.startedTs) continue;
    if (pause.heldBy?.some((h) => h.nodeId === nodeId && h.instanceId === exec.instanceId) === true) return true;
  }
  return false;
}

/** How often an open hold's cache note recounts its minutes. */
export const GAP_REFRESH_MS = 30_000;

/**
 * When the cache-gap note must be worked out again, or `undefined` when it
 * cannot change on its own. While this call is held at its own `before`
 * gate its call time is `now` and no event arrives — so the note has to
 * appear the moment the gap crosses the cache lifetime, and then keep its
 * minutes current. Anything else changes only with an event.
 */
export function cacheGapRecheckAt(
  run: RunState,
  prev: StepRef | undefined,
  cur: { nodeId: string; exec: NodeExecution },
  now: number,
): number | undefined {
  const lastSeen = prev?.exec.finishedTs;
  if (lastSeen === undefined || !callHeldOpen(run, cur.nodeId, cur.exec)) return undefined;
  const crossing = lastSeen + CACHE_TTL_MS + 1;
  return now < crossing ? crossing : now + GAP_REFRESH_MS;
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
