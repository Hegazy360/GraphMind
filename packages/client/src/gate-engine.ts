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
 *
 * Edited input (0.6.0, contract C2) adds one state. A gate is `held` until a
 * resume arrives; a resume that carries an edited input first moves it to
 * `validating` (`beginValidation`) while the session checks the edit on the
 * host's side. The verdict either releases it with the edit
 * (`completeValidation`) or puts it back to `held` (`reopen`) — SAME pauseId,
 * same pause-timeout timer, same `openedAt`, so held time is one interval
 * from the first pause to the final release, however many edits were
 * refused in between. While validating, plain resumes are ignored (the
 * debugger answers a second resumer itself), and a pause timeout or
 * `releaseAll()` still releases the gate with a plain `continue` — the
 * ORIGINAL input — and the late verdict lands nowhere (fail-open). A verdict
 * presented after the pause deadline gets the same outcome even when the
 * timer has not fired yet (synchronous validator work blocks it).
 */
import type { BreakpointMatcher, NodeKind, PausePoint, ResumeAction, RunMode } from '@graphmind-ai/schema';
import { monotonicNow, normalizeDurationMs, type Clock } from './clock.js';

export interface GateNode {
  nodeId: string;
  kind: NodeKind;
  name: string;
  /**
   * The execution this gate holds (its `node.started.instanceId`), when the
   * adapter knows it: sent as `exec.paused.instanceId` (0.6.0) so a debugger
   * can tell parallel calls of one node apart. Breakpoints never match on it.
   */
  instanceId?: string;
}

/**
 * `node` naming the execution its gate holds (see `GateNode.instanceId`), or
 * `node` itself when `instanceId` is not a non-empty string. Never throws.
 */
export function withInstanceId(node: GateNode, instanceId: unknown): GateNode {
  return typeof instanceId === 'string' && instanceId !== '' ? { ...node, instanceId } : node;
}

/**
 * What the adapter does next. `input` is present only when the debugger
 * edited the call's input and the edit was accepted (`continue` at a `before`
 * gate, `retry` at an `after` / `error` gate): run the call with it instead of
 * the live input. Test with `'input' in decision`.
 */
export type GateDecision =
  | { action: 'continue'; input?: unknown }
  | { action: 'retry'; input?: unknown }
  | { action: 'abort' }
  | { action: 'inject'; output: unknown };

/** Extra facts about a release, carried into `exec.resumed`. */
export interface ResumeInfo {
  /** Echo of `exec.resume.requestId` (absent on timeout / fail-open releases). */
  requestId?: string;
  /** The gate runs with an edited input; `after` is its wire copy. */
  edited?: { after: unknown };
}

/** A held gate as the session may inspect it (a copy; never the live record). */
export interface HeldGateView {
  pauseId: string;
  node: GateNode;
  point: PausePoint;
  runId: string;
  state: 'held' | 'validating';
}

/**
 * Names one validation of one gate. A verdict is applied only while its
 * ticket is the gate's current one, so a verdict that arrives after a pause
 * timeout or a detach released the gate is dropped.
 */
export interface ValidationTicket {
  readonly pauseId: string;
}

export const CONTINUE_DECISION: GateDecision = Object.freeze({ action: 'continue' });

export interface GateEngineCallbacks {
  /** A gate was registered and is now held. Emit `exec.paused` here. */
  onPaused(pauseId: string, node: GateNode, point: PausePoint, runId: string): void;
  /**
   * A held gate was released (by viewer, timeout, or fail-open). Emit
   * `exec.resumed`. `heldMs` is how long the gate was held on the monotonic
   * clock (>= 0, 0.01 ms resolution) — the debugger's share of the node's
   * wall-clock duration.
   */
  onResumed(
    pauseId: string,
    node: GateNode,
    action: ResumeAction,
    runId: string,
    heldMs: number,
    info: ResumeInfo | undefined,
  ): void;
  newPauseId(): string;
}

interface HeldGate {
  pauseId: string;
  node: GateNode;
  point: PausePoint;
  runId: string;
  /** Monotonic clock reading (see clock.ts) — never wall time. */
  openedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (decision: GateDecision) => void;
  /** `validating` while an edited input is checked (see the module comment). */
  state: 'held' | 'validating';
  /** The current validation's ticket; undefined while `held`. */
  ticket: ValidationTicket | undefined;
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
    /** Monotonic clock for hold accounting; injectable for tests. */
    private readonly now: Clock = monotonicNow,
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
        openedAt: this.now(),
        timer: undefined,
        resolve,
        state: 'held',
        ticket: undefined,
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

  /**
   * Route a viewer `exec.resume` to its held gate. Unknown ids are ignored,
   * and so is a gate that is validating an edit (its verdict decides).
   */
  resume(pauseId: string, action: ResumeAction, output?: unknown, info?: ResumeInfo): boolean {
    if (this.held.get(pauseId)?.state !== 'held') return false;
    const decision: GateDecision =
      action === 'inject' ? { action: 'inject', output } : { action };
    return this.settle(pauseId, decision, action, info);
  }

  /** The held gate with this id, if any. */
  peek(pauseId: string): HeldGateView | undefined {
    const gate = this.held.get(pauseId);
    if (gate === undefined) return undefined;
    return { pauseId, node: gate.node, point: gate.point, runId: gate.runId, state: gate.state };
  }

  /**
   * `held` -> `validating`: an edited input for this gate is about to be
   * checked. Returns the ticket the verdict must present, or undefined when
   * the gate is unknown or already validating.
   */
  beginValidation(pauseId: string): ValidationTicket | undefined {
    const gate = this.held.get(pauseId);
    if (gate === undefined || gate.state !== 'held') return undefined;
    const ticket: ValidationTicket = Object.freeze({ pauseId });
    gate.state = 'validating';
    gate.ticket = ticket;
    return ticket;
  }

  /**
   * `validating` -> `held`: the edit was refused and the gate waits for the
   * next resume, under the same pauseId, timer and held interval. False when
   * the ticket is stale (the gate was released meanwhile), or when the pause
   * deadline passed during validation — the gate is then continued with its
   * original input, as the pause-timeout timer would have done had
   * synchronous validator work not kept it from firing.
   */
  reopen(ticket: ValidationTicket): boolean {
    const gate = this.held.get(ticket.pauseId);
    if (gate === undefined || gate.ticket !== ticket) return false;
    if (this.overdue(gate)) {
      this.settle(ticket.pauseId, CONTINUE_DECISION, 'continue');
      return false;
    }
    gate.state = 'held';
    gate.ticket = undefined;
    return true;
  }

  /**
   * `validating` -> released with the accepted edit. False when the ticket is
   * stale: a pause timeout or a detach already continued the gate with its
   * original input. Also false when the pause deadline passed during
   * validation: the gate is continued with its original input (see `reopen`).
   */
  completeValidation(ticket: ValidationTicket, decision: GateDecision, info?: ResumeInfo): boolean {
    const gate = this.held.get(ticket.pauseId);
    if (gate === undefined || gate.ticket !== ticket) return false;
    if (this.overdue(gate)) {
      this.settle(ticket.pauseId, CONTINUE_DECISION, 'continue');
      return false;
    }
    return this.settle(ticket.pauseId, decision, decision.action, info);
  }

  /** FAIL-OPEN: release every held gate with `continue`. Returns count. */
  releaseAll(): number {
    const ids = [...this.held.keys()];
    for (const pauseId of ids) {
      try {
        this.settle(pauseId, CONTINUE_DECISION, 'continue');
      } catch {
        // One gate's bookkeeping must never keep the others held.
      }
    }
    return ids.length;
  }

  get heldCount(): number {
    return this.held.size;
  }

  /**
   * Has this gate's pause timeout elapsed? The timer normally settles the
   * gate first; a synchronous validator can keep it from firing. An
   * unreadable clock leaves the decision to the timer.
   */
  private overdue(gate: HeldGate): boolean {
    if (this.pauseTimeoutMs === undefined) return false;
    try {
      return this.now() - gate.openedAt >= this.pauseTimeoutMs;
    } catch {
      return false;
    }
  }

  private settle(
    pauseId: string,
    decision: GateDecision,
    action: ResumeAction,
    info?: ResumeInfo,
  ): boolean {
    const gate = this.held.get(pauseId);
    if (gate === undefined) return false;
    this.held.delete(pauseId);
    gate.ticket = undefined;
    if (gate.timer !== undefined) clearTimeout(gate.timer);
    let heldMs = 0;
    try {
      heldMs = normalizeDurationMs(this.now() - gate.openedAt);
    } catch {
      // The gate is already unregistered: an injected clock that throws
      // costs the release its duration, never its resolution.
    }
    try {
      this.callbacks.onResumed(pauseId, gate.node, action, gate.runId, heldMs, info);
    } catch {
      // The session guards its callbacks; this is the last line. A failure
      // while announcing the release must never leave the host awaiting a
      // gate that is no longer registered, nor throw into a timer.
    }
    gate.resolve(decision);
    return true;
  }
}
