/**
 * Viewer-local UI state: selection, camera-follow, command palette, canvas
 * filters, collapsed groups, timeline layout, level-of-detail, theme, debug
 * controls (mode + breakpoints — the viewer is authoritative for these per
 * the hello.ack contract), and connection status.
 *
 * Nothing here is derived from events; the run store owns that. Anything a
 * user chose lives here, so a re-render or a reconnect never loses it.
 */
import { create } from 'zustand';
import type { BreakpointMatcher, NodeKind, RunMode } from '@graphmind-ai/schema';
import { EMPTY_FILTER, type FilterSpec, type StatusFilter } from './filters.js';
import { loadTheme, type ThemeChoice } from '../lib/theme.js';

export type ConnectionStatus = 'connecting' | 'live' | 'detached' | 'replaying' | 'off';

/**
 * What the connection indicator should say.
 *
 * A local replay is what you are actually looking at whenever the live
 * socket is not attached — including while it retries in the background
 * after the empty-state "Replay the bundled demo run" button, which left the
 * socket configured and so reported `detached` over a replay that was
 * happily playing. The server being gone is real, and the tooltip still says
 * so; the *label* names what is on screen.
 */
export function indicatorStatus(
  connection: ConnectionStatus,
  fixtureActive: boolean,
): ConnectionStatus {
  return fixtureActive && connection !== 'live' ? 'replaying' : connection;
}

/**
 * Whether the socket is showing you the present or the past.
 *
 * An open socket is not the same as a live tail. The server services a UI
 * `subscribe` by replaying the run's whole history first (`replay.start` →
 * events → `replay.end`) and only then tailing, so under ingest saturation a
 * viewer can receive an entire run as catch-up and never reach the live tail
 * at all — measured at 0 live / 72,144 replayed. That is a live debugger
 * quietly becoming a log viewer, and the run bar has to say so.
 *
 *  - `tailing`     — attached and current; what "live" is supposed to mean.
 *  - `catching-up` — a replay is in flight; the graph is history, not now.
 *  - `behind`      — replay finished, but the events still arriving are old.
 */
export type StreamPhase = 'tailing' | 'catching-up' | 'behind';

/** Events older than this mean the tail is behind, not live. */
export const BEHIND_MS = 3_000;
/** A lag sample older than this says nothing about now — a settled run is idle, not behind. */
export const LAG_SAMPLE_TTL_MS = 10_000;

export interface StreamHealth {
  /** Per-run catch-up progress, while a `replay.start` is outstanding. */
  catchUp: Record<string, { count: number; applied: number }>;
  /** Wall-clock age of the newest envelope the live socket delivered, ms. */
  lagMs: number;
  /** When that sample was taken (`Date.now()`), so staleness is checkable. */
  lagAt: number;
}

export const IDLE_STREAM: StreamHealth = Object.freeze({ catchUp: {}, lagMs: 0, lagAt: 0 });

export interface StreamStatus {
  phase: StreamPhase;
  /** Events announced by the in-flight replays. */
  backlog: number;
  /** How many of those have been applied. */
  applied: number;
  /** Age of the newest event, when that is what makes the stream behind. */
  lagMs: number;
}

/** Fold the raw counters into the one thing the UI renders. */
export function streamStatus(stream: StreamHealth, now: number = Date.now()): StreamStatus {
  let backlog = 0;
  let applied = 0;
  let replaying = false;
  for (const runId of Object.keys(stream.catchUp)) {
    const entry = stream.catchUp[runId];
    if (entry === undefined) continue;
    replaying = true;
    backlog += entry.count;
    applied += entry.applied;
  }
  if (replaying) return { phase: 'catching-up', backlog, applied, lagMs: stream.lagMs };
  const fresh = stream.lagAt !== 0 && now - stream.lagAt <= LAG_SAMPLE_TTL_MS;
  if (fresh && stream.lagMs > BEHIND_MS) {
    return { phase: 'behind', backlog: 0, applied: 0, lagMs: stream.lagMs };
  }
  return { phase: 'tailing', backlog: 0, applied: 0, lagMs: 0 };
}

/** How much detail node cards render. Driven by zoom + graph size. */
export type LodLevel = 'full' | 'compact' | 'dot';

/** Which panes are visible under the canvas. */
export type ViewMode = 'graph' | 'split' | 'timeline';

export type { ThemeChoice };

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
  paletteOpen: boolean;
  /** Seeds the palette input (e.g. "> " to jump straight to actions). */
  paletteSeed: string;
  mode: RunMode;
  breakpoints: BreakpointMatcher[];
  connection: ConnectionStatus;
  /** Whether the live socket is tailing, catching up, or behind. */
  stream: StreamHealth;
  fixtureActive: boolean;
  /** Set by the empty-state "load demo run" button. */
  demoRequested: boolean;
  focusRequest: FocusRequest | undefined;

  // ── scale ────────────────────────────────────────────────────────────────
  /** Collapsed group roots, per run — survives selection changes. */
  collapsedByRun: Record<string, string[]>;
  lod: LodLevel;
  /** Set false to pin full detail regardless of zoom. */
  autoLod: boolean;

  // ── views ────────────────────────────────────────────────────────────────
  view: ViewMode;
  timelineHeight: number;
  filters: FilterSpec;
  theme: ThemeChoice;

  selectRun: (runId: string | undefined) => void;
  selectNode: (runId: string, nodeId: string | undefined) => void;
  setInstanceIdx: (idx: number | undefined) => void;
  toggleFollow: () => void;
  setPaletteOpen: (open: boolean, seed?: string) => void;
  setMode: (mode: RunMode) => void;
  addBreakpoint: (matcher: BreakpointMatcher) => void;
  removeBreakpoint: (matcher: BreakpointMatcher) => void;
  setConnection: (status: ConnectionStatus) => void;
  setStream: (stream: StreamHealth) => void;
  setFixtureActive: (active: boolean) => void;
  requestDemo: () => void;
  requestFocus: (nodeId: string) => void;

  toggleCollapse: (runId: string, nodeId: string) => void;
  setCollapsed: (runId: string, nodeIds: readonly string[]) => void;
  expandAll: (runId: string) => void;
  setLod: (lod: LodLevel) => void;
  setAutoLod: (auto: boolean) => void;

  setView: (view: ViewMode) => void;
  toggleTimeline: () => void;
  setTimelineHeight: (px: number) => void;
  setFilters: (patch: Partial<FilterSpec>) => void;
  toggleKindFilter: (kind: NodeKind) => void;
  setStatusFilter: (status: StatusFilter) => void;
  toggleErrorPath: () => void;
  clearFilters: () => void;
  setTheme: (theme: ThemeChoice) => void;
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

export const MIN_TIMELINE_HEIGHT = 132;
export const DEFAULT_TIMELINE_HEIGHT = 268;

export const useUiStore = create<UiState>((set) => ({
  selectedRunId: undefined,
  selectedNodeId: undefined,
  selectedInstanceIdx: undefined,
  followCamera: true,
  paletteOpen: false,
  paletteSeed: '',
  mode: 'run',
  breakpoints: [],
  connection: 'off',
  stream: IDLE_STREAM,
  fixtureActive: false,
  demoRequested: false,
  focusRequest: undefined,

  collapsedByRun: {},
  lod: 'full',
  autoLod: true,

  view: 'graph',
  timelineHeight: DEFAULT_TIMELINE_HEIGHT,
  filters: EMPTY_FILTER,
  // Seeded from storage at creation, not in an effect: a mount-time effect
  // would race the "persist on change" effect and wipe the stored choice.
  theme: loadTheme(),

  selectRun: (runId) =>
    set({ selectedRunId: runId, selectedNodeId: undefined, selectedInstanceIdx: undefined }),
  selectNode: (runId, nodeId) =>
    set({ selectedRunId: runId, selectedNodeId: nodeId, selectedInstanceIdx: undefined }),
  setInstanceIdx: (idx) => set({ selectedInstanceIdx: idx }),
  toggleFollow: () => set((s) => ({ followCamera: !s.followCamera })),
  setPaletteOpen: (open, seed = '') => set({ paletteOpen: open, paletteSeed: open ? seed : '' }),
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
  setStream: (stream) => set({ stream }),
  setFixtureActive: (active) => set({ fixtureActive: active }),
  requestDemo: () => set({ demoRequested: true }),
  requestFocus: (nodeId) => set({ focusRequest: { nodeId, nonce: ++focusNonce } }),

  toggleCollapse: (runId, nodeId) =>
    set((s) => {
      const current = s.collapsedByRun[runId] ?? [];
      const next = current.includes(nodeId)
        ? current.filter((id) => id !== nodeId)
        : [...current, nodeId];
      return { collapsedByRun: { ...s.collapsedByRun, [runId]: next } };
    }),
  setCollapsed: (runId, nodeIds) =>
    set((s) => ({ collapsedByRun: { ...s.collapsedByRun, [runId]: [...nodeIds] } })),
  expandAll: (runId) =>
    set((s) => ({ collapsedByRun: { ...s.collapsedByRun, [runId]: [] } })),
  setLod: (lod) => set((s) => (s.lod === lod ? s : { lod })),
  setAutoLod: (autoLod) => set({ autoLod, ...(autoLod ? {} : { lod: 'full' as LodLevel }) }),

  setView: (view) => set({ view }),
  toggleTimeline: () => set((s) => ({ view: s.view === 'graph' ? 'split' : 'graph' })),
  setTimelineHeight: (px) => set({ timelineHeight: Math.max(MIN_TIMELINE_HEIGHT, px) }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  toggleKindFilter: (kind) =>
    set((s) => {
      const current = s.filters.kinds;
      if (current === null) return { filters: { ...s.filters, kinds: [kind] } };
      const next = current.includes(kind)
        ? current.filter((k) => k !== kind)
        : [...current, kind];
      return { filters: { ...s.filters, kinds: next.length === 0 ? null : next } };
    }),
  setStatusFilter: (status) =>
    set((s) => ({ filters: { ...s.filters, status: s.filters.status === status ? 'all' : status } })),
  toggleErrorPath: () =>
    set((s) => ({ filters: { ...s.filters, errorPathOnly: !s.filters.errorPathOnly } })),
  clearFilters: () => set({ filters: EMPTY_FILTER }),
  setTheme: (theme) => set({ theme }),
}));

/** Collapsed roots for a run, referentially stable when empty. */
const NO_COLLAPSE: readonly string[] = Object.freeze([]);

export function collapsedFor(state: { collapsedByRun: Record<string, string[]> }, runId: string): readonly string[] {
  return state.collapsedByRun[runId] ?? NO_COLLAPSE;
}
