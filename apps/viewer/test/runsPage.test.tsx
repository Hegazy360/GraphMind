// @vitest-environment jsdom
/**
 * The runs list, driven the way a reader drives it.
 *
 * `runList.test.ts` covers the shelving and filtering rules as data. This
 * covers the part that only exists once rendered: that every control is
 * wired to those rules, that a card says what it is, and that clicking
 * things goes where it should. Three of the bugs this suite pins were
 * found by hand — a grouping control that could not act, an app filter
 * with no visible current value, and a card click that has to land on the
 * run — which is the argument for having it.
 */
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RunsPage } from '../src/pages/RunsPage.js';
import { useUiStore } from '../src/store/uiStore.js';
import { makeRun, resetStores, seedRuns, setConnection } from './render.js';

const NOW = Date.now();
const DAY = 86_400_000;

beforeEach(() => {
  resetStores();
  setConnection('live');
});

const show = (fixtureAvailable = false) => render(<RunsPage fixtureAvailable={fixtureAvailable} />);

/** The shelf headings, top to bottom — the page's structure in one line. */
const shelves = (): string[] =>
  [...document.querySelectorAll('.gm-shelf-head h2')].map((h) => h.textContent ?? '');

const cards = () => document.querySelectorAll('.gm-runcard');

describe('an empty list', () => {
  it('hands the whole page to the empty state rather than drawing a list of nothing', () => {
    show();
    expect(screen.getByRole('button', { name: 'Connect an agent' })).toBeVisible();
    expect(cards()).toHaveLength(0);
    // No facets, no filters, no "0 runs" header: there is nothing to filter.
    expect(screen.queryByRole('group', { name: 'Filter by status' })).toBeNull();
  });

  it('offers the bundled demo only when there is one to replay', () => {
    const { unmount } = show(false);
    expect(screen.queryByRole('button', { name: /Replay the bundled demo/ })).toBeNull();
    unmount();
    show(true);
    expect(screen.getByRole('button', { name: /Replay the bundled demo/ })).toBeVisible();
  });
});

describe('a card', () => {
  it('says what the run was, with each figure under its own label', () => {
    seedRuns(makeRun({ runId: 'r1', app: 'trip-planner', tools: 3, tokens: { in: 1200, out: 300 } }));
    show();

    const card = document.querySelector('.gm-runcard');
    expect(card).not.toBeNull();
    const c = within(card as HTMLElement);
    expect(c.getByText('trip-planner')).toBeVisible();
    expect(c.getByText('done')).toBeVisible();

    // A figure is a label and a value, so the card needs no column header.
    const labelled = (label: string): string => {
      const el = [...(card as HTMLElement).querySelectorAll('.gm-runcard-stat')].find(
        (stat) => stat.querySelector('.gm-runcard-label')?.textContent === label,
      );
      return el?.querySelector('.gm-runcard-value')?.textContent ?? '';
    };
    expect(labelled('nodes')).toBe('4'); // 3 tools + 1 llm
    expect(labelled('llm')).toBe('1');
    expect(labelled('tools')).toBe('3');
    expect(labelled('tokens')).toBe('1.5k');
  });

  it('opens its run — the click is the whole point of the page', async () => {
    const user = userEvent.setup();
    seedRuns(makeRun({ runId: 'run-7', app: 'trip-planner' }));
    show();

    await user.click(document.querySelector('.gm-runcard') as HTMLElement);

    expect(useUiStore.getState().selectedRunId).toBe('run-7');
    expect(useUiStore.getState().page).toBe('run');
  });

  it('leads with the error a failed run stopped on', () => {
    seedRuns(
      makeRun({
        runId: 'r1',
        status: 'error',
        error: { name: 'RateLimitError', message: '429 from provider' },
      }),
    );
    show();
    expect(screen.getByText(/RateLimitError: 429 from provider/)).toBeVisible();
  });

  it('says a live run is held, and on what', () => {
    seedRuns(
      makeRun({
        runId: 'r1',
        status: 'running',
        heldOn: { name: 'TimeoutError', message: 'upstream took 30s' },
      }),
    );
    show();
    expect(document.querySelector('.gm-runcard-status')).toHaveTextContent('held');
    expect(screen.getByText(/Held on TimeoutError: upstream took 30s/)).toBeVisible();
  });

  it('marks a run that did not come from a live agent, and says nothing when it did', () => {
    seedRuns(makeRun({ runId: 'r1', serverSource: 'import' }));
    const { unmount } = show();
    expect(screen.getByText('imported')).toBeVisible();
    unmount();

    resetStores();
    setConnection('live');
    seedRuns(makeRun({ runId: 'r2' }));
    show();
    expect(screen.queryByText('live')).toBeNull();
  });
});

describe('the status facets', () => {
  const mixed = () =>
    seedRuns(
      makeRun({ runId: 'ok1', status: 'ok' }),
      makeRun({ runId: 'ok2', status: 'ok' }),
      makeRun({ runId: 'bad', status: 'error', error: { name: 'E', message: 'boom' } }),
      makeRun({ runId: 'held', status: 'running', heldOn: { name: 'E', message: 'waiting' } }),
    );

  it('counts what each one would show, including the empty ones', () => {
    mixed();
    show();
    const facet = (name: string): string =>
      document.querySelector(`.gm-facet--${name} .gm-facet-count`)?.textContent ?? '';
    expect(facet('all')).toBe('4');
    expect(facet('live')).toBe('1');
    expect(facet('held')).toBe('1');
    expect(facet('failed')).toBe('1');
    expect(facet('done')).toBe('2');
  });

  it('filters the list, and clicking the same one again clears it', async () => {
    const user = userEvent.setup();
    mixed();
    show();
    expect(cards()).toHaveLength(4);

    const failed = screen.getByRole('button', { name: /^Failed/ });
    await user.click(failed);
    expect(cards()).toHaveLength(1);
    expect(failed).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Showing 1 run of 4/)).toBeVisible();

    await user.click(failed);
    expect(cards()).toHaveLength(4);
    expect(failed).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers a way back when a filter matches nothing', async () => {
    const user = userEvent.setup();
    seedRuns(makeRun({ runId: 'ok1', status: 'ok' }));
    show();

    await user.click(screen.getByRole('button', { name: /^Failed/ }));
    expect(cards()).toHaveLength(0);
    // Exactly one way back: the empty block owns it once the list is bare.
    const back = screen.getAllByRole('button', { name: 'Clear filters' });
    expect(back).toHaveLength(1);
    await user.click(back[0] as HTMLElement);
    expect(cards()).toHaveLength(1);
  });
});

describe('the app filter', () => {
  const threeApps = () =>
    seedRuns(
      makeRun({ runId: 'a1', app: 'my-agent' }),
      makeRun({ runId: 'a2', app: 'my-agent' }),
      makeRun({ runId: 'b1', app: 'trip-planner' }),
    );

  it('is absent when there is only one app to choose between', () => {
    seedRuns(makeRun({ runId: 'a1', app: 'my-agent' }));
    show();
    expect(screen.queryByRole('group', { name: 'Filter by app' })).toBeNull();
  });

  /**
   * The bug this pins: with no app chosen nothing was lit, so the row read
   * as a legend rather than a filter and the reader went looking for their
   * workflow under the wrong app.
   */
  it('always shows a current value — "All apps" when nothing is chosen', async () => {
    const user = userEvent.setup();
    threeApps();
    show();

    const group = within(screen.getByRole('group', { name: 'Filter by app' }));
    const all = group.getByRole('button', { name: /All apps/ });
    expect(all).toHaveAttribute('aria-pressed', 'true');

    await user.click(group.getByRole('button', { name: /my-agent/ }));
    expect(all).toHaveAttribute('aria-pressed', 'false');
    expect(group.getByRole('button', { name: /my-agent/ })).toHaveAttribute('aria-pressed', 'true');
    expect(cards()).toHaveLength(2);
    // …and the narrowed list says which app it is narrowed to.
    expect(screen.getByText('in my-agent')).toBeVisible();
  });

  it('carries each app its count, so the chips say how much is behind them', () => {
    threeApps();
    show();
    const group = within(screen.getByRole('group', { name: 'Filter by app' }));
    // Spelled out for anything reading the name: "All apps3" is not a name.
    expect(group.getByRole('button', { name: 'All apps, 3 runs' })).toBeVisible();
    expect(group.getByRole('button', { name: 'my-agent, 2 runs' })).toBeVisible();
    expect(group.getByRole('button', { name: 'trip-planner, 1 run' })).toBeVisible();
  });

  it('returns the whole list when All apps is pressed', async () => {
    const user = userEvent.setup();
    threeApps();
    show();
    const group = within(screen.getByRole('group', { name: 'Filter by app' }));
    await user.click(group.getByRole('button', { name: /trip-planner/ }));
    expect(cards()).toHaveLength(1);
    await user.click(group.getByRole('button', { name: /All apps/ }));
    expect(cards()).toHaveLength(3);
  });
});

describe('group by', () => {
  const across = () =>
    seedRuns(
      makeRun({ runId: 'a1', app: 'my-agent', startedTs: NOW - 3_600_000, finishedTs: NOW - 3_500_000 }),
      makeRun({ runId: 'b1', app: 'trip-planner', startedTs: NOW - DAY, finishedTs: NOW - DAY + 1000 }),
    );

  /** The reported bug: a control that cannot change anything reads as broken. */
  it('is not offered when there is only one app to group by', () => {
    seedRuns(
      makeRun({ runId: 'a1', app: 'my-agent', startedTs: NOW - 3_600_000, finishedTs: NOW }),
      makeRun({ runId: 'a2', app: 'my-agent', startedTs: NOW - DAY, finishedTs: NOW - DAY + 1 }),
    );
    show();
    expect(screen.queryByRole('group', { name: 'Group runs by' })).toBeNull();
    expect(shelves()).toEqual(['Today', 'Yesterday']);
  });

  it('shelves by day, then by app, and lights the chosen one', async () => {
    const user = userEvent.setup();
    across();
    show();
    expect(shelves()).toEqual(['Today', 'Yesterday']);

    const group = within(screen.getByRole('group', { name: 'Group runs by' }));
    expect(group.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(group.getByRole('button', { name: 'App' }));
    expect(shelves()).toEqual(['my-agent', 'trip-planner']);
    expect(group.getByRole('button', { name: 'App' })).toHaveAttribute('aria-pressed', 'true');
    expect(group.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('withdraws once a filter has narrowed the list to one app, and falls back to days', async () => {
    const user = userEvent.setup();
    across();
    show();

    await user.click(screen.getByRole('button', { name: 'App' }));
    expect(shelves()).toEqual(['my-agent', 'trip-planner']);

    const apps = within(screen.getByRole('group', { name: 'Filter by app' }));
    await user.click(apps.getByRole('button', { name: /my-agent/ }));

    expect(screen.queryByRole('group', { name: 'Group runs by' })).toBeNull();
    expect(shelves()).toEqual(['Today']);
  });

  it('pins what is happening now above the history, in both groupings', async () => {
    const user = userEvent.setup();
    seedRuns(
      makeRun({ runId: 'live', app: 'my-agent', status: 'running', startedTs: NOW - 5_000 }),
      makeRun({ runId: 'old', app: 'trip-planner', startedTs: NOW - 3 * DAY, finishedTs: NOW - 3 * DAY + 1 }),
    );
    show();
    expect(shelves()[0]).toBe('Live now');

    await user.click(screen.getByRole('button', { name: 'App' }));
    expect(shelves()[0]).toBe('Live now');
  });
});

describe('search', () => {
  beforeEach(() => {
    seedRuns(
      makeRun({ runId: 'aaa-111', app: 'my-agent' }),
      makeRun({
        runId: 'bbb-222',
        app: 'trip-planner',
        status: 'error',
        error: { name: 'RateLimitError', message: '429 from provider' },
      }),
    );
  });

  it('matches the app, the run id and the error a run stopped on', async () => {
    const user = userEvent.setup();
    show();
    const box = screen.getByRole('textbox', { name: 'Search runs' });

    await user.type(box, 'my-agent');
    expect(cards()).toHaveLength(1);

    await user.clear(box);
    await user.type(box, 'bbb-2');
    expect(cards()).toHaveLength(1);

    await user.clear(box);
    await user.type(box, '429');
    expect(cards()).toHaveLength(1);
    expect(screen.getByText(/RateLimitError/)).toBeVisible();
  });

  it('clears from its own button', async () => {
    const user = userEvent.setup();
    show();
    const box = screen.getByRole('textbox', { name: 'Search runs' });
    await user.type(box, 'nothing-matches-this');
    expect(cards()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(box).toHaveValue('');
    expect(cards()).toHaveLength(2);
  });
});

describe('long shelves', () => {
  it('shows a preview and unfolds the rest, keeping live runs whole', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 12 }, (_, i) =>
      makeRun({
        runId: `r${i}`,
        app: 'my-agent',
        startedTs: NOW - 3 * DAY - i * 1000,
        finishedTs: NOW - 3 * DAY - i * 1000 + 10,
      }),
    );
    seedRuns(...many);
    show();

    expect(cards()).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: /Show 4 more/ }));
    expect(cards()).toHaveLength(12);
    await user.click(screen.getByRole('button', { name: /Show fewer/ }));
    expect(cards()).toHaveLength(8);
  });
});

describe('the two things that are not a run', () => {
  it('go to their own places', async () => {
    const user = userEvent.setup();
    seedRuns(makeRun({ runId: 'r1' }));
    show();

    await user.click(screen.getByRole('button', { name: 'Connect an agent' }));
    expect(useUiStore.getState().page).toBe('connect');

    useUiStore.setState({ page: 'runs' });
    await user.click(screen.getByRole('button', { name: 'Build a workflow' }));
    expect(useUiStore.getState().page).toBe('build');
  });

  it('name themselves without reading their blurb aloud', () => {
    seedRuns(makeRun({ runId: 'r1' }));
    show();
    // The accessible name is the label alone — the blurb is for the eye.
    expect(screen.getByRole('button', { name: 'Connect an agent' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Build a workflow' })).toBeVisible();
  });
});
