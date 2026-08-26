/**
 * Groups model calls into invocations (one agent loop = one invocation; each
 * `messages.create` inside it = one step).
 *
 * Grouping is scoped by the ALS run context when inside `gm.run` (concurrent
 * runs can never cross-talk). Within a scope, the message-prefix heuristic
 * chains steps: a raw Anthropic loop grows `params.messages` monotonically
 * across turns, so a call whose first message is unchanged and whose message
 * list has GROWN continues that invocation; anything else starts a new one.
 *
 * Documented limits (keep-it-simple by design):
 *  - Outside `gm.run`, all calls share one scope: two CONCURRENT loops with
 *    the same first message can be merged into one invocation. Wrap
 *    concurrent work in `gm.run` to keep them apart.
 *  - Two back-to-back single-turn calls with identical messages count as
 *    separate invocations (the list does not grow), which is what you want.
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
  lastLength: number;
}

const MAX_SCOPES = 256;

function firstMessageKey(messages: unknown): string {
  try {
    const first = Array.isArray(messages) ? messages[0] : messages;
    return JSON.stringify(first)?.slice(0, 200) ?? 'undefined';
  } catch {
    return 'unserializable';
  }
}

export class InvocationTracker {
  private readonly byScope = new Map<string, ScopeState>();

  next(scopeId: string, messages: unknown): StepRef {
    const firstKey = firstMessageKey(messages);
    const length = Array.isArray(messages) ? messages.length : 1;
    const state = this.byScope.get(scopeId);

    if (state !== undefined && state.firstKey === firstKey && length > state.lastLength) {
      state.stepCount += 1;
      state.lastLength = length;
      return {
        invocationId: state.invocationId,
        stepIndex: state.stepCount - 1,
        isFirstStep: false,
      };
    }

    const invocationId = nextId('inv');
    this.byScope.set(scopeId, { invocationId, stepCount: 1, firstKey, lastLength: length });
    if (this.byScope.size > MAX_SCOPES) {
      // Drop the oldest scope (Map preserves insertion order).
      const oldest = this.byScope.keys().next().value;
      if (oldest !== undefined) this.byScope.delete(oldest);
    }
    return { invocationId, stepIndex: 0, isFirstStep: true };
  }
}
