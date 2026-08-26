import { useEffect, useMemo } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useFixtureConnection } from './connection/FixtureConnection.js';
import { useLiveConnection } from './connection/useLiveConnection.js';
import { resolveServerUrl } from './connection/ServerConnection.js';
import { formatHash, parseHash } from './router.js';
import { useRunStore } from './store/runStore.js';
import { useUiStore } from './store/uiStore.js';
import { InspectorPanel } from './components/InspectorPanel.js';
import { RunBar } from './components/RunBar.js';
import { RunCanvas } from './components/RunCanvas.js';
import { GraphMindMark, RunsList } from './components/RunsList.js';
import { WelcomeCard } from './components/WelcomeCard.js';
import { shouldShowWelcome } from './lib/firstRun.js';

function EmptyState({ fixtureAvailable, runCount }: { fixtureAvailable: boolean; runCount: number }) {
  const connection = useUiStore((s) => s.connection);
  // First run: connected, zero runs → the crafted welcome card.
  if (fixtureAvailable && shouldShowWelcome(connection, runCount)) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: 'var(--bg-canvas)' }}>
        <WelcomeCard />
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ gap: 14, background: 'var(--bg-canvas)' }}>
      <GraphMindMark size={40} />
      <div className="gm-empty-logo">Waiting for a run</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', textAlign: 'center', lineHeight: 1.7 }}>
        Attach an instrumented app — the viewer is {connection === 'live' ? 'connected' : connection}
        {' '}on <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>/ws/ui</code>.
      </div>
      {fixtureAvailable && (
        <button
          className="gm-action gm-action--primary"
          style={{ flex: 'none', padding: '7px 18px', fontSize: 12 }}
          onClick={() => useUiStore.getState().requestDemo()}
        >
          Load demo run
        </button>
      )}
    </div>
  );
}

export default function App() {
  const { fixtureParam, serverUrl } = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return {
      fixtureParam: params.get('fixture') === '1',
      serverUrl: resolveServerUrl(location.search),
    };
  }, []);
  const demoRequested = useUiStore((s) => s.demoRequested);

  useLiveConnection(fixtureParam ? null : serverUrl);
  useFixtureConnection(fixtureParam || demoRequested);

  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectedNodeId = useUiStore((s) => s.selectedNodeId);
  const runExists = useRunStore((s) => (selectedRunId !== undefined ? s.runs[selectedRunId] !== undefined : false));
  const firstRunId = useRunStore((s) => {
    const ids = Object.keys(s.runs);
    return ids[0];
  });
  const runCount = useRunStore((s) => Object.keys(s.runs).length);

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

  // keyboard: / search · f follow · esc close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable ||
          target.tagName === 'SELECT');
      const ui = useUiStore.getState();
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (ui.selectedRunId !== undefined) ui.setSearchOpen(true);
      } else if ((e.key === 'f' || e.key === 'F') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        ui.toggleFollow();
      } else if (e.key === 'Escape') {
        if (ui.searchOpen) ui.setSearchOpen(false);
        else if (ui.selectedNodeId !== undefined && ui.selectedRunId !== undefined) {
          ui.selectNode(ui.selectedRunId, undefined);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <RunsList />
        <main className="relative min-w-0 flex-1">
          <ReactFlowProvider>
            {selectedRunId !== undefined && runExists ? (
              <RunCanvas runId={selectedRunId} />
            ) : (
              <EmptyState fixtureAvailable={!demoRequested && !fixtureParam} runCount={runCount} />
            )}
          </ReactFlowProvider>
          <InspectorPanel />
        </main>
      </div>
      <RunBar />
    </div>
  );
}
