import { describe, expect, it } from 'vitest';
import {
  BUILD_HASH,
  RUNS_HASH,
  CONNECT_HASH,
  crumbsFor,
  depthOf,
  formatHash,
  pageHash,
  parseHash,
} from '../src/router.js';
import { routeFromHash } from '../src/connection/auth.js';

describe('hash router', () => {
  it('parses run deep links', () => {
    expect(parseHash('#/run/run-abc')).toEqual({ page: 'run', runId: 'run-abc' });
  });

  it('parses the builder page', () => {
    expect(parseHash(BUILD_HASH)).toEqual({ page: 'build' });
    expect(parseHash('#/build/')).toEqual({ page: 'build' });
    expect(parseHash('#/builder')).toEqual({});
  });

  it('parses run+node deep links (node ids contain colons)', () => {
    expect(parseHash('#/run/run-abc/node/tool%3AsearchFlights')).toEqual({
      page: 'node',
      runId: 'run-abc',
      nodeId: 'tool:searchFlights',
    });
  });

  it('round-trips through formatHash', () => {
    const hash = formatHash('run x', 'llm:step-1');
    expect(parseHash(hash)).toEqual({ page: 'node', runId: 'run x', nodeId: 'llm:step-1' });
  });

  it('ignores unknown hashes', () => {
    expect(parseHash('')).toEqual({});
    expect(parseHash('#/settings')).toEqual({});
  });

  it('formats nothing without a run', () => {
    expect(formatHash(undefined, 'node')).toBe('');
  });
});

describe('places', () => {
  it('parses the runs list', () => {
    expect(parseHash(RUNS_HASH)).toEqual({ page: 'runs' });
    expect(parseHash('#/runs/')).toEqual({ page: 'runs' });
  });

  it('parses the connect page', () => {
    expect(parseHash(CONNECT_HASH)).toEqual({ page: 'connect' });
  });

  it('pageHash round-trips every standalone place', () => {
    for (const page of ['runs', 'connect', 'build'] as const) {
      expect(parseHash(pageHash(page))).toEqual({ page });
    }
    // The two places inside a run are addressed by id, not by page.
    expect(pageHash('run')).toBe('');
    expect(pageHash('node')).toBe('');
  });
});

describe('crumbsFor (the breadcrumb is the navigation)', () => {
  const run = { runId: 'run-1', app: 'trip-planner' };
  const node = { nodeId: 'tool:convert', name: 'convertCurrency' };

  it('is one step on the runs list, and that step is where you are', () => {
    expect(crumbsFor('runs', undefined, undefined)).toEqual([
      { label: 'Runs', hash: RUNS_HASH, current: true },
    ]);
  });

  it('grows a step per level, with every ancestor a link', () => {
    const atRun = crumbsFor('run', run, undefined);
    expect(atRun.map((c) => c.label)).toEqual(['Runs', 'trip-planner']);
    expect(atRun.map((c) => c.current)).toEqual([false, true]);

    const atNode = crumbsFor('node', run, node);
    expect(atNode.map((c) => c.label)).toEqual(['Runs', 'trip-planner', 'convertCurrency']);
    expect(atNode.map((c) => c.current)).toEqual([false, false, true]);
  });

  it('every ancestor crumb links to the place above it', () => {
    const [runs, atRun] = crumbsFor('node', run, node);
    expect(runs?.hash).toBe(RUNS_HASH);
    expect(atRun?.hash).toBe(formatHash('run-1', undefined));
  });

  it('falls back to the runs list when the run is not loaded yet', () => {
    expect(crumbsFor('node', undefined, node)).toEqual([
      { label: 'Runs', hash: RUNS_HASH, current: true },
    ]);
  });

  it('a side trip extends the trail instead of replacing it', () => {
    // The whole point: from a call, Connect still knows the way back to
    // that call. A place you can enter and not leave is a bug.
    expect(crumbsFor('connect', run, node, 'node').map((c) => c.label)).toEqual([
      'Runs',
      'trip-planner',
      'convertCurrency',
      'Connect an agent',
    ]);
    expect(crumbsFor('build', run, node, 'run').map((c) => c.label)).toEqual([
      'Runs',
      'trip-planner',
      'Build a workflow',
    ]);
    expect(crumbsFor('connect', undefined, undefined, 'runs').map((c) => c.label)).toEqual([
      'Runs',
      'Connect an agent',
    ]);
  });

  it('every crumb but the last is a link, on a side trip too', () => {
    const crumbs = crumbsFor('connect', run, node, 'node');
    expect(crumbs.map((c) => c.current)).toEqual([false, false, false, true]);
    expect(crumbs[2]?.hash).toBe(formatHash('run-1', 'tool:convert'));
  });
});

describe('routeFromHash (a token is not a place)', () => {
  it('strips the credential graphmind serve puts in the link', () => {
    expect(routeFromHash('#token=gmv_abc123')).toBe('');
  });

  it('keeps a deep link carried after the token', () => {
    expect(routeFromHash('#token=gmv_abc123&/run/r1/node/n1')).toBe('#/run/r1/node/n1');
    expect(parseHash(routeFromHash('#token=gmv_abc&/run/r1'))).toEqual({
      page: 'run',
      runId: 'r1',
    });
  });

  it('leaves an ordinary hash alone', () => {
    expect(routeFromHash('#/runs')).toBe('#/runs');
    expect(routeFromHash('')).toBe('');
  });
});

describe('depthOf (which way the history moved)', () => {
  it('orders the stack', () => {
    expect(depthOf('runs')).toBeLessThan(depthOf('run'));
    expect(depthOf('run')).toBeLessThan(depthOf('node'));
  });

  it('puts a side trip deeper than anything, because that is how back behaves', () => {
    expect(depthOf('connect')).toBeGreaterThan(depthOf('node'));
    expect(depthOf('build')).toBeGreaterThan(depthOf('node'));
  });
});
