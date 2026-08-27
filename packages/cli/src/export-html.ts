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
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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

/** Read one HTML attribute out of a start tag. */
function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match?.[1] ?? match?.[2];
}

/**
 * Which files the viewer actually boots from.
 *
 * Guessing — "the first file in assets/ ending in .js" — was wrong the moment
 * the viewer gained a second chunk: `assets/` now holds `index-<hash>.js` AND
 * `synthetic-<hash>.js` (a lazily imported stress generator), and readdir
 * order decides which one gets inlined. An export built from the wrong chunk
 * opens to a blank page.
 *
 * `dist/index.html` is the build's own authoritative statement of its entry
 * points, so it is parsed instead. Anything it names that cannot be resolved
 * to a local file is an error, loudly — never a silent fallback to a guess.
 */
function readEntryAssets(dir: string): { js: string[]; css: string[] } {
  const indexPath = join(dir, 'index.html');
  let html: string;
  try {
    html = readFileSync(indexPath, 'utf8');
  } catch {
    throw new Error(
      `cannot read the viewer entry point at ${indexPath} — the viewer build is missing or incomplete`,
    );
  }

  const js: string[] = [];
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if ((attr(tag, 'type') ?? '').toLowerCase() !== 'module') continue;
    const src = attr(tag, 'src');
    if (src !== undefined && src !== '') js.push(src);
  }
  const css: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) continue;
    const href = attr(tag, 'href');
    if (href !== undefined && href !== '') css.push(href);
  }

  if (js.length === 0) {
    throw new Error(
      `${indexPath} names no <script type="module" src="..."> — cannot identify the viewer bundle`,
    );
  }
  if (css.length === 0) {
    throw new Error(
      `${indexPath} names no <link rel="stylesheet" href="..."> — cannot identify the viewer stylesheet`,
    );
  }
  return { js, css };
}

/** Resolve one `index.html` reference to a file inside the viewer build. */
function readReferencedAsset(dir: string, reference: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//')) {
    throw new Error(
      `the viewer build references a remote asset (${reference}); a self-contained export needs local files`,
    );
  }
  const root = resolve(dir);
  const path = reference.split('?')[0]?.split('#')[0] ?? '';
  const target = resolve(root, `.${path.startsWith('/') ? path : `/${path}`}`);
  if (!target.startsWith(root + sep)) {
    throw new Error(`the viewer build references ${reference}, which escapes ${root}`);
  }
  try {
    return readFileSync(target, 'utf8');
  } catch {
    throw new Error(`the viewer build references ${reference}, but ${target} is not readable`);
  }
}

export function buildRunHtml(options: ExportHtmlOptions): string {
  const { runId, app, events, schemaVersion, viewerDist, version } = options;

  const entry = readEntryAssets(viewerDist);
  const js = entry.js.map((ref) => readReferencedAsset(viewerDist, ref));
  const css = entry.css.map((ref) => readReferencedAsset(viewerDist, ref));

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
    ${css.map((sheet) => `<style>${sheet}</style>`).join('\n    ')}
  </head>
  <body>
    <div id="root"></div>
    <script>window.__GRAPHMIND_RUN__ = ${safeJson(envelopes)};</script>
    ${js.map((bundle) => `<script type="module">${bundle}</script>`).join('\n    ')}
  </body>
</html>
`;
}
