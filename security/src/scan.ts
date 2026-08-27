/**
 * The scanner.
 *
 * A leak does not have to be a verbatim substring: a value can arrive
 * percent-encoded (it came from a URL), case-folded, or base64'd (it rode
 * inside a data: URI or an HTTP basic credential). Every canary is therefore
 * hunted in several encodings, and binary artifacts (the SQLite file, its WAL)
 * are searched byte-wise rather than as decoded text.
 */
import type { Canary, CanarySet } from './canaries.js';

export interface Artifact {
  /** Human name used in failure messages, e.g. "sqlite database (bytes)". */
  readonly name: string;
  /** What the artifact is, for the report: 'db' | 'http' | 'ws' | ... */
  readonly surface: string;
  readonly content: string | Buffer;
}

export interface Hit {
  readonly canary: Canary;
  readonly artifact: string;
  readonly surface: string;
  readonly encoding: string;
  /** A short window of the artifact around the match, canary redacted out. */
  readonly context: string;
}

/** All the shapes one canary can legitimately be found in. */
function encodings(value: string): { encoding: string; needle: string }[] {
  const out = [
    { encoding: 'literal', needle: value },
    { encoding: 'lowercase', needle: value.toLowerCase() },
    { encoding: 'uppercase', needle: value.toUpperCase() },
    { encoding: 'percent-encoded', needle: encodeURIComponent(value) },
    { encoding: 'base64', needle: Buffer.from(value, 'utf8').toString('base64') },
    { encoding: 'base64url', needle: Buffer.from(value, 'utf8').toString('base64url') },
  ];
  // Deduplicate: for many values several encodings are identical.
  const seen = new Set<string>();
  return out.filter((e) => {
    if (e.needle.length < 8) return false; // never search for something short
    if (seen.has(e.needle)) return false;
    seen.add(e.needle);
    return true;
  });
}

function asSearchable(content: string | Buffer): string {
  // latin1 gives a 1:1 byte<->char mapping, so an ASCII needle found in the
  // latin1 view is a real byte-sequence match anywhere in the file.
  return typeof content === 'string' ? content : content.toString('latin1');
}

/** Redact the canary itself out of the context window so failures never print it. */
function contextAround(haystack: string, index: number, needle: string): string {
  const before = haystack.slice(Math.max(0, index - 90), index);
  const after = haystack.slice(index + needle.length, index + needle.length + 90);
  return `${before}<<<CANARY:${needle.length}chars>>>${after}`.replace(/\s+/g, ' ');
}

/** Every occurrence of every canary in one artifact. */
export function scanArtifact(artifact: Artifact, canaries: readonly Canary[]): Hit[] {
  const haystack = asSearchable(artifact.content);
  const hits: Hit[] = [];
  for (const canary of canaries) {
    for (const { encoding, needle } of encodings(canary.value)) {
      const index = haystack.indexOf(needle);
      if (index === -1) continue;
      hits.push({
        canary,
        artifact: artifact.name,
        surface: artifact.surface,
        encoding,
        context: contextAround(haystack, index, needle),
      });
      break; // one hit per canary per artifact is enough to fail
    }
  }
  return hits;
}

export function scanAll(artifacts: readonly Artifact[], canaries: readonly Canary[]): Hit[] {
  return artifacts.flatMap((artifact) => scanArtifact(artifact, canaries));
}

/** Does this artifact contain this canary (any encoding)? */
export function contains(artifact: Artifact, canary: Canary): boolean {
  return scanArtifact(artifact, [canary]).length > 0;
}

export function describeHits(hits: readonly Hit[]): string {
  if (hits.length === 0) return 'no leaks';
  return hits
    .map(
      (hit) =>
        `LEAK: canary "${hit.canary.id}" (${hit.canary.where}) found ${hit.encoding} ` +
        `in ${hit.artifact} [surface=${hit.surface}]\n    context: ${hit.context}`,
    )
    .join('\n');
}

/**
 * The whole assertion in one call: no forbidden canary may appear in any
 * artifact, and every by-design canary must appear in at least one — the
 * second half is what keeps this suite from passing vacuously when the agent
 * silently failed to run.
 */
export interface AuditResult {
  readonly leaks: Hit[];
  readonly recordedByDesign: string[];
  readonly missingByDesign: string[];
}

export function audit(artifacts: readonly Artifact[], canaries: CanarySet): AuditResult {
  const leaks = scanAll(artifacts, canaries.forbidden());
  const recordedByDesign: string[] = [];
  const missingByDesign: string[] = [];
  for (const canary of canaries.byDesign()) {
    const found = artifacts.some((artifact) => contains(artifact, canary));
    if (found) recordedByDesign.push(canary.id);
    else missingByDesign.push(canary.id);
  }
  return { leaks, recordedByDesign, missingByDesign };
}
