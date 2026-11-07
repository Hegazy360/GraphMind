/**
 * Parity pins: the analyzer's canonicalization must group calls exactly the
 * way the live loop guard does, or a run the guard held on would analyze
 * clean (and vice versa). The client is a devDependency here for exactly
 * this comparison — the shipped package never imports it.
 */
import { describe, expect, it } from 'vitest';
import { canonicalCall, canonicalize } from '@graphmind-ai/client';
import { callKey, canonicalValue, DEFAULT_IGNORE_KEYS, shortDigest } from '../src/canonical.js';

const SAMPLES: unknown[] = [
  undefined,
  null,
  0,
  -0,
  1.5,
  NaN,
  Infinity,
  'text',
  'quotes " and \\ and  ',
  true,
  false,
  [1, 'two', null, [3]],
  { b: 2, a: 1 },
  { nested: { z: [1, 2], a: { deep: true } }, top: 'x' },
  { _meta: { progressToken: 7 }, file: 'a.ts' },
  { date: new Date(0) },
  { fn: () => 1, keep: 'yes' },
  { u: undefined, keep: 1 },
];

describe('canonicalValue', () => {
  it('matches the client canonicalize on every sample', () => {
    for (const sample of SAMPLES) {
      expect(canonicalValue(sample, new Set())).toBe(canonicalize(sample, new Set()));
    }
  });

  it('matches with the default ignore keys', () => {
    for (const sample of SAMPLES) {
      expect(canonicalValue(sample)).toBe(canonicalize(sample, DEFAULT_IGNORE_KEYS as Set<string>));
    }
  });

  it('marks circular structures the way the client does', () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop['self'] = loop;
    expect(canonicalValue(loop, new Set())).toBe(canonicalize(loop, new Set()));
  });

  it('caps depth the way the client does', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 80; i += 1) deep = { d: deep };
    expect(canonicalValue(deep, new Set())).toBe(canonicalize(deep, new Set()));
  });
});

describe('callKey', () => {
  it('builds the same [nodeId, input] string as the client canonicalCall', () => {
    for (const sample of SAMPLES) {
      expect(callKey('tool:read', sample, new Set())).toBe(canonicalCall('tool:read', sample, new Set()));
    }
  });

  it('ignores _meta by default, so a progress token does not split a duplicate', () => {
    expect(callKey('t', { q: 'x', _meta: { progressToken: 1 } })).toBe(callKey('t', { q: 'x', _meta: { progressToken: 2 } }));
  });

  it('separates different nodes with identical inputs', () => {
    expect(callKey('a', { q: 1 })).not.toBe(callKey('b', { q: 1 }));
  });
});

describe('shortDigest', () => {
  it('is stable and hex-shaped', () => {
    expect(shortDigest('abc')).toBe(shortDigest('abc'));
    expect(shortDigest('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(shortDigest('abc')).not.toBe(shortDigest('abd'));
  });
});
