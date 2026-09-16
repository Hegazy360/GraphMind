#!/usr/bin/env node
/**
 * The check a user can run: install the release FROM THE REGISTRY into an
 * empty directory and run `npm audit signatures`.
 *
 *   node scripts/release/audit-signatures.mjs --version 0.5.0 [--require <publish-summary.json>]
 *
 * `npm audit signatures` verifies the registry signature of every installed
 * package and, for packages that have them, their provenance attestations.
 * On top of npm's own pass/fail, the packages this run published must each
 * show up in the `--json` report with a verified attestation — that is the
 * end-to-end proof that OIDC publishing produced something a consumer's
 * tooling can check, not just that a flag was passed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain, listPublishablePackages, parseArgs, run } from './lib.mjs';

/**
 * Pure: read `npm audit signatures --json --include-attestations` output.
 * Shape (npm 10/11/12): `{ invalid: [...], missing: [...], verified: [...] }`
 * where, with `--include-attestations`, `verified` lists the packages whose
 * ATTESTATIONS verified (each with an `attestations` object), not every
 * signed package. Returns `{ invalid, missingSignatures, attested }`.
 */
export function summarizeAuditJson(report) {
  const label = (p) => `${p?.name}@${p?.version}`;
  const invalid = (Array.isArray(report?.invalid) ? report.invalid : []).map(label);
  const missingSignatures = (Array.isArray(report?.missing) ? report.missing : []).map(label);
  const verified = Array.isArray(report?.verified) ? report.verified : [];
  const attested = new Set();
  for (const entry of verified) {
    if (entry?.name !== undefined && entry?.attestations !== undefined) attested.add(entry.name);
  }
  return { invalid, missingSignatures, attested, verified: verified.length };
}

export function auditSignatures({ names, version, required, spawn, log = console.log }) {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-audit-'));
  try {
    const opts = { cwd: dir, ...(spawn ? { spawn } : {}) };
    let result = run('npm', ['init', '-y'], { ...opts, stdio: 'ignore' });
    if (result.status !== 0) throw new Error(`npm init exited ${result.status}`);
    const specs = names.map((n) => `${n}@${version}`);
    log(`clean registry install of ${specs.join(' ')} into ${dir}`);
    result = run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...specs], opts);
    if (result.status !== 0) throw new Error(`npm install from the registry exited ${result.status}`);

    // Human-readable pass first (this is the command SECURITY.md tells users to run)...
    result = run('npm', ['audit', 'signatures'], opts);
    const humanStatus = result.status;
    // ...then the machine-readable pass to name which packages carry attestations.
    const json = run('npm', ['audit', 'signatures', '--json', '--include-attestations'], { ...opts, stdio: 'pipe' });
    let report;
    try {
      report = JSON.parse(json.stdout);
    } catch {
      report = undefined;
    }
    const summary = summarizeAuditJson(report);
    const problems = [];
    if (humanStatus !== 0) problems.push(`npm audit signatures exited ${humanStatus}`);
    for (const p of summary.invalid) problems.push(`invalid signature or attestation: ${p}`);
    for (const name of required ?? []) {
      if (!summary.attested.has(name)) problems.push(`${name}@${version} was published by this run but npm audit signatures reports no verified attestation for it`);
    }
    return { ok: problems.length === 0, problems, summary };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const packages = listPublishablePackages();
  const version = typeof args.version === 'string' ? args.version : packages[0]?.version;
  let required;
  if (typeof args.require === 'string') {
    const summary = JSON.parse(readFileSync(args.require, 'utf8'));
    required = Array.isArray(summary.published) ? summary.published : [];
  }
  const result = auditSignatures({ names: packages.map((p) => p.name), version, required });
  console.log(`\npackages with verified attestations: ${result.summary.attested.size}`);
  if (!result.ok) {
    console.error('\nSIGNATURE AUDIT FAILED:');
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('npm audit signatures: OK');
}
