/**
 * Groups model steps into invocations (one `streamText`/`generateText` call
 * = one invocation; each model call inside it = one step).
 *
 * Grouping is scoped by the ALS run context when inside `gm.run` (concurrent
 * runs can never cross-talk). Within a scope, the prompt-prefix heuristic
 * chains steps: `ai` grows the provider prompt monotonically across steps of
 * one call, so a step whose prompt has the same first message and MORE
 * messages than the scope's previous step continues that invocation;
 * anything else starts a new one.
 *
 * Documented limits (keep-it-simple by design):
 *  - Outside `gm.run`, all steps share one scope: two CONCURRENT calls with
 *    the same first message can be merged into one invocation.
 *  - Two back-to-back single-step calls with identical prompts are counted
 *    as separate invocations (prompt length does not grow), which is the
 *    desired behavior.
 */

import { nextId } from './ids.js';

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
  lastPromptLen: number;
}

const MAX_SCOPES = 256;

function firstMessageKey(prompt: unknown): string {
  try {
    const first = Array.isArray(prompt) ? prompt[0] : prompt;
    return JSON.stringify(first)?.slice(0, 200) ?? 'undefined';
  } catch {
    return 'unserializable';
  }
}

export class InvocationTracker {
  private readonly byScope = new Map<string, ScopeState>();

  next(scopeId: string, prompt: unknown): StepRef {
    const firstKey = firstMessageKey(prompt);
    const promptLen = Array.isArray(prompt) ? prompt.length : 1;
    const state = this.byScope.get(scopeId);

    if (state !== undefined && state.firstKey === firstKey && promptLen > state.lastPromptLen) {
      state.stepCount += 1;
      state.lastPromptLen = promptLen;
      return { invocationId: state.invocationId, stepIndex: state.stepCount - 1, isFirstStep: false };
    }

    const invocationId = nextId('inv');
    this.byScope.set(scopeId, { invocationId, stepCount: 1, firstKey, lastPromptLen: promptLen });
    if (this.byScope.size > MAX_SCOPES) {
      // Drop the oldest scope (Map preserves insertion order).
      const oldest = this.byScope.keys().next().value;
      if (oldest !== undefined) this.byScope.delete(oldest);
    }
    return { invocationId, stepIndex: 0, isFirstStep: true };
  }
}
