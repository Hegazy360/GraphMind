/**
 * ELK layout pipeline. Two changes matter for large runs:
 *
 *  1. **Off the main thread.** ELK runs in a Web Worker (`elk-worker.min.js`,
 *     loaded as its own asset), so laying out 300 nodes never blocks paint,
 *     input, or the streaming hot path. If a worker can't be created — old
 *     browser, blocked blob/worker URL, tests — we fall back to the bundled
 *     main-thread build. Fail-open, like the rest of GraphMind.
 *  2. **`layered` instead of `radial`.** Radial re-shuffles the entire graph
 *     whenever a node arrives; layered respects model order and grows
 *     downward, which is what a run actually looks like. `mrtree` stays for
 *     tiny graphs, where it is prettier.
 *
 * Layout runs ONLY on structural change — never per token — and mid-run
 * appends usually skip ELK entirely (see incremental.ts).
 */
import type { ElkNode } from 'elkjs';
import type { FlowEdgeSpec, FlowNodeSpec } from '../store/runStateToFlow.js';

interface ElkLike {
  layout: (graph: ElkNode) => Promise<ElkNode>;
}

export type LayoutBackend = 'worker' | 'main' | 'pending';

let backend: LayoutBackend = 'pending';
let elkPromise: Promise<ElkLike> | undefined;

/** Which engine served the last layout — surfaced in the perf overlay. */
export function layoutBackend(): LayoutBackend {
  return backend;
}

/** Algorithms we actually use; registering fewer speeds worker start-up. */
const ALGORITHMS = ['layered', 'mrtree'];

async function createWorkerElk(): Promise<ElkLike> {
  const [{ default: ELKConstructor }, { default: workerUrl }] = await Promise.all([
    import('elkjs/lib/elk-api.js'),
    import('elkjs/lib/elk-worker.min.js?url'),
  ]);
  const elk = new ELKConstructor({ workerUrl, algorithms: ALGORITHMS }) as unknown as ElkLike;
  // Prove the worker actually answers before we commit to it.
  await elk.layout({ id: 'probe', children: [{ id: 'a', width: 1, height: 1 }] });
  return elk;
}

async function createMainThreadElk(): Promise<ElkLike> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  return new ELK() as unknown as ElkLike;
}

function getElk(): Promise<ElkLike> {
  elkPromise ??= (async () => {
    if (typeof Worker === 'function') {
      try {
        const elk = await createWorkerElk();
        backend = 'worker';
        return elk;
      } catch (error) {
        console.warn('[graphmind] ELK worker unavailable, laying out on the main thread', error);
      }
    }
    const elk = await createMainThreadElk();
    backend = 'main';
    return elk;
  })();
  return elkPromise;
}

export interface PositionedNode extends FlowNodeSpec {
  position: { x: number; y: number };
}

/** Vertical gap between layers. Must exceed PAUSE_BANNER_HEIGHT so a paused
 *  card can grow in place without colliding with the layer below. */
export const LAYER_GAP = 118;
/** Horizontal gap between siblings in a layer. */
export const SIBLING_GAP = 46;

/** Above this many nodes the graph is laid out with the large-graph profile. */
export const LARGE_GRAPH_NODES = 12;

export function elkOptionsFor(nodeCount: number): Record<string, string> {
  if (nodeCount <= LARGE_GRAPH_NODES) {
    return {
      'elk.algorithm': 'mrtree',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': String(SIBLING_GAP),
      'elk.mrtree.spacing.nodeNode': String(SIBLING_GAP),
      'elk.padding': '[top=32,left=32,bottom=32,right=32]',
    };
  }
  return {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',
    // Model order keeps freshly-arrived siblings to the right of their
    // predecessors instead of re-sorting the whole layer.
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
    'elk.spacing.nodeNode': String(SIBLING_GAP),
    'elk.spacing.edgeNode': '24',
    'elk.padding': '[top=32,left=32,bottom=32,right=32]',
  };
}

export async function layoutGraph(
  nodes: FlowNodeSpec[],
  edges: FlowEdgeSpec[],
): Promise<PositionedNode[]> {
  if (nodes.length === 0) return [];
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: elkOptionsFor(nodes.length),
    children: nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const elk = await getElk();
  const laid = await elk.layout(graph);
  const byId = new Map<string, { x: number; y: number }>();
  for (const child of laid.children ?? []) {
    byId.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return nodes.map((node) => ({
    ...node,
    position: byId.get(node.id) ?? { x: 0, y: 0 },
  }));
}
