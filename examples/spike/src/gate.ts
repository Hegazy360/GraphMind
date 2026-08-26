/**
 * Gate engine: cooperative pause points inside the agent process.
 *
 * - `gate(point, node)` returns a promise. If no debugger is connected or no
 *   breakpoint matches, it resolves synchronously with `continue` (fast path).
 * - If a breakpoint matches, an `exec.paused` event is sent to the debugger
 *   and the promise stays pending until `exec.resume` arrives.
 * - FAIL-OPEN: if the WS connection drops (or errors) while gates are held,
 *   every pending gate resolves with `continue` and all breakpoints are
 *   cleared, so the run proceeds as if no debugger were attached.
 */

import WebSocket from 'ws';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { now, Trace } from './trace.js';
import type {
  AgentToDebugger,
  DebuggerToAgent,
  GatePoint,
  NodeInfo,
  ResumeAction,
} from './protocol.js';

interface PendingGate {
  pauseId: string;
  point: GatePoint;
  node: NodeInfo;
  openedAt: number;
  resolve: (action: ResumeAction) => void;
}

export class GateEngine {
  readonly trace: Trace;

  private ws: WebSocket | undefined;
  private connected = false;
  private everConnected = false;
  private breakpoints = new Set<string>();
  private readonly pending = new Map<string, PendingGate>();
  private seq = 0;
  private stepCounter = 0;
  private readonly observers: Promise<void>[] = [];

  /** Pass-through gate cost (ms) per gate, recorded only when no debugger was ever attached. */
  readonly passThroughOverheadsMs: number[] = [];
  /** Text observed by the middleware tee, per step index. */
  readonly observedTextByStep: string[] = [];
  /** The exact CallOptions the middleware saw for each doStream call, per step index. */
  readonly doStreamParamsByStep: LanguageModelV4CallOptions[] = [];

  constructor(trace: Trace) {
    this.trace = trace;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  isPendingPause(pauseId: string): boolean {
    return this.pending.has(pauseId);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  nextStepIndex(): number {
    return this.stepCounter++;
  }

  /** Connect to the debugger; resolves once breakpoints are armed (first bp.set). */
  connect(url: string, { timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let handshakeDone = false;
      const timer = setTimeout(() => {
        if (!handshakeDone) reject(new Error('debugger connect timeout'));
      }, timeoutMs);

      ws.on('open', () => {
        this.connected = true;
        this.everConnected = true;
        this.trace.mark('engine:connected');
      });
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as DebuggerToAgent;
        if (msg.type === 'bp.set') {
          this.breakpoints = new Set(msg.breakpoints);
          this.trace.mark('engine:bp-set', { breakpoints: msg.breakpoints });
          if (!handshakeDone) {
            handshakeDone = true;
            clearTimeout(timer);
            resolve();
          }
        } else if (msg.type === 'exec.resume') {
          this.resume(msg.pauseId, msg.action);
        }
      });
      ws.on('close', () => this.onDisconnect());
      ws.on('error', () => this.onDisconnect());
    });
  }

  /** FAIL-OPEN: auto-continue everything when the controller goes away. */
  private onDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.breakpoints.clear();
    const held = [...this.pending.values()];
    this.pending.clear();
    this.trace.mark('engine:disconnected', { heldGates: held.length });
    for (const g of held) {
      this.trace.mark('gate:auto-continue', {
        pauseId: g.pauseId,
        point: g.point,
        toolName: g.node.toolName,
        stepIndex: g.node.stepIndex,
        heldMs: now() - g.openedAt,
      });
      g.resolve({ type: 'continue' });
    }
  }

  resume(pauseId: string, action: ResumeAction): boolean {
    const g = this.pending.get(pauseId);
    if (g === undefined) return false;
    this.pending.delete(pauseId);
    this.trace.mark('gate:resolved', {
      pauseId,
      point: g.point,
      toolName: g.node.toolName,
      stepIndex: g.node.stepIndex,
      action: action.type,
      heldMs: now() - g.openedAt,
    });
    g.resolve(action);
    return true;
  }

  private breakpointKeys(point: GatePoint, node: NodeInfo): string[] {
    const keys = [`${point}:*`];
    if (node.kind === 'step' && node.stepIndex !== undefined) {
      keys.push(`${point}:${node.stepIndex}`);
    }
    if (node.toolName !== undefined) keys.push(`${point}:${node.toolName}`);
    return keys;
  }

  private send(msg: AgentToDebugger): void {
    if (this.ws !== undefined && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Fire-and-forget observability event (node-start etc). */
  emitNode(event: string, node: NodeInfo): void {
    this.trace.mark(`node:${event}`, {
      toolName: node.toolName,
      stepIndex: node.stepIndex,
      toolCallId: node.toolCallId,
    });
    this.send({ type: 'exec.node', event, node });
  }

  /** The core primitive: returns a promise the caller awaits before proceeding. */
  gate(point: GatePoint, node: NodeInfo): Promise<ResumeAction> {
    const hit =
      this.connected &&
      this.breakpointKeys(point, node).some(k => this.breakpoints.has(k));
    if (!hit) {
      this.trace.mark('gate:pass', {
        point,
        toolName: node.toolName,
        stepIndex: node.stepIndex,
      });
      return Promise.resolve({ type: 'continue' });
    }
    const pauseId = `pause-${++this.seq}`;
    return new Promise<ResumeAction>(resolve => {
      this.pending.set(pauseId, { pauseId, point, node, openedAt: now(), resolve });
      this.trace.mark('gate:open', {
        pauseId,
        point,
        toolName: node.toolName,
        stepIndex: node.stepIndex,
      });
      this.send({ type: 'exec.paused', pauseId, point, node });
    });
  }

  /**
   * gate() plus timing measured at the await site (includes promise/microtask
   * cost). Overhead samples are only recorded when no debugger was ever
   * attached, i.e. in the baseline scenario.
   */
  async timedGate(point: GatePoint, node: NodeInfo): Promise<ResumeAction> {
    const t0 = now();
    const action = await this.gate(point, node);
    if (!this.everConnected) this.passThroughOverheadsMs.push(now() - t0);
    return action;
  }

  setObservedText(stepIndex: number, text: string): void {
    this.observedTextByStep[stepIndex] = text;
  }

  recordDoStreamParams(stepIndex: number, params: LanguageModelV4CallOptions): void {
    this.doStreamParamsByStep[stepIndex] = params;
  }

  trackObserver(p: Promise<void>): void {
    this.observers.push(p);
  }

  async drainObservers(): Promise<void> {
    await Promise.all(this.observers);
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
