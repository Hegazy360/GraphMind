/**
 * A layout/contrast audit that runs inside the page.
 *
 * The two failure modes a screenshot review is supposed to catch — text that
 * is silently cut off, and text that disappears into its own background in
 * one of the two themes — are exactly the two a unit test cannot see. This
 * measures both from real computed styles and real box geometry.
 */
import type { Page } from '@playwright/test';

export interface ContrastFinding {
  selector: string;
  text: string;
  color: string;
  background: string;
  ratio: number;
}

export interface ClipFinding {
  selector: string;
  text: string;
  axis: 'x' | 'y';
  content: number;
  box: number;
}

export interface OverlapFinding {
  container: string;
  a: string;
  b: string;
  overlapPx: number;
}

export interface AuditReport {
  theme: string;
  bodyBackground: string;
  inspected: number;
  contrast: ContrastFinding[];
  clipped: ClipFinding[];
  overlapping: OverlapFinding[];
}

export interface AuditOptions {
  /** Elements whose legibility we care about. */
  textSelectors: string[];
  /** Containers whose direct children must not overlap. */
  rowSelectors: string[];
  /** Report anything below this WCAG contrast ratio. */
  minRatio: number;
}

export const DEFAULT_TEXT_SELECTORS = [
  '.gm-topbar-title h1',
  '.gm-topbar-title .gm-pill',
  '.gm-stat-value',
  '.gm-stat-label',
  '.gm-toolbtn-label',
  '.gm-node-title',
  '.gm-node-kind',
  '.gm-node-meta .gm-pill',
  '.gm-pause-label',
  '.gm-pause-error',
  '.gm-action',
  '.gm-token-tail',
  '.gm-inspect-head .gm-node-title',
  '.gm-inspect-stat-value',
  '.gm-inspect-stat-label',
  '.gm-section-label',
  '.gm-why-error-name',
  '.gm-why-error-message',
  '.gm-conn-label',
  '.gm-run-item-app',
  '.gm-timeline-name',
  '.gm-palette-title',
  '.gm-palette-sub',
];

export const DEFAULT_ROW_SELECTORS = [
  '.gm-topbar-title',
  '.gm-topbar-stats',
  '.gm-topbar-actions',
  '.gm-node-head',
  '.gm-node-meta',
  '.gm-actions',
  '.gm-inspect-head',
  '.gm-runbar',
];

/**
 * Run the audit in the page and return what it found. Nothing here throws —
 * the caller decides what counts as a failure.
 */
export async function auditPage(page: Page, options: AuditOptions): Promise<AuditReport> {
  return await page.evaluate((opts: AuditOptions): AuditReport => {
    interface Rgba {
      r: number;
      g: number;
      b: number;
      a: number;
    }

    const parse = (value: string): Rgba | null => {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (match === null) return null;
      const parts = (match[1] ?? '').split(',').map((p) => Number.parseFloat(p.trim()));
      const [r, g, b, a] = parts;
      if (r === undefined || g === undefined || b === undefined) return null;
      return { r, g, b, a: a ?? 1 };
    };

    const over = (top: Rgba, bottom: Rgba): Rgba => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });

    /** Flatten every translucent background between the element and an opaque one. */
    const backgroundOf = (el: Element): Rgba => {
      const layers: Rgba[] = [];
      let node: Element | null = el;
      while (node !== null) {
        const parsed = parse(getComputedStyle(node).backgroundColor);
        if (parsed !== null && parsed.a > 0) {
          layers.push(parsed);
          if (parsed.a >= 0.999) break;
        }
        node = node.parentElement;
      }
      let out: Rgba = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (layer !== undefined) out = over(layer, out);
      }
      return out;
    };

    /** CSS `opacity` compounds down the tree and dims text against its ground. */
    const effectiveOpacity = (el: Element): number => {
      let alpha = 1;
      let node: Element | null = el;
      while (node !== null) {
        alpha *= Number.parseFloat(getComputedStyle(node).opacity || '1');
        node = node.parentElement;
      }
      return alpha;
    };

    const channel = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance = (c: Rgba): number =>
      0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    const ratio = (a: Rgba, b: Rgba): number => {
      const la = luminance(a);
      const lb = luminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    const describe = (el: Element): string => {
      const cls = el.getAttribute('class');
      const first = cls === null ? '' : `.${cls.trim().split(/\s+/).slice(0, 2).join('.')}`;
      return `${el.tagName.toLowerCase()}${first}`;
    };

    const isVisible = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };

    const ownText = (el: Element): string => (el.textContent ?? '').trim();

    const contrast: ContrastFinding[] = [];
    const clipped: ClipFinding[] = [];
    const overlapping: OverlapFinding[] = [];
    let inspected = 0;

    for (const selector of opts.textSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!isVisible(el)) continue;
        const text = ownText(el);
        if (text === '') continue;
        inspected += 1;

        const style = getComputedStyle(el);
        const fg = parse(style.color);
        if (fg === null) continue;
        const bg = backgroundOf(el);
        const alpha = fg.a * effectiveOpacity(el);
        const blended = over({ ...fg, a: alpha }, bg);
        const value = ratio(blended, bg);
        if (value < opts.minRatio) {
          contrast.push({
            selector: `${selector} → ${describe(el)}`,
            text: text.slice(0, 60),
            color: style.color,
            background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
            ratio: Math.round(value * 100) / 100,
          });
        }

        // Clipping only counts where the browser actually cuts text off and
        // says nothing — `overflow: visible` spills (caught by the overlap
        // pass) and `text-overflow: ellipsis` is a deliberate truncation.
        const hiddenX = style.overflowX === 'hidden' || style.overflowX === 'clip';
        const hiddenY = style.overflowY === 'hidden' || style.overflowY === 'clip';
        const ellipsis = style.textOverflow === 'ellipsis';
        if (hiddenX && !ellipsis && el.scrollWidth > el.clientWidth + 1) {
          clipped.push({
            selector: `${selector} → ${describe(el)}`,
            text: text.slice(0, 60),
            axis: 'x',
            content: el.scrollWidth,
            box: el.clientWidth,
          });
        }
        if (hiddenY && el.scrollHeight > el.clientHeight + 1) {
          clipped.push({
            selector: `${selector} → ${describe(el)}`,
            text: text.slice(0, 60),
            axis: 'y',
            content: el.scrollHeight,
            box: el.clientHeight,
          });
        }
      }
    }

    for (const selector of opts.rowSelectors) {
      for (const row of document.querySelectorAll(selector)) {
        if (!isVisible(row)) continue;
        const children = [...row.children].filter(
          (child) => isVisible(child) && ownText(child) !== '',
        );
        for (let i = 0; i < children.length; i++) {
          for (let j = i + 1; j < children.length; j++) {
            const a = children[i];
            const b = children[j];
            if (a === undefined || b === undefined) continue;
            if (a.contains(b) || b.contains(a)) continue;
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            const dx = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const dy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            // 1px of rounding is not an overlap; two boxes sharing real area is.
            if (dx > 1 && dy > 1) {
              overlapping.push({
                container: selector,
                a: `${describe(a)}: ${ownText(a).slice(0, 24)}`,
                b: `${describe(b)}: ${ownText(b).slice(0, 24)}`,
                overlapPx: Math.round(dx),
              });
            }
          }
        }
      }
    }

    return {
      theme: document.documentElement.getAttribute('data-theme') ?? 'system',
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      inspected,
      contrast,
      clipped,
      overlapping,
    };
  }, options);
}
