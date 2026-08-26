/**
 * The graph. ELK lays nodes out on structural change only; per-token
 * updates flow through the token-buffer registry straight into the node
 * cards, so the React Flow `nodes` array stays referentially stable while
 * a step streams. Ported behaviours from the legacy Flow.jsx: ELK
 * mrtree/radial pipeline, follow-active-node camera with an eye toggle,
 * auto-arrange, fuzzy search.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import { layoutGraph } from '../layout/elkLayout.js';
import { motionMs } from '../lib/motion.js';
import {
  edgeVisual,
  runStateToFlow,
  type FlowEdgeSpec,
  type FlowNodeData,
} from '../store/runStateToFlow.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import type { RunState } from '../store/types.js';
import { InvocationNode } from './nodes/InvocationNode.js';
import { LlmStepNode } from './nodes/LlmStepNode.js';
import { ToolNode } from './nodes/ToolNode.js';
import { IconArrange, IconEye, IconEyeOff, IconFit, IconSearch } from './Icons.js';
import { SearchOverlay } from './SearchOverlay.js';

type CanvasNode = Node<FlowNodeData>;

const nodeTypes: NodeTypes = {
  invocation: InvocationNode,
  llmStep: LlmStepNode,
  tool: ToolNode,
};

function toEdge(spec: FlowEdgeSpec, run: RunState | undefined): Edge {
  const visual = run === undefined ? 'idle' : edgeVisual(run, spec.target);
  return {
    id: spec.id,
    source: spec.source,
    target: spec.target,
    type: 'default',
    className: `gm-edge-${visual}`,
  };
}

/** The node the camera should chase: an active pause wins, else the most recently started running execution. */
function pickFocusNode(run: RunState): string | undefined {
  for (const pauseId of Object.keys(run.pauses)) {
    const pause = run.pauses[pauseId];
    if (pause !== undefined && pause.active) return pause.nodeId;
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
  return best;
}

export function RunCanvas({ runId }: { runId: string }) {
  const structureVersion = useRunStore((s) => s.runs[runId]?.structureVersion ?? -1);
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? -1);
  const followCamera = useUiStore((s) => s.followCamera);
  const focusRequest = useUiStore((s) => s.focusRequest);
  const searchOpen = useUiStore((s) => s.searchOpen);

  const rf = useReactFlow<CanvasNode>();
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [arrangeNonce, setArrangeNonce] = useState(0);
  const didFitRef = useRef<string | null>(null);
  const lastFollowRef = useRef('');
  const handledFocusRef = useRef(0);

  // ── structural changes → ELK layout ──────────────────────────────────────
  useEffect(() => {
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const graph = runStateToFlow(run);
    let cancelled = false;
    void layoutGraph(graph.nodes, graph.edges).then((positioned) => {
      if (cancelled) return;
      const currentRun = useRunStore.getState().runs[runId];
      setNodes((prev) => {
        const prevById = new Map(prev.map((n) => [n.id, n]));
        return positioned.map((p) => {
          const old = prevById.get(p.id);
          if (
            old !== undefined &&
            old.position.x === p.position.x &&
            old.position.y === p.position.y &&
            old.width === p.width &&
            old.height === p.height
          ) {
            return old;
          }
          return {
            id: p.id,
            type: p.type,
            position: p.position,
            data: p.data,
            width: p.width,
            height: p.height,
            draggable: true,
            connectable: false,
            deletable: false,
            selectable: false,
          } satisfies CanvasNode;
        });
      });
      setEdges(graph.edges.map((e) => toEdge(e, currentRun)));
      if (didFitRef.current !== runId) {
        didFitRef.current = runId;
        requestAnimationFrame(() => {
          void rf.fitView({ padding: 0.2, duration: motionMs(700) });
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [runId, structureVersion, arrangeNonce, rf]);

  // ── lifecycle changes → restyle edges (no layout) ────────────────────────
  useEffect(() => {
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return;
    setEdges((prev) =>
      prev.map((edge) => {
        const className = `gm-edge-${edgeVisual(run, edge.target)}`;
        return edge.className === className ? edge : { ...edge, className };
      }),
    );
  }, [runId, statusVersion]);

  // ── follow-active-node camera (legacy eye toggle) ────────────────────────
  useEffect(() => {
    if (!followCamera) return;
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return;
    const focusId = pickFocusNode(run);
    if (focusId === undefined) {
      // Run settled → fit the whole graph once.
      const key = `fit:${runId}:${structureVersion}`;
      if (run.meta.status !== 'running' && run.meta.status !== 'pending' && lastFollowRef.current !== key && nodes.length > 0) {
        lastFollowRef.current = key;
        void rf.fitView({ padding: 0.18, duration: motionMs(900) });
      }
      return;
    }
    const node = nodes.find((n) => n.id === focusId);
    if (node === undefined) return;
    // Key on the laid-out position too: a re-layout (pause banner, new
    // sibling) that moves the focused node re-centers the camera on it.
    const key = `${runId}:${focusId}:${Math.round(node.position.x)},${Math.round(node.position.y)}`;
    if (lastFollowRef.current === key) return;
    lastFollowRef.current = key;
    void rf.setCenter(
      node.position.x + (node.width ?? 0) / 2,
      node.position.y + (node.height ?? 0) / 2,
      { zoom: 0.92, duration: motionMs(650) },
    );
  }, [followCamera, statusVersion, structureVersion, nodes, runId, rf]);

  // ── explicit focus requests (search, deep links) ─────────────────────────
  useEffect(() => {
    if (focusRequest === undefined || handledFocusRef.current === focusRequest.nonce) return;
    const node = nodes.find((n) => n.id === focusRequest.nodeId);
    if (node === undefined) return; // not laid out yet — retry when nodes land
    handledFocusRef.current = focusRequest.nonce;
    void rf.setCenter(
      node.position.x + (node.width ?? 0) / 2,
      node.position.y + (node.height ?? 0) / 2,
      { zoom: 1, duration: motionMs(550) },
    );
  }, [focusRequest, nodes, rf]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

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
  const setSearchOpen = useUiStore((s) => s.setSearchOpen);

  return (
    <div className="absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        minZoom={0.2}
        maxZoom={1.75}
        elementsSelectable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} color="var(--grid-dot)" />
      </ReactFlow>

      <div className="gm-canvas-controls">
        <button
          className="gm-iconbtn"
          title="Fit view"
          onClick={() => void rf.fitView({ padding: 0.18, duration: motionMs(600) })}
        >
          <IconFit />
        </button>
        <button
          className={`gm-iconbtn${followCamera ? ' gm-iconbtn--on' : ''}`}
          title="Follow active node (f)"
          onClick={toggleFollow}
        >
          {followCamera ? <IconEye /> : <IconEyeOff />}
        </button>
        <button
          className="gm-iconbtn"
          title="Auto-arrange nodes"
          onClick={() => setArrangeNonce((n) => n + 1)}
        >
          <IconArrange />
        </button>
        <button className="gm-iconbtn" title="Search nodes (/)" onClick={() => setSearchOpen(true)}>
          <IconSearch />
        </button>
      </div>

      {searchOpen && <SearchOverlay runId={runId} />}
    </div>
  );
}
