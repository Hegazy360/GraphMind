#!/usr/bin/env node
/**
 * Pack every publishable package with `pnpm pack` and prove the tarballs are
 * shippable.
 *
 *   node scripts/release/pack.mjs --out <dir>
 *
 * Why pnpm and not npm: the workspace manifests say `"@graphmind-ai/schema":
 * "workspace:*"`. `pnpm pack` / `pnpm publish` rewrite that to the real
 * version; `npm pack` / `npm publish` do NOT, and a manifest containing
 * `workspace:*` is uninstallable for everyone (`npm ERR! Unsupported URL
 * Type "workspace:"`). Every tarball is therefore opened and its package.json
 * checked — this is the guard that turns a wrong publish command into a red
 * job instead of a broken release.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT, isMain, listPublishablePackages, parseArgs, run } from './lib.mjs';

/** package.json text from inside a tarball (`package/package.json`). */
export function manifestFromTarball(tarballPath, { exec = execFileSync } = {}) {
  const text = exec('tar', ['-xOf', tarballPath, 'package/package.json'], { encoding: 'utf8' });
  return JSON.parse(text);
}

/**
 * Pure check over a parsed manifest: every dependency block must be free of
 * `workspace:` / `link:` / `file:` specifiers. Returns the offending
 * `field.name: spec` strings (empty = clean).
 */
export function findUnpublishableSpecifiers(manifest) {
  const bad = [];
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (/^(workspace|link|file):/.test(String(spec))) bad.push(`${field}.${name}: ${spec}`);
    }
  }
  return bad;
}

/**
 * What provenance publishing needs of a manifest. npm refuses `--provenance`
 * when `repository.url` is missing or does not name the repository the
 * workflow runs in, so catch it before the publish step does.
 */
export function findProvenanceBlockers(manifest, repoSlug) {
  const problems = [];
  const url = manifest.repository?.url;
  if (typeof url !== 'string' || url === '') {
    problems.push('repository.url is missing');
  } else if (repoSlug !== undefined && !url.toLowerCase().includes(repoSlug.toLowerCase())) {
    problems.push(`repository.url "${url}" does not name ${repoSlug}`);
  }
  if (manifest.private === true) problems.push('package is private');
  return problems;
}

/**
 * Pack all publishable packages into `outDir`. Returns
 * `{ tarballs: [{ name, version, path }], problems: string[] }`.
 */
export function packAll({ root = REPO_ROOT, outDir, repoSlug, spawn, exec } = {}) {
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const problems = [];
  const tarballs = [];
  for (const pkg of listPublishablePackages(root)) {
    const before = new Set(readdirSync(out));
    const result = run('pnpm', ['pack', '--pack-destination', out], { cwd: pkg.dir, ...(spawn ? { spawn } : {}) });
    if (result.status !== 0) {
      problems.push(`${pkg.name}: pnpm pack exited ${result.status}`);
      continue;
    }
    const created = readdirSync(out).filter((f) => !before.has(f) && f.endsWith('.tgz'));
    if (created.length !== 1) {
      problems.push(`${pkg.name}: expected one new tarball, found ${created.length}`);
      continue;
    }
    const path = join(out, created[0]);
    const manifest = manifestFromTarball(path, exec ? { exec } : {});
    if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
      problems.push(`${path}: contains ${manifest.name}@${manifest.version}, expected ${pkg.name}@${pkg.version}`);
    }
    for (const bad of findUnpublishableSpecifiers(manifest)) {
      problems.push(`${pkg.name}: tarball manifest still has ${bad} — pack with pnpm, not npm`);
    }
    for (const bad of findProvenanceBlockers(manifest, repoSlug)) {
      problems.push(`${pkg.name}: ${bad} — npm will refuse --provenance`);
    }
    tarballs.push({ name: pkg.name, version: pkg.version, path });
  }
  return { tarballs, problems };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.out !== 'string') {
    console.error('usage: node scripts/release/pack.mjs --out <dir> [--repo owner/name]');
    process.exit(2);
  }
  const repoSlug = typeof args.repo === 'string' ? args.repo : process.env.GITHUB_REPOSITORY;
  const { tarballs, problems } = packAll({ outDir: args.out, repoSlug });
  for (const t of tarballs) console.log(`  packed ${t.name}@${t.version} -> ${t.path}`);
  if (problems.length > 0) {
    console.error('\nPACK CHECK FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\n${tarballs.length} tarball(s) packed; no workspace:/link:/file: specifiers remain.`);
}
