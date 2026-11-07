// @vitest-environment jsdom
/**
 * The two pieces of chrome that are on screen whatever place you are in:
 * the header, which is the navigation, and the band a held run puts under
 * it.
 *
 * Both are small and both are load-bearing. The header is the only way to
 * reach Connect and Build from inside a run — they were dead ends once —
 * and the hold band is the only thing standing between "a process is
 * stopped mid-call somewhere" and the reader never finding out.
 */
import userEvent from '@testing-library/user-event';
import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppHeader } from '../src/components/AppHeader.js';
import { HoldStrip } from '../src/components/HoldStrip.js';
import { EmptyState } from '../src/components/EmptyState.js';
import { useRunStore } from '../src/store/runStore.js';
import { useUiStore } from '../src/store/uiStore.js';
import { makeRun, resetStores, seedRuns, setConnection } from './render.js';

beforeEach(() => {
  resetStores();
});

describe('the breadcrumb is the navigation', () => {
  it('shows only Runs when that is the whole stack', () => {
    render(<AppHeader />);
    const crumbs = [...document.querySelectorAll('.gm-crumb')].map((c) => c.textContent);
    expect(crumbs).toEqual(['Runs']);
  });

  it('grows with the stack, and every ancestor is a link', () => {
    seedRuns(makeRun({ runId: 'r1', app: 'trip-planner', tools: 1 }));
    useUiStore.setState({ page: 'node', selectedRunId: 'r1', selectedNodeId: 'tool-0', stackAt: 'node' });
    render(<AppHeader />);

    const crumbs = [...document.querySelectorAll('.gm-crumb')].map((c) => c.textContent);
    expect(crumbs).toEqual(['Runs', 'trip-planner', 'tool0']);
    // The last is where you are; it is not a link.
    expect(document.querySelectorAll('.gm-crumb[href]')).toHaveLength(2);
  });

  it('keeps describing the stack while you are off on a side trip', () => {
    seedRuns(makeRun({ runId: 'r1', app: 'trip-planner', tools: 1 }));
    useUiStore.setState({ page: 'connect', selectedRunId: 'r1', selectedNodeId: 'tool-0', stackAt: 'node' });
    render(<AppHeader />);

    const crumbs = [...document.querySelectorAll('.gm-crumb')].map((c) => c.textContent);
    expect(crumbs).toEqual(['Runs', 'trip-planner', 'tool0', 'Connect an agent']);
  });
});

describe('the places menu', () => {
  it('reaches every place from anywhere — they were once dead ends', async () => {
    const user = userEvent.setup();
    seedRuns(makeRun({ runId: 'r1' }));
    useUiStore.setState({ page: 'run', selectedRunId: 'r1', stackAt: 'run' });
    render(<AppHeader />);

    await user.click(screen.getByRole('button', { name: /go to/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Build a workflow' }));
    expect(useUiStore.getState().page).toBe('build');

    await user.click(screen.getByRole('button', { name: /go to/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Connect an agent' }));
    expect(useUiStore.getState().page).toBe('connect');
  });

  it('closes when the same button is pressed again', async () => {
    const user = userEvent.setup();
    render(<AppHeader />);
    const brand = screen.getByRole('button', { name: /go to/i });

    await user.click(brand);
    expect(brand).toHaveAttribute('aria-expanded', 'true');
    await user.click(brand);
    expect(brand).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('the connection light', () => {
  it('never flatters the connection', () => {
    for (const [connection, label] of [
      ['live', 'live'],
      ['connecting', 'connecting'],
      ['detached', 'detached'],
      ['off', 'offline'],
    ] as const) {
      setConnection(connection);
      const { unmount } = render(<AppHeader />);
      expect(document.querySelector('.gm-conn-label')).toHaveTextContent(label);
      unmount();
    }
  });

  it('calls a replay a replay, not a connection', () => {
    useUiStore.setState({ connection: 'off', fixtureActive: true });
    render(<AppHeader />);
    expect(document.querySelector('.gm-conn-label')).toHaveTextContent('replaying');
  });

  it('says it is catching up rather than showing green on a backlog', () => {
    setConnection('live');
    useUiStore.setState({
      stream: { catchUp: { 'r1': { count: 5000, applied: 1200 } }, lagMs: 0, lagAt: 0 },
    });
    render(<AppHeader />);
    expect(document.querySelector('.gm-conn-label')).toHaveTextContent(/catching up/);
  });
});

describe('the hold band', () => {
  const heldRun = () =>
    seedRuns(
      makeRun({
        runId: 'r1',
        status: 'running',
        heldOn: { name: 'TimeoutError', message: 'upstream took 30s' },
      }),
    );

  it('is absent when nothing is held', () => {
    seedRuns(makeRun({ runId: 'r1' }));
    useUiStore.setState({ selectedRunId: 'r1' });
    render(<HoldStrip />);
    expect(screen.queryByRole('status', { name: 'A call is held' })).toBeNull();
  });

  it('names the held call and why, wherever you are standing', () => {
    heldRun();
    useUiStore.setState({ selectedRunId: 'r1', page: 'runs' });
    render(<HoldStrip />);

    const band = screen.getByRole('status', { name: 'A call is held' });
    expect(within(band).getByText('heldTool')).toBeVisible();
    expect(within(band).getByText(/TimeoutError: upstream took 30s/)).toBeVisible();
  });

  it('offers the way in, and going there selects the held call', async () => {
    const user = userEvent.setup();
    heldRun();
    useUiStore.setState({ selectedRunId: 'r1', page: 'run' });
    render(<HoldStrip />);

    await user.click(screen.getByRole('button', { name: /Open the held call/ }));
    expect(useUiStore.getState().selectedNodeId).toBe('held');
    expect(useUiStore.getState().page).toBe('node');
  });

  /** Two Continues on one screen is how you click the wrong one. */
  it('steps aside on the very call it is about, and comes back for another', () => {
    heldRun();
    useUiStore.setState({ selectedRunId: 'r1', page: 'node', selectedNodeId: 'held' });
    const { rerender } = render(<HoldStrip />);
    expect(screen.queryByRole('status', { name: 'A call is held' })).toBeNull();

    // Reading a different call: the band is the way back to the held one.
    act(() => useUiStore.setState({ selectedNodeId: 'tool-0' }));
    rerender(<HoldStrip />);
    expect(screen.getByRole('status', { name: 'A call is held' })).toBeVisible();
  });

  it('goes away when the gate is released', () => {
    heldRun();
    useUiStore.setState({ selectedRunId: 'r1', page: 'run' });
    const { rerender } = render(<HoldStrip />);
    expect(screen.getByRole('status', { name: 'A call is held' })).toBeVisible();

    act(() => {
      const runs = { ...useRunStore.getState().runs };
      const run = runs['r1'];
      if (run === undefined) throw new Error('seeded run missing');
      // Released: the gate is resolved and the node no longer points at it.
      const { activePauseId: _released, ...heldNode } = run.nodes['held']!;
      runs['r1'] = {
        ...run,
        nodes: { ...run.nodes, held: heldNode },
        pauses: { p1: { ...run.pauses['p1']!, active: false } },
        statusVersion: run.statusVersion + 1,
      };
      useRunStore.setState({ runs });
    });
    rerender(<HoldStrip />);
    expect(screen.queryByRole('status', { name: 'A call is held' })).toBeNull();
  });
});

describe('the empty state', () => {
  it('tells the truth about the connection and offers one way forward', () => {
    setConnection('detached');
    render(<EmptyState fixtureAvailable={false} />);
    expect(screen.getByRole('heading', { name: /No debugger server/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect an agent' })).toBeVisible();
  });

  it('says it is waiting once something is attached', () => {
    setConnection('live');
    render(<EmptyState fixtureAvailable={false} />);
    expect(screen.getByRole('heading', { name: /Waiting for a run/ })).toBeVisible();
  });

  it('its buttons go where they say', async () => {
    const user = userEvent.setup();
    setConnection('live');
    render(<EmptyState fixtureAvailable />);

    await user.click(screen.getByRole('button', { name: 'Build a workflow' }));
    expect(useUiStore.getState().page).toBe('build');

    await user.click(screen.getByRole('button', { name: /Replay the bundled demo/ }));
    expect(useUiStore.getState().demoRequested).toBe(true);
  });
});
