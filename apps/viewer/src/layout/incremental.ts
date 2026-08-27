/**
 * Incremental layout.
 *
 * The layout itself is fast (see tidyTree.ts — ~1ms at 300 nodes), so this
 * is not about cost: it is about *stillness*. Re-laying out the whole graph
 * on every `node.started` re-centres parents over their new children and the
 * canvas slides under you while you are trying to read it. So every
 * structural change is classified first:
 *
 *  - `none`   — same ids, same sizes: reuse the previous positions verbatim.
 *  - `resize` — a card grew or shrank in place (a gate opened its action
 *               bar). Positions stand; only the box changes.
 *  - `append` — everything that was on screen is still there and a handful of
 *               nodes arrived. Place the new ones under their parents in free
 *               space and leave the rest of the graph exactly where it is.
 *  - `full`   — anything else (first layout, collapse/expand, removals, a
 *               burst too large to place sanely, explicit auto-arrange).
 *
 * A full pass is then *anchored*: the result is translated so the nodes that
 * already existed keep their centroid, which stops the camera from jumping.
 */
import type { FlowGraph, FlowNodeSpec } from '../store/runStateToFlow.js';
import { LAYER_GAP, SIBLING_GAP, type PositionedNode } from './tidyTree.js';

export type LayoutMode = 'none' | 'resize' | 'append' | 'full';

export interface Placed {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

/** Below this, a full re-layout is cheap and looks better than appending. */
export const APPEND_MIN_NODES = 24;
/** Appending more than this at once produces a mess — re-layout instead. */
export const APPEND_MAX_NEW = 40;

export function planLayout(
  prev: ReadonlyMap<string, Placed>,
  next: FlowGraph,
  opts: { force?: boolean } = {},
): LayoutMode {
  if (opts.force === true) return 'full';
  if (prev.size === 0) return next.nodes.length === 0 ? 'none' : 'full';

  const nextIds = new Set(next.nodes.map((n) => n.id));
  for (const id of prev.keys()) {
    if (!nextIds.has(id)) return 'full'; // a node disappeared (collapse, clear)
  }

  const added: FlowNodeSpec[] = [];
  let resized = false;
  for (const node of next.nodes) {
    const before = prev.get(node.id);
    if (before === undefined) {
      added.push(node);
      continue;
    }
    if (before.width !== node.width || before.height !== node.height) resized = true;
  }

  if (added.length === 0) return resized ? 'resize' : 'none';
  if (prev.size < APPEND_MIN_NODES) return 'full';
  if (added.length > APPEND_MAX_NEW) return 'full';
  return 'append';
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

/**
 * Place newly-arrived nodes without touching anything already on screen.
 * A new node lands one layer below its parent, centred on it, shifted
 * sideways until it finds free space (alternating right/left so a fan-out
 * spreads symmetrically).
 */
export function appendLayout(prev: ReadonlyMap<string, Placed>, next: FlowGraph): PositionedNode[] {
  const parentOf = new Map<string, string>();
  for (const edge of next.edges) {
    if (!parentOf.has(edge.target)) parentOf.set(edge.target, edge.source);
  }

  const placed = new Map<string, Placed>(prev);
  const occupied: Rect[] = [];
  for (const entry of prev.values()) {
    occupied.push({ x: entry.position.x, y: entry.position.y, width: entry.width, height: entry.height });
  }

  let bounds = boundsOf(occupied);

  for (const node of next.nodes) {
    if (placed.has(node.id)) continue;
    const parentId = parentOf.get(node.id);
    const parent = parentId === undefined ? undefined : placed.get(parentId);
    const anchorX =
      parent !== undefined
        ? parent.position.x + parent.width / 2 - node.width / 2
        : bounds.maxX + SIBLING_GAP;
    const anchorY =
      parent !== undefined ? parent.position.y + parent.height + LAYER_GAP : bounds.minY;

    let position = { x: anchorX, y: anchorY };
    const stride = node.width + SIBLING_GAP;
    for (let attempt = 0; attempt < 512; attempt++) {
      const ring = Math.ceil(attempt / 2);
      const dx = attempt === 0 ? 0 : (attempt % 2 === 1 ? ring : -ring) * stride;
      const candidate: Rect = { x: anchorX + dx, y: anchorY, width: node.width, height: node.height };
      if (!occupied.some((rect) => overlaps(candidate, rect, 12))) {
        position = { x: candidate.x, y: candidate.y };
        break;
      }
    }

    const entry: Placed = { id: node.id, position, width: node.width, height: node.height };
    placed.set(node.id, entry);
    occupied.push({ x: position.x, y: position.y, width: node.width, height: node.height });
    bounds = boundsOf(occupied);
  }

  return next.nodes.map((node) => {
    const entry = placed.get(node.id);
    return { ...node, position: entry?.position ?? { x: 0, y: 0 } };
  });
}

function boundsOf(rects: readonly Rect[]): { minX: number; maxX: number; minY: number; maxY: number } {
  if (rects.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    maxX = Math.max(maxX, rect.x + rect.width);
    minY = Math.min(minY, rect.y);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Translate a fresh layout so the nodes that already existed keep their
 * average position. A tidy-tree pass re-origins its output at (0,0) every
 * time; without this the whole graph slides under the camera whenever a
 * layer is added.
 */
export function anchorPositions(
  prev: ReadonlyMap<string, Placed>,
  positioned: readonly PositionedNode[],
): PositionedNode[] {
  let count = 0;
  let sumPrevX = 0;
  let sumPrevY = 0;
  let sumNextX = 0;
  let sumNextY = 0;
  for (const node of positioned) {
    const before = prev.get(node.id);
    if (before === undefined) continue;
    count += 1;
    sumPrevX += before.position.x;
    sumPrevY += before.position.y;
    sumNextX += node.position.x;
    sumNextY += node.position.y;
  }
  if (count === 0) return [...positioned];
  const dx = Math.round((sumPrevX - sumNextX) / count);
  const dy = Math.round((sumPrevY - sumNextY) / count);
  if (dx === 0 && dy === 0) return [...positioned];
  return positioned.map((node) => ({
    ...node,
    position: { x: node.position.x + dx, y: node.position.y + dy },
  }));
}

/** Keep positions, apply new sizes (the `resize` plan). */
export function resizeOnly(
  prev: ReadonlyMap<string, Placed>,
  next: FlowGraph,
): PositionedNode[] {
  return next.nodes.map((node) => ({
    ...node,
    position: prev.get(node.id)?.position ?? { x: 0, y: 0 },
  }));
}
