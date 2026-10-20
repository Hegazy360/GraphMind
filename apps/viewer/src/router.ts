/**
 * Hand-rolled hash routing. `#/run/:runId` and `#/run/:runId/node/:nodeId`
 * deep links select (and center) a run/node; `#/build` opens the workflow
 * builder page.
 */
export type Page = 'debug' | 'build';

export interface Route {
  page?: Page;
  runId?: string;
  nodeId?: string;
}

export const BUILD_HASH = '#/build';

export function parseHash(hash: string): Route {
  if (hash === BUILD_HASH || hash === `${BUILD_HASH}/`) return { page: 'build' };
  const match = /^#\/run\/([^/]+)(?:\/node\/(.+))?$/.exec(hash);
  if (match === null) return {};
  const runId = match[1];
  const nodeId = match[2];
  return {
    page: 'debug',
    ...(runId !== undefined ? { runId: decodeURIComponent(runId) } : {}),
    ...(nodeId !== undefined ? { nodeId: decodeURIComponent(nodeId) } : {}),
  };
}

export function formatHash(runId: string | undefined, nodeId: string | undefined): string {
  if (runId === undefined) return '';
  const base = `#/run/${encodeURIComponent(runId)}`;
  return nodeId === undefined ? base : `${base}/node/${encodeURIComponent(nodeId)}`;
}
