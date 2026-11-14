#!/usr/bin/env node
/**
 * Start Acme Tasks.
 *   node dist/server.js            serve the API (port: $PORT, else auto — stable per worktree)
 *   node dist/server.js --spec     write openapi.json next to package.json and exit
 *
 * The URL is recorded in .jack/run/acme-tasks.json in this worktree, which
 * the example's preview scripts read — so two worktrees never collide.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { choosePort, parsePortFlag, stablePort, worktreeRoot, writeRunInfo } from '@graphmind-ai/jack-cli';
import { createTasksApp } from './app.js';
import { buildOpenApi } from './openapi.js';
import { routes } from './routes.js';

if (process.argv.includes('--spec')) {
  const out = fileURLToPath(new URL('../openapi.json', import.meta.url));
  writeFileSync(out, `${JSON.stringify(buildOpenApi(routes), null, 2)}\n`);
  console.log(`wrote ${out}`);
} else {
  const root = worktreeRoot();
  const { port, note } = await choosePort(parsePortFlag(process.env.PORT), 'acme-tasks', root);
  // Bind first: the OIDC issuer inside the app must be the exact origin it is served on.
  let handle: ((req: Request) => Response | Promise<Response>) | null = null;
  const server = serve({ fetch: (req) => handle!(req), port, hostname: '127.0.0.1' }, async (info) => {
    const origin = `http://127.0.0.1:${info.port}`;
    // Link mode: Acme needs Jack's issuer. The preview's port is stable per worktree, so it is known in advance.
    const linkSecret = process.env.JACK_LINK_SECRET;
    const env = linkSecret
      ? { JACK_LINK_SECRET: linkSecret, JACK_LINK_ISSUER: process.env.JACK_LINK_ISSUER ?? `http://127.0.0.1:${stablePort('preview', root)}`, JACK_LINK_AUDIENCE: origin }
      : {};
    const { app } = await createTasksApp({ origin, env });
    handle = app.fetch;
    const unregister = writeRunInfo({ service: 'acme-tasks', url: origin }, root);
    const stop = () => {
      unregister();
      server.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (note) console.log(note);
    console.log(`Acme Tasks API at ${origin}`);
    console.log(`  spec:   ${origin}/openapi.json`);
    console.log(`  login:  ${origin}/.well-known/openid-configuration  (users: alice / alice-password, bob / bob-password)`);
    console.log('  keys:   tk_demo_alice, tk_demo_bob');
    if (linkSecret) console.log(`  link:   ${origin}/jack/link  (Jack issuer ${env.JACK_LINK_ISSUER})`);
    console.log(`  try:    curl -H 'authorization: Bearer tk_demo_alice' ${origin}/tasks`);
  });
}
