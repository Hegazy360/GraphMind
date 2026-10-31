/**
 * The connect page's catalogue: the install command and the two lines, per
 * stack. It is the whole content of the page, so a stack that cannot be
 * followed is a page that cannot be followed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STACK,
  STACKS,
  stackById,
  stacksByLanguage,
} from '../src/connect/catalog.js';

describe('the stack catalogue', () => {
  it('every stack can actually be followed: a snippet, docs and a capability line', () => {
    for (const stack of STACKS) {
      expect(stack.instrument.trim().length).toBeGreaterThan(0);
      expect(stack.docs).toMatch(/^https:\/\/graphmind\.ai\/docs\//);
      // The capability line is the one thing you want *before* wiring up.
      expect(stack.capability.trim().length).toBeGreaterThan(20);
      expect(stack.blurb.trim().length).toBeGreaterThan(0);
    }
  });

  it('ids are unique — the chooser keys on them', () => {
    expect(new Set(STACKS.map((s) => s.id)).size).toBe(STACKS.length);
  });

  it('the proxy is the only stack with nothing to install', () => {
    expect(STACKS.filter((s) => s.install === '').map((s) => s.id)).toEqual(['mcp-proxy']);
  });

  it('groups by language without losing or duplicating a stack', () => {
    const groups = stacksByLanguage();
    expect(groups.flatMap((g) => g.stacks)).toHaveLength(STACKS.length);
    expect(groups.map((g) => g.language)).toEqual(['TypeScript', 'Python', 'Any language']);
  });

  it('falls back to the first stack rather than throwing on an unknown id', () => {
    expect(stackById(DEFAULT_STACK).id).toBe(DEFAULT_STACK);
    expect(stackById('nope' as never).id).toBe(STACKS[0]!.id);
  });
});
