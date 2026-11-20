import { describe, expect, it } from 'vitest';
import { analyzeTrend, groupByApp, twoProportionZ, type ExecutionSample, type RunSample } from '../src/index.js';

let clock = 0;

interface RunSpec {
  status?: 'ok' | 'error';
  app?: string;
  /** [toolName, outcome] per call; outcome: ok | throw | silent */
  tools?: Array<[string, 'ok' | 'throw' | 'silent', number?]>;
  /** Input tokens per LLM step, and whether it stopped at the limit. */
  llm?: Array<[number, ('stop' | 'length')?]>;
  noTime?: boolean;
}

function run(id: string, spec: RunSpec = {}): RunSample {
  clock += 60_000;
  const t = clock;
  const executions: ExecutionSample[] = [];
  for (const [i, [tokens, finish]] of (spec.llm ?? [[1000]]).entries()) {
    executions.push({
      nodeId: 'llm:main',
      kind: 'llm',
      name: 'main',
      status: 'ok',
      ...(spec.noTime ? {} : { startedTs: t + i }),
      output: { finishReason: finish ?? 'stop' },
      usage: { inputTokens: tokens, outputTokens: 10, totalTokens: tokens + 10 },
      durationMs: 100,
    });
  }
  for (const [i, [name, outcome, ms]] of (spec.tools ?? []).entries()) {
    executions.push({
      nodeId: `tool:${name}`,
      kind: 'tool',
      name,
      parentId: 'llm:main',
      instanceId: `${id}-${i}`,
      input: { i },
      status: outcome === 'throw' ? 'error' : 'ok',
      ...(outcome === 'throw' ? { errorMessage: `${name} exploded` } : {}),
      output: outcome === 'silent' ? { isError: true } : { ok: true },
      durationMs: ms ?? 50,
    });
  }
  return { runId: id, app: spec.app ?? 'agent', status: spec.status ?? 'ok', executions };
}

const many = (n: number, prefix: string, spec: RunSpec | ((i: number) => RunSpec)) =>
  Array.from({ length: n }, (_, i) => run(`${prefix}${i}`, typeof spec === 'function' ? spec(i) : spec));

describe('analyzeTrend', () => {
  it('pools tool health across runs: rates, runs affected, percentiles, top error', () => {
    const trend = analyzeTrend([
      run('a', { tools: [['search', 'ok', 10], ['search', 'throw', 20]] }),
      run('b', { tools: [['search', 'silent', 30], ['fetch', 'ok', 40]] }),
      run('c', { tools: [['search', 'throw', 40]] }),
    ]);
    expect(trend.runs).toBe(3);
    const search = trend.tools[0]!;
    expect(search).toMatchObject({ name: 'search', calls: 4, failures: 2, silentFailures: 1, failureRate: 0.75, runs: 3, runsFailing: 3, p50Ms: 20, p95Ms: 40 });
    expect(search.topError).toEqual({ message: 'search exploded', count: 2 });
    expect(trend.tools[1]).toMatchObject({ name: 'fetch', failureRate: 0, runs: 1 });
    expect(trend.overall).toMatchObject({ runs: 3, okRate: 1, toolCalls: 5, toolFailures: 3 });
  });

  it('reports no shifts, and says why, when there are too few runs', () => {
    const trend = analyzeTrend(many(6, 'r', { tools: [['search', 'throw']] }));
    expect(trend.baseline).toBeUndefined();
    expect(trend.shifts).toEqual([]);
    expect(trend.notes.join(' ')).toContain('needs 5 in each window');
    // A chronic problem is still worth saying without a comparison.
    expect(trend.verdict).toBe('6 runs, 100% ok; search fails 100% of its 6 calls across 6 runs.');
    expect(analyzeTrend(many(3, 'q', {})).verdict).toBe('3 runs, 100% ok; too few runs to compare earlier and recent behaviour.');
  });

  it('flags a tool whose failure rate jumped, naming the first recent run that showed it', () => {
    const before = many(10, 'old', { tools: [['search', 'ok'], ['search', 'ok'], ['fetch', 'ok']] });
    const after = many(10, 'new', (i) => ({ tools: [['search', i === 0 ? 'ok' : 'throw'], ['search', 'silent'], ['fetch', 'ok']] }));
    const trend = analyzeTrend([...after, ...before].reverse()); // order must not matter
    const shift = trend.shifts.find((s) => s.metric === 'tool-failure-rate');
    expect(shift).toMatchObject({ direction: 'worse', tool: { name: 'search' }, baseline: 0, firstRunId: 'new0' });
    expect(shift!.recent).toBeCloseTo(19 / 20);
    expect(shift!.z!).toBeGreaterThan(2);
    expect(trend.shifts.some((s) => s.tool?.name === 'fetch')).toBe(false);
    expect(trend.verdict).toContain('search failed 95% of calls recently');
  });

  it('does not flag noise: a small change on few calls fails the z-test', () => {
    const before = many(5, 'old', { tools: [['search', 'ok']] });
    const after = many(5, 'new', (i) => ({ tools: [['search', i < 1 ? 'throw' : 'ok']] }));
    const trend = analyzeTrend([...before, ...after]);
    expect(trend.baseline).toBeDefined();
    expect(trend.shifts).toEqual([]);
    expect(trend.verdict).toContain('nothing changed');
  });

  it('flags falling completion, rising token-limit stops and growing prompts', () => {
    const before = many(8, 'old', { llm: [[1000], [1200]] });
    const after = many(8, 'new', { status: 'error', llm: [[3000], [4000, 'length']] });
    const trend = analyzeTrend([...before, ...after]);
    const metrics = trend.shifts.map((s) => s.metric);
    expect(metrics).toEqual(expect.arrayContaining(['run-ok-rate', 'length-stop-rate', 'input-tokens']));
    expect(trend.shifts.every((s) => s.direction === 'worse')).toBe(true);
    expect(trend.shifts.find((s) => s.metric === 'input-tokens')).toMatchObject({ baseline: 1200, recent: 4000 });
    expect(trend.shifts.find((s) => s.metric === 'run-ok-rate')).toMatchObject({ baseline: 1, recent: 0, firstRunId: 'new0' });
  });

  it('reports improvements too, after the regressions', () => {
    const before = many(8, 'old', { tools: [['search', 'throw'], ['search', 'throw']], llm: [[5000]] });
    const after = many(8, 'new', { tools: [['search', 'ok'], ['search', 'ok']], llm: [[9000]] });
    const trend = analyzeTrend([...before, ...after]);
    expect(trend.shifts[0]).toMatchObject({ metric: 'input-tokens', direction: 'worse' });
    expect(trend.shifts.find((s) => s.metric === 'tool-failure-rate')).toMatchObject({ direction: 'better' });
  });

  it('honours `recent` and the thresholds', () => {
    const runs = [...many(12, 'old', { tools: [['t', 'ok']] }), ...many(3, 'new', { tools: [['t', 'throw']] })];
    expect(analyzeTrend(runs).baseline!.runs).toBe(8); // default split: newer half (7), older 8
    const strict = analyzeTrend(runs, { recent: 3, minRuns: 3 });
    expect(strict.recent!.runs).toBe(3);
    expect(strict.shifts.find((s) => s.metric === 'tool-failure-rate')?.direction).toBe('worse');
    expect(analyzeTrend(runs, { recent: 3, minRuns: 3, minZ: 99 }).shifts.filter((s) => s.metric === 'tool-failure-rate')).toEqual([]);
  });

  it('survives hostile and empty input', () => {
    expect(analyzeTrend([]).verdict).toBe('Nothing to analyze: no runs.');
    const weird = { runId: 'x', executions: [{ nodeId: 'n', kind: 'tool', name: 't', status: 'ok', output: null, durationMs: Number.NaN, usage: 'nope' }] } as unknown as RunSample;
    const trend = analyzeTrend([weird, run('y', { noTime: true })]);
    expect(trend.runs).toBe(2);
    expect(trend.notes.join(' ')).toContain('no start time');
    expect(trend.notes.join(' ')).toContain('still running or never recorded an end');
    expect(() => JSON.stringify(trend)).not.toThrow();
  });
});

describe('helpers', () => {
  it('twoProportionZ', () => {
    expect(twoProportionZ(0, 10, 0, 10)).toBeUndefined();
    expect(twoProportionZ(1, 0, 1, 1)).toBeUndefined();
    expect(twoProportionZ(10, 100, 30, 100)!).toBeCloseTo(3.54, 1);
  });

  it('groupByApp', () => {
    const groups = groupByApp([run('a', { app: 'x' }), run('b', { app: 'y' }), run('c', { app: 'x' }), { executions: [] }]);
    expect([...groups.keys()]).toEqual(['x', 'y', '']);
    expect(groups.get('x')!.map((s) => s.runId)).toEqual(['a', 'c']);
  });
});
