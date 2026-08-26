/**
 * Groups model requests into invocations (one agent turn-loop = one
 * invocation; each request inside it = one step), so the viewer can show
 * "step 3 of the handle-ticket loop" instead of a flat list of HTTP calls.
 *
 * Grouping is scoped by the ALS run context when inside `gm.run` (concurrent
 * runs can never cross-talk). Within a scope, two chaining heuristics run, in
 * order:
 *
 *  1. **`previous_response_id` chaining** (Responses API): a request whose
 *     `previous_response_id` is the id of the response the scope's previous
 *     step produced continues that invocation. This is exact, not a guess.
 *  2. **Prompt-prefix growth** (Chat Completions, and Responses used with a
 *     full input array): an agent loop grows its message array monotonically,
 *     so a request whose first message is unchanged and whose message count
 *     has GROWN continues the previous invocation.
 *
 * Anything else starts a new invocation.
 *
 * Documented limits (keep-it-simple by design):
 *  - Outside `gm.run`, all requests share one scope: two CONCURRENT loops with
 *    the same first message can be merged into one invocation. Wrap concurrent
 *    work in `gm.run` to keep them apart.
 *  - Two back-to-back single-step calls with identical prompts count as
 *    separate invocations (the prompt did not grow), which is what you want.
 */

import { nextId } from './ids.js';

export interface PromptKey {
  /** Stable digest of the first message / input item. */
  firstKey: string;
  /** Number of messages / input items in this request. */
  length: number;
  /** Responses API only: the id this request continues from. */
  previousResponseId?: string | undefined;
}

export interface StepRef {
  invocationId: string;
  /** 0-based step index within the invocation. */
  stepIndex: number;
  isFirstStep: boolean;
}

interface ScopeState {
  invocationId: string;
  stepCount: number;
  firstKey: string;
  lastLength: number;
  /** Last `response.id` produced in this scope (Responses API chaining). */
  lastResponseId: string | undefined;
}

const MAX_SCOPES = 256;

/** Stable-ish digest of the first message of a prompt. */
export function firstMessageKey(prompt: unknown): string {
  try {
    const first = Array.isArray(prompt) ? prompt[0] : prompt;
    return JSON.stringify(first)?.slice(0, 200) ?? 'undefined';
  } catch {
    return 'unserializable';
  }
}

export function promptKey(prompt: unknown, previousResponseId?: unknown): PromptKey {
  return {
    firstKey: firstMessageKey(prompt),
    length: Array.isArray(prompt) ? prompt.length : 1,
    previousResponseId: typeof previousResponseId === 'string' ? previousResponseId : undefined,
  };
}

export class InvocationTracker {
  private readonly byScope = new Map<string, ScopeState>();

  next(scopeId: string, key: PromptKey): StepRef {
    const state = this.byScope.get(scopeId);

    if (state !== undefined && this.continues(state, key)) {
      state.stepCount += 1;
      state.firstKey = key.firstKey;
      state.lastLength = key.length;
      return {
        invocationId: state.invocationId,
        stepIndex: state.stepCount - 1,
        isFirstStep: false,
      };
    }

    const invocationId = nextId('inv');
    this.byScope.set(scopeId, {
      invocationId,
      stepCount: 1,
      firstKey: key.firstKey,
      lastLength: key.length,
      lastResponseId: undefined,
    });
    if (this.byScope.size > MAX_SCOPES) {
      // Drop the oldest scope (Map preserves insertion order).
      const oldest = this.byScope.keys().next().value;
      if (oldest !== undefined) this.byScope.delete(oldest);
    }
    return { invocationId, stepIndex: 0, isFirstStep: true };
  }

  /** Record the response id a step produced, for `previous_response_id` chaining. */
  noteResponseId(scopeId: string, responseId: unknown): void {
    if (typeof responseId !== 'string' || responseId.length === 0) return;
    const state = this.byScope.get(scopeId);
    if (state !== undefined) state.lastResponseId = responseId;
  }

  private continues(state: ScopeState, key: PromptKey): boolean {
    if (
      key.previousResponseId !== undefined &&
      state.lastResponseId !== undefined &&
      key.previousResponseId === state.lastResponseId
    ) {
      return true;
    }
    return state.firstKey === key.firstKey && key.length > state.lastLength;
  }
}
