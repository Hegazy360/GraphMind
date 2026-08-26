/**
 * ELK layout pipeline, ported from the legacy Flow.jsx
 * `getLayoutedElements`: mrtree for small graphs, radial once the node
 * count grows past 10. Runs ONLY on structural change — never per token.
 */
import type ELKType from 'elkjs';
import type { ElkNode } from 'elkjs';
import type { FlowEdgeSpec, FlowNodeSpec } from '../store/runStateToFlow.js';

// elkjs is ~1.4MB — load it as its own async chunk on first layout.
let elkPromise: Promise<InstanceType<typeof ELKType>> | undefined;

function getElk(): Promise<InstanceType<typeof ELKType>> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => new ELK());
  return elkPromise;
}

export interface PositionedNode extends FlowNodeSpec {
  position: { x: number; y: number };
}

export function elkOptionsFor(nodeCount: number): Record<string, string> {
  return nodeCount > 10
    ? {
        'elk.algorithm': 'org.eclipse.elk.radial',
        'org.eclipse.elk.spacing.nodeNode': '70',
      }
    : {
        'elk.algorithm': 'org.eclipse.elk.mrtree',
        'elk.direction': 'DOWN',
        'org.eclipse.elk.spacing.nodeNode': '55',
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
