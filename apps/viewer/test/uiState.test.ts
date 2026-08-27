/**
 * Viewer-local state: collapse memory per run, filter toggles, and the
 * three-state theme choice.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { collapsedFor, useUiStore } from '../src/store/uiStore.js';
import { EMPTY_FILTER } from '../src/store/filters.js';
import { isThemeChoice, nextTheme, themeLabel } from '../src/lib/theme.js';

beforeEach(() => {
  useUiStore.setState({
    collapsedByRun: {},
    filters: EMPTY_FILTER,
    view: 'graph',
    theme: 'system',
    lod: 'full',
  });
});

describe('collapse memory', () => {
  it('remembers folded groups per run', () => {
    const ui = useUiStore.getState();
    ui.toggleCollapse('run-a', 'agent:x');
    ui.toggleCollapse('run-b', 'agent:y');
    expect(collapsedFor(useUiStore.getState(), 'run-a')).toEqual(['agent:x']);
    expect(collapsedFor(useUiStore.getState(), 'run-b')).toEqual(['agent:y']);
  });

  it('toggles back off and expands all', () => {
    const ui = useUiStore.getState();
    ui.toggleCollapse('run-a', 'agent:x');
    ui.toggleCollapse('run-a', 'agent:x');
    expect(collapsedFor(useUiStore.getState(), 'run-a')).toEqual([]);
    ui.setCollapsed('run-a', ['a', 'b']);
    expect(collapsedFor(useUiStore.getState(), 'run-a')).toEqual(['a', 'b']);
    ui.expandAll('run-a');
    expect(collapsedFor(useUiStore.getState(), 'run-a')).toEqual([]);
  });

  it('returns a stable empty array for untouched runs', () => {
    const state = useUiStore.getState();
    expect(collapsedFor(state, 'never-seen')).toBe(collapsedFor(state, 'other'));
  });
});

describe('filters', () => {
  it('kind filters accumulate and clear back to "all kinds"', () => {
    const ui = useUiStore.getState();
    ui.toggleKindFilter('tool');
    expect(useUiStore.getState().filters.kinds).toEqual(['tool']);
    ui.toggleKindFilter('llm');
    expect(useUiStore.getState().filters.kinds).toEqual(['tool', 'llm']);
    ui.toggleKindFilter('tool');
    ui.toggleKindFilter('llm');
    expect(useUiStore.getState().filters.kinds).toBeNull();
  });

  it('a status filter toggles off when re-selected', () => {
    const ui = useUiStore.getState();
    ui.setStatusFilter('error');
    expect(useUiStore.getState().filters.status).toBe('error');
    ui.setStatusFilter('error');
    expect(useUiStore.getState().filters.status).toBe('all');
  });

  it('clearing resets every lens', () => {
    const ui = useUiStore.getState();
    ui.setStatusFilter('slow');
    ui.toggleErrorPath();
    ui.toggleKindFilter('tool');
    ui.clearFilters();
    expect(useUiStore.getState().filters).toEqual(EMPTY_FILTER);
  });
});

describe('views', () => {
  it('the timeline toggle flips between graph and split', () => {
    const ui = useUiStore.getState();
    ui.toggleTimeline();
    expect(useUiStore.getState().view).toBe('split');
    ui.toggleTimeline();
    expect(useUiStore.getState().view).toBe('graph');
  });

  it('pinning full detail turns auto level-of-detail off', () => {
    const ui = useUiStore.getState();
    ui.setLod('dot');
    expect(useUiStore.getState().lod).toBe('dot');
    ui.setAutoLod(false);
    expect(useUiStore.getState().autoLod).toBe(false);
    expect(useUiStore.getState().lod).toBe('full');
  });
});

describe('theme', () => {
  it('cycles system → dark → light → system', () => {
    expect(nextTheme('system')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('system');
  });

  it('validates stored values', () => {
    expect(isThemeChoice('dark')).toBe(true);
    expect(isThemeChoice('neon')).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });

  it('labels every state', () => {
    expect(themeLabel('system')).toContain('System');
    expect(themeLabel('light')).toContain('Light');
  });
});
