#!/usr/bin/env node
/**
 * Publish every workspace package at the repo's version — idempotently.
 *
 *   node scripts/release/publish-npm.mjs [--dry-run] [--summary <file>]
 *
 * Runs `pnpm -r publish --access public --provenance --no-git-checks`, which
 * (a) rewrites `workspace:*` to real versions — `npm publish` does not — and
 * (b) natively skips any package whose version is already on the registry
 * ("There are no new packages that should be published"). Around that:
 *
 *   before: ask the registry which of the packages already exist at this
 *           version, and say so. All of them -> a no-op success (re-running
 *           the workflow for a released tag must be green, not red).
 *   after:  poll the registry until every package resolves. A partial
 *           publish (5 of 8) is a failed release that names the missing
 *           three, because `graphmind-ai@X` depends on `@graphmind-ai/*@X`
 *           and a consumer gets ETARGET until they exist.
 *
 * A pre-release version (anything with a `-`, e.g. 0.5.0-rc.1) is published
 * under the `next` dist-tag so `latest` keeps pointing at the last release.
 *
 * Authentication is npm's business: Trusted Publishing (OIDC) when the job has
 * `id-token: write` and no token is configured; an `NPM_TOKEN` written to
 * ~/.npmrc by the workflow otherwise. Nothing here reads a secret.
 */
import { writeFileSync } from 'node:fs';
import { REPO_ROOT, isMain, listPublishablePackages, parseArgs, publishedVersions, run, sleep } from './lib.mjs';

/**
 * Pure planning step. `lookup(name)` resolves to the Set of versions the
 * registry has for `name` (undefined = could not tell). Returns
 * `{ version, already, toPublish, unknown }`.
 */
export async function planPublish(packages, lookup) {
  const versions = new Set(packages.map((p) => p.version));
  if (versions.size !== 1) {
    throw new Error(`packages disagree on their version: ${[...versions].join(', ')} — run check-versions first`);
  }
  const [version] = versions;
  const already = [];
  const toPublish = [];
  const unknown = [];
  for (const pkg of packages) {
    const have = await lookup(pkg.name);
    if (have === undefined) unknown.push(pkg.name);
    else if (have.has(version)) already.push(pkg.name);
    else toPublish.push(pkg.name);
  }
  return { version, already, toPublish, unknown };
}

/**
 * Poll until every name resolves at `version`, or the deadline passes.
 * Returns the names still missing (empty = all there).
 */
export async function waitUntilPublished(names, version, lookup, { deadlineMs = 10 * 60 * 1000, intervalMs = 10_000, now = Date.now, wait = sleep, log = () => {} } = {}) {
  const pending = new Set(names);
  const started = now();
  while (pending.size > 0) {
    for (const name of [...pending]) {
      const have = await lookup(name);
      if (have?.has(version)) {
        pending.delete(name);
        log(`  ok   ${name}@${version}`);
      }
    }
    if (pending.size === 0 || now() - started > deadlineMs) break;
    await wait(intervalMs);
  }
  return [...pending];
}

/**
 * The whole operation. Injectable: `lookup`, `spawn` (for pnpm), `wait`.
 * Returns `{ ok, version, already, published, missing, dryRun }`.
 */
export async function publishNpm({ root = REPO_ROOT, dryRun = false, lookup, spawn, wait, deadlineMs, intervalMs, log = console.log } = {}) {
  const packages = listPublishablePackages(root);
  if (packages.length === 0) throw new Error('no publishable packages under packages/');
  const resolveVersions = lookup ?? ((name) => publishedVersions(name));

  const plan = await planPublish(packages, resolveVersions);
  log(`Publishing ${packages.length} package(s) at ${plan.version}${dryRun ? ' (DRY RUN — nothing will be uploaded)' : ''}`);
  for (const name of plan.already) log(`  skip ${name}@${plan.version} — already on the registry`);
  for (const name of plan.unknown) log(`  ?    ${name} — registry lookup failed; pnpm will decide`);

  if (plan.toPublish.length === 0 && plan.unknown.length === 0) {
    log(`\nNothing to publish: all ${packages.length} package(s) are already at ${plan.version}. No-op success.`);
    return { ok: true, version: plan.version, already: plan.already, published: [], missing: [], dryRun, noop: true };
  }

  const args = ['-r', 'publish', '--access', 'public', '--provenance', '--no-git-checks'];
  // A pre-release (0.5.0-rc.1 — versionFromTag accepts it) must not become
  // `latest`: npm tags whatever it publishes `latest` unless told otherwise,
  // and `npm install graphmind-ai` would then hand every user the RC.
  if (plan.version.includes('-')) args.push('--tag', 'next');
  if (dryRun) args.push('--dry-run');
  log(`\n$ pnpm ${args.join(' ')}`);
  const result = run('pnpm', args, { cwd: root, ...(spawn ? { spawn } : {}) });
  if (result.status !== 0) log(`\npnpm publish exited ${result.status}; checking what actually landed...`);

  if (dryRun) {
    return { ok: result.status === 0, version: plan.version, already: plan.already, published: [], missing: [], dryRun, wanted: plan.toPublish };
  }

  const wanted = [...plan.toPublish, ...plan.unknown];
  log(`\nWaiting for ${wanted.length} package(s) to resolve on the registry...`);
  const missing = await waitUntilPublished(wanted, plan.version, resolveVersions, {
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(wait === undefined ? {} : { wait }),
    log,
  });
  const published = wanted.filter((name) => !missing.includes(name));
  if (missing.length > 0) {
    log(`\nPARTIAL PUBLISH: ${published.length + plan.already.length} of ${packages.length} package(s) are at ${plan.version}. MISSING:`);
    for (const name of missing) log(`  MISSING  ${name}@${plan.version}`);
    log('\nAnything depending on these resolves to ETARGET. Fix the cause and re-run this workflow — it skips what already landed.');
  }
  return { ok: missing.length === 0 && result.status === 0, version: plan.version, already: plan.already, published, missing, dryRun };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const result = await publishNpm({ dryRun });
  if (typeof args.summary === 'string') {
    writeFileSync(args.summary, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nsummary written to ${args.summary}`);
  }
  process.exit(result.ok ? 0 : 1);
}
