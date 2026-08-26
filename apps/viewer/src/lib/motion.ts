export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Animation duration honouring reduced-motion. */
export function motionMs(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}
