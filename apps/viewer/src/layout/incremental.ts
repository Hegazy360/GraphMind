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

/** Breathing room kept between an appended card and everything already placed. */
const APPEND_MARGIN = 12;

/**
 * "Is this box free?" over the cards already on the canvas.
 *
 * Coordinates go in and out as four numbers rather than a rectangle object.
 * That is not premature: this is called once per node already on screen,
 * every time a node arrives, so an object per rectangle is an allocation per
 * card per frame for the entire life of a run.
 *
 * Rectangles are stored pre-grown by `APPEND_MARGIN`, which turns a margin
 * test into a plain intersection — `overlaps(a, b, m)` is exactly `a`
 * intersecting `b` grown by `m` — so a query never re-derives the margin.
 */
interface Occupancy {
  insert: (x: number, y: number, width: number, height: number) => void;
  hits: (x: number, y: number, width: number, height: number) => boolean;
}

/** Flat [x, y, right, bottom] quads; a scan is four compares per rectangle. */
function listOccupancy(): Occupancy {
  const box: number[] = [];
  return {
    insert: (x, y, width, height) => {
      box.push(
        x - APPEND_MARGIN,
        y - APPEND_MARGIN,
        x + width + APPEND_MARGIN,
        y + height + APPEND_MARGIN,
      );
    },
    hits: (x, y, width, height) => {
      const right = x + width;
      const bottom = y + height;
      for (let i = 0; i < box.length; i += 4) {
        if (
          x < (box[i + 2] as number) &&
          right > (box[i] as number) &&
          y < (box[i + 3] as number) &&
          bottom > (box[i + 1] as number)
        ) {
          return true;
        }
      }
      return false;
    },
  };
}

/** Uniform hash grid: costs a pass to fill, then answers in O(1) expected. */
const CELL = 1024;
/** Cell coordinates pack into one exact integer key. ±2^20 cells ≈ ±400M px. */
const CELL_OFFSET = 1 << 20;
const CELL_SPAN = 1 << 21;

function gridOccupancy(): Occupancy {
  /** Same flat quads; buckets hold offsets into this, not copies. */
  const box: number[] = [];
  const cells = new Map<number, number[]>();
  const key = (cx: number, cy: number): number => (cx + CELL_OFFSET) * CELL_SPAN + (cy + CELL_OFFSET);
  return {
    insert: (x, y, width, height) => {
      const left = x - APPEND_MARGIN;
      const top = y - APPEND_MARGIN;
      const right = x + width + APPEND_MARGIN;
      const bottom = y + height + APPEND_MARGIN;
      const at = box.length;
      box.push(left, top, right, bottom);
      const cx1 = Math.floor(right / CELL);
      const cy1 = Math.floor(bottom / CELL);
      for (let cx = Math.floor(left / CELL); cx <= cx1; cx++) {
        for (let cy = Math.floor(top / CELL); cy <= cy1; cy++) {
          const k = key(cx, cy);
          const bucket = cells.get(k);
          if (bucket === undefined) cells.set(k, [at]);
          else bucket.push(at);
        }
      }
    },
    hits: (x, y, width, height) => {
      const right = x + width;
      const bottom = y + height;
      const cx1 = Math.floor(right / CELL);
      const cy1 = Math.floor(bottom / CELL);
      for (let cx = Math.floor(x / CELL); cx <= cx1; cx++) {
        for (let cy = Math.floor(y / CELL); cy <= cy1; cy++) {
          const bucket = cells.get(key(cx, cy));
          if (bucket === undefined) continue;
          for (const at of bucket) {
            if (
              x < (box[at + 2] as number) &&
              right > (box[at] as number) &&
              y < (box[at + 3] as number) &&
              bottom > (box[at + 1] as number)
            ) {
              return true;
            }
          }
        }
      }
      return false;
    },
  };
}

/**
 * Arrivals below this, and filling the grid costs more than the scans it
 * saves — one node arriving needs one pass either way. Above it, every extra
 * arrival is free, which is the case that used to hurt: a 40-node burst onto
 * a 1,600-node canvas was 64,000 rectangle tests.
 */
const GRID_MIN_NEW = 12;

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Place newly-arrived nodes without touching anything already on screen.
 * A new node lands one layer below its parent, centred on it, shifted
 * sideways until it finds free space (alternating right/left so a fan-out
 * spreads symmetrically).
 *
 * Actually incremental. The canvas already on screen is read *once* — into an
 * occupancy structure and a running bounding box — and each arriving node
 * then costs a constant number of rectangle tests. The previous version
 * re-scanned every placed rectangle on every collision probe *and* re-derived
 * the bounding box from scratch after each placement, so a burst cost
 * O(new · placed) and a long streaming run got slower the longer you watched
 * it.
 *
 * One O(placed) pass per call remains and is the signature's, not the
 * algorithm's: the only description of the canvas this function is given is
 * the map, so it has to read it. What it no longer does is read it again per
 * arrival, copy it, or allocate a rectangle per card on the way past.
 */
export function appendLayout(prev: ReadonlyMap<string, Placed>, next: FlowGraph): PositionedNode[] {
  const parentOf = new Map<string, string>();
  for (const edge of next.edges) {
    if (!parentOf.has(edge.target)) parentOf.set(edge.target, edge.source);
  }

  // Only the arrivals get a map of their own; `prev` is read where it lies.
  const added = new Map<string, Placed>();
  const lookup = (id: string): Placed | undefined => added.get(id) ?? prev.get(id);

  const arriving = next.nodes.length - prev.size;
  const occupancy = arriving >= GRID_MIN_NEW ? gridOccupancy() : listOccupancy();
  // Empty stays an empty box, not (0,0,0,0) with a stray origin folded in:
  // a parentless node anchors off maxX/minY, and one phantom rect at the
  // origin would drag it there.
  const bounds: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const entry of prev.values()) {
    occupancy.insert(entry.position.x, entry.position.y, entry.width, entry.height);
    expand(bounds, entry.position.x, entry.position.y, entry.width, entry.height);
  }

  for (const node of next.nodes) {
    if (lookup(node.id) !== undefined) continue;
    const parentId = parentOf.get(node.id);
    const parent = parentId === undefined ? undefined : lookup(parentId);
    // An empty canvas has no edges to hang off: fall back to the origin, the
    // same answer a bounding box over zero rectangles used to give.
    const boundsMaxX = Number.isFinite(bounds.maxX) ? bounds.maxX : 0;
    const boundsMinY = Number.isFinite(bounds.minY) ? bounds.minY : 0;
    const anchorX =
      parent !== undefined
        ? parent.position.x + parent.width / 2 - node.width / 2
        : boundsMaxX + SIBLING_GAP;
    const anchorY =
      parent !== undefined ? parent.position.y + parent.height + LAYER_GAP : boundsMinY;

    let x = anchorX;
    const stride = node.width + SIBLING_GAP;
    for (let attempt = 0; attempt < 512; attempt++) {
      const ring = Math.ceil(attempt / 2);
      const dx = attempt === 0 ? 0 : (attempt % 2 === 1 ? ring : -ring) * stride;
      if (!occupancy.hits(anchorX + dx, anchorY, node.width, node.height)) {
        x = anchorX + dx;
        break;
      }
    }

    const position = { x, y: anchorY };
    added.set(node.id, { id: node.id, position, width: node.width, height: node.height });
    occupancy.insert(x, anchorY, node.width, node.height);
    expand(bounds, x, anchorY, node.width, node.height);
  }

  return next.nodes.map((node) => {
    const entry = lookup(node.id);
    return { ...node, position: entry?.position ?? { x: 0, y: 0 } };
  });
}

function expand(bounds: Bounds, x: number, y: number, width: number, height: number): void {
  if (x < bounds.minX) bounds.minX = x;
  if (x + width > bounds.maxX) bounds.maxX = x + width;
  if (y < bounds.minY) bounds.minY = y;
  if (y + height > bounds.maxY) bounds.maxY = y + height;
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
