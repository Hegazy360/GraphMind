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
import {
  loadPanels,
  presetPanels,
  savePanels,
  type PanelId,
  type Panels,
  type PresetId,
} from './workspace.js';
import type { Page } from '../router.js';

export type ConnectionStatus = 'connecting' | 'live' | 'detached' | 'replaying' | 'off';

/**
 * What this viewer may do on the server it is attached to (0.6 `welcome.control`).
 * Absent: a 0.5 server, or no live socket.
 */
export interface ControlInfo {
  /** `viewer` = full control (the #token= credential); `anonymous` = no token (continue/retry/abort only). */
  principal: 'viewer' | 'agent' | 'anonymous';
  /** What `graphmind resume` (the agent token) may do: serve --allow-control. */
  agentLevel: 'off' | 'resume' | 'inject' | 'edit';
  /** False under `serve --no-edit-input`. */
  editInput: boolean;
  hubCapabilities: string[];
}

/** A short-lived message about a control the server refused or answered (pause taken, edit refused). */
export interface ControlNotice {
  code: string;
  message: string;
  nonce: number;
}

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

/**
 * "Open the inject editor" as state rather than as a callback.
 *
 * The editor is rendered twice — once in the held card, once in the
 * inspector's held-gate footer — and the keyboard has to be able to open
 * whichever one the user is actually looking at without either component
 * knowing the other exists.
 */
export interface InjectRequest {
  pauseId: string;
  variant: 'card' | 'panel';
  nonce: number;
}

interface UiState {
  /** Which place is on screen. */
  page: Page;
  /**
   * How deep the *stack* was when a side trip (connect, build) was taken.
   *
   * A side trip does not unwind the stack — you expect to come back to the
   * call you were reading, not to the top — so the trail keeps describing
   * where you stood, and leaving returns you exactly there.
   */
  stackAt: 'runs' | 'run' | 'node';
  selectedRunId: string | undefined;
  selectedNodeId: string | undefined;
  /** Selected execution index in the inspector (per-instance selector). */
  selectedInstanceIdx: number | undefined;
  followCamera: boolean;
  paletteOpen: boolean;
  /** Seeds the palette input (e.g. "> " to jump straight to actions). */
  paletteSeed: string;
  /** The "which panels do I want" dialog (store/workspace.ts). */
  customizeOpen: boolean;
  mode: RunMode;
  breakpoints: BreakpointMatcher[];
  connection: ConnectionStatus;
  /** What this viewer may do on the attached server (0.6), if it said. */
  control: ControlInfo | undefined;
  /** The latest refused/answered control, for the run bar. */
  controlNotice: ControlNotice | undefined;
  /** Whether the live socket is tailing, catching up, or behind. */
  stream: StreamHealth;
  fixtureActive: boolean;
  /** Set by the empty-state "load demo run" button. */
  demoRequested: boolean;
  focusRequest: FocusRequest | undefined;
  injectRequest: InjectRequest | undefined;
  /**
   * Width of the inspector overlay, or 0 when it is closed.
   *
   * The camera needs it. The inspector is `position: absolute` over the
   * canvas, so the canvas element is ~390px wider than the part of it anyone
   * can see — and framing or centring against the element is exactly how a
   * held node ends up hidden behind the panel describing it.
   */
  inspectorWidth: number;

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
  /**
   * Which panels this reader has in their workspace. Seeded from storage at
   * creation for the same reason the theme is: a mount-time effect would
   * race the persist-on-change effect and wipe the stored choice.
   */
  panels: Panels;

  setPage: (page: Page) => void;
  /** Leave a side trip, back to the place it was taken from. */
  leaveAside: () => void;
  /**
   * Go to a run's graph, from anywhere. Unlike `closeNode` this does not
   * care where you were — a breadcrumb click from a side trip has to land,
   * and inferring the destination from the current selection is how it
   * silently did nothing instead.
   */
  openRun: (runId: string) => void;
  selectRun: (runId: string | undefined) => void;
  selectNode: (runId: string, nodeId: string | undefined) => void;
  closeNode: () => void;
  setInstanceIdx: (idx: number | undefined) => void;
  toggleFollow: () => void;
  setPaletteOpen: (open: boolean, seed?: string) => void;
  setCustomizeOpen: (open: boolean) => void;
  setMode: (mode: RunMode) => void;
  addBreakpoint: (matcher: BreakpointMatcher) => void;
  removeBreakpoint: (matcher: BreakpointMatcher) => void;
  setConnection: (status: ConnectionStatus) => void;
  setControl: (control: ControlInfo | undefined) => void;
  noteControl: (code: string, message: string) => void;
  clearControlNotice: () => void;
  setStream: (stream: StreamHealth) => void;
  setFixtureActive: (active: boolean) => void;
  requestDemo: () => void;
  requestFocus: (nodeId: string) => void;
  requestInject: (pauseId: string, variant: 'card' | 'panel') => void;
  setInspectorWidth: (px: number) => void;

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
  togglePanel: (id: PanelId) => void;
  applyPreset: (preset: Exclude<PresetId, 'custom'>) => void;
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
  page: 'runs',
  stackAt: 'runs',
  selectedRunId: undefined,
  selectedNodeId: undefined,
  selectedInstanceIdx: undefined,
  followCamera: true,
  paletteOpen: false,
  paletteSeed: '',
  customizeOpen: false,
  mode: 'run',
  breakpoints: [],
  connection: 'off',
  control: undefined,
  controlNotice: undefined,
  stream: IDLE_STREAM,
  fixtureActive: false,
  demoRequested: false,
  focusRequest: undefined,
  injectRequest: undefined,
  inspectorWidth: 0,

  collapsedByRun: {},
  lod: 'full',
  autoLod: true,

  view: 'graph',
  timelineHeight: DEFAULT_TIMELINE_HEIGHT,
  filters: EMPTY_FILTER,
  // Seeded from storage at creation, not in an effect: a mount-time effect
  // would race the "persist on change" effect and wipe the stored choice.
  theme: loadTheme(),
  panels: loadPanels(),

  setPage: (page) =>
    set((s) => {
      if (s.page === page) return s;
      // Remember the stack as it is left, so a side trip can come back to it.
      if (page === 'runs' || page === 'run' || page === 'node') {
        return { page, stackAt: page };
      }
      return { page };
    }),
  leaveAside: () =>
    set((s) => {
      if (s.page !== 'connect' && s.page !== 'build') return s;
      // A run that has since gone away (a cleared list, a new session) would
      // strand us on a place with nothing to show; the list always exists.
      const back = s.selectedRunId === undefined ? 'runs' : s.stackAt;
      return { page: back as Page };
    }),
  selectRun: (runId) =>
    set({
      selectedRunId: runId,
      selectedNodeId: undefined,
      selectedInstanceIdx: undefined,
      ...(runId === undefined ? {} : { page: 'run' as Page, stackAt: 'run' as const }),
    }),
  selectNode: (runId, nodeId) =>
    set({
      selectedRunId: runId,
      selectedNodeId: nodeId,
      selectedInstanceIdx: undefined,
      page: (nodeId === undefined ? 'run' : 'node') as Page,
      stackAt: nodeId === undefined ? ('run' as const) : ('node' as const),
    }),
  /**
   * Step back up to the graph *keeping* the selection, so the node you were
   * reading is still lit and centred when you get there. Distinct from
   * `selectNode(runId, undefined)`, which is an explicit deselect.
   */
  closeNode: () =>
    set((s) => (s.page === 'node' ? { page: 'run' as Page, stackAt: 'run' as const } : s)),
  openRun: (runId) =>
    set((s) => ({
      selectedRunId: runId,
      // Same run: keep the call you were reading picked on the graph.
      selectedNodeId: s.selectedRunId === runId ? s.selectedNodeId : undefined,
      ...(s.selectedRunId === runId ? {} : { selectedInstanceIdx: undefined }),
      page: 'run' as Page,
      stackAt: 'run' as const,
    })),
  setInstanceIdx: (idx) => set({ selectedInstanceIdx: idx }),
  toggleFollow: () => set((s) => ({ followCamera: !s.followCamera })),
  setPaletteOpen: (open, seed = '') => set({ paletteOpen: open, paletteSeed: open ? seed : '' }),
  setCustomizeOpen: (customizeOpen) => set({ customizeOpen }),
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
  setControl: (control) => set({ control }),
  noteControl: (code, message) => set({ controlNotice: { code, message, nonce: ++focusNonce } }),
  clearControlNotice: () => set({ controlNotice: undefined }),
  setStream: (stream) => set({ stream }),
  setFixtureActive: (active) => set({ fixtureActive: active }),
  requestDemo: () => set({ demoRequested: true }),
  requestFocus: (nodeId) => set({ focusRequest: { nodeId, nonce: ++focusNonce } }),
  requestInject: (pauseId, variant) =>
    set({ injectRequest: { pauseId, variant, nonce: ++focusNonce } }),
  setInspectorWidth: (px) =>
    set((s) => (s.inspectorWidth === px ? s : { inspectorWidth: Math.max(0, px) })),

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
  togglePanel: (id) =>
    set((state) => {
      const panels = { ...state.panels, [id]: !state.panels[id] };
      savePanels(panels);
      return { panels };
    }),
  applyPreset: (preset) => {
    const panels = presetPanels(preset);
    savePanels(panels);
    set({ panels });
  },
}));

/** Collapsed roots for a run, referentially stable when empty. */
const NO_COLLAPSE: readonly string[] = Object.freeze([]);

export function collapsedFor(state: { collapsedByRun: Record<string, string[]> }, runId: string): readonly string[] {
  return state.collapsedByRun[runId] ?? NO_COLLAPSE;
}
