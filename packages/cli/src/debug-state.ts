/**
 * Server-held debug state: the current breakpoints and execution mode.
 *
 * This is what arms *future* app connections — the server echoes it in every
 * `hello.ack`, so a client that reconnects (or attaches mid-run) picks the
 * state up in one message. Held in memory only: a server restart starts
 * clean, matching a fresh debugging session.
 */
import type { BreakpointMatcher, NodeKind, RunMode } from '@graphmind-ai/schema';

/** Stable stringify (sorted keys, recursive) for exact-field-equality dedup. */
function canonicalKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalKey(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Pause-on-error is the product's headline mechanic, so a fresh debug
 * session arms it by default; the viewer shows it as a removable breakpoint.
 *
 * It is unscoped on purpose — every node kind, every error. That is also the
 * sharpest setting there is: in a chatty agent an incidental tool failure
 * holds the run before the interesting failure does. Hence
 * `--pause-on-error` / `GRAPHMIND_PAUSE_ON_ERROR`, which narrows or removes
 * the default *without* changing it (see `parsePauseOnError`).
 */
export const DEFAULT_BREAKPOINTS: readonly BreakpointMatcher[] = [{ point: 'error' }];

const NODE_KINDS: readonly NodeKind[] = [
  'agent',
  'llm',
  'tool',
  'chain',
  'retriever',
  'custom',
];

const OFF_VALUES = new Set(['off', 'none', 'no', 'false', '0']);
const ON_VALUES = new Set(['on', 'all', 'yes', 'true', '1']);

/** Accepted `--pause-on-error` / `GRAPHMIND_PAUSE_ON_ERROR` values, for help text. */
export const PAUSE_ON_ERROR_VALUES: readonly string[] = ['on', 'off', ...NODE_KINDS];

export type PauseOnErrorResult =
  | { ok: true; breakpoints: readonly BreakpointMatcher[] }
  | { ok: false; error: string };

/**
 * Resolve the breakpoints a fresh server arms, from one user-supplied value.
 *
 *   undefined | '' | 'on' | 'all'   the default: pause on every node error
 *   'off' | 'none' | 'false' | '0'  start with no breakpoints at all
 *   'tool' | 'llm' | ...            pause only on that node kind's errors
 *
 * Anything else is an error rather than a silent fallback: a typo that
 * quietly re-armed the sharpest setting would be worse than a failed start.
 */
export function parsePauseOnError(raw: string | undefined): PauseOnErrorResult {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || ON_VALUES.has(value)) return { ok: true, breakpoints: DEFAULT_BREAKPOINTS };
  if (OFF_VALUES.has(value)) return { ok: true, breakpoints: [] };
  if ((NODE_KINDS as readonly string[]).includes(value)) {
    return { ok: true, breakpoints: [{ point: 'error', kind: value as NodeKind }] };
  }
  return {
    ok: false,
    error:
      `pause-on-error must be one of ${PAUSE_ON_ERROR_VALUES.join(', ')} ` +
      `(got "${raw}")`,
  };
}

export class DebugState {
  private readonly matchers = new Map<string, BreakpointMatcher>();
  mode: RunMode = 'run';

  constructor(initial: readonly BreakpointMatcher[] = DEFAULT_BREAKPOINTS) {
    for (const matcher of initial) {
      this.matchers.set(canonicalKey(matcher), matcher);
    }
  }

  get breakpoints(): BreakpointMatcher[] {
    return [...this.matchers.values()];
  }

  /** Add a breakpoint. Returns false when an identical matcher exists. */
  set(matcher: BreakpointMatcher): boolean {
    const key = canonicalKey(matcher);
    if (this.matchers.has(key)) return false;
    this.matchers.set(key, matcher);
    return true;
  }

  /** Remove a breakpoint by exact field equality. Returns false if absent. */
  clear(matcher: BreakpointMatcher): boolean {
    return this.matchers.delete(canonicalKey(matcher));
  }
}
