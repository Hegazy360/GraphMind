/**
 * Motion policy.
 *
 * Two rules, both enforced here rather than remembered at each call site:
 *
 *  1. **Reduced motion is not a suggestion.** Every duration in the app goes
 *     through `motionMs`, which returns 0 when the OS asks for less motion —
 *     the camera then jumps instead of gliding, which is the correct answer,
 *     not a degraded one. CSS keyframes are switched off separately in
 *     index.css under the same media query.
 *  2. **Motion carries meaning or it does not happen.** A node arriving
 *     animates *from its caller* so the eye reads "this was called by that".
 *     `enterOffset` is that vector, clamped: a parent 3,000px away would
 *     otherwise fling the card across the canvas and teach the eye nothing.
 */

export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Animation duration honouring reduced-motion. */
export function motionMs(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

/** Durations, in one place, so the app moves at a consistent tempo. */
export const DURATION = {
  /** A card arriving from its caller. */
  enter: 420,
  /** The camera gliding to a node it chose to follow. */
  follow: 620,
  /** The camera answering a direct request (palette, deep link, timeline). */
  focus: 480,
  /** Framing the whole graph. */
  frame: 460,
  /** A gate opening: slower, because it is a full stop. */
  hold: 760,
} as const;

/**
 * How far a card should appear to travel from its caller, and no further.
 *
 * A short hop reads as causality; a long one reads as the layout exploding.
 * 96px is roughly the inter-layer gap, so a normal parent/child arrival looks
 * like the edge drawing itself.
 */
export const MAX_ENTER_TRAVEL = 96;

export interface Point {
  x: number;
  y: number;
}

/**
 * The translate offset a newly-placed card should animate *from*, given its
 * own centre and its caller's. Returns a small upward hop when the node has
 * no caller (a run's root): things still arrive, they just arrive from
 * nowhere in particular.
 */
export function enterOffset(node: Point, parent: Point | undefined): Point {
  if (parent === undefined) return { x: 0, y: -18 };
  const dx = parent.x - node.x;
  const dy = parent.y - node.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return { x: 0, y: -18 };
  const scale = Math.min(1, MAX_ENTER_TRAVEL / distance);
  return { x: Math.round(dx * scale), y: Math.round(dy * scale) };
}
