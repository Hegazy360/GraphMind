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
 *
 * Both traversals are **iterative**, over explicit stacks. That is not a
 * micro-optimisation: `runStateToFlow` chains consecutive `llm` siblings, so
 * the tree's depth is the number of distinct llm nodes in the run. The
 * shipped adapters mint one stable `llm:step` node (depth 1), but any
 * instrumentation that mints a nodeId per step makes depth ≈ node count, and
 * a recursive measure/place blew the JS stack at ~6,000 — the canvas
 * rendering nothing at all.
 *
 * Cycle breaking is likewise O(n): the previous pass walked every node's
 * ancestor chain to the root, which is O(n·depth) — the entire reason layout
 * measured ~O(n²) (188ms at 3,200 nodes, of which 187ms was this loop).
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
  /** Cut a node loose from its parent, in both directions. */
  const detach = (id: string): void => {
    const parent = parentOf.get(id);
    if (parent === undefined) return;
    parentOf.delete(id);
    const siblings = childrenOf.get(parent);
    if (siblings !== undefined) childrenOf.set(parent, siblings.filter((s) => s !== id));
  };

  // Break any accidental cycle: the node that closes the loop becomes a root,
  // so the whole ring stays reachable from somewhere. Both maps have to be
  // cut, or the traversal below never terminates.
  //
  // One amortised pass, not one ancestor-walk per node: every node is pushed
  // onto `path` at most once across the whole loop, because anything already
  // settled stops the walk immediately.
  const UNSEEN = 0;
  const ON_PATH = 1;
  const SETTLED = 2;
  const cycleState = new Map<string, number>();
  const path: string[] = [];
  for (const node of nodes) {
    path.length = 0;
    let current: string | undefined = node.id;
    while (current !== undefined && (cycleState.get(current) ?? UNSEEN) === UNSEEN) {
      cycleState.set(current, ON_PATH);
      path.push(current);
      current = parentOf.get(current);
    }
    // Walked back into the chain we are standing on → that node is its own
    // ancestor. Cutting the edge above it breaks exactly one link.
    if (current !== undefined && cycleState.get(current) === ON_PATH) detach(current);
    for (const id of path) cycleState.set(id, SETTLED);
  }

  const roots = nodes.filter((node) => !parentOf.has(node.id));
  /** Tallest node at each depth, plus the depth of packed leaf blocks. */
  const layerHeight: number[] = [];
  const noteLayer = (depth: number, height: number): void => {
    layerHeight[depth] = Math.max(layerHeight[depth] ?? 0, height);
  };

  /** Belt and braces: even a cycle the pass above missed can only be walked once. */
  const measured = new Set<string>();

  /**
   * Pass 1 — pre-order walk over the branch nodes, over an explicit stack.
   * Classifies each node's children into packed leaves and child branches,
   * and notes the layer heights. Subtree widths need children first, so they
   * are filled in by pass 2 below.
   */
  const entries: Measured[] = [];
  const openEntry = (node: FlowNodeSpec, depth: number): Measured => {
    noteLayer(depth, node.height);
    measured.add(node.id);
    return {
      id: node.id,
      node,
      depth,
      branches: [],
      leaves: [],
      leafColumns: 0,
      leafRows: 0,
      leafBlockWidth: 0,
      width: node.width,
    };
  };

  const measuredRoots = roots.map((root) => openEntry(root, 0));
  const stack: Measured[] = [...measuredRoots];
  while (stack.length > 0) {
    const entry = stack.pop() as Measured;
    entries.push(entry);
    const childIds = childrenOf.get(entry.id) ?? [];
    for (const childId of childIds) {
      const child = byId.get(childId);
      if (child === undefined || measured.has(childId)) continue;
      if ((childrenOf.get(childId) ?? []).length > 0) {
        const branch = openEntry(child, entry.depth + 1);
        entry.branches.push(branch);
        stack.push(branch);
      } else {
        entry.leaves.push(child);
      }
    }

    const leaves = entry.leaves;
    const leafColumns = leafColumnsFor(leaves.length, maxLeafColumns);
    entry.leafColumns = leafColumns;
    entry.leafRows = leafColumns === 0 ? 0 : Math.ceil(leaves.length / leafColumns);
    let leafWidth = 0;
    let leafHeight = 0;
    for (const leaf of leaves) {
      if (leaf.width > leafWidth) leafWidth = leaf.width;
      if (leaf.height > leafHeight) leafHeight = leaf.height;
    }
    entry.leafBlockWidth =
      leafColumns === 0 ? 0 : leafColumns * leafWidth + (leafColumns - 1) * siblingGap;
    if (entry.leafRows > 0) {
      noteLayer(entry.depth + 1, entry.leafRows * leafHeight + (entry.leafRows - 1) * leafRowGap);
    }
  }

  // Pass 2 — subtree widths. `entries` is in pre-order, so every descendant
  // sits after its ancestor: walking it backwards visits children first,
  // which is exactly the post-order the recursive version got for free.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Measured;
    let childrenWidth = entry.leafBlockWidth;
    let blocks = entry.leafBlockWidth > 0 ? 1 : 0;
    for (const branch of entry.branches) {
      childrenWidth += branch.width;
      blocks += 1;
    }
    if (blocks > 1) childrenWidth += (blocks - 1) * siblingGap;
    entry.width = Math.max(entry.node.width, childrenWidth);
  }

  // Layer bands, top-down.
  const layerY: number[] = [];
  let y = 0;
  for (let depth = 0; depth < layerHeight.length; depth++) {
    layerY[depth] = y;
    y += (layerHeight[depth] ?? 0) + layerGap;
  }

  // Pass 3 — placement, pre-order over an explicit stack. Each frame carries
  // the left edge its subtree owns, so siblings can be pushed in any order.
  const positions = new Map<string, { x: number; y: number }>();
  const placeStack: { entry: Measured; left: number }[] = [];
  let rootLeft = 0;
  for (const entry of measuredRoots) {
    placeStack.push({ entry, left: rootLeft });
    rootLeft += entry.width + siblingGap * 2;
  }

  while (placeStack.length > 0) {
    const { entry, left } = placeStack.pop() as { entry: Measured; left: number };
    const nodeY = layerY[entry.depth] ?? 0;
    positions.set(entry.id, {
      x: left + (entry.width - entry.node.width) / 2,
      y: nodeY,
    });

    let cursor = left;
    if (entry.leafColumns > 0) {
      let leafWidth = 0;
      let leafHeight = 0;
      for (const leaf of entry.leaves) {
        if (leaf.width > leafWidth) leafWidth = leaf.width;
        if (leaf.height > leafHeight) leafHeight = leaf.height;
      }
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
      placeStack.push({ entry: branch, left: cursor });
      cursor += branch.width + siblingGap;
    }
  }

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? { x: 0, y: 0 },
  }));
}
