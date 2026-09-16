#!/usr/bin/env node
/**
 * Prove the packages on the registry carry provenance attestations.
 *
 *   node scripts/release/verify-provenance.mjs --version 0.5.0 [--require <publish-summary.json>]
 *
 * Reads what `npm view <pkg>@<ver> --json` reads — the packument's
 * `versions[v].dist.attestations` — and expects an entry whose
 * `provenance.predicateType` is a SLSA provenance predicate.
 *
 * `--require` narrows the FAILURE to the packages a publish run actually
 * uploaded (from publish-npm.mjs's summary): a version that was published by
 * hand before this workflow existed (0.4.4) has no attestation, and re-running
 * the workflow for it must be a no-op success, not a red build. Packages
 * outside that list are still reported, as warnings.
 */
import { readFileSync } from 'node:fs';
import { fetchPackument, isMain, listPublishablePackages, parseArgs } from './lib.mjs';

/** Pure: given a packument and version, describe its provenance. */
export function provenanceOf(packument, version) {
  const dist = packument?.versions?.[version]?.dist;
  if (dist === undefined) return { exists: false, attested: false };
  const attestations = Array.isArray(dist.attestations) ? dist.attestations : dist.attestations ? [dist.attestations] : [];
  const provenance = attestations.find((a) => typeof a?.provenance?.predicateType === 'string' && /slsa\.dev\/provenance/.test(a.provenance.predicateType));
  return {
    exists: true,
    attested: provenance !== undefined,
    url: provenance?.url ?? attestations[0]?.url,
    predicateType: provenance?.provenance?.predicateType,
  };
}

export async function verifyProvenance({ names, version, required, fetch: fetchImpl, log = console.log }) {
  const requiredSet = new Set(required ?? names);
  const failures = [];
  const warnings = [];
  for (const name of names) {
    let doc;
    try {
      doc = await fetchPackument(name, fetchImpl ? { fetch: fetchImpl } : {});
    } catch (error) {
      failures.push(`${name}: registry lookup failed (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const info = provenanceOf(doc, version);
    const must = requiredSet.has(name);
    if (!info.exists) {
      (must ? failures : warnings).push(`${name}@${version} is not on the registry`);
    } else if (!info.attested) {
      (must ? failures : warnings).push(`${name}@${version} has NO provenance attestation`);
    } else {
      log(`  ok   ${name}@${version}  ${info.predicateType}  ${info.url ?? ''}`);
    }
  }
  return { ok: failures.length === 0, failures, warnings };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const packages = listPublishablePackages();
  const version = typeof args.version === 'string' ? args.version : packages[0]?.version;
  let required;
  if (typeof args.require === 'string') {
    const summary = JSON.parse(readFileSync(args.require, 'utf8'));
    required = Array.isArray(summary.published) ? summary.published : [];
    if (summary.version !== undefined && summary.version !== version) {
      console.error(`summary is for ${summary.version}, but --version is ${version}`);
      process.exit(2);
    }
  }
  console.log(`Checking provenance for ${packages.length} package(s) at ${version}${required ? ` (required for ${required.length} published in this run)` : ''}`);
  const result = await verifyProvenance({ names: packages.map((p) => p.name), version, required });
  for (const w of result.warnings) console.log(`  warn ${w}`);
  if (!result.ok) {
    console.error('\nPROVENANCE CHECK FAILED:');
    for (const f of result.failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(result.warnings.length > 0
    ? `\nProvenance OK for everything this run published (${result.warnings.length} pre-existing package(s) without attestations, listed above).`
    : `\nAll ${packages.length} package(s) at ${version} carry SLSA provenance.`);
}
