#!/usr/bin/env node
/**
 * The whole example in one process, on free ports, correctly wired:
 *
 *   pnpm --filter jack-tasks dev                 # users sign in with Acme's login (OIDC)
 *   pnpm --filter jack-tasks dev -- --auth apikey   # users paste their Acme API key
 *   pnpm --filter jack-tasks dev -- --auth link     # users log in with Acme's session login (no OAuth server)
 *   pnpm --filter jack-tasks dev -- --auth single   # no sign-in; acts as tk_demo_alice
 *
 * Ports are stable per worktree (and move to the next free one if taken), so
 * several worktrees can each run `dev` at the same time. Both servers are
 * registered in .jack/run/, so `jack tools` / `jack call` in this worktree
 * talk to this worktree's preview.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { choosePort, startPreview, worktreeRoot, writeRunInfo } from '@graphmind-ai/jack-cli';
import { createTasksApp, defaultOidcClients } from './app.js';

const { values } = parseArgs({ options: { auth: { type: 'string', default: 'oidc' } } });
const auth = values.auth as 'oidc' | 'apikey' | 'link' | 'single';
if (!['oidc', 'apikey', 'link', 'single'].includes(auth)) {
  console.error('--auth must be oidc, apikey, link or single');
  process.exit(1);
}

const root = worktreeRoot();
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Link mode shares one secret between Acme and Jack. Dev default; set your own in production.
const linkSecret = process.env.JACK_LINK_SECRET ?? 'acme-dev-link-secret-change-me-0123456789abcdef';

// 1. The API (and Acme's login), on this worktree's port.
const { port: apiPort, note } = await choosePort('auto', 'acme-tasks', root);
if (note) console.log(note);
let apiFetch: ((r: Request) => Response | Promise<Response>) | null = null;
const api = await new Promise<{ origin: string; close: () => void }>((resolve) => {
  const s = serve({ fetch: (r) => apiFetch!(r), port: apiPort, hostname: '127.0.0.1' }, (info) =>
    resolve({ origin: `http://127.0.0.1:${info.port}`, close: () => s.close() }),
  );
});
// The preview's origin is only known after it starts, but Acme needs it as JACK_LINK_ISSUER. Preview ports
// are stable per worktree, so compute it the same way the preview will.
const previewPort = (await choosePort('auto', 'preview', root)).port;
const previewOrigin = `http://127.0.0.1:${previewPort}`;
const { app } = await createTasksApp({
  origin: api.origin,
  oidcClients: defaultOidcClients(),
  env: auth === 'link' ? { JACK_LINK_SECRET: linkSecret, JACK_LINK_ISSUER: previewOrigin, JACK_LINK_AUDIENCE: api.origin } : {},
});
apiFetch = app.fetch;
const unregisterApi = writeRunInfo({ service: 'acme-tasks', url: api.origin }, root);
console.log(`Acme Tasks API at ${api.origin}   (users: alice / alice-password · keys: tk_demo_alice)`);

// 2. Jack's preview, pointed at it.
const env: Record<string, string | undefined> = {
  ...process.env,
  ACME_TASKS_URL: api.origin,
  ACME_OIDC_CLIENT_SECRET: process.env.ACME_OIDC_CLIENT_SECRET ?? 'acme-dev-secret',
  JACK_LINK_SECRET: linkSecret,
};
// Only --auth single acts as one fixed key; otherwise an exported key must not silently disable sign-in.
if (auth === 'single') env.JACK_UPSTREAM_API_KEY ??= 'tk_demo_alice';
else delete env.JACK_UPSTREAM_API_KEY;
const preview = await startPreview(
  {
    config: here(auth === 'oidc' ? '../jack.oidc.yaml' : auth === 'link' ? '../jack.link.yaml' : '../jack.yaml'),
    port: auth === 'link' ? previewPort : 'auto',
    runRoot: root,
    env,
  },
  { out: (l) => console.log(l), err: (l) => console.error(l) },
);

const stop = async () => {
  await preview.close();
  unregisterApi();
  api.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
