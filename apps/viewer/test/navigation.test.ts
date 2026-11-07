/**
 * Where a "go to this run" lands.
 *
 * `selectRun` is itself the navigation: it picks the run AND moves to the
 * run place. The Build page's "Open the run" used to call it and then
 * `setPage('runs')`, which put the reader back on the list every time —
 * the one place that button must not land. The contract is pinned here
 * because the two calls look independent and compose silently.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../src/store/uiStore.js';

beforeEach(() => {
  useUiStore.setState({ page: 'build', selectedRunId: undefined, selectedNodeId: undefined });
});

describe('opening a run', () => {
  it('selectRun moves to the run, from anywhere', () => {
    useUiStore.getState().selectRun('run-1');
    expect(useUiStore.getState().page).toBe('run');
    expect(useUiStore.getState().selectedRunId).toBe('run-1');
  });

  it('is not undone by a later setPage: nothing may follow it with "runs"', () => {
    const ui = useUiStore.getState();
    ui.selectRun('run-1');
    // This is the bug, written down: the run is still selected, but the
    // reader is on the list and has to find it again.
    ui.setPage('runs');
    expect(useUiStore.getState().page).toBe('runs');
    expect(useUiStore.getState().selectedRunId).toBe('run-1');
  });

  it('clears the node, so a run opens on its graph rather than a stale call', () => {
    useUiStore.setState({ selectedNodeId: 'node-from-another-run' });
    useUiStore.getState().selectRun('run-2');
    expect(useUiStore.getState().selectedNodeId).toBeUndefined();
    expect(useUiStore.getState().page).toBe('run');
  });
});
