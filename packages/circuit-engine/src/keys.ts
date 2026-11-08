/**
 * Divergence keys. Same canonicalization as GraphMind's loop guard and
 * behavior analysis (via @graphmind-ai/analyze), so "did this call change?"
 * means the same thing in the live engine, the replayer and the analyzer.
 * Unsalted on purpose: these keys never leave the journal they describe.
 */
import { canonicalValue } from '@graphmind-ai/analyze';
import type { EntryKind } from '@graphmind-ai/circuit-schema';

export function entryKey(kind: EntryKind, name: string, input: unknown): string {
  // canonicalValue returns undefined only for un-canonicalizable values
  // (cycles, depth bombs); those can't be journaled either, so a sentinel
  // that compares unequal to any real key is the honest fallback.
  return canonicalValue([kind, name, input === undefined ? null : input]) ?? `!uncanonical:${kind}:${name}`;
}
