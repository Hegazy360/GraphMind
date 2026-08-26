/**
 * Server-held debug state: the current breakpoints and execution mode.
 *
 * This is what arms *future* app connections — the server echoes it in every
 * `hello.ack`, so a client that reconnects (or attaches mid-run) picks the
 * state up in one message. Held in memory only: a server restart starts
 * clean, matching a fresh debugging session.
 */
import type { BreakpointMatcher, RunMode } from '@graphmind/schema';

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
 */
const DEFAULT_BREAKPOINTS: BreakpointMatcher[] = [{ point: 'error' }];

export class DebugState {
  private readonly matchers = new Map<string, BreakpointMatcher>();
  mode: RunMode = 'run';

  constructor() {
    for (const matcher of DEFAULT_BREAKPOINTS) {
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
