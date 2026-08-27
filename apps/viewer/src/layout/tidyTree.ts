/**
 * The layout engine.
 *
 * A GraphMind graph is always a forest: `runStateToFlow` gives every node at
 * most one incoming edge (parent containment, or the previous step in an LLM
 * chain), and collapsing only re-points edges at an ancestor. That structure
 * is worth exploiting, because the general-purpose alternative is not free —
 * ELK's `layered` algorithm took **9.0s** on the 301-node stress run, mostly
 * fighting a single layer 200 tools wide. This does the same graph in
 * ~1ms.
 *
 * Two ideas do the work:
 *
 *  1. **Tidy tree.** Post-order measurement of subtree widths, pre-order
 *     placement centring each parent over its children. Linear, deterministic,
 *     and stable: a new node shifts its own branch, not the whole canvas.
 *  2. **Leaf packing.** A step that calls twenty tools would otherwise stretch
 *     a layer 6,000px wide. Childless siblings are packed into a compact grid
 *     instead, and the layer's band grows to fit it — so a wide fan-out reads
 *     as a block you can take in at a glance.
 */
import type { FlowEdgeSpec, FlowNodeSpec } from '../store/runStateToFlow.js';

export interface PositionedNode extends FlowNodeSpec {
  position: { x: number; y: number };
}

export interface TidyTreeOptions {
  /** Vertical gap between layers. */
  layerGap?: number;
  /** Horizontal gap between siblings and subtrees. */
  siblingGap?: number;
  /** Vertical gap between rows inside a packed leaf block. */
  leafRowGap?: number;
  /** Hard cap on columns in a packed leaf block. */
  maxLeafColumns?: number;
}

interface Measured {
  id: string;
  node: FlowNodeSpec;
  depth: number;
  /** Children that own children of their own — laid out as subtrees. */
  branches: Measured[];
  /** Childless children — packed into a grid. */
  leaves: FlowNodeSpec[];
  leafColumns: number;
  leafRows: number;
  leafBlockWidth: number;
  /** Total horizontal space this subtree needs. */
  width: number;
}

const DEFAULTS = {
  layerGap: 118,
  siblingGap: 46,
  leafRowGap: 26,
  maxLeafColumns: 8,
} as const;

/**
 * Vertical gap between layers. Must exceed PAUSE_BANNER_HEIGHT so a paused
 * card can grow its action bar in place without colliding with the layer
 * below — that is what makes a gate opening a zero-relayout event.
 */
export const LAYER_GAP = DEFAULTS.layerGap;
/** Horizontal gap between siblings and between subtrees. */
export const SIBLING_GAP = DEFAULTS.siblingGap;

/**
 * The layout entry point used by the canvas. Synchronous on purpose: at
 * ~1ms for 300 nodes there is nothing to await, and no async means no
 * stale-result races while a run streams in.
 */
export function layoutGraph(
  nodes: readonly FlowNodeSpec[],
  edges: readonly FlowEdgeSpec[],
): PositionedNode[] {
  return tidyTreeLayout(nodes, edges);
}

/**
 * Columns for a packed block of `count` leaves: roughly square, biased wide
 * (screens are), never past the cap.
 */
export function leafColumnsFor(count: number, max: number = DEFAULTS.maxLeafColumns): number {
  if (count <= 0) return 0;
  if (count <= 4) return count;
  return Math.max(1, Math.min(max, Math.ceil(Math.sqrt(count * 1.7))));
}

export function tidyTreeLayout(
  nodes: readonly FlowNodeSpec[],
  edges: readonly FlowEdgeSpec[],
  options: TidyTreeOptions = {},
): PositionedNode[] {
  const layerGap = options.layerGap ?? DEFAULTS.layerGap;
  const siblingGap = options.siblingGap ?? DEFAULTS.siblingGap;
  const leafRowGap = options.leafRowGap ?? DEFAULTS.leafRowGap;
  const maxLeafColumns = options.maxLeafColumns ?? DEFAULTS.maxLeafColumns;
  if (nodes.length === 0) return [];

  const byId = new Map<string, FlowNodeSpec>();
  for (const node of nodes) byId.set(node.id, node);

  // First incoming edge wins: a DAG edge added by some future adapter still
  // renders, it just doesn't get a second parent in the tree.
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    if (parentOf.has(edge.target) || edge.target === edge.source) continue;
    parentOf.set(edge.target, edge.source);
    const list = childrenOf.get(edge.source);
    if (list === undefined) childrenOf.set(edge.source, [edge.target]);
    else list.push(edge.target);
  }
  // Break any accidental cycle: a node that is its own ancestor becomes a
  // root. Both maps have to be cut, or the recursive measure below never
  // terminates.
  for (const id of [...parentOf.keys()]) {
    const seen = new Set<string>([id]);
    let current = parentOf.get(id);
    for (let hops = 0; current !== undefined && hops <= nodes.length; hops++) {
      if (!seen.has(current)) {
        seen.add(current);
        current = parentOf.get(current);
        continue;
      }
      const parent = parentOf.get(id);
      parentOf.delete(id);
      if (parent !== undefined) {
        const siblings = childrenOf.get(parent);
        if (siblings !== undefined) childrenOf.set(parent, siblings.filter((s) => s !== id));
      }
      break;
    }
  }

  const roots = nodes.filter((node) => !parentOf.has(node.id));
  /** Tallest node at each depth, plus the depth of packed leaf blocks. */
  const layerHeight: number[] = [];
  const noteLayer = (depth: number, height: number): void => {
    layerHeight[depth] = Math.max(layerHeight[depth] ?? 0, height);
  };

  /** Belt and braces: even a cycle the pass above missed can only be walked once. */
  const measured = new Set<string>();
  const measure = (node: FlowNodeSpec, depth: number): Measured => {
    noteLayer(depth, node.height);
    measured.add(node.id);
    const childIds = childrenOf.get(node.id) ?? [];
    const branches: Measured[] = [];
    const leaves: FlowNodeSpec[] = [];
    for (const childId of childIds) {
      const child = byId.get(childId);
      if (child === undefined || measured.has(childId)) continue;
      if ((childrenOf.get(childId) ?? []).length > 0) branches.push(measure(child, depth + 1));
      else leaves.push(child);
    }

    const leafColumns = leafColumnsFor(leaves.length, maxLeafColumns);
    const leafRows = leafColumns === 0 ? 0 : Math.ceil(leaves.length / leafColumns);
    const leafWidth = leaves.reduce((max, leaf) => Math.max(max, leaf.width), 0);
    const leafHeight = leaves.reduce((max, leaf) => Math.max(max, leaf.height), 0);
    const leafBlockWidth =
      leafColumns === 0 ? 0 : leafColumns * leafWidth + (leafColumns - 1) * siblingGap;
    if (leafRows > 0) {
      noteLayer(depth + 1, leafRows * leafHeight + (leafRows - 1) * leafRowGap);
    }

    const blocks: number[] = [];
    if (leafBlockWidth > 0) blocks.push(leafBlockWidth);
    for (const branch of branches) blocks.push(branch.width);
    const childrenWidth =
      blocks.length === 0
        ? 0
        : blocks.reduce((sum, w) => sum + w, 0) + (blocks.length - 1) * siblingGap;

    return {
      id: node.id,
      node,
      depth,
      branches,
      leaves,
      leafColumns,
      leafRows,
      leafBlockWidth,
      width: Math.max(node.width, childrenWidth),
    };
  };

  const measuredRoots = roots.map((root) => measure(root, 0));

  // Layer bands, top-down.
  const layerY: number[] = [];
  let y = 0;
  for (let depth = 0; depth < layerHeight.length; depth++) {
    layerY[depth] = y;
    y += (layerHeight[depth] ?? 0) + layerGap;
  }

  const positions = new Map<string, { x: number; y: number }>();
  const place = (entry: Measured, left: number): void => {
    const nodeY = layerY[entry.depth] ?? 0;
    positions.set(entry.id, {
      x: left + (entry.width - entry.node.width) / 2,
      y: nodeY,
    });

    let cursor = left;
    if (entry.leafColumns > 0) {
      const leafWidth = entry.leaves.reduce((max, leaf) => Math.max(max, leaf.width), 0);
      const leafHeight = entry.leaves.reduce((max, leaf) => Math.max(max, leaf.height), 0);
      const childY = layerY[entry.depth + 1] ?? nodeY + entry.node.height + layerGap;
      entry.leaves.forEach((leaf, index) => {
        const column = index % entry.leafColumns;
        const row = Math.floor(index / entry.leafColumns);
        // Centre the final, possibly short, row under the block.
        const inRow = Math.min(entry.leaves.length - row * entry.leafColumns, entry.leafColumns);
        const rowWidth = inRow * leafWidth + (inRow - 1) * siblingGap;
        const rowLeft = cursor + (entry.leafBlockWidth - rowWidth) / 2;
        positions.set(leaf.id, {
          x: rowLeft + column * (leafWidth + siblingGap) + (leafWidth - leaf.width) / 2,
          y: childY + row * (leafHeight + leafRowGap),
        });
      });
      cursor += entry.leafBlockWidth + siblingGap;
    }
    for (const branch of entry.branches) {
      place(branch, cursor);
      cursor += branch.width + siblingGap;
    }
  };

  let rootLeft = 0;
  for (const entry of measuredRoots) {
    place(entry, rootLeft);
    rootLeft += entry.width + siblingGap * 2;
  }

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? { x: 0, y: 0 },
  }));
}
