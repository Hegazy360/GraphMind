/**
 * From a routed polyline to the SVG path the edge component draws.
 *
 * `roundedPath` turns square corners into short quadratic arcs. Rounding
 * lives here, not in the router, so the geometry harness reasons about the
 * straight segments it was promised, and so it can be tested without a DOM.
 */
import type { Point } from './routeEdges.js';

/** Corner radius; never more than half the shorter adjacent segment. */
export const CORNER_RADIUS = 8;

/** SVG path for a polyline with rounded corners. */
export function roundedPath(points: readonly Point[], radius: number = CORNER_RADIUS): string {
  if (points.length === 0) return '';
  const first = points[0] as Point;
  if (points.length === 1) return `M ${fmt(first.x)} ${fmt(first.y)}`;
  let d = `M ${fmt(first.x)} ${fmt(first.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1] as Point;
    const corner = points[i] as Point;
    const next = points[i + 1] as Point;
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0 || inLen === 0 || outLen === 0) {
      d += ` L ${fmt(corner.x)} ${fmt(corner.y)}`;
      continue;
    }
    const inX = corner.x - ((corner.x - prev.x) / inLen) * r;
    const inY = corner.y - ((corner.y - prev.y) / inLen) * r;
    const outX = corner.x + ((next.x - corner.x) / outLen) * r;
    const outY = corner.y + ((next.y - corner.y) / outLen) * r;
    d += ` L ${fmt(inX)} ${fmt(inY)} Q ${fmt(corner.x)} ${fmt(corner.y)} ${fmt(outX)} ${fmt(outY)}`;
  }
  const last = points[points.length - 1] as Point;
  d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
  return d;
}

/** Two decimals: sub-pixel precision without 17-digit floats in the DOM. */
function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}
