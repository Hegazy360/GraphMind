/**
 * The geometry harness — pure predicates the layout and the router are held
 * to, in tests and (through the same maths) in the browser.
 *
 * Three questions, because three real bugs got past a human looking at a
 * screenshot: does an edge pass through a card that is not one of its ends,
 * do two cards overlap, and does an edge actually leave and arrive
 * vertically at the handles it claims to connect.
 */
import type { RoutedEdge } from './routeEdges.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Crossing {
  edgeId: string;
  nodeId: string;
  /** Index of the offending segment (points[i] → points[i+1]). */
  segment: number;
}

/** Strict overlap: two cards that merely share a border do not overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Does the open segment p→q pass through the interior of `rect`?
 * Liang–Barsky clipping; a segment that only touches the boundary is not a
 * hit, so an edge running exactly along a card's edge (or ending on one) is
 * not reported.
 */
export function segmentIntersectsRect(
  p: { x: number; y: number },
  q: { x: number; y: number },
  rect: Rect,
): boolean {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (denominator: number, numerator: number): boolean => {
    // Parallel to this boundary: the whole segment is on one side of it.
    // (The strict checks above already rejected a segment on the line.)
    if (denominator === 0) return numerator > 0;
    const t = numerator / denominator;
    if (denominator < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  // Strict interior: a point ON the boundary is outside, so the four tests
  // are against the open rectangle. For the parallel case that means a
  // segment lying on the boundary line is rejected (numerator === 0 → false).
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  if (dx === 0 && (p.x <= left || p.x >= right)) return false;
  if (dy === 0 && (p.y <= top || p.y >= bottom)) return false;
  if (!clip(-dx, p.x - left)) return false;
  if (!clip(dx, right - p.x)) return false;
  if (!clip(-dy, p.y - top)) return false;
  if (!clip(dy, bottom - p.y)) return false;
  // Non-empty overlap of the parameter interval means a run of interior
  // points, not a single touching point.
  return t1 - t0 > 1e-9;
}

export interface CrossingOptions {
  /**
   * Trim this much off each end of the polyline before testing, so an edge
   * that starts on its source's bottom border and ends on its target's top
   * border is never charged with "crossing" the card it is plugged into.
   */
  inset?: number;
}

/**
 * Every (edge, card) pair where a segment of the routed edge passes through
 * a card that is neither its source nor its target. Empty means the routing
 * holds. Quadratic in a test harness is fine: 300 nodes × 300 edges × ≤ 5
 * segments is well under a million cheap tests.
 */
export function edgeCrossings(
  positioned: readonly { id: string; position: { x: number; y: number }; width: number; height: number }[],
  routed: ReadonlyMap<string, RoutedEdge>,
  options: CrossingOptions = {},
): Crossing[] {
  const inset = options.inset ?? 2;
  const rects = positioned.map((node) => ({
    id: node.id,
    rect: { x: node.position.x, y: node.position.y, width: node.width, height: node.height },
  }));
  const out: Crossing[] = [];
  for (const [edgeId, edge] of routed) {
    const points = insetPolyline(edge.points, inset);
    for (let i = 0; i + 1 < points.length; i++) {
      const p = points[i] as { x: number; y: number };
      const q = points[i + 1] as { x: number; y: number };
      for (const { id, rect } of rects) {
        if (id === edge.source || id === edge.target) continue;
        if (segmentIntersectsRect(p, q, rect)) out.push({ edgeId, nodeId: id, segment: i });
      }
    }
  }
  return out;
}

/** Pull the first point forward and the last point back along their segments. */
export function insetPolyline(
  points: readonly { x: number; y: number }[],
  inset: number,
): { x: number; y: number }[] {
  if (points.length < 2 || inset <= 0) return [...points];
  const out = points.map((p) => ({ x: p.x, y: p.y }));
  const first = out[0] as { x: number; y: number };
  const second = out[1] as { x: number; y: number };
  const last = out[out.length - 1] as { x: number; y: number };
  const beforeLast = out[out.length - 2] as { x: number; y: number };
  const move = (from: { x: number; y: number }, to: { x: number; y: number }): void => {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    if (len <= inset) return; // shorter than the inset — leave it
    from.x += ((to.x - from.x) / len) * inset;
    from.y += ((to.y - from.y) / len) * inset;
  };
  move(first, second);
  move(last, beforeLast);
  return out;
}

/** Is this segment vertical (within floating-point noise)? */
export function isVertical(p: { x: number; y: number }, q: { x: number; y: number }): boolean {
  return Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) > 1e-6;
}
