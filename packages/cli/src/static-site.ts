/**
 * Serves the built viewer SPA from the viewer-dist directory when present,
 * and a minimal built-in placeholder page when it is not. No dependency on
 * the viewer having been built — the server is fully functional without it.
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { VERSION } from './version.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

const PLACEHOLDER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GraphMind</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0d1117; color: #e6edf3;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; } code { background: #161b22; padding: .15rem .4rem; border-radius: 4px; }
  a { color: #58a6ff; } p.muted { color: #8b949e; font-size: .9rem; }
</style>
</head>
<body>
<main>
<h1>GraphMind server is running</h1>
<p>The viewer web app isn't built into this installation, so there is nothing
visual to show yet — but the server is fully live:</p>
<p>
apps stream to <code>/ingest</code> (WebSocket),
viewers speak <code>/ws/ui</code> (WebSocket),
and the REST API is at <a href="/api/runs"><code>/api/runs</code></a>
(health: <a href="/health"><code>/health</code></a>).
</p>
<p class="muted">graphmind-ai v${VERSION}</p>
</main>
</body>
</html>
`;

function tryFile(path: string): Uint8Array | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return new Uint8Array(readFileSync(path));
  } catch {
    return undefined;
  }
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': MIME['.html'] as string } });
}

function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Handler for `GET /*` (everything the API routes did not claim). */
export function serveViewer(requestUrl: string, viewerDist: string): Response {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return notFound();
  }

  const root = resolve(viewerDist);
  const index = tryFile(join(root, 'index.html'));
  if (index === undefined) {
    // Viewer not built. Placeholder for page-like paths, 404 for assets.
    if (extname(pathname) === '' || pathname === '/') return html(PLACEHOLDER);
    return notFound();
  }

  const target = resolve(root, `.${pathname}`);
  const inRoot = target === root || target.startsWith(root + sep);
  if (inRoot && target !== root) {
    const file = tryFile(target);
    if (file !== undefined) {
      const mime = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
      return new Response(file, { status: 200, headers: { 'content-type': mime } });
    }
  }
  // SPA fallback: unknown extensionless (route-like) paths get index.html.
  if (extname(pathname) === '' || pathname === '/') {
    return new Response(index, {
      status: 200,
      headers: { 'content-type': MIME['.html'] as string },
    });
  }
  return notFound();
}
