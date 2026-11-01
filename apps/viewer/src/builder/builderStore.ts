/**
 * What the Build page remembers while you look at a run and come back: the
 * graph being drawn, which node is selected, the project it was written to,
 * and the job running it.
 *
 * Deliberately NOT here: any secret. API keys live in a password field's
 * component state for the length of one request, then nowhere — not in this
 * store, not in localStorage, not in the URL.
 */
import { create } from 'zustand';
import {
  ROOT_ID,
  addEdge,
  defaultGraph,
  makeNode,
  patchNode,
  removeEdge,
  removeNode,
  type GraphNode,
  type NodeKind,
  type WorkflowGraph,
} from './graph.js';
import type { CreateResponse, JobInfo, JobLine } from './types.js';

interface BuilderState {
  graph: WorkflowGraph;
  /** The node whose fields the inspector shows. */
  selectedId: string | undefined;
  /** Path of the generated file shown in the code panel. */
  selectedFile: string | undefined;
  /** The project on disk, once Create has run for this graph. */
  created: CreateResponse | undefined;
  job: JobInfo | undefined;
  lines: JobLine[];

  setGraph: (graph: WorkflowGraph) => void;
  patchGraph: (patch: Partial<WorkflowGraph>) => void;
  select: (id: string | undefined) => void;
  addNode: (kind: Exclude<NodeKind, 'agent'>, at: { x: number; y: number }, connectTo?: string) => string;
  updateNode: (id: string, patch: Partial<GraphNode>) => void;
  moveNode: (id: string, at: { x: number; y: number }) => void;
  deleteNode: (id: string) => void;
  connect: (from: string, to: string) => void;
  disconnect: (edgeId: string) => void;
  selectFile: (path: string | undefined) => void;
  setCreated: (created: CreateResponse | undefined) => void;
  setJob: (job: JobInfo | undefined) => void;
  appendLines: (lines: readonly JobLine[]) => void;
  resetJob: () => void;
  reset: () => void;
}

/** Lines kept on the page; the server keeps its own, larger, buffer. */
const MAX_LINES = 1500;

export const useBuilderStore = create<BuilderState>((set) => ({
  graph: defaultGraph(),
  selectedId: ROOT_ID,
  selectedFile: undefined,
  created: undefined,
  job: undefined,
  lines: [],

  setGraph: (graph) => set({ graph }),
  patchGraph: (patch) => set((s) => ({ graph: { ...s.graph, ...patch } })),
  select: (selectedId) => set({ selectedId }),
  addNode: (kind, at, connectTo) => {
    const node = makeNode(kind, useBuilderStore.getState().graph, at);
    set((s) => {
      const withNode: WorkflowGraph = { ...s.graph, nodes: [...s.graph.nodes, node] };
      // A new node arrives wired to the agent that asked for it: an
      // unconnected node is a node that does nothing, which is never what
      // was meant by placing it.
      const graph = connectTo === undefined ? withNode : addEdge(withNode, connectTo, node.id);
      return { graph, selectedId: node.id };
    });
    return node.id;
  },
  updateNode: (id, patch) => set((s) => ({ graph: patchNode(s.graph, id, patch) })),
  moveNode: (id, at) => set((s) => ({ graph: patchNode(s.graph, id, { x: at.x, y: at.y }) })),
  deleteNode: (id) =>
    set((s) => ({
      graph: removeNode(s.graph, id),
      selectedId: s.selectedId === id ? ROOT_ID : s.selectedId,
    })),
  connect: (from, to) => set((s) => ({ graph: addEdge(s.graph, from, to) })),
  disconnect: (edgeId) => set((s) => ({ graph: removeEdge(s.graph, edgeId) })),
  selectFile: (path) => set({ selectedFile: path }),
  setCreated: (created) => set({ created }),
  setJob: (job) => set({ job }),
  appendLines: (lines) =>
    set((s) => {
      if (lines.length === 0) return s;
      const last = s.lines[s.lines.length - 1]?.i ?? -1;
      const fresh = lines.filter((line) => line.i > last);
      if (fresh.length === 0) return s;
      const next = [...s.lines, ...fresh];
      return { lines: next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next };
    }),
  resetJob: () => set({ job: undefined, lines: [] }),
  reset: () =>
    set({ graph: defaultGraph(), selectedId: ROOT_ID, selectedFile: undefined, created: undefined, job: undefined, lines: [] }),
}));
