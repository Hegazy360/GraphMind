/**
 * Camera maths.
 *
 * Pure, because the canvas cannot be trusted to tell the truth about itself:
 * React Flow's own `fitView`/`setCenter` are silently dropped when they are
 * issued in the same commit as the nodes they refer to (see RunCanvas), and a
 * camera that *sometimes* moves is worse than one that never does — the run
 * pauses, and the frame the whole product exists for is off screen.
 *
 * So we compute the viewport ourselves and hand React Flow a finished
 * transform. Every function here is total, allocation-light and testable
 * without a DOM.
 *
 * ── insets ────────────────────────────────────────────────────────────────
 * The canvas element and the part of it a human can see are not always the
 * same rectangle. At desktop widths the inspector is a docked pane and they
 * are; at narrow widths it becomes a full-width overlay and the element is
 * several hundred pixels wider than what is visible. Framing or centring
 * against the element is what puts a held node underneath the panel that is
 * describing it, so every function here takes insets and aims at the visible
 * rectangle instead.
 */

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Insets {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface ZoomLimits {
  minZoom: number;
  maxZoom: number;
}

/** The part of a viewport a human can actually see, after overlays. */
export function usableRect(view: Size, insets: Insets = {}): Box {
  const left = Math.max(0, insets.left ?? 0);
  const top = Math.max(0, insets.top ?? 0);
  const right = Math.max(0, insets.right ?? 0);
  const bottom = Math.max(0, insets.bottom ?? 0);
  // An inset wider than the viewport would invert the rectangle; a squeezed
  // canvas is still better than a negative one.
  const width = Math.max(120, view.width - left - right);
  const height = Math.max(120, view.height - top - bottom);
  return { x: left, y: top, width, height };
}

/** Union of a set of boxes, or undefined when there are none. */
export function boundsOf(boxes: Iterable<Box>): Box | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  for (const box of boxes) {
    seen = true;
    if (box.x < minX) minX = box.x;
    if (box.y < minY) minY = box.y;
    if (box.x + box.width > maxX) maxX = box.x + box.width;
    if (box.y + box.height > maxY) maxY = box.y + box.height;
  }
  if (!seen) return undefined;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Put `bounds` fully inside the visible rectangle, as large as it will go.
 * `padding` is a fraction of the content, not pixels, so a two-node graph and
 * a three-hundred-node graph get the same visual margin.
 */
export function frameViewport(
  bounds: Box,
  view: Size,
  options: { padding?: number; insets?: Insets } & Partial<ZoomLimits> = {},
): Viewport {
  const rect = usableRect(view, options.insets);
  const padding = options.padding ?? 0.16;
  const minZoom = options.minZoom ?? 0.02;
  const maxZoom = options.maxZoom ?? 1;
  const zoom = clamp(
    Math.min(
      rect.width / (bounds.width * (1 + padding)),
      rect.height / (bounds.height * (1 + padding)),
    ),
    minZoom,
    maxZoom,
  );
  return {
    zoom,
    x: rect.x + rect.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: rect.y + rect.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

/**
 * Centre one box in the visible rectangle at a given zoom.
 *
 * `bias` nudges the target off centre along y: a held node wants to sit a
 * little above the middle, because the thing you read next — the action row
 * and whatever it grew downwards — is *under* it. 0 = dead centre, 0.5 =
 * halfway to the top edge.
 */
export function centerViewport(
  box: Box,
  view: Size,
  options: { zoom: number; insets?: Insets; bias?: number } ,
): Viewport {
  const rect = usableRect(view, options.insets);
  const bias = clamp(options.bias ?? 0, -0.8, 0.8);
  const zoom = options.zoom;
  return {
    zoom,
    x: rect.x + rect.width / 2 - (box.x + box.width / 2) * zoom,
    y: rect.y + rect.height / 2 - (rect.height / 2) * bias - (box.y + box.height / 2) * zoom,
  };
}

/**
 * Is `box` already comfortably on screen under `viewport`?
 *
 * The camera should not move for a node the user can already see — chasing a
 * fan-out of six parallel tools across a graph that fits on screen is motion
 * sickness, not information.
 */
export function isComfortablyVisible(
  box: Box,
  viewport: Viewport,
  view: Size,
  insets: Insets = {},
  margin = 24,
): boolean {
  const rect = usableRect(view, insets);
  const left = box.x * viewport.zoom + viewport.x;
  const top = box.y * viewport.zoom + viewport.y;
  const right = left + box.width * viewport.zoom;
  const bottom = top + box.height * viewport.zoom;
  return (
    left >= rect.x + margin &&
    top >= rect.y + margin &&
    right <= rect.x + rect.width - margin &&
    bottom <= rect.y + rect.height - margin
  );
}

/** How far apart two viewports are, in screen pixels of translation. */
export function viewportDistance(a: Viewport, b: Viewport): number {
  return Math.hypot(a.x - b.x, a.y - b.y) + Math.abs(a.zoom - b.zoom) * 600;
}
