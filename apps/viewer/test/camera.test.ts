/**
 * The camera. Every one of these is a bug that shipped: the paused card off
 * screen, the held node underneath the inspector that was explaining it, and
 * a viewport that crawled because each move restarted from the last frame of
 * the one before.
 */
import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  centerViewport,
  frameViewport,
  isComfortablyVisible,
  usableRect,
  viewportDistance,
  type Box,
} from '../src/lib/camera.js';

const VIEW = { width: 1200, height: 800 };

function box(x: number, y: number, width = 100, height = 60): Box {
  return { x, y, width, height };
}

/** Where a box lands on screen under a viewport. */
function project(b: Box, vp: { x: number; y: number; zoom: number }) {
  return {
    left: b.x * vp.zoom + vp.x,
    top: b.y * vp.zoom + vp.y,
    right: (b.x + b.width) * vp.zoom + vp.x,
    bottom: (b.y + b.height) * vp.zoom + vp.y,
  };
}

describe('usableRect', () => {
  it('is the whole viewport with no overlays', () => {
    expect(usableRect(VIEW)).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('shrinks by the inspector, from the right', () => {
    expect(usableRect(VIEW, { right: 392 })).toEqual({ x: 0, y: 0, width: 808, height: 800 });
  });

  it('never inverts, however wide the overlay claims to be', () => {
    const rect = usableRect({ width: 300, height: 200 }, { right: 900 });
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });
});

describe('boundsOf', () => {
  it('unions every box', () => {
    expect(boundsOf([box(0, 0), box(300, 200)])).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 260,
    });
  });

  it('is undefined for nothing (the caller must not frame an empty graph)', () => {
    expect(boundsOf([])).toBeUndefined();
  });
});

describe('frameViewport', () => {
  it('puts the whole graph on screen with a margin', () => {
    const bounds = { x: -286, y: 0, width: 836, height: 722 };
    const vp = frameViewport(bounds, VIEW, { padding: 0.16 });
    const p = project(bounds, vp);
    expect(p.left).toBeGreaterThan(0);
    expect(p.top).toBeGreaterThan(0);
    expect(p.right).toBeLessThan(VIEW.width);
    expect(p.bottom).toBeLessThan(VIEW.height);
  });

  it('never zooms in past 1:1 for a small graph', () => {
    expect(frameViewport(box(0, 0, 40, 20), VIEW).zoom).toBe(1);
  });

  it('frames into the visible half when the inspector is open', () => {
    const bounds = { x: 0, y: 0, width: 800, height: 400 };
    const vp = frameViewport(bounds, VIEW, { insets: { right: 400 } });
    // The graph's centre must land in the left 800px, not the middle of the
    // element — that is what used to hide a run behind its own inspector.
    const centreX = (bounds.x + bounds.width / 2) * vp.zoom + vp.x;
    expect(centreX).toBeCloseTo(400, 0);
    expect(project(bounds, vp).right).toBeLessThanOrEqual(800);
  });

  it('respects the zoom floor rather than vanishing a huge graph', () => {
    const vp = frameViewport({ x: 0, y: 0, width: 400_000, height: 10 }, VIEW, {
      minZoom: 0.06,
    });
    expect(vp.zoom).toBe(0.06);
  });
});

describe('centerViewport', () => {
  it('centres a node in the visible rectangle', () => {
    const target = box(1000, 2000, 248, 188);
    const vp = centerViewport(target, VIEW, { zoom: 1 });
    const p = project(target, vp);
    expect((p.left + p.right) / 2).toBeCloseTo(600, 6);
    expect((p.top + p.bottom) / 2).toBeCloseTo(400, 6);
  });

  it('keeps a held node clear of the inspector', () => {
    const held = box(1000, 2000, 248, 188);
    const vp = centerViewport(held, VIEW, { zoom: 1, insets: { right: 392 } });
    expect(project(held, vp).right).toBeLessThan(VIEW.width - 392);
  });

  it('biases a held node above centre, so its action row has room below', () => {
    const held = box(0, 0, 248, 188);
    const middle = centerViewport(held, VIEW, { zoom: 1 });
    const raised = centerViewport(held, VIEW, { zoom: 1, bias: 0.16 });
    expect(raised.y).toBeLessThan(middle.y);
    // …but still on screen, not shoved off the top.
    expect(project(held, raised).top).toBeGreaterThan(0);
  });
});

describe('isComfortablyVisible', () => {
  const vp = { x: 0, y: 0, zoom: 1 };

  it('is true for a node well inside the frame', () => {
    expect(isComfortablyVisible(box(400, 300), vp, VIEW)).toBe(true);
  });

  it('is false for a node past the bottom edge', () => {
    expect(isComfortablyVisible(box(400, 790), vp, VIEW)).toBe(false);
  });

  it('counts the inspector as off screen, because it is', () => {
    const behindPanel = box(900, 300, 248, 96);
    expect(isComfortablyVisible(behindPanel, vp, VIEW)).toBe(true);
    expect(isComfortablyVisible(behindPanel, vp, VIEW, { right: 392 })).toBe(false);
  });

  it('accounts for zoom', () => {
    const far = box(2000, 1500);
    expect(isComfortablyVisible(far, vp, VIEW)).toBe(false);
    expect(isComfortablyVisible(far, { x: 0, y: 0, zoom: 0.2 }, VIEW)).toBe(true);
  });
});

describe('viewportDistance', () => {
  it('is zero for the same viewport', () => {
    expect(viewportDistance({ x: 1, y: 2, zoom: 0.5 }, { x: 1, y: 2, zoom: 0.5 })).toBe(0);
  });

  it('treats a zoom change as a real move', () => {
    expect(viewportDistance({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, zoom: 1.1 })).toBeGreaterThan(
      50,
    );
  });

  it('stays under the canvas no-op threshold for sub-pixel drift', () => {
    expect(
      viewportDistance({ x: 0, y: 0, zoom: 1 }, { x: 0.4, y: -0.3, zoom: 1.000001 }),
    ).toBeLessThan(6);
  });
});
