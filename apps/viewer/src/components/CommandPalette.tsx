/**
 * Cmd/Ctrl-K. One box that finds anything in the debugger: a node in the
 * current run, another run, or an action ("show only the error path", "copy
 * deep link", "collapse all"). Typing `>` narrows to actions, the way a
 * developer already expects it to.
 *
 * Everything the palette can do is also reachable by mouse — the palette is
 * the fast path, never the only path.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { matchSorter } from 'match-sorter';
import { broadcastControl, getConnection } from '../connection/ServerConnection.js';
import { canvasActions, copyText, deepLink } from '../lib/commands.js';
import { fmtRelative } from '../lib/format.js';
import { collapsibleRoots } from '../store/collapse.js';
import { useRunStore } from '../store/runStore.js';
import { nodeStatus, runBadgeStatus, type NodeLifeStatus } from '../store/types.js';
import { collapsedFor, matcherKey, useUiStore } from '../store/uiStore.js';
import { StatusDot } from './nodes/nodeParts.js';
import { IconChevron } from './Icons.js';

type Group = 'Actions' | 'Nodes' | 'Runs';

interface PaletteItem {
  id: string;
  group: Group;
  title: string;
  subtitle?: string;
  hint?: string;
  status?: NodeLifeStatus;
  keywords?: string;
  run: () => void;
}

const GROUP_ORDER: Group[] = ['Actions', 'Nodes', 'Runs'];

function useActionItems(runId: string | undefined): PaletteItem[] {
  const view = useUiStore((s) => s.view);
  const filters = useUiStore((s) => s.filters);
  const followCamera = useUiStore((s) => s.followCamera);
  const mode = useUiStore((s) => s.mode);
  const theme = useUiStore((s) => s.theme);
  const fixtureActive = useUiStore((s) => s.fixtureActive);
  const selectedNodeId = useUiStore((s) => s.selectedNodeId);
  const collapsedCount = useUiStore((s) => (runId === undefined ? 0 : collapsedFor(s, runId).length));

  return useMemo<PaletteItem[]>(() => {
    const ui = useUiStore.getState();
    const items: PaletteItem[] = [
      {
        id: 'act:timeline',
        group: 'Actions',
        title: view === 'graph' ? 'Open the timeline' : 'Close the timeline',
        subtitle: 'Waterfall of every execution, with overlaps and gates',
        hint: '⇧T',
        keywords: 'waterfall trace spans duration parallel',
        run: () => ui.toggleTimeline(),
      },
      {
        id: 'act:timeline-only',
        group: 'Actions',
        title: 'Timeline only (hide the graph)',
        keywords: 'waterfall fullscreen',
        run: () => ui.setView('timeline'),
      },
      {
        id: 'act:errorpath',
        group: 'Actions',
        title: filters.errorPathOnly ? 'Show the whole graph' : 'Show only the error path',
        subtitle: 'Dim everything that is not an ancestor of a failure',
        hint: '⇧E',
        keywords: 'failure ancestry blame focus dim',
        run: () => ui.toggleErrorPath(),
      },
      {
        id: 'act:filter-error',
        group: 'Actions',
        title: 'Filter: errored nodes',
        keywords: 'failed exception',
        run: () => ui.setStatusFilter('error'),
      },
      {
        id: 'act:filter-slow',
        group: 'Actions',
        title: 'Filter: slow nodes',
        subtitle: 'p90 duration and above, for this run',
        keywords: 'latency duration p90 hotspot',
        run: () => ui.setStatusFilter('slow'),
      },
      {
        id: 'act:filter-paused',
        group: 'Actions',
        title: 'Filter: paused nodes',
        keywords: 'held gate breakpoint',
        run: () => ui.setStatusFilter('paused'),
      },
      {
        id: 'act:filter-clear',
        group: 'Actions',
        title: 'Clear all filters',
        keywords: 'reset show everything',
        run: () => ui.clearFilters(),
      },
      {
        id: 'act:collapse',
        group: 'Actions',
        title: collapsedCount > 0 ? 'Expand all groups' : 'Collapse all groups',
        subtitle: 'Fold sub-agents and chains into summary cards',
        hint: '⇧C',
        keywords: 'fold group summarize subtree',
        run: () => {
          if (runId === undefined) return;
          if (collapsedCount > 0) ui.expandAll(runId);
          else {
            const run = useRunStore.getState().runs[runId];
            if (run !== undefined) ui.setCollapsed(runId, collapsibleRoots(run));
          }
        },
      },
      {
        id: 'act:follow',
        group: 'Actions',
        title: followCamera ? 'Stop following the active node' : 'Follow the active node',
        hint: 'F',
        keywords: 'camera chase live',
        run: () => ui.toggleFollow(),
      },
      {
        id: 'act:fit',
        group: 'Actions',
        title: 'Fit the graph to the screen',
        hint: '⇧F',
        keywords: 'zoom fit view',
        run: () => canvasActions()?.fitView(),
      },
      {
        id: 'act:arrange',
        group: 'Actions',
        title: 'Re-arrange the layout',
        subtitle: 'Full ELK pass — tidies a graph grown by incremental layout',
        hint: '⇧A',
        keywords: 'layout elk tidy',
        run: () => canvasActions()?.arrange(),
      },
      {
        id: 'act:link',
        group: 'Actions',
        title: 'Copy deep link to this view',
        hint: '⇧L',
        keywords: 'share url permalink',
        run: () => {
          if (runId === undefined) return;
          void copyText(deepLink(runId, selectedNodeId));
        },
      },
      {
        id: 'act:mode',
        group: 'Actions',
        title: mode === 'run' ? 'Switch to step mode' : 'Switch to run mode',
        subtitle: 'Step mode pauses at every gate',
        keywords: 'debug step through',
        run: () => {
          const next = mode === 'run' ? 'step' : 'run';
          ui.setMode(next);
          broadcastControl('mode.set', { mode: next });
        },
      },
      {
        id: 'act:pauseall',
        group: 'Actions',
        title: 'Break before every node',
        keywords: 'breakpoint pause all gate',
        run: () => {
          const matcher = {};
          ui.addBreakpoint(matcher);
          broadcastControl('breakpoint.set', { matcher });
        },
      },
      {
        id: 'act:clearbp',
        group: 'Actions',
        title: 'Clear every breakpoint',
        keywords: 'remove breakpoints',
        run: () => {
          for (const matcher of useUiStore.getState().breakpoints) {
            ui.removeBreakpoint(matcher);
            broadcastControl('breakpoint.clear', { matcher });
          }
        },
      },
      {
        id: 'act:theme',
        group: 'Actions',
        title: `Theme: ${theme} → ${theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system'}`,
        keywords: 'dark light appearance colour color',
        run: () => ui.setTheme(theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system'),
      },
    ];

    if (selectedNodeId !== undefined && runId !== undefined) {
      const node = useRunStore.getState().runs[runId]?.nodes[selectedNodeId];
      if (node !== undefined) {
        const matcher = { kind: node.kind, name: node.name };
        const isSet = useUiStore
          .getState()
          .breakpoints.some((m) => matcherKey(m) === matcherKey(matcher));
        items.push({
          id: 'act:bp-selected',
          group: 'Actions',
          title: `${isSet ? 'Clear' : 'Set'} breakpoint on ${node.name}`,
          keywords: 'break gate selected',
          run: () => {
            if (isSet) {
              ui.removeBreakpoint(matcher);
              broadcastControl('breakpoint.clear', { matcher });
            } else {
              ui.addBreakpoint(matcher);
              broadcastControl('breakpoint.set', { matcher });
            }
          },
        });
        items.push({
          id: 'act:collapse-selected',
          group: 'Actions',
          title: `Collapse / expand ${node.name}`,
          keywords: 'fold group subtree',
          run: () => ui.toggleCollapse(runId, selectedNodeId),
        });
      }
    }

    if (fixtureActive) {
      items.push({
        id: 'act:restart',
        group: 'Actions',
        title: 'Restart the replay',
        keywords: 'demo fixture again',
        run: () => getConnection('fixture')?.restart?.(),
      });
    }
    return items;
  }, [view, filters.errorPathOnly, followCamera, mode, theme, fixtureActive, selectedNodeId, collapsedCount, runId]);
}

export function CommandPalette() {
  const runId = useUiStore((s) => s.selectedRunId);
  const seed = useUiStore((s) => s.paletteSeed);
  const runs = useRunStore((s) => s.runs);
  const structureVersion = useRunStore((s) => (runId === undefined ? 0 : s.runs[runId]?.structureVersion ?? 0));
  const statusVersion = useRunStore((s) => (runId === undefined ? 0 : s.runs[runId]?.statusVersion ?? 0));
  const [query, setQuery] = useState(seed);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const actions = useActionItems(runId);

  const nodeItems = useMemo<PaletteItem[]>(() => {
    void structureVersion;
    void statusVersion;
    if (runId === undefined) return [];
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return [];
    return run.order.flatMap((nodeId) => {
      const node = run.nodes[nodeId];
      if (node === undefined) return [];
      const status = nodeStatus(node);
      const execs = node.executions.length;
      return [
        {
          id: `node:${nodeId}`,
          group: 'Nodes' as const,
          title: node.name,
          subtitle: nodeId,
          hint: execs > 1 ? `${node.kind} ×${execs}` : node.kind,
          status,
          keywords: `${node.kind} ${status}`,
          run: () => {
            const ui = useUiStore.getState();
            ui.selectNode(runId, nodeId);
            ui.requestFocus(nodeId);
          },
        },
      ];
    });
  }, [runId, structureVersion, statusVersion]);

  const runItems = useMemo<PaletteItem[]>(
    () =>
      Object.values(runs)
        .sort((a, b) => (b.meta.startedTs ?? 0) - (a.meta.startedTs ?? 0))
        .map((run) => ({
          id: `run:${run.runId}`,
          group: 'Runs' as const,
          title: run.meta.app,
          subtitle: run.runId,
          hint: run.meta.startedTs !== undefined ? fmtRelative(run.meta.startedTs) : undefined,
          keywords: runBadgeStatus(run),
          run: () => useUiStore.getState().selectRun(run.runId),
        })),
    [runs],
  );

  const results = useMemo(() => {
    const actionsOnly = query.startsWith('>');
    const term = actionsOnly ? query.slice(1).trim() : query.trim();
    const pool = actionsOnly ? actions : [...actions, ...nodeItems, ...runItems];
    const matched =
      term === ''
        ? actionsOnly
          ? pool
          : [...nodeItems.slice(0, 40), ...actions, ...runItems]
        : matchSorter(pool, term, { keys: ['title', 'subtitle', 'keywords'] });
    return matched.slice(0, 60);
  }, [query, actions, nodeItems, runItems]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  const close = () => useUiStore.getState().setPaletteOpen(false);

  const choose = (item: PaletteItem | undefined) => {
    if (item === undefined) return;
    item.run();
    close();
  };

  // Group headers are rendered inline while walking the flat, ranked list.
  let lastGroup: Group | undefined;

  return (
    <div className="gm-scrim" onMouseDown={close} role="presentation">
      <div
        className="gm-palette"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="gm-palette-input">
          <span className="gm-palette-prefix" aria-hidden>
            {query.startsWith('>') ? '›' : '⌘'}
          </span>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search nodes, runs, or type > for actions…"
            spellCheck={false}
            aria-label="Search nodes, runs and actions"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(results[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          />
          <span className="gm-kbd">esc</span>
        </div>

        <div className="gm-palette-results" ref={listRef} role="listbox" aria-label="Results">
          {results.length === 0 ? (
            <div className="gm-palette-empty">
              No match for <strong>{query.replace(/^>/, '').trim()}</strong>
            </div>
          ) : (
            results.map((item, i) => {
              const header = item.group !== lastGroup ? item.group : undefined;
              lastGroup = item.group;
              return (
                <div key={item.id}>
                  {header !== undefined && <div className="gm-palette-group">{header}</div>}
                  <button
                    className={`gm-palette-item${i === active ? ' gm-palette-item--active' : ''}`}
                    data-active={i === active}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(item)}
                  >
                    {item.status !== undefined ? (
                      <StatusDot status={item.status} />
                    ) : (
                      <IconChevron width={11} height={11} style={{ opacity: 0.45, flexShrink: 0 }} />
                    )}
                    <span className="gm-palette-title">{item.title}</span>
                    {item.subtitle !== undefined && (
                      <span className="gm-palette-sub">{item.subtitle}</span>
                    )}
                    {item.hint !== undefined && <span className="gm-palette-hint">{item.hint}</span>}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="gm-palette-footer">
          <span>
            <span className="gm-kbd">↑</span>
            <span className="gm-kbd">↓</span> navigate
          </span>
          <span>
            <span className="gm-kbd">↵</span> run
          </span>
          <span>
            <span className="gm-kbd">&gt;</span> actions only
          </span>
        </div>
      </div>
    </div>
  );
}
