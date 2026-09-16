/**
 * The one edge type the canvas draws.
 *
 * The route (an orthogonal polyline in layout coordinates) is computed in
 * `RunCanvas.applyLayout` by `layout/routeEdges.ts` and arrives on
 * `edge.data.points`. This component rounds its corners and paints it.
 * Everything visual — colour, width, the marching-ants flow on a live edge,
 * the dashed ghost, the fade-in — stays in index.css on the same
 * `.react-flow__edge.gm-edge-<state> .react-flow__edge-path` selectors the
 * bezier edge used, so nothing about the state vocabulary changed.
 *
 * Why the route's endpoints are used and React Flow's `sourceX/Y`,
 * `targetX/Y` props are NOT: those props come from handle bounds React Flow
 * measures with `getBoundingClientRect` when a node mounts. The handles sit
 * inside `.gm-node`, and `.gm-node` is mid-way through its 420ms entrance
 * keyframe (a translate of up to ~100px plus a scale) at that moment, so the
 * cached bounds are offset by wherever the card happened to be in its slide
 * — for the life of the node. That is the "edges not sticking to the nodes"
 * the founder saw: the bezier was anchored to a phantom. The route is built
 * from the node's position and its declared width/height, which are exactly
 * the wrapper's box, so its ends are the border centres the handles rest on
 * once the animation is over. `RunCanvas` re-routes on every drag frame, so
 * a card being moved keeps its edges too.
 */
import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react';
import { roundedPath } from '../../layout/edgePath.js';
import type { Point } from '../../layout/routeEdges.js';

export interface GmEdgeData extends Record<string, unknown> {
  points: Point[];
}

export type GmEdgeType = Edge<GmEdgeData, 'gm'>;

export function GmEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerStart,
  markerEnd,
  style,
  interactionWidth,
}: EdgeProps<GmEdgeType>) {
  const route = data?.points;
  // No route (the target never got a position): the plain handle-to-handle
  // line React Flow would have drawn, which at least is *a* line.
  const points: readonly Point[] =
    route !== undefined && route.length >= 2
      ? route
      : [
          { x: sourceX, y: sourceY },
          { x: targetX, y: targetY },
        ];
  const path = roundedPath(points);
  return (
    <BaseEdge
      id={id}
      path={path}
      {...(markerStart !== undefined ? { markerStart } : {})}
      {...(markerEnd !== undefined ? { markerEnd } : {})}
      {...(style !== undefined ? { style } : {})}
      {...(interactionWidth !== undefined ? { interactionWidth } : {})}
    />
  );
}
