import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  embeddedRun,
  parseFixtureParam,
  useFixtureConnection,
  type FixtureName,
} from './connection/FixtureConnection.js';
import { useLiveConnection } from './connection/useLiveConnection.js';
import { resolveServerUrl } from './connection/ServerConnection.js';
import { parseStressParams, useStressRun } from './connection/StressConnection.js';
import { formatHash, parseHash } from './router.js';
import { canvasActions, copyText, deepLink } from './lib/commands.js';
import { heldGate, resumeGate, stepGate } from './lib/gate.js';
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
      fixtureParam: parseFixtureParam(search),
      serverUrl: resolveServerUrl(search),
      stress: parseStressParams(search),
    };
  }, []);
  const demoRequested = useUiStore((s) => s.demoRequested);
  // A run exported by `graphmind record --html` inlines itself into the page.
  const hasEmbeddedRun = useMemo(() => embeddedRun() !== null, []);
  const offline = fixtureParam !== null || hasEmbeddedRun || stress !== null;
  const fixture: FixtureName | null =
    fixtureParam ?? (demoRequested || hasEmbeddedRun ? 'demo' : null);

  useLiveConnection(offline ? null : serverUrl);
  useFixtureConnection(fixture);
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
  // Below the rail's own width plus a usable canvas there is nothing to show
  // next to it, so a narrow window starts with the graph and reveals the run
  // list as an overlay on demand (index.css does the overlay half).
  const [railOpen, setRailOpen] = useState(
    () => typeof matchMedia !== 'function' || !matchMedia('(max-width: 860px)').matches,
  );
  /** The gate holding the selected run, if any — drives the paused moment. */
  const heldPauseId = useRunStore((s) => {
    if (selectedRunId === undefined) return undefined;
    const run = s.runs[selectedRunId];
    if (run === undefined) return undefined;
    for (const id of Object.keys(run.pauses)) {
      if (run.pauses[id]?.active === true) return id;
    }
    return undefined;
  });

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

  /**
   * A gate opening should arrive with its evidence already on screen.
   *
   * Execution is held: the next thing the user does is decide, and the
   * inputs to that decision — the error, the exact input that produced it,
   * the siblings that did not fail — all live in the inspector. Opening it
   * for them removes a click from the only moment that is genuinely urgent.
   *
   * It never *takes* a selection: if you were already reading some other
   * node, you stay there. The card's own banner is still the fallback.
   */
  useEffect(() => {
    if (heldPauseId === undefined || selectedRunId === undefined) return;
    const ui = useUiStore.getState();
    if (ui.selectedNodeId !== undefined) return;
    const nodeId = useRunStore.getState().runs[selectedRunId]?.pauses[heldPauseId]?.nodeId;
    if (nodeId === undefined) return;
    ui.selectNode(selectedRunId, nodeId);
  }, [heldPauseId, selectedRunId]);

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

      // ── while a gate is held, the decision owns the keyboard ─────────────
      // c/s/r/i are unbound the rest of the time, and a held run is a full
      // stop: nothing else is more urgent than what happens next. Abort is
      // deliberately not bound — an irreversible action should cost a click.
      if (!e.shiftKey && ui.selectedRunId !== undefined) {
        const pause = heldGate(ui.selectedRunId);
        if (pause !== undefined) {
          const runId = ui.selectedRunId;
          const key1 = e.key.toLowerCase();
          if (key1 === 'c' || key1 === 's' || key1 === 'r' || key1 === 'i') {
            e.preventDefault();
            if (key1 === 'c') resumeGate(runId, pause.pauseId, 'continue');
            else if (key1 === 's') stepGate(runId, pause.pauseId);
            else if (key1 === 'r') resumeGate(runId, pause.pauseId, 'retry');
            else {
              // Inject from the keyboard always opens the *panel* editor:
              // it is the copy that can never be covered, and it sits beside
              // the error and the input you are about to substitute for.
              ui.selectNode(runId, pause.nodeId);
              ui.requestInject(pause.pauseId, 'panel');
            }
            return;
          }
        }
      }

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
            {/*
              The inspector is a *pane*, not an overlay. It used to be
              absolutely positioned over the whole workspace, which put it on
              top of the timeline's controls, the minimap, and — the papercut
              that mattered — the inject button on a held card. Docking it
              costs some canvas width and removes a whole class of "the thing
              I need is behind the thing describing it" bugs. Below the
              narrow breakpoint it goes back to being an overlay, because at
              phone width there is no room for two panes at all.
            */}
            <div className="gm-workspace-panes">
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
                  fixtureAvailable={!demoRequested && fixtureParam === null && stress === null}
                  runCount={runCount}
                  railOpen={railOpen}
                  onOpenRail={() => setRailOpen(true)}
                />
              )}
            </ReactFlowProvider>
            </div>
            <InspectorPanel />
          </div>
        </main>
      </div>
      <RunBar onToggleRail={() => setRailOpen((open) => !open)} railOpen={railOpen} />
      {paletteOpen && <CommandPalette />}
    </div>
  );
}
