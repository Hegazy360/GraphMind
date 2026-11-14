#!/usr/bin/env node
/**
 * Run a `jack` command against THIS worktree's Acme Tasks API:
 *   node dist/with-api.js preview --config jack.oidc.yaml
 *
 * Reads .jack/run/acme-tasks.json (written by `pnpm start`) and exports its
 * URL as ACME_TASKS_URL, which jack.yaml and jack.oidc.yaml use for
 * `upstream` and `issuer`. An explicit ACME_TASKS_URL wins.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRunInfo, runFile } from '@graphmind-ai/jack-cli';

const env = { ...process.env };
if (!env.ACME_TASKS_URL) {
  const api = readRunInfo('acme-tasks');
  if (!api) {
    console.error(`Acme Tasks is not running in this worktree (no ${runFile('acme-tasks')}).`);
    console.error('Start it first:  pnpm --filter jack-tasks start   — or run everything at once:  pnpm --filter jack-tasks dev');
    process.exit(1);
  }
  env.ACME_TASKS_URL = api.url;
}
env.ACME_OIDC_CLIENT_SECRET ??= 'acme-dev-secret';
env.JACK_LINK_SECRET ??= 'acme-dev-link-secret-change-me-0123456789abcdef';
const cli = fileURLToPath(new URL('../../../packages/jack-cli/dist/cli.js', import.meta.url));
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
