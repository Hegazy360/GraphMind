/**
 * Where you are, as one value.
 *
 * The viewer is a small stack of places, one on screen at a time:
 *
 *     runs  →  run  →  node
 *
 * Each is a hash URL, so the browser's own back button walks back up it, a
 * deep link lands exactly where it says, and `graphmind record --html`,
 * `graphmind mcp` and ⇧L keep emitting the links they always did.
 *
 * `connect` and `build` are side trips rather than steps: you take one from
 * wherever you are and you expect to come back. So they do not replace the
 * trail, they extend it — `Runs › trip-planner › currencyConvert › Connect`
 * — and every ancestor stays a link. A place you can enter and not leave is
 * a bug, not a layout.
 */
export type Page = 'runs' | 'run' | 'node' | 'connect' | 'build';

/** The places inside a run — the two that need one selected. */
export function inRun(page: Page): boolean {
  return page === 'run' || page === 'node';
}

/** A side trip: entered from somewhere, and expected to return there. */
export function isAside(page: Page): boolean {
  return page === 'connect' || page === 'build';
}

export interface Route {
  page?: Page;
  runId?: string;
  nodeId?: string;
}

export const RUNS_HASH = '#/runs';
export const BUILD_HASH = '#/build';
export const CONNECT_HASH = '#/connect';

/** One step of the breadcrumb: a label, and where clicking it goes. */
export interface Crumb {
  label: string;
  hash: string;
  /** The last crumb is where you are; it is not a link. */
  current: boolean;
}

const ASIDE_LABEL: Record<'connect' | 'build', string> = {
  connect: 'Connect an agent',
  build: 'Build a workflow',
};

/**
 * The trail to a place. This is the whole navigation model the header
 * renders — no separate "which tab is active" state to keep in step.
 *
 * `run` and `node` describe where the *stack* is standing, which is still
 * true while you are off on a side trip: that is what makes the way back
 * exact rather than "somewhere up there".
 */
export function crumbsFor(
  page: Page,
  run: { runId: string; app: string } | undefined,
  node: { nodeId: string; name: string } | undefined,
  /** How deep the stack was when a side trip was taken. */
  stack: 'runs' | 'run' | 'node' = 'runs',
): Crumb[] {
  const aside = isAside(page) ? (page as 'connect' | 'build') : undefined;
  const at = aside === undefined ? (page as 'runs' | 'run' | 'node') : stack;

  const crumbs: Omit<Crumb, 'current'>[] = [{ label: 'Runs', hash: RUNS_HASH }];

  if (at !== 'runs' && run !== undefined) {
    crumbs.push({ label: run.app, hash: formatHash(run.runId, undefined) });
    if (at === 'node' && node !== undefined) {
      crumbs.push({ label: node.name, hash: formatHash(run.runId, node.nodeId) });
    }
  }
  if (aside !== undefined) {
    crumbs.push({ label: ASIDE_LABEL[aside], hash: pageHash(aside) });
  }

  // Where you are is the end of the trail, whatever truncated it — a run
  // that has not arrived yet collapses the stack, and the last crumb left
  // standing is still the one you are on.
  return crumbs.map((crumb, index) => ({ ...crumb, current: index === crumbs.length - 1 }));
}

export function parseHash(hash: string): Route {
  if (hash === BUILD_HASH || hash === `${BUILD_HASH}/`) return { page: 'build' };
  if (hash === CONNECT_HASH || hash === `${CONNECT_HASH}/`) return { page: 'connect' };
  if (hash === RUNS_HASH || hash === `${RUNS_HASH}/`) return { page: 'runs' };
  const match = /^#\/run\/([^/]+)(?:\/node\/(.+))?$/.exec(hash);
  if (match === null) return {};
  const runId = match[1];
  const nodeId = match[2];
  return {
    page: nodeId === undefined ? 'run' : 'node',
    ...(runId !== undefined ? { runId: decodeURIComponent(runId) } : {}),
    ...(nodeId !== undefined ? { nodeId: decodeURIComponent(nodeId) } : {}),
  };
}

export function formatHash(runId: string | undefined, nodeId: string | undefined): string {
  if (runId === undefined) return '';
  const base = `#/run/${encodeURIComponent(runId)}`;
  return nodeId === undefined ? base : `${base}/node/${encodeURIComponent(nodeId)}`;
}

/** The hash for a place that is not inside a run. */
export function pageHash(page: Page): string {
  if (page === 'build') return BUILD_HASH;
  if (page === 'connect') return CONNECT_HASH;
  if (page === 'runs') return RUNS_HASH;
  return '';
}

/**
 * How far into the stack a place is, so the history knows whether a move was
 * forward (push a new entry) or back (replace the current one). A side trip
 * counts as deeper than anything, because that is how it behaves: you go in,
 * and back comes out.
 */
export function depthOf(page: Page): number {
  switch (page) {
    case 'runs':
      return 0;
    case 'run':
      return 1;
    case 'node':
      return 2;
    default:
      return 3;
  }
}
