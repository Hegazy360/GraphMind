/**
 * Gate engine: cooperative pause points inside the instrumented process.
 * Productionized from examples/spike/src/gate.ts (which stays untouched).
 *
 * The session owns the decision of WHETHER to gate (attached? matching
 * breakpoint? step mode?); this engine owns the bookkeeping of HELD gates:
 * registration, resume routing, pause timeouts, and fail-open release.
 *
 * Fail-open invariants:
 *  - `releaseAll()` resolves every held gate with `continue` (called on
 *    disconnect and on dispose).
 *  - An optional per-gate pause timeout auto-continues a gate nobody resumes.
 *  - Timers are unref'd so held bookkeeping never keeps the process alive.
 */
import type { BreakpointMatcher, NodeKind, PausePoint, ResumeAction, RunMode } from '@graphmind/schema';

export interface GateNode {
  nodeId: string;
  kind: NodeKind;
  name: string;
}

export type GateDecision =
  | { action: 'continue' }
  | { action: 'retry' }
  | { action: 'abort' }
  | { action: 'inject'; output: unknown };

export const CONTINUE_DECISION: GateDecision = Object.freeze({ action: 'continue' });

export interface GateEngineCallbacks {
  /** A gate was registered and is now held. Emit `exec.paused` here. */
  onPaused(pauseId: string, node: GateNode, point: PausePoint, runId: string): void;
  /** A held gate was released (by viewer, timeout, or fail-open). Emit `exec.resumed`. */
  onResumed(pauseId: string, node: GateNode, action: ResumeAction, runId: string): void;
  newPauseId(): string;
}

interface HeldGate {
  pauseId: string;
  node: GateNode;
  point: PausePoint;
  runId: string;
  openedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (decision: GateDecision) => void;
}

export function matcherMatches(
  matcher: BreakpointMatcher,
  point: PausePoint,
  node: GateNode,
): boolean {
  if ((matcher.point ?? 'before') !== point) return false;
  if (matcher.kind !== undefined && matcher.kind !== node.kind) return false;
  if (matcher.name !== undefined && matcher.name !== node.name) return false;
  return true;
}

export function matcherEquals(a: BreakpointMatcher, b: BreakpointMatcher): boolean {
  return a.kind === b.kind && a.name === b.name && a.point === b.point;
}

export class GateEngine {
  private breakpoints: BreakpointMatcher[] = [];
  private mode: RunMode = 'run';
  private readonly held = new Map<string, HeldGate>();

  constructor(
    private readonly callbacks: GateEngineCallbacks,
    private readonly pauseTimeoutMs: number | undefined,
  ) {}

  /** Adopt the viewer's full state (from `hello.ack`). */
  arm(breakpoints: readonly BreakpointMatcher[], mode: RunMode): void {
    this.breakpoints = [...breakpoints];
    this.mode = mode;
  }

  /** Drop all viewer state (on detach). Held gates are released separately. */
  disarm(): void {
    this.breakpoints = [];
    this.mode = 'run';
  }

  setMode(mode: RunMode): void {
    this.mode = mode;
  }

  addBreakpoint(matcher: BreakpointMatcher): void {
    if (!this.breakpoints.some((existing) => matcherEquals(existing, matcher))) {
      this.breakpoints.push(matcher);
    }
  }

  removeBreakpoint(matcher: BreakpointMatcher): void {
    this.breakpoints = this.breakpoints.filter((existing) => !matcherEquals(existing, matcher));
  }

  snapshot(): { breakpoints: BreakpointMatcher[]; mode: RunMode } {
    return { breakpoints: [...this.breakpoints], mode: this.mode };
  }

  /**
   * Should execution pause at this point? Step mode pauses at every `before`
   * and `error` point (never at `after` unless an explicit `after`
   * breakpoint matches); run mode pauses only on matching breakpoints.
   */
  shouldPause(point: PausePoint, node: GateNode): boolean {
    if (this.mode === 'step' && point !== 'after') return true;
    return this.breakpoints.some((matcher) => matcherMatches(matcher, point, node));
  }

  /** Register a held gate; resolves when released. Call only after `shouldPause`. */
  hold(point: PausePoint, node: GateNode, runId: string): Promise<GateDecision> {
    return new Promise<GateDecision>((resolve) => {
      const pauseId = this.callbacks.newPauseId();
      const gate: HeldGate = {
        pauseId,
        node,
        point,
        runId,
        openedAt: Date.now(),
        timer: undefined,
        resolve,
      };
      if (this.pauseTimeoutMs !== undefined) {
        gate.timer = setTimeout(() => {
          this.settle(pauseId, CONTINUE_DECISION, 'continue');
        }, this.pauseTimeoutMs);
        gate.timer.unref?.();
      }
      this.held.set(pauseId, gate);
      this.callbacks.onPaused(pauseId, node, point, runId);
    });
  }

  /** Route a viewer `exec.resume` to its held gate. Unknown ids are ignored. */
  resume(pauseId: string, action: ResumeAction, output?: unknown): boolean {
    const decision: GateDecision =
      action === 'inject' ? { action: 'inject', output } : { action };
    return this.settle(pauseId, decision, action);
  }

  /** FAIL-OPEN: release every held gate with `continue`. Returns count. */
  releaseAll(): number {
    const ids = [...this.held.keys()];
    for (const pauseId of ids) this.settle(pauseId, CONTINUE_DECISION, 'continue');
    return ids.length;
  }

  get heldCount(): number {
    return this.held.size;
  }

  private settle(pauseId: string, decision: GateDecision, action: ResumeAction): boolean {
    const gate = this.held.get(pauseId);
    if (gate === undefined) return false;
    this.held.delete(pauseId);
    if (gate.timer !== undefined) clearTimeout(gate.timer);
    this.callbacks.onResumed(pauseId, gate.node, action, gate.runId);
    gate.resolve(decision);
    return true;
  }
}
