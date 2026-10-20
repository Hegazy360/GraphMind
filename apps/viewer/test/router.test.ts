import { describe, expect, it } from 'vitest';
import { BUILD_HASH, formatHash, parseHash } from '../src/router.js';

describe('hash router', () => {
  it('parses run deep links', () => {
    expect(parseHash('#/run/run-abc')).toEqual({ page: 'debug', runId: 'run-abc' });
  });

  it('parses the builder page', () => {
    expect(parseHash(BUILD_HASH)).toEqual({ page: 'build' });
    expect(parseHash('#/build/')).toEqual({ page: 'build' });
    expect(parseHash('#/builder')).toEqual({});
  });

  it('parses run+node deep links (node ids contain colons)', () => {
    expect(parseHash('#/run/run-abc/node/tool%3AsearchFlights')).toEqual({
      page: 'debug',
      runId: 'run-abc',
      nodeId: 'tool:searchFlights',
    });
  });

  it('round-trips through formatHash', () => {
    const hash = formatHash('run x', 'llm:step-1');
    expect(parseHash(hash)).toEqual({ page: 'debug', runId: 'run x', nodeId: 'llm:step-1' });
  });

  it('ignores unknown hashes', () => {
    expect(parseHash('')).toEqual({});
    expect(parseHash('#/settings')).toEqual({});
  });

  it('formats nothing without a run', () => {
    expect(formatHash(undefined, 'node')).toBe('');
  });
});
