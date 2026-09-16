/**
 * Canvas geometry, measured on the painted DOM.
 *
 * The unit harness (test/geometry.test.ts) proves the router's polylines
 * clear every card. This proves what the user sees does too: the SVG path
 * React Flow actually painted, sampled every 4px and mapped to client
 * coordinates, against the cards' real bounding boxes. It would have caught
 * all three of the founder's screenshots — edges drawn through the row of
 * cards above their target, edges peeling away from the handles (React Flow
 * caches handle bounds it measured mid-entrance-animation), and a held
 * card's action row rendered outside its own border.
 *
 * Both bundled fixtures are checked at two moments: as they open (the
 * catalogue is on screen before anything runs) and while the planted gate is
 * held (the paused card is 92px taller and the inspector is open). The
 * assertions are about *rules*, not node lists, because the MCP fixture is
 * owned by the MCP workstream and keeps growing.
 */
import type { Page } from '@playwright/test';
import {
  FIXTURE_NODES,
  distanceToRect,
  expect,
  nodeCard,
  openFixtureRun,
  openViewer,
  pointInside,
  readCanvasGeometry,
  rectWithin,
  test,
  waitForCanvasStill,
  type CanvasGeometry,
  type DomEdgeSamples,
} from './harness.js';

const MCP_SESSION = 'server:docs-mcp';

/** How close the path's ends must be to the handle they claim to join. */
const HANDLE_TOLERANCE_PX = 3;
/** Samples within this much of either end are the handle stubs, not a crossing. */
const END_INSET_PX = 2;

interface Violation {
  edge: string;
  node: string;
  at: { x: number; y: number };
}

/** Every (edge, card) pair where a painted sample lies inside a card that is not one of the edge's ends. */
function crossings(geometry: CanvasGeometry): Violation[] {
  const out: Violation[] = [];
  for (const edge of geometry.edges) {
    for (let i = 0; i < edge.samples.length; i++) {
      const length = edge.lengths[i] ?? 0;
      if (length < END_INSET_PX || length > edge.total - END_INSET_PX) continue;
      const p = edge.samples[i] as { x: number; y: number };
      for (const node of geometry.nodes) {
        if (node.id === edge.source || node.id === edge.target) continue;
        // A 1px inset: the stroke's anti-aliased edge kissing a card's border
        // is not the bug under test; a line 40px inside it is.
        if (pointInside(p, node.rect, 1)) out.push({ edge: edge.id, node: node.id, at: p });
      }
    }
  }
  return out;
}

/** Would the straight line between the handles cross a card? (Non-vacuity for `crossings`.) */
function straightLineCrossings(geometry: CanvasGeometry, edge: DomEdgeSamples): number {
  const s = geometry.nodes.find((n) => n.id === edge.source)?.sourceHandle;
  const t = geometry.nodes.find((n) => n.id === edge.target)?.targetHandle;
  if (s === undefined || s === null || t === undefined || t === null) return 0;
  const from = { x: s.x + s.width / 2, y: s.y + s.height };
  const to = { x: t.x + t.width / 2, y: t.y };
  let hits = 0;
  const steps = Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4));
  for (const node of geometry.nodes) {
    if (node.id === edge.source || node.id === edge.target) continue;
    for (let i = 1; i < steps; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
      if (pointInside(p, node.rect, 1)) {
        hits += 1;
        break;
      }
    }
  }
  return hits;
}

function describe(violations: Violation[]): string {
  return violations
    .slice(0, 12)
    .map((v) => `${v.edge} passes through ${v.node} at (${v.at.x.toFixed(1)}, ${v.at.y.toFixed(1)})`)
    .join('\n');
}

function handleCentre(rect: { x: number; width: number }): number {
  return rect.x + rect.width / 2;
}

/**
 * The geometric truths every frame of the canvas has to satisfy. Returns the
 * geometry so a caller can assert moment-specific things on it.
 */
async function expectCleanGeometry(page: Page, label: string): Promise<CanvasGeometry> {
  const geometry = await waitForCanvasStill(page);
  expect(geometry.nodes.length, `${label}: cards painted`).toBeGreaterThan(1);
  // Every fixture is one tree: one painted edge per card except the root.
  expect(geometry.edges.length, `${label}: one edge per non-root card`).toBe(geometry.nodes.length - 1);

  // (1) No painted edge passes through a card that is not one of its ends.
  const found = crossings(geometry);
  expect(found, `${label}: edges crossing cards\n${describe(found)}`).toEqual([]);

  // (2) Each path starts on its source's bottom handle and ends on its
  //     target's top handle, and the stubs at both ends are vertical.
  for (const edge of geometry.edges) {
    expect(edge.source, `${edge.id}: source card on screen`).not.toBeNull();
    expect(edge.target, `${edge.id}: target card on screen`).not.toBeNull();
    const source = geometry.nodes.find((n) => n.id === edge.source);
    const target = geometry.nodes.find((n) => n.id === edge.target);
    const first = edge.samples[0];
    const last = edge.samples[edge.samples.length - 1];
    if (
      source?.sourceHandle === null ||
      source?.sourceHandle === undefined ||
      target?.targetHandle === null ||
      target?.targetHandle === undefined ||
      first === undefined ||
      last === undefined
    ) {
      throw new Error(`${edge.id}: missing handle boxes`);
    }
    const startGap = distanceToRect(first, source.sourceHandle);
    const endGap = distanceToRect(last, target.targetHandle);
    expect(startGap, `${label}: ${edge.id} starts ${startGap.toFixed(1)}px from the source handle`).toBeLessThanOrEqual(
      HANDLE_TOLERANCE_PX,
    );
    expect(endGap, `${label}: ${edge.id} ends ${endGap.toFixed(1)}px from the target handle`).toBeLessThanOrEqual(
      HANDLE_TOLERANCE_PX,
    );
    expect(Math.abs(first.x - handleCentre(source.sourceHandle)), `${edge.id}: first stub vertical`).toBeLessThan(1.5);
    expect(Math.abs(last.x - handleCentre(target.targetHandle)), `${edge.id}: last stub vertical`).toBeLessThan(1.5);
  }

  // (3) Every action button sits inside the card that owns it.
  for (const node of geometry.nodes) {
    for (const action of node.actions) {
      expect(rectWithin(action, node.rect), `${label}: an action in ${node.id} overflows its card`).toBe(true);
    }
  }

  // (4) No two cards overlap.
  for (let i = 0; i < geometry.nodes.length; i++) {
    for (let j = i + 1; j < geometry.nodes.length; j++) {
      const a = (geometry.nodes[i] as CanvasGeometry['nodes'][number]).rect;
      const b = (geometry.nodes[j] as CanvasGeometry['nodes'][number]).rect;
      const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      expect(overlap, `${label}: ${geometry.nodes[i]?.id} overlaps ${geometry.nodes[j]?.id}`).toBe(false);
    }
  }
  return geometry;
}

/**
 * Non-vacuity for the crossing check: the shape on screen must contain edges
 * whose STRAIGHT line would go through a card — otherwise "no crossings" is
 * a property of the shape, not of the routing. Those edges must have gone
 * round (their painted length exceeds the straight line).
 */
function expectRoutingWasNeeded(geometry: CanvasGeometry, label: string): void {
  const needing = geometry.edges.filter((e) => straightLineCrossings(geometry, e) > 0);
  expect(needing.length, `${label}: edges a straight line would draw through a card`).toBeGreaterThan(0);
  for (const edge of needing) {
    const s = geometry.nodes.find((n) => n.id === edge.source)?.sourceHandle;
    const t = geometry.nodes.find((n) => n.id === edge.target)?.targetHandle;
    if (s === null || s === undefined || t === null || t === undefined) throw new Error('handles');
    const straight = Math.hypot(t.x - s.x, t.y - s.y);
    expect(edge.total, `${label}: ${edge.id} went round`).toBeGreaterThan(straight * 1.05);
  }
}

/** Wait for whichever card holds the gate, and return its id. */
async function waitForHeldCard(page: Page): Promise<string> {
  const banner = page.locator('.react-flow__node .gm-pause-banner').first();
  await expect(banner).toBeVisible({ timeout: 45_000 });
  const heldId = await banner.evaluate((el) => el.closest('.react-flow__node')?.getAttribute('data-id') ?? '');
  expect(heldId).not.toBe('');
  await expect(page.getByRole('complementary', { name: 'Node inspector' })).toBeVisible();
  // The hold animation plus the re-frame the inspector opening provokes.
  await page.waitForTimeout(1_200);
  return heldId;
}

async function expectHeldCardClear(page: Page, geometry: CanvasGeometry, heldId: string): Promise<void> {
  const held = geometry.nodes.find((n) => n.id === heldId);
  expect(held, `${heldId} on screen`).toBeDefined();
  expect(geometry.inspector, 'inspector open').not.toBeNull();
  expect(geometry.canvas).not.toBeNull();
  if (held === undefined || geometry.inspector === null || geometry.canvas === null) return;
  // The held card carries the resume row…
  expect(held.actions.length, 'the held card shows its action row').toBeGreaterThanOrEqual(3);
  // …is entirely inside the canvas…
  expect(held.rect.y).toBeGreaterThanOrEqual(geometry.canvas.y - 1);
  expect(held.rect.y + held.rect.height).toBeLessThanOrEqual(geometry.canvas.y + geometry.canvas.height + 1);
  expect(held.rect.x).toBeGreaterThanOrEqual(geometry.canvas.x - 1);
  // …and not underneath the inspector that explains it.
  expect(held.rect.x + held.rect.width, 'held card clipped by the inspector').toBeLessThanOrEqual(
    geometry.inspector.x,
  );
  // Which means its buttons are actually clickable.
  await expect(nodeCard(page, heldId).getByRole('button', { name: 'Continue', exact: true })).toBeInViewport();
}

// ── MCP fixture ─────────────────────────────────────────────────────────────

test('MCP session: painted edges leave the handles they claim to and cross no card', async ({ page }) => {
  await openViewer(page, { query: 'fixture=mcp' });
  await expect(nodeCard(page, MCP_SESSION)).toBeVisible();
  const geometry = await expectCleanGeometry(page, 'mcp open');
  expectRoutingWasNeeded(geometry, 'mcp open');
});

test('MCP session: at the held gate the card grew, its actions are inside it, and the edges still clear', async ({
  page,
}) => {
  await openViewer(page, { query: 'fixture=mcp' });
  await expect(nodeCard(page, MCP_SESSION)).toBeVisible();

  const heldId = await waitForHeldCard(page);
  const geometry = await expectCleanGeometry(page, 'mcp held');
  // The held card's box grew for its action row. Measured against the
  // smallest other card rather than against itself "before": on a loaded
  // runner the replay reaches the gate before a "before" sample is taken.
  const heldHeight = geometry.nodes.find((n) => n.id === heldId)?.rect.height ?? 0;
  const smallestOther = Math.min(...geometry.nodes.filter((n) => n.id !== heldId).map((n) => n.rect.height));
  expect(heldHeight, 'the held card grew its action row').toBeGreaterThan(smallestOther + 40);
  await expectHeldCardClear(page, geometry, heldId);
});

// ── demo recording ──────────────────────────────────────────────────────────

test('demo run: painted edges cross no card and meet both handles', async ({ page }) => {
  await openFixtureRun(page);
  for (const id of Object.values(FIXTURE_NODES)) await expect(nodeCard(page, id)).toBeVisible();
  const geometry = await expectCleanGeometry(page, 'demo open');
  // 5 tools pack 3 + 2: the two row-1 targets are the ones a bezier went through row 0 for.
  const needing = geometry.edges.filter((e) => straightLineCrossings(geometry, e) > 0).map((e) => e.target);
  expect(new Set(needing)).toEqual(new Set([FIXTURE_NODES.currency, FIXTURE_NODES.webSearch]));
  expectRoutingWasNeeded(geometry, 'demo open');
});

test('demo run: the held gate keeps its actions inside the card, clear of the inspector, edges intact', async ({
  page,
}) => {
  await openFixtureRun(page);
  const heldId = await waitForHeldCard(page);
  expect(heldId).toBe(FIXTURE_NODES.currency);
  const geometry = await expectCleanGeometry(page, 'demo held');
  await expectHeldCardClear(page, geometry, heldId);
});

// ── the user moves a card ───────────────────────────────────────────────────

test('a dragged card keeps its edge on both handles, re-routed from where it was dropped', async ({ page }) => {
  await openFixtureRun(page);
  const dragged = FIXTURE_NODES.webSearch; // row 1 — its edge is a gutter route
  await expect(nodeCard(page, dragged)).toBeVisible();
  await waitForCanvasStill(page);

  const card = nodeCard(page, dragged);
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  // Rightwards past the block into clear canvas (a card dropped on top of
  // the row above would rightly be crossed by its own generic route — the
  // router routes trees, it does not dodge arbitrary obstacles).
  const from = { x: box.x + box.width / 2, y: box.y + 14 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 30, { steps: 6 });
  await page.mouse.move(from.x + 560, from.y + 120, { steps: 12 });
  await page.mouse.up();

  const moved = await card.boundingBox();
  expect(moved).not.toBeNull();
  if (moved === null) return;
  expect(Math.hypot(moved.x - box.x, moved.y - box.y), 'the card moved').toBeGreaterThan(150);

  const geometry = await readCanvasGeometry(page);
  const edge = geometry.edges.find((e) => e.target === dragged);
  const target = geometry.nodes.find((n) => n.id === dragged);
  const source = geometry.nodes.find((n) => n.id === edge?.source);
  if (edge === undefined || target?.targetHandle == null || source?.sourceHandle == null) {
    throw new Error('edge or handles missing after the drag');
  }
  const first = edge.samples[0] as { x: number; y: number };
  const last = edge.samples[edge.samples.length - 1] as { x: number; y: number };
  expect(distanceToRect(first, source.sourceHandle)).toBeLessThanOrEqual(HANDLE_TOLERANCE_PX);
  expect(distanceToRect(last, target.targetHandle)).toBeLessThanOrEqual(HANDLE_TOLERANCE_PX);
  // Re-routed on drop: the last stub is vertical into the new handle position.
  expect(Math.abs(last.x - handleCentre(target.targetHandle))).toBeLessThan(1.5);
  const beforeLast = edge.samples[edge.samples.length - 2] as { x: number; y: number };
  expect(Math.abs(beforeLast.x - last.x)).toBeLessThan(1.5);
  // And still through nobody: the moved card's edge crosses no other card.
  const found = crossings(geometry).filter((v) => v.edge === edge.id);
  expect(found, describe(found)).toEqual([]);
});
