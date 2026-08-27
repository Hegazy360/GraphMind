/**
 * Bundle one run into a single self-contained HTML file: the viewer's own
 * JS and CSS inlined, with the run's envelopes embedded as
 * `window.__GRAPHMIND_RUN__`.
 *
 * The point is shareability without a service. Attach the file to an issue,
 * drop it in Slack, open it on a plane — it is the same debugger UI reading a
 * frozen run, with no server, no network, and no account. It is also, by
 * construction, a complete record of what happened: prompts, tool inputs and
 * outputs, errors and timings all travel with it, which is exactly why the
 * command warns about handing it to people you would not hand your prompts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredEvent } from './storage.js';

export interface ExportHtmlOptions {
  runId: string;
  app: string;
  events: StoredEvent[];
  schemaVersion: number;
  viewerDist: string;
  version: string;
}

/** `</script>` inside embedded JSON would close our own tag; also dodge HTML comments. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function readAsset(dir: string, suffix: string): string {
  const assets = join(dir, 'assets');
  const file = readdirSync(assets).find((name) => name.endsWith(suffix));
  if (file === undefined) throw new Error(`no ${suffix} asset in ${assets}`);
  return readFileSync(join(assets, file), 'utf8');
}

export function buildRunHtml(options: ExportHtmlOptions): string {
  const { runId, app, events, schemaVersion, viewerDist, version } = options;

  const js = readAsset(viewerDist, '.js');
  const css = readAsset(viewerDist, '.css');

  const envelopes = events.map((event) => ({
    gm: schemaVersion,
    seq: event.seq,
    ts: event.ts,
    runId: event.runId,
    type: event.type,
    payload: event.payload,
  }));

  const title = `${app} — GraphMind run ${runId}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark light" />
    <meta name="robots" content="noindex" />
    <title>${title.replace(/[<>&]/g, '')}</title>
    <!--
      Exported by GraphMind v${version} (https://graphmind.ai).
      Self-contained: the viewer and one recorded run, no network required.
    -->
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>window.__GRAPHMIND_RUN__ = ${safeJson(envelopes)};</script>
    <script type="module">${js}</script>
  </body>
</html>
`;
}
