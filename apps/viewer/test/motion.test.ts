/**
 * Motion policy. The arrival vector is the one piece of the animation system
 * that is computed rather than declared, so it is the one piece that can be
 * wrong in a way CSS cannot catch.
 */
import { describe, expect, it } from 'vitest';
import { DURATION, MAX_ENTER_TRAVEL, enterOffset, motionMs } from '../src/lib/motion.js';

describe('enterOffset', () => {
  it('points from the node back towards its caller', () => {
    // Parent above and to the left → the card animates in from up-left.
    const offset = enterOffset({ x: 200, y: 400 }, { x: 100, y: 300 });
    expect(offset.x).toBeLessThan(0);
    expect(offset.y).toBeLessThan(0);
  });

  it('never travels further than one layer, however far the caller is', () => {
    const offset = enterOffset({ x: 0, y: 0 }, { x: 8000, y: -6000 });
    expect(Math.hypot(offset.x, offset.y)).toBeLessThanOrEqual(MAX_ENTER_TRAVEL + 1);
  });

  it('preserves the direction while clamping the distance', () => {
    const near = enterOffset({ x: 0, y: 0 }, { x: 30, y: 40 });
    const far = enterOffset({ x: 0, y: 0 }, { x: 3000, y: 4000 });
    // Same 3:4 bearing, different lengths.
    expect(near.x / near.y).toBeCloseTo(far.x / far.y, 1);
    expect(Math.hypot(far.x, far.y)).toBeGreaterThan(Math.hypot(near.x, near.y));
  });

  it('gives a rootless node a small hop rather than nothing', () => {
    expect(enterOffset({ x: 10, y: 10 }, undefined)).toEqual({ x: 0, y: -18 });
  });

  it('does not divide by zero when a card sits exactly on its caller', () => {
    const offset = enterOffset({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(Number.isFinite(offset.x)).toBe(true);
    expect(Number.isFinite(offset.y)).toBe(true);
  });
});

describe('motionMs', () => {
  it('passes durations through when nothing objects', () => {
    // jsdom-free environment: matchMedia is undefined, so nothing can ask for
    // reduced motion, and durations are honoured.
    expect(motionMs(420)).toBe(420);
  });

  it('collapses to an instant jump under reduced motion', () => {
    const original = (globalThis as { matchMedia?: unknown }).matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true });
    try {
      expect(motionMs(420)).toBe(0);
      expect(motionMs(DURATION.hold)).toBe(0);
    } finally {
      if (original === undefined) delete (globalThis as { matchMedia?: unknown }).matchMedia;
      else (globalThis as { matchMedia?: unknown }).matchMedia = original;
    }
  });
});

describe('duration scale', () => {
  it('gives a gate the slowest move — it is a full stop, not a nudge', () => {
    expect(DURATION.hold).toBeGreaterThan(DURATION.follow);
    expect(DURATION.follow).toBeGreaterThan(DURATION.focus);
  });
});
