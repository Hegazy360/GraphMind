/**
 * The graph.
 *
 * Scale rules, in order of how much they matter at 300 nodes:
 *  0. A run past AUTO_COLLAPSE_NODES opens folded: fifty sibling sub-agents
 *     side by side is a 15,000px-wide graph of unreadable dots.
 *  1. Layout is *incremental* (see layout/incremental.ts). A node arriving
 *     mid-run places itself under its parent; the rest of the graph does not
 *     move. Full passes are debounced and anchored so the camera doesn't
 *     jump.
 *  2. Level of detail is CSS-driven. A single class on the wrapper strips
 *     token tails, meta rows and shadows as you zoom out; only the LOD
 *     watcher re-renders per zoom frame, never the cards.
 *  3. React Flow virtualizes the DOM above a threshold
 *     (`onlyRenderVisibleElements`).
 *  4. Filters dim, they don't remove — the shape of the run stays readable.
 *
 * Per-token updates still bypass all of this: they flow through the token
 * buffer registry straight into the card that owns them.
 *
 * ── the camera ────────────────────────────────────────────────────────────
 * Every viewport move in this file is computed here and handed to React Flow
 * as a finished transform, on the frame *after* the nodes that provoked it.
 * Both halves of that sentence are load-bearing. React Flow's own `fitView`
 * and `setCenter` are dropped when they are issued in the same commit as the
 * nodes they refer to — measured: the follow camera called `setCenter` on the
 * held node and the viewport never moved, leaving the paused card completely
 * off screen, which is the one frame this product exists to show. Computing
 * the transform ourselves (lib/camera.ts) removes the measurement race
 * entirely, and a one-frame defer removes the commit race.
 *
 * The camera also aims at the part of the canvas a human can *see* rather
 * than at the element. Normally those are the same thing — the inspector is
 * a docked pane — but at narrow widths it becomes a full-width overlay, and
 * then the element is wider than the visible region (see `Insets`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import { layoutGraph } from '../layout/tidyTree.js';
import {
  anchorPositions,
  appendLayout,
  planLayout,
  resizeOnly,
  type LayoutMode,
  type Placed,
} from '../layout/incremental.js';
import {
  boundsOf,
  centerViewport,
  frameViewport,
  isComfortablyVisible,
  viewportDistance,
  type Box,
  type Insets,
  type Viewport,
} from '../lib/camera.js';
import { registerCanvasActions } from '../lib/commands.js';
import { DURATION, enterOffset, motionMs } from '../lib/motion.js';
import { autoCollapseRoots } from '../store/collapse.js';
import { isFilterActive, matchingNodeIds } from '../store/filters.js';
import {
  edgeVisual,
  canReuseFlowNode,
  runStateToFlow,
  type FlowEdgeSpec,
  type FlowNodeData,
} from '../store/runStateToFlow.js';
import { useRunStore } from '../store/runStore.js';
import { collapsedFor, useUiStore, type LodLevel } from '../store/uiStore.js';
import { nodeStatus, type RunState } from '../store/types.js';
import { GroupNode } from './nodes/GroupNode.js';
import { InvocationNode } from './nodes/InvocationNode.js';
import { LlmStepNode } from './nodes/LlmStepNode.js';
import { ToolNode } from './nodes/ToolNode.js';
import { IconArrange, IconEye, IconEyeOff, IconFit, IconLayers } from './Icons.js';

type CanvasNode = Node<FlowNodeData>;

const nodeTypes: NodeTypes = {
  invocation: InvocationNode,
  llmStep: LlmStepNode,
  tool: ToolNode,
  group: GroupNode,
};

/** Coalesce a burst of node.started events into one layout. */
const LAYOUT_DEBOUNCE_MS = 90;
/** …but never starve layout during a continuous stream. */
const LAYOUT_MAX_WAIT_MS = 420;
/** Above this many nodes React Flow only mounts what's on screen. */
const VIRTUALIZE_ABOVE = 90;
/** Above this many nodes a run opens with its subtrees folded. */
const AUTO_COLLAPSE_NODES = 70;

const MIN_ZOOM = 0.06;
const MAX_ZOOM = 1.75;

/**
 * Below this the inspector is not "a panel beside the graph", it is the
 * screen — reserving its width would squeeze the camera into a sliver. Past
 * that point the graph is simply behind the panel and the user closes it.
 */
const MIN_CANVAS_AFTER_INSPECTOR = 420;

/**
 * The zoom below which "show the whole run" stops being useful and starts
 * being a mosaic. Above it the camera prefers to widen; below it, it follows.
 */
const WIDE_ENOUGH_ZOOM = 0.62;

function toEdge(spec: FlowEdgeSpec, run: RunState | undefined, dimmed: boolean): Edge {
  const visual = run === undefined ? 'idle' : edgeVisual(run, spec.target);
  return {
    id: spec.id,
    source: spec.source,
    target: spec.target,
    type: 'default',
    className: `gm-edge-${visual}${dimmed ? ' gm-dim' : ''}`,
  };
}

interface FocusTarget {
  nodeId: string;
  /** A gate opening pulls the camera back even to a node it already visited. */
  reason: 'pause' | 'running';
}

/** The node the camera should chase: an active pause wins, else the most recently started running execution. */
function pickFocusNode(run: RunState): FocusTarget | undefined {
  for (const pauseId of Object.keys(run.pauses)) {
    const pause = run.pauses[pauseId];
    if (pause !== undefined && pause.active) return { nodeId: pause.nodeId, reason: 'pause' };
  }
  let best: string | undefined;
  let bestTs = -1;
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    for (const exec of node.executions) {
      if (exec.status === 'running' && exec.startedTs >= bestTs) {
        bestTs = exec.startedTs;
        best = nodeId;
      }
    }
  }
  return best === undefined ? undefined : { nodeId: best, reason: 'running' };
}

function boxOf(node: { position: { x: number; y: number }; width?: number | null; height?: number | null }): Box {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? 0,
    height: node.height ?? 0,
  };
}

function lodFor(zoom: number, nodeCount: number): LodLevel {
  if (zoom < 0.42) return 'dot';
  if (zoom < 0.72) return 'compact';
  if (nodeCount > 260 && zoom < 0.95) return 'compact';
  return 'full';
}

/**
 * Isolated so zoom frames re-render one empty component instead of the whole
 * canvas. Writes the quantized level into the UI store; the cards read it.
 */
function LodWatcher({ nodeCount }: { nodeCount: number }) {
  const zoom = useStore((s) => s.transform[2]);
  const autoLod = useUiStore((s) => s.autoLod);
  useEffect(() => {
    if (!autoLod) return;
    useUiStore.getState().setLod(lodFor(zoom, nodeCount));
  }, [zoom, nodeCount, autoLod]);
  return null;
}

const MINIMAP_COLORS: Record<string, string> = {
  running: 'var(--accent)',
  paused: 'var(--amber)',
  error: 'var(--err)',
  ok: 'var(--ok)',
  aborted: 'var(--text-faint)',
  ghost: 'var(--ghost)',
};

export function RunCanvas({ runId }: { runId: string }) {
  const structureVersion = useRunStore((s) => s.runs[runId]?.structureVersion ?? -1);
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? -1);
  const followCamera = useUiStore((s) => s.followCamera);
  const focusRequest = useUiStore((s) => s.focusRequest);
  const filters = useUiStore((s) => s.filters);
  const lod = useUiStore((s) => s.lod);
  const collapsed = useUiStore((s) => collapsedFor(s, runId));
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);

  const rf = useReactFlow<CanvasNode>();
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [arrangeNonce, setArrangeNonce] = useState(0);
  /** Bumps when the canvas element itself changes size. */
  const [viewNonce, setViewNonce] = useState(0);
  const [perf, setPerf] = useState<{ mode: LayoutMode; ms: number; nodes: number }>({
    mode: 'none',
    ms: 0,
    nodes: 0,
  });
  const didFitRef = useRef<string | null>(null);
  const lastFollowRef = useRef('');
  const handledFocusRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Latest laid-out nodes, for callbacks registered once (the palette). */
  const nodesRef = useRef<CanvasNode[]>([]);
  const placedRef = useRef(new Map<string, Placed>());
  const autoCollapsedRef = useRef<string | null>(null);
  const lastLayoutAtRef = useRef(0);
  const forceRef = useRef(false);
  /** Pending camera move, so a burst of events produces one move. */
  const cameraTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Live inspector width for callbacks that outlive a render. */
  const insetRef = useRef(0);
  /**
   * Where the camera is (or is on its way to).
   *
   * Not `rf.getViewport()`: mid-animation that returns an interpolated frame,
   * so "is this node comfortably visible?" would be answered about a viewport
   * that is about to stop existing — and a camera decision taken against a
   * moving target oscillates. `onMove` keeps this honest when the *user* pans
   * or zooms, which is the only other thing that moves it.
   */
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });

  const viewSize = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return undefined;
    const width = el.clientWidth;
    const height = el.clientHeight;
    if (width === 0 || height === 0) return undefined;
    return { width, height };
  }, []);

  const insetsFor = useCallback((view: { width: number; height: number }): Insets => {
    const panel = insetRef.current;
    if (panel <= 0) return {};
    return view.width - panel >= MIN_CANVAS_AFTER_INSPECTOR ? { right: panel } : {};
  }, []);

  insetRef.current = inspectorWidth;

  /**
   * Apply a viewport, once, after the current burst of events.
   *
   * A fan-out is six `node.started` envelopes in the same tick, and each one
   * re-runs the follow effect; without coalescing the camera would start six
   * animations, each interrupting the last a frame in, and crawl. A zero
   * timeout (not `requestAnimationFrame`) because rAF does not run in a tab
   * that is not compositing — a viewer left in a background tab would come
   * back with a camera that had queued up moves and made none of them.
   */
  const applyViewport = useCallback(
    (target: Viewport, duration: number) => {
      // A move to where the camera already is, is not a move. Re-issuing one
      // starts an animation, and an animation the eye can just about see for
      // no reason at all is the definition of noise.
      if (viewportDistance(viewportRef.current, target) < 6) return;
      clearTimeout(cameraTimerRef.current);
      viewportRef.current = target;
      cameraTimerRef.current = setTimeout(() => {
        rf.setViewport(target, { duration: motionMs(duration) });
      }, 0);
    },
    [rf],
  );

  useEffect(() => () => clearTimeout(cameraTimerRef.current), []);

  /**
   * The canvas changing size is a camera event.
   *
   * Docking the inspector, dragging its edge, opening the waterfall or
   * resizing the window all change how much of the graph fits — and a run
   * that is *held* has no further events to re-trigger the follow decision,
   * so without this the frame the product exists for would be left half off
   * screen by a window resize. Debounced so a drag re-frames once, at the
   * end, instead of animating against itself sixty times a second.
   */
  useEffect(() => {
    const element = containerRef.current;
    if (element === null || typeof ResizeObserver !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setViewNonce((n) => n + 1), 260);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  /** Frame a set of boxes in the visible part of the canvas. */
  const frameBoxes = useCallback(
    (boxes: readonly Box[], options: { padding?: number; duration?: number } = {}): boolean => {
      const view = viewSize();
      const bounds = boundsOf(boxes);
      if (view === undefined || bounds === undefined) return false;
      applyViewport(
        frameViewport(bounds, view, {
          padding: options.padding ?? 0.16,
          insets: insetsFor(view),
          minZoom: MIN_ZOOM,
          maxZoom: 1,
        }),
        options.duration ?? 0,
      );
      return true;
    },
    [applyViewport, insetsFor, viewSize],
  );

  // A different run: forget every cached position.
  useEffect(() => {
    placedRef.current = new Map();
    didFitRef.current = null;
    lastFollowRef.current = '';
  }, [runId]);

  // A large run opens folded (see collapse.ts) — once per run, and only
  // while the user hasn't folded anything themselves.
  useEffect(() => {
    if (autoCollapsedRef.current === runId) return;
    const run = useRunStore.getState().runs[runId];
    if (run === undefined || run.order.length <= AUTO_COLLAPSE_NODES) return;
    autoCollapsedRef.current = runId;
    const ui = useUiStore.getState();
    if (collapsedFor(ui, runId).length > 0) return;
    const roots = autoCollapseRoots(run);
    if (roots.length === 0) return;
    ui.setCollapsed(runId, roots);
    // The folded graph is a completely different shape — frame it again.
    didFitRef.current = null;
  }, [runId, structureVersion]);

  const applyLayout = useCallback(() => {
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) {
      setNodes([]);
      setEdges([]);
      placedRef.current = new Map();
      return;
    }
    const graph = runStateToFlow(run, { collapsed });
    const prev = placedRef.current;
    const force = forceRef.current;
    forceRef.current = false;
    const mode = planLayout(prev, graph, { force });

    const started = performance.now();
    let positioned;
    if (mode === 'full') {
      const laid = layoutGraph(graph.nodes, graph.edges);
      positioned = force ? laid : anchorPositions(prev, laid);
    } else if (mode === 'append') {
      positioned = appendLayout(prev, graph);
    } else {
      positioned = resizeOnly(prev, graph);
    }
    const elapsed = performance.now() - started;
    lastLayoutAtRef.current = Date.now();

    const next = new Map<string, Placed>();
    for (const node of positioned) {
      next.set(node.id, {
        id: node.id,
        position: node.position,
        width: node.width,
        height: node.height,
      });
    }

    // Causality: a card that has just been placed animates in *from its
    // caller*, so a fan-out reads as one node calling five and not as five
    // cards materialising out of the background. The offset is written as a
    // CSS custom property on the React Flow wrapper; index.css owns the
    // curve, and switches the whole thing off under reduced motion and on a
    // graph too big to afford it.
    const parentOf = new Map<string, string>();
    for (const edge of graph.edges) {
      if (!parentOf.has(edge.target)) parentOf.set(edge.target, edge.source);
    }
    const centreOf = (id: string): { x: number; y: number } | undefined => {
      const placed = next.get(id);
      if (placed === undefined) return undefined;
      return { x: placed.position.x + placed.width / 2, y: placed.position.y + placed.height / 2 };
    };

    placedRef.current = next;

    const matching = isFilterActive(filters) ? matchingNodeIds(run, filters) : undefined;
    setNodes((previous) => {
      const byId = new Map(previous.map((n) => [n.id, n]));
      return positioned.map((p) => {
        const old = byId.get(p.id);
        const className = matching !== undefined && !matching.has(p.id) ? 'gm-dim' : undefined;
        // `data` is the card's POINTER INTO THE STORE ({runId, nodeId}) — the
        // card reads its own state through it. Reusing the previous node to
        // avoid a re-render is only sound while that pointer is unchanged.
        //
        // Two runs of the same agent have the same node ids and the same
        // shape, so the layout is identical and every position matches: the
        // fast path below would hand back the OLD run's node wholesale and
        // the canvas would render the previous run's results under the new
        // run's header. Cheap to compare, and not comparing it made the
        // debugger show you someone else's answers.
        const sameRun =
          old !== undefined && old.data.runId === p.data.runId && old.data.nodeId === p.data.nodeId;
        if (old !== undefined && canReuseFlowNode(old, p, className)) return old;
        const style =
          old?.style ??
          (() => {
            const parentId = parentOf.get(p.id);
            const from = enterOffset(
              centreOf(p.id) ?? { x: p.position.x, y: p.position.y },
              parentId === undefined ? undefined : centreOf(parentId),
            );
            return { '--gm-in-x': `${from.x}px`, '--gm-in-y': `${from.y}px` } as React.CSSProperties;
          })();
        return {
          id: p.id,
          type: p.type,
          position: p.position,
          data: sameRun && old !== undefined ? old.data : p.data,
          width: p.width,
          height: p.height,
          style,
          ...(className !== undefined ? { className } : {}),
          draggable: true,
          connectable: false,
          deletable: false,
          selectable: false,
        } satisfies CanvasNode;
      });
    });
    setEdges(
      graph.edges.map((edge) =>
        toEdge(edge, run, matching !== undefined && !matching.has(edge.target)),
      ),
    );
    setPerf({ mode, ms: elapsed, nodes: graph.nodes.length });
  }, [runId, collapsed, filters]);

  // Frame a run once its cards exist. Instant, not animated: a fit the user
  // didn't ask for should feel like the page loading, not like the camera
  // being taken away from them.
  useEffect(() => {
    if (nodes.length === 0 || didFitRef.current === runId) return;
    if (frameBoxes(nodes.map(boxOf), { padding: 0.16 })) {
      didFitRef.current = runId;
    }
  }, [nodes, runId, frameBoxes]);

  // ── structural changes → (debounced) layout ──────────────────────────────
  useEffect(() => {
    const since = Date.now() - lastLayoutAtRef.current;
    const delay = since > LAYOUT_MAX_WAIT_MS ? 0 : LAYOUT_DEBOUNCE_MS;
    const timer = setTimeout(() => applyLayout(), delay);
    return () => clearTimeout(timer);
  }, [applyLayout, structureVersion, arrangeNonce]);

  // ── lifecycle changes → restyle edges + filter dimming (no layout) ───────
  useEffect(() => {
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return;
    const matching = isFilterActive(filters) ? matchingNodeIds(run, filters) : undefined;
    // Returning `prev` unchanged matters: a fresh array here would re-render
    // every edge on every ingested event.
    setEdges((prev) => {
      let changed = false;
      const next = prev.map((edge) => {
        const className = `gm-edge-${edgeVisual(run, edge.target)}${
          matching !== undefined && !matching.has(edge.target) ? ' gm-dim' : ''
        }`;
        if (edge.className === className) return edge;
        changed = true;
        return { ...edge, className };
      });
      return changed ? next : prev;
    });
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((node) => {
        const className = matching !== undefined && !matching.has(node.id) ? 'gm-dim' : undefined;
        if (node.className === className) return node;
        changed = true;
        const { className: _drop, ...rest } = node;
        return className === undefined ? (rest as CanvasNode) : { ...rest, className };
      });
      return changed ? next : prev;
    });
  }, [runId, statusVersion, filters]);

  // ── follow the active node ───────────────────────────────────────────────
  //
  // Two rules keep this from turning into motion sickness:
  //  - a node already comfortably on screen does not move the camera. Six
  //    tools fanning out of one step used to yank the viewport six times for
  //    a graph that already fitted;
  //  - a gate is different. It is a full stop, so it always re-frames, sits
  //    slightly above centre (the action row grows downwards) and gets a
  //    guaranteed legible zoom.
  useEffect(() => {
    if (!followCamera) return;
    const run = useRunStore.getState().runs[runId];
    const view = viewSize();
    if (run === undefined || view === undefined || nodes.length === 0) return;
    const insets = insetsFor(view);
    const focus = pickFocusNode(run);

    if (focus === undefined) {
      // Run settled → fit the whole graph once.
      const key = `fit:${runId}:${structureVersion}`;
      if (
        run.meta.status !== 'running' &&
        run.meta.status !== 'pending' &&
        lastFollowRef.current !== key
      ) {
        lastFollowRef.current = key;
        frameBoxes(nodes.map(boxOf), { padding: 0.16, duration: DURATION.follow });
      }
      return;
    }

    const node = nodes.find((n) => n.id === focus.nodeId);
    if (node === undefined) return; // not laid out yet — retry when it is
    const box = boxOf(node);
    const held = focus.reason === 'pause';

    // Key on the laid-out position and on *why* we are looking: a re-layout
    // that moves the focused node re-centres on it, and a gate opening pulls
    // the camera back to a node the run already ran through.
    //
    // A held gate also keys on the inspector's width. Selecting the paused
    // node opens the inspector *after* the camera has already framed the
    // node, and without this the panel then slides over the frame it was
    // opened to explain.
    const key = `${runId}:${focus.nodeId}:${focus.reason}:${Math.round(box.x)},${Math.round(
      box.y,
    )}:${insets.right ?? 0}:${Math.round(view.width)}x${Math.round(view.height)}`;
    if (lastFollowRef.current === key) return;

    const current = viewportRef.current;

    // Rule 1 — while the whole run still fits at a legible size, keep the
    // whole run framed. "Where did that come from?" and "what else is
    // running?" are answered by the same picture, and the camera stops
    // lurching once per arrival. `applyViewport` no-ops when the frame has
    // not actually changed, so this costs one move per new layer, not one
    // per event.
    if (!held) {
      const whole = boundsOf(nodes.map(boxOf));
      if (whole !== undefined) {
        const framed = frameViewport(whole, view, {
          padding: 0.16,
          insets,
          minZoom: MIN_ZOOM,
          maxZoom: 1,
        });
        if (framed.zoom >= WIDE_ENOUGH_ZOOM) {
          lastFollowRef.current = key;
          applyViewport(framed, DURATION.follow);
          return;
        }
      }
      // Rule 2 — too big to show whole. Chase, but only what has left the
      // screen: six parallel tools on a graph that already fits used to yank
      // the viewport six times.
      if (isComfortablyVisible(box, current, view, insets)) {
        lastFollowRef.current = key;
        return;
      }
    }
    lastFollowRef.current = key;

    // Rule 3 — a gate is a full stop. It always re-frames, sits a little
    // above centre (the action row grows downwards) and gets a zoom at which
    // its buttons are readable.
    const zoom = held
      ? Math.max(0.85, Math.min(current.zoom, 1.15))
      : Math.max(0.72, Math.min(current.zoom, 1.1));
    applyViewport(
      centerViewport(box, view, { zoom, insets, bias: held ? 0.16 : 0 }),
      held ? DURATION.hold : DURATION.follow,
    );
  }, [
    followCamera,
    statusVersion,
    structureVersion,
    nodes,
    runId,
    rf,
    viewSize,
    insetsFor,
    frameBoxes,
    applyViewport,
    inspectorWidth,
    viewNonce,
  ]);

  // ── explicit focus requests (palette, deep links, timeline) ──────────────
  useEffect(() => {
    if (focusRequest === undefined || handledFocusRef.current === focusRequest.nonce) return;
    const node = nodes.find((n) => n.id === focusRequest.nodeId);
    const view = viewSize();
    if (node === undefined || view === undefined) return; // not laid out yet
    handledFocusRef.current = focusRequest.nonce;
    applyViewport(
      centerViewport(boxOf(node), view, {
        zoom: Math.max(0.9, viewportRef.current.zoom),
        insets: insetsFor(view),
      }),
      DURATION.focus,
    );
  }, [focusRequest, nodes, rf, viewSize, insetsFor, applyViewport]);

  // ── expose canvas verbs to the command palette ───────────────────────────
  useEffect(
    () =>
      registerCanvasActions({
        fitView: () =>
          void frameBoxes(nodesRef.current.map(boxOf), {
            padding: 0.16,
            duration: DURATION.frame,
          }),
        arrange: () => {
          forceRef.current = true;
          setArrangeNonce((n) => n + 1);
        },
        focusNode: (nodeId) => useUiStore.getState().requestFocus(nodeId),
        zoomIn: () => void rf.zoomIn({ duration: motionMs(200) }),
        zoomOut: () => void rf.zoomOut({ duration: motionMs(200) }),
      }),
    [rf, frameBoxes],
  );

  nodesRef.current = nodes;

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setNodes((nds) => {
      const next = applyNodeChanges(changes, nds);
      // Keep the incremental layout's memory in sync with manual drags.
      for (const change of changes) {
        if (change.type !== 'position' || change.dragging === true) continue;
        const moved = next.find((n) => n.id === change.id);
        if (moved === undefined) continue;
        const entry = placedRef.current.get(moved.id);
        if (entry !== undefined) placedRef.current.set(moved.id, { ...entry, position: moved.position });
      }
      return next;
    });
  }, []);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: CanvasNode) => {
      useUiStore.getState().selectNode(runId, node.id);
    },
    [runId],
  );

  const onPaneClick = useCallback(() => {
    useUiStore.getState().selectNode(runId, undefined);
  }, [runId]);

  /** The user panning or zooming is the other thing that moves the camera. */
  const onMove = useCallback((_event: unknown, viewport: Viewport) => {
    viewportRef.current = viewport;
  }, []);

  const toggleFollow = useUiStore((s) => s.toggleFollow);

  const minimapColor = useCallback(
    (node: CanvasNode) => {
      const run = useRunStore.getState().runs[runId];
      const state = run?.nodes[node.id];
      if (state === undefined) return 'var(--ghost)';
      return MINIMAP_COLORS[nodeStatus(state)] ?? 'var(--ghost)';
    },
    [runId],
  );

  const showMinimap = nodes.length > 8;
  const bigGraph = nodes.length > VIRTUALIZE_ABOVE;
  const lodLabel = useMemo(
    () => (lod === 'full' ? 'detail' : lod === 'compact' ? 'compact' : 'overview'),
    [lod],
  );

  return (
    <div
      className={`gm-canvas gm-lod-${lod}${bigGraph ? ' gm-canvas--big' : ''}`}
      ref={containerRef}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onMove={onMove}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        elementsSelectable={false}
        nodesConnectable={false}
        onlyRenderVisibleElements={bigGraph}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} color="var(--grid-dot)" />
        <LodWatcher nodeCount={nodes.length} />
        {showMinimap && (
          <MiniMap
            className="gm-minimap"
            pannable
            zoomable
            ariaLabel="Graph minimap"
            nodeColor={minimapColor}
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
            maskColor="var(--minimap-mask)"
            bgColor="var(--minimap-bg)"
          />
        )}
      </ReactFlow>

      <div className="gm-canvas-controls">
        <button
          className="gm-iconbtn"
          title="Fit view (⇧F)"
          aria-label="Fit view"
          onClick={() =>
            void frameBoxes(nodes.map(boxOf), { padding: 0.16, duration: DURATION.frame })
          }
        >
          <IconFit />
        </button>
        <button
          className={`gm-iconbtn${followCamera ? ' gm-iconbtn--on' : ''}`}
          title="Follow the active node (f)"
          aria-label="Follow the active node"
          aria-pressed={followCamera}
          onClick={toggleFollow}
        >
          {followCamera ? <IconEye /> : <IconEyeOff />}
        </button>
        <button
          className="gm-iconbtn"
          title="Re-arrange the layout (⇧A)"
          aria-label="Re-arrange the layout"
          onClick={() => {
            forceRef.current = true;
            setArrangeNonce((n) => n + 1);
          }}
        >
          <IconArrange />
        </button>
      </div>

      {nodes.length > 40 && (
        <div
          className="gm-canvas-hud"
          title={`Layout: ${perf.mode} pass over ${perf.nodes} nodes in ${perf.ms.toFixed(2)}ms. Detail drops automatically as you zoom out.`}
        >
          <IconLayers width={11} height={11} />
          {perf.nodes} nodes · {lodLabel}
        </div>
      )}
    </div>
  );
}
