/**
 * The Vercel Function entry for graphmind.ai's dynamic paths (/app, /p, /.well-known,
 * /dashboard/callback, /api/internal). Bundled by scripts/build-vercel.mjs into
 * .vercel/output/functions/_platform.func.
 *
 * The platform is built once per function instance and reused across
 * requests (Fluid compute keeps instances warm), so the Postgres pool, the
 * JWKS cache and Jack's bundle cache survive between requests.
 *
 * A boot failure (a missing variable) answers 503 with a fixed message and
 * logs the variable name only; the next request tries again.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { waitUntil } from '@vercel/functions';
import { ConfigError, createHostedPlatform } from './hosted.js';
import { redact } from './redact.js';

type Listener = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

let ready: Promise<Listener> | null = null;

function boot(): Promise<Listener> {
  return createHostedPlatform({ waitUntil }).then((h) => {
    console.log(`[platform] booted (${h.mode})`);
    return getRequestListener(h.app.fetch) as Listener;
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let listener: Listener;
  try {
    listener = await (ready ??= boot());
  } catch (err) {
    ready = null;
    console.error('[platform] boot failed:', err instanceof ConfigError ? err.message : redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'service unavailable', detail: 'the platform is misconfigured; see the function logs' }));
    return;
  }
  await listener(req, res);
}
