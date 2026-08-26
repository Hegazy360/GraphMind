/**
 * Hand-rolled hash routing: `#/run/:runId` and `#/run/:runId/node/:nodeId`
 * deep links select (and center) a run/node.
 */
export interface Route {
  runId?: string;
  nodeId?: string;
}

export function parseHash(hash: string): Route {
  const match = /^#\/run\/([^/]+)(?:\/node\/(.+))?$/.exec(hash);
  if (match === null) return {};
  const runId = match[1];
  const nodeId = match[2];
  return {
    ...(runId !== undefined ? { runId: decodeURIComponent(runId) } : {}),
    ...(nodeId !== undefined ? { nodeId: decodeURIComponent(nodeId) } : {}),
  };
}

export function formatHash(runId: string | undefined, nodeId: string | undefined): string {
  if (runId === undefined) return '';
  const base = `#/run/${encodeURIComponent(runId)}`;
  return nodeId === undefined ? base : `${base}/node/${encodeURIComponent(nodeId)}`;
}
