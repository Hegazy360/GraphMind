#!/usr/bin/env node
/**
 * After a release, prove every artifact is actually installable at the
 * version this repo says it is.
 *
 *   node scripts/verify-published.mjs                       # npm, repo's own version
 *   node scripts/verify-published.mjs 0.4.3                 # npm, explicit version
 *   node scripts/verify-published.mjs --registries all      # npm + PyPI + RubyGems
 *   node scripts/verify-published.mjs 0.7.0 --registries pypi
 *
 * This exists because `pnpm -r publish` printed "✅ Published package
 * @graphmind-ai/client@0.4.3" and the registry served 0.4.2 for the next few
 * minutes. That is ordinary read-replica lag, but the consequence is not
 * ordinary: `graphmind-ai@0.4.3` depends on `@graphmind-ai/client@0.4.3`, so
 * for that window `npm install graphmind-ai` failed with ETARGET for
 * everyone. A release is not finished when the publish command exits; it is
 * finished when a stranger can install it.
 *
 * WHY THE DEFAULT IS npm ONLY: each publish workflow calls this right after
 * its own upload (publish-npm → npm, publish-python → pypi, publish-ruby →
 * rubygems), and the three run concurrently off one tag — the npm job must
 * not fail because PyPI is still uploading. `--registries all` is the
 * human's final check that the whole release landed.
 *
 * Polls until every artifact resolves or the deadline passes. Exit 0 = the
 * release is installable.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const registriesFlag = args.indexOf('--registries');
let registries = ['npm'];
if (registriesFlag !== -1) {
  const raw = args[registriesFlag + 1];
  if (raw === undefined) {
    console.error('--registries needs a value: npm,pypi,rubygems or all');
    process.exit(1);
  }
  registries = raw === 'all' ? ['npm', 'pypi', 'rubygems'] : raw.split(',').map((r) => r.trim());
  const known = new Set(['npm', 'pypi', 'rubygems']);
  const bad = registries.filter((r) => !known.has(r));
  if (bad.length > 0) {
    console.error(`unknown registry "${bad.join(', ')}" — expected npm, pypi, rubygems or all`);
    process.exit(1);
  }
  args.splice(registriesFlag, 2);
}

const expected =
  args[0] ??
  JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8')).version;

/** One artifact to verify: a probe returns the version list the registry serves. */
const targets = [];

if (registries.includes('npm')) {
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, 'packages', entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.private === true) continue;
    targets.push({
      label: `${pkg.name} (npm)`,
      probe: async () => {
        const res = await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2F')}`, {
          headers: { accept: 'application/json' },
        });
        return res.ok ? Object.keys((await res.json()).versions ?? {}) : undefined;
      },
    });
  }
}

if (registries.includes('pypi') && existsSync(join(root, 'python', 'pyproject.toml'))) {
  targets.push({
    label: 'graphmind-ai (PyPI)',
    probe: async () => {
      const res = await fetch('https://pypi.org/pypi/graphmind-ai/json', {
        headers: { accept: 'application/json' },
      });
      return res.ok ? Object.keys((await res.json()).releases ?? {}) : undefined;
    },
  });
}

if (registries.includes('rubygems') && existsSync(join(root, 'ruby', 'graphmind.gemspec'))) {
  targets.push({
    label: 'graphmind (RubyGems)',
    probe: async () => {
      const res = await fetch('https://rubygems.org/api/v1/versions/graphmind.json', {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return undefined;
      const versions = await res.json();
      return Array.isArray(versions) ? versions.map((v) => v.number) : undefined;
    },
  });
}

const DEADLINE_MS = 10 * 60 * 1000;
const started = Date.now();
const pending = new Set(targets);

console.log(
  `Verifying ${targets.length} artifact(s) resolve at ${expected} (${registries.join(', ')})...`,
);

while (pending.size > 0) {
  for (const target of [...pending]) {
    let found;
    try {
      found = await target.probe();
    } catch {
      // network blip: just try again on the next pass
    }
    if (found?.includes(expected) === true) {
      pending.delete(target);
      console.log(`  ok   ${target.label}@${expected}`);
    }
  }
  if (pending.size === 0) break;
  if (Date.now() - started > DEADLINE_MS) {
    console.error(`\nNOT INSTALLABLE after ${Math.round((Date.now() - started) / 1000)}s:`);
    for (const target of pending) console.error(`  MISSING  ${target.label}@${expected}`);
    console.error(
      '\nAnything depending on these resolves to ETARGET (or pip/gem install fails).\n' +
        'If this is not lag, re-run the publish for the missing artifacts before\n' +
        'announcing anything.',
    );
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

console.log(`\nAll ${targets.length} artifact(s) are installable at ${expected}.`);
