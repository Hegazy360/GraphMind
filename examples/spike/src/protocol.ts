/**
 * Wire protocol between the agent-side gate engine (WS client) and the
 * fake debugger (WS server). Kept deliberately tiny for the spike.
 */

export type GatePoint = 'before-step' | 'before-tool' | 'on-error';

export type ResumeAction =
  | { type: 'continue' }
  | { type: 'retry' }
  | { type: 'inject'; output: unknown }
  | { type: 'abort' };

export interface NodeInfo {
  kind: 'step' | 'tool';
  stepIndex?: number;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  attempt?: number;
  error?: string;
}

/** Messages the debugger sends to the agent process. */
export type DebuggerToAgent =
  | { type: 'bp.set'; breakpoints: string[] }
  | { type: 'exec.resume'; pauseId: string; action: ResumeAction };

/** Messages the agent process sends to the debugger. */
export type AgentToDebugger =
  | { type: 'exec.paused'; pauseId: string; point: GatePoint; node: NodeInfo }
  | { type: 'exec.node'; event: string; node: NodeInfo };
