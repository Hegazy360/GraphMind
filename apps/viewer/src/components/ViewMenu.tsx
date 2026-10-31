/**
 * How the graph is drawn: how much detail, which pane, how much is folded,
 * and the theme.
 *
 * These were seven separate controls strung across the toolbar — a three-way
 * segmented control, a collapse toggle and a theme cycler — competing for
 * room with the run's own figures and winning. They are all answers to "how
 * do I want to look at this", they are all changed rarely, and every one of
 * them also has a keyboard shortcut and a palette entry. One menu.
 */
import { useRef, useState } from 'react';
import { useDismissable } from '../hooks/useDismissable.js';
import { themeLabel } from '../lib/theme.js';
import { collapsibleRoots } from '../store/collapse.js';
import { useRunStore } from '../store/runStore.js';
import { collapsedFor, useUiStore } from '../store/uiStore.js';
import { hiddenCount, presetOf } from '../store/workspace.js';
import {
  IconCollapse,
  IconExpand,
  IconGraph,
  IconMoon,
  IconSliders,
  IconSplit,
  IconSun,
  IconTheme,
  IconTimeline,
} from './Icons.js';

export function ViewMenu({ runId }: { runId: string }) {
  const view = useUiStore((s) => s.view);
  const theme = useUiStore((s) => s.theme);
  const panels = useUiStore((s) => s.panels);
  const collapsedCount = useUiStore((s) => collapsedFor(s, runId).length);
  const preset = presetOf(panels);
  const hidden = hiddenCount(panels);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, () => setOpen(false), ref);

  const toggleCollapseAll = () => {
    const ui = useUiStore.getState();
    if (collapsedCount > 0) ui.expandAll(runId);
    else {
      const current = useRunStore.getState().runs[runId];
      if (current !== undefined) ui.setCollapsed(runId, collapsibleRoots(current));
    }
  };

  return (
    <div className="gm-popover-host" ref={ref}>
      <button
        className={`gm-toolbtn${open || collapsedCount > 0 ? ' gm-toolbtn--on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Detail, panes, folding and theme"
      >
        {view === 'timeline' ? <IconTimeline /> : view === 'split' ? <IconSplit /> : <IconGraph />}
        <span className="gm-toolbtn-label">View</span>
        {collapsedCount > 0 && <span className="gm-count">{collapsedCount}</span>}
      </button>
      {open && (
        <div className="gm-popover" role="dialog" aria-label="View options">
          {/* How much of each run you want, before how it is drawn: it is the
              setting that changes the page most, and the one a new reader is
              most likely to be looking for. */}
          <div className="gm-section-label">Detail</div>
          <button
            className="gm-filter-row"
            onClick={() => {
              setOpen(false);
              useUiStore.getState().setCustomizeOpen(true);
            }}
          >
            <IconSliders />
            {preset === 'essentials' ? 'Essentials' : preset === 'everything' ? 'Everything' : 'Custom'}
            <span className="gm-filter-hint">{hidden === 0 ? 'all panels on' : `${hidden} off`}</span>
          </button>

          <div className="gm-section-label" style={{ marginTop: 12 }}>
            Panes
          </div>
          <div className="gm-seg gm-seg--wide" role="radiogroup" aria-label="View">
            <button
              className={view === 'graph' ? 'gm-seg--on' : ''}
              onClick={() => useUiStore.getState().setView('graph')}
              role="radio"
              aria-checked={view === 'graph'}
            >
              <IconGraph />
              Graph
            </button>
            <button
              className={view === 'split' ? 'gm-seg--on' : ''}
              onClick={() => useUiStore.getState().setView('split')}
              title="Graph + timeline (⇧T)"
              role="radio"
              aria-checked={view === 'split'}
            >
              <IconSplit />
              Split
            </button>
            <button
              className={view === 'timeline' ? 'gm-seg--on' : ''}
              onClick={() => useUiStore.getState().setView('timeline')}
              role="radio"
              aria-checked={view === 'timeline'}
            >
              <IconTimeline />
              Timeline
            </button>
          </div>

          <div className="gm-section-label" style={{ marginTop: 12 }}>
            Folding
          </div>
          <button
            className={`gm-filter-row${collapsedCount > 0 ? ' gm-filter-row--on' : ''}`}
            onClick={toggleCollapseAll}
          >
            {collapsedCount > 0 ? <IconExpand /> : <IconCollapse />}
            {collapsedCount > 0 ? `Expand ${collapsedCount} folded` : 'Collapse'}
            {/* Decoration: it must not end up in the button's accessible name. */}
            <span className="gm-filter-hint" aria-hidden="true">
              ⇧C
            </span>
          </button>

          <div className="gm-section-label" style={{ marginTop: 12 }}>
            Theme
          </div>
          <div className="gm-seg gm-seg--wide" role="radiogroup" aria-label="Theme">
            {(['system', 'dark', 'light'] as const).map((choice) => (
              <button
                key={choice}
                className={theme === choice ? 'gm-seg--on' : ''}
                onClick={() => useUiStore.getState().setTheme(choice)}
                role="radio"
                aria-checked={theme === choice}
              >
                {choice === 'system' ? <IconTheme /> : choice === 'dark' ? <IconMoon /> : <IconSun />}
                {themeLabel(choice).replace(/ theme$/i, '')}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
