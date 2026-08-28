#!/usr/bin/env node
/**
 * Run a command on the OLDEST Node this repo supports, not just the newest.
 *
 *   node scripts/check-node-floor.mjs pnpm test:security
 *
 * This exists because of a real bug. `node:sqlite` round-trips a string
 * containing a NUL byte on Node 24 and mangles it on Node 22, so a `runId`
 * with a NUL in it was stored under a different id than the app streamed
 * under — on some runtimes and not others. Every local suite was green; CI
 * (Node 22) was red; the failure was invisible from the dev machine.
 *
 * `engines` says `>=22.13`, so the floor is part of the contract and has to be
 * executed, not declared. Same lesson as the Python README's stale benchmark:
 * verify on what you claim to support.
 *
 * Finds the floor interpreter from nvm; if it is not installed it says how to
 * get it and exits 0, because a missing optional toolchain must not be
 * confused with a failing test.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines?.node ?? '';
const floorMajor = Number(/(\d+)/.exec(engines)?.[1]);

if (!Number.isInteger(floorMajor)) {
  console.error(`could not read a major version out of engines.node ("${engines}")`);
  process.exit(1);
}

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error('usage: node scripts/check-node-floor.mjs <command> [args...]');
  process.exit(1);
}

if (process.versions.node.startsWith(`${floorMajor}.`)) {
  console.log(`Already on Node ${process.versions.node} (the floor). Running directly.`);
  process.exit(spawnSync(command[0], command.slice(1), { stdio: 'inherit', cwd: root }).status ?? 1);
}

const nvmVersions = join(homedir(), '.nvm', 'versions', 'node');
const match = existsSync(nvmVersions)
  ? readdirSync(nvmVersions)
      .filter((name) => name.startsWith(`v${floorMajor}.`))
      .sort()
      .pop()
  : undefined;

if (match === undefined) {
  console.log(
    `Node ${floorMajor} is not installed, so the floor was NOT exercised.\n` +
      `  engines.node is "${engines}" and this is Node ${process.versions.node}.\n` +
      `  Install it with:  nvm install ${floorMajor}\n` +
      '  Then re-run. (Skipping rather than failing: a missing optional\n' +
      '  toolchain is not a failing test, and CI runs the floor regardless.)',
  );
  process.exit(0);
}

const bin = join(nvmVersions, match, 'bin');
console.log(`Running on Node ${match} (engines floor ${floorMajor}): ${command.join(' ')}`);
const result = spawnSync(command[0], command.slice(1), {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
});
process.exit(result.status ?? 1);
