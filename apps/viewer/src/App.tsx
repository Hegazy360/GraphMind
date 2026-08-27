import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { embeddedRun, useFixtureConnection } from './connection/FixtureConnection.js';
import { useLiveConnection } from './connection/useLiveConnection.js';
import { resolveServerUrl } from './connection/ServerConnection.js';
import { parseStressParams, useStressRun } from './connection/StressConnection.js';
import { formatHash, parseHash } from './router.js';
import { canvasActions, copyText, deepLink } from './lib/commands.js';
import { applyTheme, nextTheme, saveTheme } from './lib/theme.js';
import { collapsibleRoots } from './store/collapse.js';
import { useRunStore } from './store/runStore.js';
import { MIN_TIMELINE_HEIGHT, collapsedFor, useUiStore } from './store/uiStore.js';
import { CommandPalette } from './components/CommandPalette.js';
import { InspectorPanel } from './components/InspectorPanel.js';
import { RunBar } from './components/RunBar.js';
import { RunCanvas } from './components/RunCanvas.js';
import { RunsList } from './components/RunsList.js';
import { EmptyState } from './components/EmptyState.js';
import { Timeline } from './components/Timeline.js';
import { TopBar } from './components/TopBar.js';

/** The draggable divider between the graph and the waterfall. */
function TimelineSplitter({ onResize }: { onResize: (height: number) => void }) {
  const dragging = useRef(false);
  const onDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragging.current) return;
      onResize(window.innerHeight - event.clientY - 44);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onResize]);

  return (
    <div
      className="gm-splitter"
      onMouseDown={onDown}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the timeline"
      tabIndex={0}
      onKeyDown={(event) => {
        const height = useUiStore.getState().timelineHeight;
        if (event.key === 'ArrowUp') onResize(height + 24);
        if (event.key === 'ArrowDown') onResize(Math.max(MIN_TIMELINE_HEIGHT, height - 24));
      }}
    />
  );
}

export default function App() {
  const { fixtureParam, serverUrl, stress } = useMemo(() => {
    const search = location.search;
    return {
      fixtureParam: new URLSearchParams(search).get('fixture') === '1',
      serverUrl: resolveServerUrl(search),
      stress: parseStressParams(search),
    };
  }, []);
  const demoRequested = useUiStore((s) => s.demoRequested);
  // A run exported by `graphmind record --html` inlines itself into the page.
  const hasEmbeddedRun = useMemo(() => embeddedRun() !== null, []);

  useLiveConnection(fixtureParam || hasEmbeddedRun || stress !== null ? null : serverUrl);
  useFixtureConnection(fixtureParam || demoRequested || hasEmbeddedRun);
  useStressRun(stress);

  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectedNodeId = useUiStore((s) => s.selectedNodeId);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const view = useUiStore((s) => s.view);
  const timelineHeight = useUiStore((s) => s.timelineHeight);
  const theme = useUiStore((s) => s.theme);
  const runExists = useRunStore((s) =>
    selectedRunId !== undefined ? s.runs[selectedRunId] !== undefined : false,
  );
  const firstRunId = useRunStore((s) => Object.keys(s.runs)[0]);
  const runCount = useRunStore((s) => Object.keys(s.runs).length);
  const [railOpen, setRailOpen] = useState(true);

  // theme: the store is seeded from storage; keep <html> and storage in sync
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // hash → state (deep links)
  useEffect(() => {
    const apply = () => {
      const route = parseHash(location.hash);
      if (route.runId === undefined) return;
      const ui = useUiStore.getState();
      if (route.nodeId !== undefined) {
        ui.selectNode(route.runId, route.nodeId);
        ui.requestFocus(route.nodeId);
      } else if (ui.selectedRunId !== route.runId) {
        ui.selectRun(route.runId);
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  // state → hash
  useEffect(() => {
    const next = formatHash(selectedRunId, selectedNodeId);
    if (next === location.hash) return;
    history.replaceState(null, '', next === '' ? location.pathname + location.search : next);
  }, [selectedRunId, selectedNodeId]);

  // auto-select the first run to arrive (deep links win — they select first)
  useEffect(() => {
    if (selectedRunId === undefined && firstRunId !== undefined) {
      useUiStore.getState().selectRun(firstRunId);
    }
  }, [selectedRunId, firstRunId]);

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.tagName === 'SELECT');
      const ui = useUiStore.getState();
      const meta = e.metaKey || e.ctrlKey;

      // ⌘K / ctrl-K always opens the palette, even from a text field.
      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      if (e.key === 'Escape') {
        if (ui.paletteOpen) ui.setPaletteOpen(false);
        else if (ui.selectedNodeId !== undefined && ui.selectedRunId !== undefined) {
          ui.selectNode(ui.selectedRunId, undefined);
        }
        return;
      }
      if (typing || meta || e.altKey) return;

      // Match on the lowercased key plus the shift flag rather than on the
      // shifted character: keyboard layouts (and some automation) disagree
      // about whether shift+t arrives as "T" or as "t".
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const shift = e.shiftKey;

      if (key === '/' || key === '>') {
        e.preventDefault();
        ui.setPaletteOpen(true, key === '>' ? '>' : '');
        return;
      }
      if (key === 'f') {
        e.preventDefault();
        if (shift) canvasActions()?.fitView();
        else ui.toggleFollow();
        return;
      }
      if (key === 'a' && shift) {
        e.preventDefault();
        canvasActions()?.arrange();
        return;
      }
      if (key === 't' && shift) {
        e.preventDefault();
        ui.toggleTimeline();
        return;
      }
      if (key === 'e' && shift) {
        e.preventDefault();
        ui.toggleErrorPath();
        return;
      }
      if (key === 'c' && shift) {
        e.preventDefault();
        const runId = ui.selectedRunId;
        if (runId === undefined) return;
        if (collapsedFor(ui, runId).length > 0) ui.expandAll(runId);
        else {
          const run = useRunStore.getState().runs[runId];
          if (run !== undefined) ui.setCollapsed(runId, collapsibleRoots(run));
        }
        return;
      }
      if (key === 'l' && shift) {
        e.preventDefault();
        const runId = ui.selectedRunId;
        if (runId !== undefined) void copyText(deepLink(runId, ui.selectedNodeId));
        return;
      }
      if (key === 'b' && !shift) {
        setRailOpen((open) => !open);
        return;
      }
      if (key === 'd' && !shift) {
        ui.setTheme(nextTheme(useUiStore.getState().theme));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const showRun = selectedRunId !== undefined && runExists;
  const showTimeline = showRun && (view === 'split' || view === 'timeline');

  return (
    <div className="gm-app">
      <div className="gm-app-body">
        {railOpen && <RunsList onCollapse={() => setRailOpen(false)} />}
        <main className="gm-main">
          {showRun && <TopBar runId={selectedRunId} />}
          <div className="gm-workspace">
            <ReactFlowProvider>
              {showRun ? (
                <>
                  {view !== 'timeline' && (
                    <div className="gm-workspace-graph">
                      <RunCanvas runId={selectedRunId} />
                    </div>
                  )}
                  {showTimeline && (
                    <>
                      {view === 'split' && (
                        <TimelineSplitter
                          onResize={(height) => useUiStore.getState().setTimelineHeight(height)}
                        />
                      )}
                      <div
                        className="gm-workspace-timeline"
                        style={
                          view === 'timeline'
                            ? { flex: 1, minHeight: 0 }
                            : { height: timelineHeight, flexShrink: 0 }
                        }
                      >
                        <Timeline runId={selectedRunId} />
                      </div>
                    </>
                  )}
                </>
              ) : (
                <EmptyState
                  fixtureAvailable={!demoRequested && !fixtureParam && stress === null}
                  runCount={runCount}
                  railOpen={railOpen}
                  onOpenRail={() => setRailOpen(true)}
                />
              )}
            </ReactFlowProvider>
            <InspectorPanel />
          </div>
        </main>
      </div>
      <RunBar onToggleRail={() => setRailOpen((open) => !open)} railOpen={railOpen} />
      {paletteOpen && <CommandPalette />}
    </div>
  );
}
