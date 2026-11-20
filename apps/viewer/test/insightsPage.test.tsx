// @vitest-environment jsdom
/**
 * The Insights page: recommendations with run links, the empty states, the
 * no-server state, and recorded text rendered as text, never markup.
 */
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BehaviorTrend, Recommendation } from '@graphmind-ai/analyze';
import { InsightsPage, type AppInsights } from '../src/pages/InsightsPage.js';
import { parseHash, crumbsFor } from '../src/router.js';
import { useUiStore } from '../src/store/uiStore.js';
import { resetStores } from './render.js';

const XSS = '<img src=x onerror=alert(1)>';

function trend(over: Partial<BehaviorTrend> = {}): BehaviorTrend {
  return {
    runs: 12,
    points: [],
    overall: { runs: 12, okRate: 0.75, toolCalls: 40, toolFailures: 6, llmSteps: 20, lengthStops: 0 },
    tools: [
      {
        nodeId: 'tool:search',
        name: 'search',
        calls: 40,
        failures: 6,
        silentFailures: 0,
        failureRate: 0.15,
        runs: 12,
        runsFailing: 4,
        p95Ms: 1200,
      },
    ],
    shifts: [
      {
        metric: 'okRate',
        direction: 'worse',
        baseline: 0.9,
        recent: 0.5,
        firstRunId: 'run-shift',
        summary: 'ok rate fell from 90% to 50%',
      },
    ],
    verdict: 'search fails in a third of runs.',
    notes: ['2 replays left out'],
    ...over,
  } as BehaviorTrend;
}

function rec(over: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'tool-failing',
    severity: 'high',
    title: 'search fails in 4 of 12 runs',
    target: { nodeId: 'tool:search', name: 'search' },
    evidence: { runIds: ['run-a', 'run-b'], runs: 4, counts: { failures: 6 }, example: XSS },
    change: 'Validate the query before calling search.',
    verify: { metric: 'search failure rate', now: 0.15, expect: 'below 0.05' },
    ...over,
  } as Recommendation;
}

function serve(apps: AppInsights[]) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ apps }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => resetStores());
afterEach(() => vi.unstubAllGlobals());

describe('InsightsPage', () => {
  it('routes #/insights as a side trip', () => {
    expect(parseHash('#/insights')).toEqual({ page: 'insights' });
    expect(crumbsFor('insights', undefined, undefined).map((c) => c.label)).toEqual(['Runs', 'Insights']);
  });

  it('renders a recommendation with run links, evidence and verify', async () => {
    serve([{ app: 'trip-planner', trend: trend(), recommendations: [rec()] }]);
    render(<InsightsPage />);
    const card = await screen.findByTestId('insights-rec');
    expect(within(card).getByText('high')).toBeInTheDocument();
    expect(within(card).getByText('search fails in 4 of 12 runs')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'run-a' })).toHaveAttribute('href', '#/run/run-a');
    expect(within(card).getByRole('link', { name: 'run-b' })).toHaveAttribute('href', '#/run/run-b');
    expect(within(card).getByText('4 runs')).toBeInTheDocument();
    expect(within(card).getByText(/verify: search failure rate is 15% now → below 0.05/)).toBeInTheDocument();
    expect(screen.getByText('search fails in a third of runs.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'run-shift' })).toHaveAttribute('href', '#/run/run-shift');
    expect(screen.getByText('15%')).toBeInTheDocument();
  });

  it('renders a hostile example as text, not markup', async () => {
    serve([{ app: 'trip-planner', trend: trend(), recommendations: [rec({ title: `${XSS} title` })] }]);
    const { container } = render(<InsightsPage />);
    await screen.findByTestId('insights-rec');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(`“${XSS}”`)).toBeInTheDocument();
    expect(screen.getByText(`${XSS} title`)).toBeInTheDocument();
  });

  it('says nothing needs changing for an app with no recommendations', async () => {
    serve([{ app: 'quiet', trend: trend({ shifts: [] }), recommendations: [] }]);
    render(<InsightsPage />);
    expect(await screen.findByText('Nothing the recordings prove needs changing.')).toBeInTheDocument();
  });

  it('asks for a run when there are none', async () => {
    serve([]);
    render(<InsightsPage />);
    expect(await screen.findByTestId('insights-empty')).toHaveTextContent(
      'Run your agent with GraphMind attached',
    );
  });

  it('explains the local server is needed when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<InsightsPage />);
    expect(await screen.findByTestId('insights-no-server')).toHaveTextContent('npx graphmind-ai');
  });

  it('does not fetch in fixture mode', async () => {
    const fetchMock = serve([]);
    useUiStore.setState({ fixtureActive: true });
    render(<InsightsPage />);
    expect(await screen.findByTestId('insights-no-server')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches with includeReplays=1 when the toggle is on', async () => {
    const fetchMock = serve([{ app: 'a', trend: trend(), recommendations: [] }]);
    render(<InsightsPage />);
    await screen.findByTestId('insights-app');
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'include replays' }));
    await screen.findByTestId('insights-app');
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/api/insights?includeReplays=1');
  });
});

describe('fmtVerify', () => {
  it('rates as percentages, durations as durations, counts as counts', async () => {
    const { fmtVerify } = await import('../src/pages/InsightsPage.js');
    expect(fmtVerify('waste-share', 0.023809523809523808)).toBe('2%');
    expect(fmtVerify('tool-silent-failures', 3)).toBe('3');
    expect(fmtVerify('tool-failure-rate', 1)).toBe('100%');
    expect(fmtVerify('manual-fixes-per-run', 1.5)).toBe('1.5');
    expect(fmtVerify('tool-p95-ms', 4000)).toMatch(/4(\.0)?\s?s/);
  });
});
