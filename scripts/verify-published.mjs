#!/usr/bin/env node
/**
 * After a release, prove every package is actually installable at the version
 * this repo says it is.
 *
 *   node scripts/verify-published.mjs          # checks the repo's own version
 *   node scripts/verify-published.mjs 0.4.3
 *
 * This exists because `pnpm -r publish` printed "✅ Published package
 * @graphmind-ai/client@0.4.3" and the registry served 0.4.2 for the next few
 * minutes. That is ordinary read-replica lag, but the consequence is not
 * ordinary: `graphmind-ai@0.4.3` depends on `@graphmind-ai/client@0.4.3`, so
 * for that window `npm install graphmind-ai` failed with ETARGET for
 * everyone. A release is not finished when the publish command exits; it is
 * finished when a stranger can install it.
 *
 * Polls until every package resolves or the deadline passes. Exit 0 = the
 * release is installable.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expected = process.argv[2] ?? JSON.parse(
  readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8'),
).version;

const names = [];
for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = join(root, 'packages', entry.name, 'package.json');
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (pkg.private === true) continue;
  names.push(pkg.name);
}

const DEADLINE_MS = 10 * 60 * 1000;
const started = Date.now();
const pending = new Set(names);

console.log(`Verifying ${names.length} package(s) resolve at ${expected}...`);

while (pending.size > 0) {
  for (const name of [...pending]) {
    let found;
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
        headers: { accept: 'application/json' },
      });
      if (res.ok) found = Object.keys((await res.json()).versions ?? {});
    } catch {
      // network blip: just try again on the next pass
    }
    if (found?.includes(expected) === true) {
      pending.delete(name);
      console.log(`  ok   ${name}@${expected}`);
    }
  }
  if (pending.size === 0) break;
  if (Date.now() - started > DEADLINE_MS) {
    console.error(`\nNOT INSTALLABLE after ${Math.round((Date.now() - started) / 1000)}s:`);
    for (const name of pending) console.error(`  MISSING  ${name}@${expected}`);
    console.error(
      '\nAnything depending on these resolves to ETARGET. If this is not lag,\n' +
        're-run the publish for the missing packages before announcing anything.',
    );
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

console.log(`\nAll ${names.length} package(s) are installable at ${expected}.`);
