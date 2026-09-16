/**
 * GRAPHMIND_LOOP_ALLOW exists because `graphmind mcp-proxy` users cannot pass
 * session options, yet the banner told them to use `loopGuard.allowNodes`.
 */
import { describe, expect, it } from 'vitest';
import { parseLoopAllow, resolveLoopGuard } from '../src/loop-guard.js';

describe('GRAPHMIND_LOOP_ALLOW', () => {
  it('parses a comma-separated list, trimming and dropping empties', () => {
    expect(parseLoopAllow('pollJob, tool:heartbeat ,,')).toEqual(['pollJob', 'tool:heartbeat']);
    expect(parseLoopAllow('')).toEqual([]);
    expect(parseLoopAllow(undefined)).toEqual([]);
    expect(parseLoopAllow(' , ')).toEqual([]);
  });

  it('feeds allowNodes when no option is given; an option array replaces it', () => {
    const fromEnv = resolveLoopGuard(undefined, { GRAPHMIND_LOOP_ALLOW: 'pollJob,tool:x' });
    expect([...fromEnv.allowNodes].sort()).toEqual(['pollJob', 'tool:x']);
    const fromOption = resolveLoopGuard({ allowNodes: ['only'] }, { GRAPHMIND_LOOP_ALLOW: 'pollJob' });
    expect([...fromOption.allowNodes]).toEqual(['only']);
    expect([...resolveLoopGuard({ allowNodes: [] }, { GRAPHMIND_LOOP_ALLOW: 'pollJob' }).allowNodes]).toEqual([]);
    expect([...resolveLoopGuard(undefined, {}).allowNodes]).toEqual([]);
  });
});
