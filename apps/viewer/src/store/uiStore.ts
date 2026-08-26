/**
 * Viewer-local UI state: selection, camera-follow, search, debug controls
 * (mode + breakpoints — the viewer is authoritative for these per the
 * hello.ack contract), and connection status.
 */
import { create } from 'zustand';
import type { BreakpointMatcher, RunMode } from '@graphmind/schema';

export type ConnectionStatus = 'connecting' | 'live' | 'detached' | 'replaying' | 'off';

export interface FocusRequest {
  nodeId: string;
  /** Monotonic nonce so repeated focuses on the same node still fire. */
  nonce: number;
}

interface UiState {
  selectedRunId: string | undefined;
  selectedNodeId: string | undefined;
  /** Selected execution index in the inspector (per-instance selector). */
  selectedInstanceIdx: number | undefined;
  followCamera: boolean;
  searchOpen: boolean;
  mode: RunMode;
  breakpoints: BreakpointMatcher[];
  connection: ConnectionStatus;
  fixtureActive: boolean;
  /** Set by the empty-state "load demo run" button. */
  demoRequested: boolean;
  focusRequest: FocusRequest | undefined;

  selectRun: (runId: string | undefined) => void;
  selectNode: (runId: string, nodeId: string | undefined) => void;
  setInstanceIdx: (idx: number | undefined) => void;
  toggleFollow: () => void;
  setSearchOpen: (open: boolean) => void;
  setMode: (mode: RunMode) => void;
  addBreakpoint: (matcher: BreakpointMatcher) => void;
  removeBreakpoint: (matcher: BreakpointMatcher) => void;
  setConnection: (status: ConnectionStatus) => void;
  setFixtureActive: (active: boolean) => void;
  requestDemo: () => void;
  requestFocus: (nodeId: string) => void;
}

export function matcherKey(matcher: BreakpointMatcher): string {
  return `${matcher.kind ?? '*'}|${matcher.name ?? '*'}|${matcher.point ?? 'before'}`;
}

export function matcherLabel(matcher: BreakpointMatcher): string {
  const parts: string[] = [];
  if (matcher.kind !== undefined) parts.push(matcher.kind);
  if (matcher.name !== undefined) parts.push(matcher.name);
  if (parts.length === 0) parts.push('all nodes');
  const point = matcher.point ?? 'before';
  return point === 'before' ? parts.join(' · ') : `${parts.join(' · ')} @ ${point}`;
}

let focusNonce = 0;

export const useUiStore = create<UiState>((set) => ({
  selectedRunId: undefined,
  selectedNodeId: undefined,
  selectedInstanceIdx: undefined,
  followCamera: true,
  searchOpen: false,
  mode: 'run',
  breakpoints: [],
  connection: 'off',
  fixtureActive: false,
  demoRequested: false,
  focusRequest: undefined,

  selectRun: (runId) =>
    set({ selectedRunId: runId, selectedNodeId: undefined, selectedInstanceIdx: undefined }),
  selectNode: (runId, nodeId) =>
    set({ selectedRunId: runId, selectedNodeId: nodeId, selectedInstanceIdx: undefined }),
  setInstanceIdx: (idx) => set({ selectedInstanceIdx: idx }),
  toggleFollow: () => set((s) => ({ followCamera: !s.followCamera })),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setMode: (mode) => set({ mode }),
  addBreakpoint: (matcher) =>
    set((s) =>
      s.breakpoints.some((m) => matcherKey(m) === matcherKey(matcher))
        ? s
        : { breakpoints: [...s.breakpoints, matcher] },
    ),
  removeBreakpoint: (matcher) =>
    set((s) => ({
      breakpoints: s.breakpoints.filter((m) => matcherKey(m) !== matcherKey(matcher)),
    })),
  setConnection: (status) => set({ connection: status }),
  setFixtureActive: (active) => set({ fixtureActive: active }),
  requestDemo: () => set({ demoRequested: true }),
  requestFocus: (nodeId) => set({ focusRequest: { nodeId, nonce: ++focusNonce } }),
}));
