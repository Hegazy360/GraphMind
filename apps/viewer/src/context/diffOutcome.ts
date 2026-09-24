/**
 * The prompt-diff verdict for one pair of steps, and the plain sentence the
 * view prints when it refuses. Memoized per pair of recorded input objects,
 * so re-rendering the inspector (every event of a live run) costs a lookup.
 */
import { normalizePrompt, type NormPrompt, type RefusalCode } from './normalizePrompt.js';
import { diffPrompts, type PromptDiff } from './promptDiff.js';

export type DiffOutcome =
  | { status: 'first' }
  | { status: 'refused'; side: 'prev' | 'cur'; code: RefusalCode; text: string }
  | { status: 'diff'; diff: PromptDiff; prev: NormPrompt; cur: NormPrompt };

export function refusalText(code: RefusalCode, side: 'prev' | 'cur', detail?: string): string {
  const Side = side === 'cur' ? "This step's" : "The previous step's";
  const subject = side === 'cur' ? 'This step' : 'The previous step';
  switch (code) {
    case 'redacted':
      return `${Side} recorded prompt contains redacted values (GRAPHMIND_HIDE_INPUTS or a secret-shaped key) — hidden values can't be compared.`;
    case 'shrunk':
      if (detail === 'python') {
        return `${Side} prompt is incomplete — cut by a pre-0.6 Python SDK's preview limits, or a value the recorder could not capture (a cycle, nesting past 64 levels) — so a message-by-message comparison would be wrong.`;
      }
      if (detail === 'ruby') {
        return `${Side} prompt is incomplete — trimmed by a pre-0.6 Ruby SDK (last 12 messages, 2,000 characters each), or a value the recorder could not capture — so a message-by-message comparison would be wrong.`;
      }
      return `${Side} recorded prompt was shrunk to fit the 512 KB event limit, so messages are missing or cut — a message-by-message comparison would be wrong.`;
    case 'preview':
      if (detail === 'langgraph') {
        return `${subject} recorded only a preview of its prompt (a LangGraph adapter with maxPayloadChars set, or a pre-0.6 one), not the messages.`;
      }
      if (detail === 'mcp') {
        return `${subject}'s input is a preview cut by graphmind mcp (get_node), not the recorded prompt.`;
      }
      return `${subject} recorded a preview string instead of the messages.`;
    case 'batched':
      return `${subject} sent ${detail ?? 'several'} prompts in one batched call — there is no single prompt to compare.`;
    case 'server-state':
      return `${subject} continued a server-side conversation (previous_response_id) and sent only the new items — the full prompt is not in the recording.`;
    case 'missing':
      return `${subject} recorded no input.`;
    case 'unknown':
    default:
      return detail === 'unserializable'
        ? `${Side} recorded input could not be serialized by the SDK.`
        : `GraphMind doesn't recognise the shape of ${side === 'cur' ? "this step's" : "the previous step's"} recorded input, so it can't line up messages.`;
  }
}

function compute(prevInput: unknown, curInput: unknown): DiffOutcome {
  const cur = normalizePrompt(curInput);
  const prev = normalizePrompt(prevInput);
  // Report this step first: it is the one on screen.
  if (!cur.ok) return { status: 'refused', side: 'cur', code: cur.code, text: refusalText(cur.code, 'cur', cur.detail) };
  if (!prev.ok) return { status: 'refused', side: 'prev', code: prev.code, text: refusalText(prev.code, 'prev', prev.detail) };
  return { status: 'diff', diff: diffPrompts(prev.prompt, cur.prompt), prev: prev.prompt, cur: cur.prompt };
}

const cache = new WeakMap<object, WeakMap<object, DiffOutcome>>();

function cacheable(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/** The memoized outcome if it was already computed (never computes). */
export function peekDiffOutcome(prevInput: unknown, curInput: unknown): DiffOutcome | undefined {
  if (!cacheable(prevInput) || !cacheable(curInput)) return undefined;
  return cache.get(prevInput)?.get(curInput);
}

export function computeDiffOutcome(prevInput: unknown, curInput: unknown): DiffOutcome {
  if (!cacheable(prevInput) || !cacheable(curInput)) return compute(prevInput, curInput);
  let inner = cache.get(prevInput);
  if (inner === undefined) {
    inner = new WeakMap();
    cache.set(prevInput, inner);
  }
  const hit = inner.get(curInput);
  if (hit !== undefined) return hit;
  const outcome = compute(prevInput, curInput);
  inner.set(curInput, outcome);
  return outcome;
}
