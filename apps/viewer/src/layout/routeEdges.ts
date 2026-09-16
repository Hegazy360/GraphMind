/**
 * Orthogonal edge routing over a tidy-tree layout.
 *
 * Why this exists: React Flow's default edge is a bezier from the parent's
 * bottom handle to the child's top handle. With packed leaf blocks (five or
 * more childless siblings become a grid) every edge to a row >= 1 leaf passes
 * *through* the row-0 card above it — measured on a real MCP session, 6 of 11
 * edges crossed another card — and the curves peel away from the handles, so
 * the graph reads as cards floating near lines rather than a tree.
 *
 * The route for every edge, in layout coordinates (before any rendering):
 *
 *   1. leave the parent from its bottom-centre and drop to a **bus line** in
 *      the layer gap below it (all of a parent's edges share one bus, so a
 *      fan-out reads as one trunk splitting);
 *   2. run horizontally along the bus;
 *   3. for a branch child or a row-0 leaf: drop straight into its top-centre;
 *      for a packed leaf on row r >= 1: descend through the **column gutter**
 *      to the left of its column (the block's left margin for column 0), jog
 *      into the column at `top - leafRowGap/2`, and drop the last half gap
 *      onto the top-centre handle.
 *
 * Edges sharing a gutter (rows 1, 2, 3 … of the same column) are spread by
 * GUTTER_LANE_PX each, deeper rows further LEFT, so a shallower row's jog
 * never crosses a deeper row's drop.
 *
 * Corners are square here. The renderer (components/edges/GmEdge.tsx) rounds
 * them when it builds the path string, so the geometry harness sees exactly
 * the segments it reasons about: every first and last segment vertical, and
 * every horizontal run inside a gap no card occupies.
 *
 * O(edges): one pass to find each source's nearest child layer, one pass to
 * route. Nothing here looks at other edges' routes or scans the canvas.
 */
import type { FlowEdgeSpec } from '../store/runStateToFlow.js';
import type { LeafCell, PositionedNode } from './tidyTree.js';

export interface Point {
  x: number;
  y: number;
}

export interface RoutedEdge {
  source: string;
  target: string;
  /** Polyline from the source's bottom-centre to the target's top-centre. */
  points: Point[];
}

export interface RouteOptions {
  siblingGap: number;
  leafRowGap: number;
  layerGap: number;
}

/** Horizontal spread between lines sharing one gutter. */
export const GUTTER_LANE_PX = 3;
/** Shortest vertical stub an edge keeps at either end. */
const MIN_DROP = 8;

/** The smallest description of a card the router needs. */
export interface RoutableNode {
  id: string;
  position: Point;
  width: number;
  height: number;
  leafCell?: LeafCell | undefined;
}

export function routeEdges(
  positioned: readonly RoutableNode[],
  edges: readonly FlowEdgeSpec[],
  options: RouteOptions,
): Map<string, RoutedEdge> {
  const { siblingGap, leafRowGap, layerGap } = options;
  const byId = new Map<string, RoutableNode>();
  for (const node of positioned) byId.set(node.id, node);

  // Pass 1 — for each source, the top of its nearest forward child. The bus
  // sits halfway up the gap above that layer, which in a tidy-tree layout is
  // free of cards across the whole subtree.
  const nearestChildTop = new Map<string, number>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (target.position.y < source.position.y + source.height) continue; // backward edge
    const current = nearestChildTop.get(edge.source);
    if (current === undefined || target.position.y < current) {
      nearestChildTop.set(edge.source, target.position.y);
    }
  }

  // Pass 2 — route.
  const out = new Map<string, RoutedEdge>();
  const maxLane = Math.max(0, siblingGap / 2 - MIN_DROP / 2);
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;

    const sx = source.position.x + source.width / 2;
    const sBottom = source.position.y + source.height;
    const tx = target.position.x + target.width / 2;
    const tTop = target.position.y;

    // A target that is not below its source (a cycle the layout broke, a
    // dragged card, a DAG edge some future adapter emits): no gap to route
    // through, so draw the honest straight line rather than invent one.
    if (tTop < sBottom + 2 * MIN_DROP) {
      out.set(edge.id, { source: edge.source, target: edge.target, points: [{ x: sx, y: sBottom }, { x: tx, y: tTop }] });
      continue;
    }

    const childTop = nearestChildTop.get(edge.source) ?? tTop;
    const bus = busY(sBottom, childTop, layerGap);

    const cell = target.leafCell;
    const points: Point[] = [{ x: sx, y: sBottom }, { x: sx, y: bus }];
    if (cell !== undefined && cell.row >= 1 && cellHoldsTarget(cell, target, siblingGap)) {
      // The gutter left of the column. Deeper rows sit further left so the
      // jog of a shallower row (which starts at the lane and runs RIGHT into
      // its card) never meets the drop of a deeper one.
      const gutter = cell.blockLeft + cell.column * (cell.columnWidth + siblingGap) - siblingGap / 2;
      const lane = Math.min((cell.row - 1) * GUTTER_LANE_PX, maxLane);
      const gx = gutter - lane;
      const jogY = tTop - leafRowGap / 2;
      points.push({ x: gx, y: bus }, { x: gx, y: jogY }, { x: tx, y: jogY }, { x: tx, y: tTop });
    } else {
      points.push({ x: tx, y: bus }, { x: tx, y: tTop });
    }

    out.set(edge.id, { source: edge.source, target: edge.target, points: simplify(points) });
  }
  return out;
}

/**
 * The bus line for a parent: halfway up the layer gap above its nearest
 * child layer. Clamped so it stays below a parent that has grown in place
 * (a paused card eats 92 of the 118px gap) and above the children.
 */
function busY(sourceBottom: number, childTop: number, layerGap: number): number {
  let bus = childTop - layerGap / 2;
  if (bus < sourceBottom + MIN_DROP) bus = sourceBottom + MIN_DROP;
  if (bus > childTop - MIN_DROP) bus = (sourceBottom + childTop) / 2;
  return bus;
}

/**
 * The cell is layout memory; the card may have been dragged since. A cell
 * only steers the route while the card is still centred in it — otherwise
 * the gutter descent would end nowhere near the jog.
 */
function cellHoldsTarget(cell: LeafCell, target: RoutableNode, siblingGap: number): boolean {
  const cellCentre = cell.blockLeft + cell.column * (cell.columnWidth + siblingGap) + cell.columnWidth / 2;
  return Math.abs(target.position.x + target.width / 2 - cellCentre) < 0.5;
}

/** Drop zero-length segments and collinear middle points. */
function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last !== undefined && last.x === point.x && last.y === point.y) continue;
    const prev = out[out.length - 2];
    if (
      last !== undefined &&
      prev !== undefined &&
      ((prev.x === last.x && last.x === point.x) || (prev.y === last.y && last.y === point.y))
    ) {
      out[out.length - 1] = point;
      continue;
    }
    out.push(point);
  }
  return out;
}
