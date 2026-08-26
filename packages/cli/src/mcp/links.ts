/**
 * Viewer deep links. Must stay in sync with the viewer's hash router
 * (`apps/viewer/src/router.ts`): `#/run/:runId` and
 * `#/run/:runId/node/:nodeId`, both segments URI-component-encoded.
 */

/** `http://127.0.0.1:<port>` — no trailing slash. */
export function viewerBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function runLink(baseUrl: string, runId: string): string {
  return `${baseUrl}/#/run/${encodeURIComponent(runId)}`;
}

export function nodeLink(baseUrl: string, runId: string, nodeId: string): string {
  return `${runLink(baseUrl, runId)}/node/${encodeURIComponent(nodeId)}`;
}
