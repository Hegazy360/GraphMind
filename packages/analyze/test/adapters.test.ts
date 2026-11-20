import { describe, expect, it } from 'vitest';
import {
  analyzeTrend,
  recommend,
  sampleFromCircuitRun,
  samplesFromJackCalls,
  type CircuitEntryLike,
  type JackCallLike,
  type RunSample,
} from '../src/index.js';

function circuitRun(id: string, at: number, opts: { status?: string; fetch?: Partial<CircuitEntryLike> } = {}): RunSample {
  const entries: CircuitEntryLike[] = [
    { seq: 0, kind: 'step', name: 'fetch-invoice', status: 'completed', input: { id }, output: { amount: 10 }, attempts: [{ startedAt: at }], interventions: [], startedAt: at, finishedAt: at + 50, ...opts.fetch },
    { seq: 1, kind: 'approval', name: 'finance-signoff', status: 'completed', attempts: [], interventions: [], startedAt: at + 60, finishedAt: at + 9_000 },
    { seq: 2, kind: 'mcp', name: 'billing.refund', status: 'completed', output: { ok: true }, attempts: [], interventions: [], startedAt: at + 9_100, finishedAt: at + 9_300 },
  ];
  return sampleFromCircuitRun({ id, workflow: 'triage-invoice', status: opts.status ?? 'completed', createdAt: at }, entries);
}

describe('sampleFromCircuitRun', () => {
  it('maps work entries to tool executions and leaves waiting out', () => {
    const s = circuitRun('run_1', 1000, { status: 'paused', fetch: { status: 'paused', error: { message: 'ERP down' }, interventions: [{ action: 'retry' }] } });
    expect(s).toMatchObject({ runId: 'run_1', app: 'triage-invoice', status: 'running', origin: 'circuit' });
    expect(s.executions.map((e) => e.name)).toEqual(['fetch-invoice', 'billing.refund']);
    expect(s.executions[0]).toMatchObject({
      nodeId: 'circuit:triage-invoice:step:fetch-invoice',
      kind: 'tool',
      status: 'error',
      errorMessage: 'ERP down',
      durationMs: 50,
      interventions: [{ action: 'retry' }],
    });
    expect(sampleFromCircuitRun({ id: 'x', workflow: 'w', status: 'timed_out', createdAt: 0 }, []).status).toBe('error');
  });

  it('R-manual-fix: the same step fixed by hand across runs', () => {
    const runs = [0, 1, 2, 3].map((i) =>
      circuitRun(`run_${i}`, i * 100_000, {
        fetch: i < 3 ? { interventions: [{ action: 'inject' }], error: { message: 'ERP down' }, status: 'completed' } : {},
      }),
    );
    const rec = recommend(runs).recommendations.find((r) => r.id === 'R-manual-fix');
    expect(rec).toMatchObject({
      severity: 'high',
      target: { name: 'fetch-invoice' },
      evidence: { runIds: ['run_0', 'run_1', 'run_2'], runs: 3, counts: { inject: 3 } },
      verify: { metric: 'manual-fixes-per-run' },
    });
    expect(rec!.change).toContain('compute it in the step');
  });

  it('gives Circuit advice for a step that keeps failing', () => {
    const runs = [0, 1, 2].map((i) => circuitRun(`r${i}`, i * 1000, { status: 'failed', fetch: { status: 'failed', error: { message: 'ERP 503' } } }));
    const rec = recommend(runs).recommendations.find((r) => r.id === 'R-tool-error-repeat');
    expect(rec!.change).toContain('Handle that case inside the step');
  });
});

describe('samplesFromJackCalls', () => {
  const call = (id: number, status: string, upstreamStatus: number | null = null, tool = 'create_task'): JackCallLike => ({ id, tool, status, upstreamStatus, ms: 40, at: 1_000 + id });

  it('one sample per call; declined and forbidden are not failures', () => {
    const samples = samplesFromJackCalls('acme', [call(1, 'ok', 200), call(2, 'upstream_error', 422), call(3, 'declined'), call(4, 'forbidden')]);
    expect(samples.map((s) => s.status)).toEqual(['ok', 'error', 'ok', 'ok']);
    expect(samples[1]!.executions[0]).toMatchObject({ nodeId: 'jack:acme:create_task', errorMessage: 'API answered HTTP 422' });
    expect(samples[1]!.origin).toBe('jack');
    expect(analyzeTrend(samples).tools[0]).toMatchObject({ calls: 4, failures: 1 });
  });

  it('Jack advice: 4xx → fix the description in jack.yaml; schema mismatch → explain arguments', () => {
    const rejected = samplesFromJackCalls('acme', [1, 2, 3, 4].map((i) => call(i, 'upstream_error', 400)));
    expect(recommend(rejected).recommendations[0]!.change).toContain('rewrite the description in jack.yaml');
    const invalid = samplesFromJackCalls('acme', [1, 2, 3].map((i) => call(i, 'invalid_arguments')));
    expect(recommend(invalid).recommendations[0]!.change).toContain('arguments its schema rejects');
  });

  it('a Jack tool that started failing after a deploy is a regression', () => {
    const calls = [...Array.from({ length: 20 }, (_, i) => call(i, 'ok', 200)), ...Array.from({ length: 20 }, (_, i) => call(100 + i, 'upstream_error', 400))];
    const [rec] = recommend(samplesFromJackCalls('acme', calls)).recommendations;
    expect(rec).toMatchObject({ id: 'R-regression', target: { name: 'create_task' } });
    expect(rec!.change).toContain('Compare call-19 (before) with call-100');
    expect(rec!.title).toBe('create_task failed 100% of calls recently, against 0% before (20 of 20).');
  });
});

describe('replays and abandoned runs', () => {
  it('leaves replays out unless asked, and reports abandoned runs as such', () => {
    const base = (id: string, extra: Partial<RunSample>): RunSample => ({ runId: id, app: 'a', status: 'ok', executions: [], ...extra });
    const trend = analyzeTrend([base('a', {}), base('r', { source: 'replay' }), base('x', { status: 'abandoned' })]);
    expect(trend.runs).toBe(2);
    expect(trend.notes.join(' ')).toContain('1 replay run(s) left out');
    expect(trend.notes.join(' ')).toContain('1 run(s) were abandoned');
    expect(analyzeTrend([base('a', {}), base('r', { source: 'replay' })], { includeReplays: true }).runs).toBe(2);
  });

  it('recommendation evidence comes from the same runs the trend counted', () => {
    const failing = (id: string, source?: string): RunSample => ({
      runId: id, app: 'a', status: 'error', ...(source ? { source } : {}),
      executions: [{ nodeId: 'tool:t', kind: 'tool', name: 't', status: 'error', errorMessage: 'boom', startedTs: id.length }],
    });
    const runs = [failing('replay-1', 'replay'), failing('replay-2', 'replay'), failing('a1'), failing('a2'), failing('a3')];
    const rec = recommend(runs).recommendations.find((r) => r.id === 'R-tool-error-repeat')!;
    expect(rec.evidence).toMatchObject({ runs: 3, runIds: ['a1', 'a2', 'a3'] });
    expect(recommend(runs, { includeReplays: true }).recommendations[0]!.evidence.runs).toBe(5);
  });
});

describe('Jack wording', () => {
  it('a Jack trend counts calls, not runs', () => {
    const calls = [1, 2, 3, 4, 5].map((i) => ({ id: i, tool: 't', status: 'upstream_error', upstreamStatus: 400, ms: 5, at: i }));
    const { trend, recommendations } = recommend(samplesFromJackCalls('p', calls));
    expect(trend.verdict).toBe('5 calls, 0% ok; t fails 100% of its 5 calls.');
    expect(trend.notes.join(' ')).toContain('there are 5 call(s)');
    expect(recommendations[0]!.title).toContain('across 5 calls');
    expect(recommend(samplesFromJackCalls('p', [])).trend.verdict).toBe('Nothing to analyze: no runs.');
  });
});
