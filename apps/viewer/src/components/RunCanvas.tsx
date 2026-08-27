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
import { registerCanvasActions } from '../lib/commands.js';
import { motionMs } from '../lib/motion.js';
import { autoCollapseRoots } from '../store/collapse.js';
import { isFilterActive, matchingNodeIds } from '../store/filters.js';
import {
  edgeVisual,
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

/**
 * Framing a run is fiddlier than it looks. `fitView` before React Flow has
 * measured a single card computes an infinite bounding box — which lands a
 * NaN transform on the viewport and blanks the canvas with no way back — and
 * a call issued in the same commit as the nodes themselves is simply dropped.
 * So: only fit once something is measured, then confirm the viewport actually
 * moved, and retry a few frames if it didn't.
 */
interface Framed {
  position: { x: number; y: number };
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * Frame a set of nodes ourselves rather than calling `fitView`.
 *
 * React Flow only fits nodes it has *measured*, and measurement is a DOM
 * round-trip that hasn't happened on the frame a run first lays out — the
 * call is silently dropped (in v12 its promise never even settles) and the
 * user is left staring at the top-left corner of a 2,400px graph. We already
 * know every box exactly, because we just laid them out, so the viewport
 * maths is ours to do: no measurement, no race, no animation to interrupt.
 */
function frameNodes(
  rf: ReturnType<typeof useReactFlow<CanvasNode>>,
  container: HTMLElement | null,
  framed: readonly Framed[],
  options: { padding?: number; duration?: number; maxZoom?: number } = {},
): boolean {
  if (container === null || framed.length === 0) return false;
  const viewWidth = container.clientWidth;
  const viewHeight = container.clientHeight;
  if (viewWidth === 0 || viewHeight === 0) return false;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of framed) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + (node.width ?? 0));
    maxY = Math.max(maxY, node.position.y + (node.height ?? 0));
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const padding = options.padding ?? 0.14;
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(
      options.maxZoom ?? 1,
      Math.min(viewWidth / (width * (1 + padding)), viewHeight / (height * (1 + padding))),
    ),
  );
  rf.setViewport(
    {
      x: viewWidth / 2 - (minX + width / 2) * zoom,
      y: viewHeight / 2 - (minY + height / 2) * zoom,
      zoom,
    },
    { duration: motionMs(options.duration ?? 0) },
  );
  return true;
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

  const rf = useReactFlow<CanvasNode>();
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [arrangeNonce, setArrangeNonce] = useState(0);
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
    placedRef.current = next;

    const matching = isFilterActive(filters) ? matchingNodeIds(run, filters) : undefined;
    setNodes((previous) => {
      const byId = new Map(previous.map((n) => [n.id, n]));
      return positioned.map((p) => {
        const old = byId.get(p.id);
        const className = matching !== undefined && !matching.has(p.id) ? 'gm-dim' : undefined;
        if (
          old !== undefined &&
          old.position.x === p.position.x &&
          old.position.y === p.position.y &&
          old.width === p.width &&
          old.height === p.height &&
          old.type === p.type &&
          old.className === className
        ) {
          return old;
        }
        return {
          id: p.id,
          type: p.type,
          position: p.position,
          data: old?.data ?? p.data,
          width: p.width,
          height: p.height,
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
    if (frameNodes(rf, containerRef.current, nodes, { padding: 0.16 })) {
      didFitRef.current = runId;
    }
  }, [nodes, runId, rf]);

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

  // ── follow-active-node camera (legacy eye toggle) ────────────────────────
  useEffect(() => {
    if (!followCamera) return;
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return;
    const focus = pickFocusNode(run);
    if (focus === undefined) {
      // Run settled → fit the whole graph once.
      const key = `fit:${runId}:${structureVersion}`;
      if (
        run.meta.status !== 'running' &&
        run.meta.status !== 'pending' &&
        lastFollowRef.current !== key &&
        nodes.length > 0
      ) {
        lastFollowRef.current = key;
        frameNodes(rf, containerRef.current, nodes, { padding: 0.16, duration: 700 });
      }
      return;
    }
    const node = nodes.find((n) => n.id === focus.nodeId);
    if (node === undefined) return;
    // Key on the laid-out position and on *why* we are looking: a re-layout
    // that moves the focused node re-centres on it, and a gate opening pulls
    // the camera back to a node the run already ran through.
    const key = `${runId}:${focus.nodeId}:${focus.reason}:${Math.round(node.position.x)},${Math.round(node.position.y)}`;
    if (lastFollowRef.current === key) return;
    lastFollowRef.current = key;
    void rf.setCenter(
      node.position.x + (node.width ?? 0) / 2,
      node.position.y + (node.height ?? 0) / 2,
      { zoom: Math.max(0.72, Math.min(rf.getZoom(), 1.1)), duration: motionMs(650) },
    );
  }, [followCamera, statusVersion, structureVersion, nodes, runId, rf]);

  // ── explicit focus requests (palette, deep links, timeline) ──────────────
  useEffect(() => {
    if (focusRequest === undefined || handledFocusRef.current === focusRequest.nonce) return;
    const node = nodes.find((n) => n.id === focusRequest.nodeId);
    if (node === undefined) return; // not laid out yet — retry when nodes land
    handledFocusRef.current = focusRequest.nonce;
    void rf.setCenter(
      node.position.x + (node.width ?? 0) / 2,
      node.position.y + (node.height ?? 0) / 2,
      { zoom: Math.max(0.9, rf.getZoom()), duration: motionMs(550) },
    );
  }, [focusRequest, nodes, rf]);

  // ── expose canvas verbs to the command palette ───────────────────────────
  useEffect(
    () =>
      registerCanvasActions({
        fitView: () => frameNodes(rf, containerRef.current, nodesRef.current, { padding: 0.16, duration: 450 }),
        arrange: () => {
          forceRef.current = true;
          setArrangeNonce((n) => n + 1);
        },
        focusNode: (nodeId) => useUiStore.getState().requestFocus(nodeId),
        zoomIn: () => void rf.zoomIn({ duration: motionMs(200) }),
        zoomOut: () => void rf.zoomOut({ duration: motionMs(200) }),
      }),
    [rf],
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
          onClick={() => frameNodes(rf, containerRef.current, nodes, { padding: 0.16, duration: 450 })}
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
