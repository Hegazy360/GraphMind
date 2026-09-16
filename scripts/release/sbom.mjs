#!/usr/bin/env node
/**
 * One CycloneDX SBOM per release, describing what a consumer actually installs.
 *
 *   node scripts/release/sbom.mjs --tarballs <dir> --out graphmind-0.5.0.cdx.json
 *
 * Why ONE workspace SBOM and not eight: the eight packages share a version and
 * a single dependency closure (`graphmind-ai` depends on the seven libraries;
 * the libraries depend only on each other and zod), so eight documents would
 * repeat one graph eight times. And why it is generated from a CLEAN `npm
 * install` of the packed tarballs into an empty directory rather than from the
 * pnpm workspace: the workspace holds dev dependencies, examples and apps, and
 * `@cyclonedx/cyclonedx-npm` reads `npm ls`, which does not understand pnpm's
 * layout. The clean install is exactly what `npm install graphmind-ai` gives a
 * user, so the SBOM lists exactly that — 0 dev dependencies, every runtime one.
 *
 * The generator is pinned (`@cyclonedx/cyclonedx-npm@6.0.1`) and fetched with
 * `npx --yes <name>@<version>`; Dependabot does not see it, so bump it here.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT, isMain, listPublishablePackages, parseArgs, run } from './lib.mjs';

export const CYCLONEDX_NPM_VERSION = '6.0.1';

/**
 * Install the tarballs into a fresh directory with npm (not pnpm: a consumer's
 * resolver, a consumer's layout). Returns the directory. `--ignore-scripts`
 * because nothing here needs a lifecycle script to run and a release job
 * should not execute one.
 */
export function cleanInstall(tarballDir, { spawn, keep = false, log = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-sbom-'));
  const tarballs = readdirSync(tarballDir).filter((f) => f.endsWith('.tgz')).map((f) => join(tarballDir, f));
  if (tarballs.length === 0) throw new Error(`no .tgz files in ${tarballDir}`);
  log(`clean install of ${tarballs.length} tarball(s) into ${dir}`);
  const opts = { cwd: dir, ...(spawn ? { spawn } : {}) };
  let result = run('npm', ['init', '-y'], { ...opts, stdio: 'ignore' });
  if (result.status !== 0) throw new Error(`npm init exited ${result.status}`);
  result = run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--install-links=false', ...tarballs], opts);
  if (result.status !== 0) {
    if (!keep) rmSync(dir, { recursive: true, force: true });
    throw new Error(`npm install of the tarballs exited ${result.status}`);
  }
  return dir;
}

/**
 * Pure checks over a parsed SBOM: CycloneDX, has components, and every one of
 * `expected` (`{name, version}`) appears with a matching purl.
 */
export function validateSbom(sbom, expected) {
  const problems = [];
  if (sbom?.bomFormat !== 'CycloneDX') problems.push(`bomFormat is ${String(sbom?.bomFormat)}, expected CycloneDX`);
  const components = Array.isArray(sbom?.components) ? sbom.components : [];
  if (components.length === 0) problems.push('SBOM lists no components');
  const purls = new Set(components.map((c) => c.purl).filter(Boolean));
  if (sbom?.metadata?.component?.purl) purls.add(sbom.metadata.component.purl);
  for (const { name, version } of expected) {
    const purl = `pkg:npm/${name.startsWith('@') ? name.replace('@', '%40') : name}@${version}`;
    if (!purls.has(purl)) problems.push(`${name}@${version} is missing from the SBOM (wanted purl ${purl})`);
  }
  return { ok: problems.length === 0, problems, componentCount: components.length };
}

export function generateSbom({ tarballDir, outFile, expected, spawn, log = console.log }) {
  const dir = cleanInstall(tarballDir, { spawn, log });
  try {
    const out = resolve(outFile);
    const result = run('npx', ['--yes', `@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}`, '--output-format', 'JSON', '--spec-version', '1.6', '--output-reproducible', '--output-file', out], { cwd: dir, ...(spawn ? { spawn } : {}) });
    if (result.status !== 0) throw new Error(`cyclonedx-npm exited ${result.status}`);
    if (!existsSync(out)) throw new Error(`cyclonedx-npm produced no file at ${out}`);
    const sbom = JSON.parse(readFileSync(out, 'utf8'));
    return validateSbom(sbom, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.tarballs !== 'string' || typeof args.out !== 'string') {
    console.error('usage: node scripts/release/sbom.mjs --tarballs <dir> --out <file.cdx.json>');
    process.exit(2);
  }
  const expected = listPublishablePackages(REPO_ROOT).map((p) => ({ name: p.name, version: p.version }));
  const result = generateSbom({ tarballDir: args.tarballs, outFile: args.out, expected });
  if (!result.ok) {
    console.error('\nSBOM CHECK FAILED:');
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\nSBOM OK: ${result.componentCount} components, all ${expected.length} GraphMind packages present -> ${args.out}`);
}
