/**
 * The only persistent chrome in the viewer.
 *
 * One row: where you are, whether the debugger is attached, and the three
 * menus. Everything else belongs to whichever place is on screen. The old
 * layout had a top bar *and* a bottom bar *and* a left rail framing the
 * canvas on three sides; this is the whole frame now.
 *
 * The breadcrumb is not decoration — it is the navigation. `Runs › app ›
 * node` is the stack you are standing on, every ancestor is a link, and the
 * browser's back button walks the same path because each crumb is a hash.
 */
import { useMemo, useRef, useState } from 'react';
import { isExportedRun } from '../connection/FixtureConnection.js';
import { getConnection } from '../connection/ServerConnection.js';
import { crumbsFor, inRun, isAside } from '../router.js';
import { useRunStore } from '../store/runStore.js';
import {
  indicatorStatus,
  streamStatus,
  useUiStore,
  type ConnectionStatus,
} from '../store/uiStore.js';
import { useDismissable } from '../hooks/useDismissable.js';
import { DebugMenu } from './DebugMenu.js';
import { IconChevron, IconCompass, IconPlus, IconReplay, IconSearch, IconStack } from './Icons.js';
import { GraphMindMark } from './Mark.js';
import { ViewMenu } from './ViewMenu.js';

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  live: 'live',
  connecting: 'connecting',
  detached: 'detached',
  replaying: 'replaying',
  off: 'offline',
};

const CONNECTION_HINT: Record<ConnectionStatus, string> = {
  live: 'Attached to the debug server — events are streaming in.',
  connecting: 'Reaching the debug server…',
  detached: 'The debug server went away. Reconnecting with backoff; gates fail open.',
  replaying: 'Replaying a recorded run locally — no debug server attached.',
  off: 'Not attached to a debug server.',
};

function seconds(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * The connection light never flatters the connection.
 *
 * An open socket is not a live tail: the server replays a run's history
 * before it tails, so a saturated server can deliver a whole run as catch-up
 * while the dot sits on green. "live" here means live; anything else says
 * what it actually is.
 */
function ConnectionChip() {
  const connection = useUiStore((s) => s.connection);
  const fixtureActive = useUiStore((s) => s.fixtureActive);
  const stream = useUiStore((s) => s.stream);
  const status = indicatorStatus(connection, fixtureActive);

  let label = CONNECTION_LABEL[status];
  let hint = CONNECTION_HINT[status];
  let modifier: string = status;

  if (status === 'live') {
    const tail = streamStatus(stream);
    if (tail.phase === 'catching-up') {
      const done = tail.applied.toLocaleString('en-US');
      const total = tail.backlog.toLocaleString('en-US');
      label = `catching up ${done}/${total}`;
      modifier = 'catchup';
      hint =
        `Attached, but this is replayed history, not the live tail: the server is still sending ` +
        `${total} stored events for the runs you are subscribed to. Gates that opened during the ` +
        'backlog have already been decided — you are watching a recording until this finishes.';
    } else if (tail.phase === 'behind') {
      label = `behind ${seconds(tail.lagMs)}`;
      modifier = 'behind';
      hint =
        `Attached and tailing, but the newest event to arrive is ${seconds(tail.lagMs)} old — the ` +
        'stream is not keeping up with the run. What is on the canvas happened a while ago.';
    }
  }

  return (
    <div className="gm-conn-group" title={hint} data-phase={modifier}>
      <span className={`gm-conn gm-conn--${modifier}`} />
      <span className="gm-conn-label">{label}</span>
    </div>
  );
}

/**
 * Everywhere you can go, from anywhere.
 *
 * The breadcrumb walks *back*; this is how you go sideways. Without it the
 * two side trips were only reachable from the runs list, so getting to them
 * from inside a run meant leaving the run first — and the keyboard route
 * (⌘K) is not something a first-time reader knows about yet.
 */
function PlacesMenu() {
  const page = useUiStore((s) => s.page);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, () => setOpen(false), ref);

  const go = (to: 'runs' | 'connect' | 'build') => {
    setOpen(false);
    useUiStore.getState().setPage(to);
  };

  return (
    <div className="gm-popover-host" ref={ref}>
      <button
        className="gm-header-brand"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="GraphMind — go to…"
        aria-label="GraphMind — go to…"
      >
        <GraphMindMark size={19} />
      </button>
      {open && (
        <div className="gm-popover gm-popover--places" role="menu" aria-label="Go to">
          <button
            className={`gm-filter-row${page === 'runs' ? ' gm-filter-row--on' : ''}`}
            role="menuitem"
            onClick={() => go('runs')}
          >
            <IconStack />
            Runs
          </button>
          <button
            className={`gm-filter-row${page === 'connect' ? ' gm-filter-row--on' : ''}`}
            role="menuitem"
            onClick={() => go('connect')}
          >
            <IconCompass />
            Connect an agent
          </button>
          <button
            className={`gm-filter-row${page === 'build' ? ' gm-filter-row--on' : ''}`}
            role="menuitem"
            onClick={() => go('build')}
          >
            <IconPlus />
            Build a workflow
          </button>
        </div>
      )}
    </div>
  );
}

export function AppHeader() {
  const page = useUiStore((s) => s.page);
  const runId = useUiStore((s) => s.selectedRunId);
  const nodeId = useUiStore((s) => s.selectedNodeId);
  const fixtureActive = useUiStore((s) => s.fixtureActive);
  const app = useRunStore((s) => (runId === undefined ? undefined : s.runs[runId]?.meta.app));
  const nodeName = useRunStore((s) =>
    runId === undefined || nodeId === undefined ? undefined : s.runs[runId]?.nodes[nodeId]?.name,
  );

  // Where the stack is standing, which stays true while you are off on a
  // side trip — that is what makes the way back exact.
  const stackAt = useUiStore((s) => s.stackAt);

  const crumbs = useMemo(
    () =>
      crumbsFor(
        page,
        runId !== undefined && app !== undefined ? { runId, app } : undefined,
        nodeId !== undefined ? { nodeId, name: nodeName ?? nodeId } : undefined,
        stackAt,
      ),
    [page, runId, app, nodeId, nodeName, stackAt],
  );

  const insideRun = inRun(page) && runId !== undefined;

  return (
    <header className="gm-header">
      <PlacesMenu />

      <nav className="gm-crumbs" aria-label="Breadcrumb">
        {crumbs.map((crumb, index) => (
          <span key={crumb.hash} className="gm-crumb-slot">
            {index > 0 && <IconChevron className="gm-crumb-sep" width={12} height={12} />}
            {crumb.current ? (
              <span className="gm-crumb gm-crumb--current" aria-current="page">
                {crumb.label}
              </span>
            ) : (
              <a className="gm-crumb" href={crumb.hash}>
                {crumb.label}
              </a>
            )}
          </span>
        ))}
      </nav>

      <div className="gm-header-actions">
        <ConnectionChip />

        {/* Re-ingesting the embedded envelopes is something an exported page
            really can do, unlike the debugger controls beside it. */}
        {fixtureActive && (
          <button
            className="gm-iconbtn"
            title={isExportedRun() ? 'Re-render the recorded run' : 'Restart the replay'}
            aria-label="Restart the replay"
            onClick={() => getConnection('fixture')?.restart?.()}
          >
            <IconReplay />
          </button>
        )}

        <DebugMenu />
        {insideRun && <ViewMenu runId={runId} />}

        <button
          className="gm-toolbtn"
          onClick={() => useUiStore.getState().setPaletteOpen(true)}
          title="Search nodes, runs and actions"
        >
          <IconSearch />
          <span className="gm-toolbtn-label">Search</span>
          <span className="gm-kbd">⌘K</span>
        </button>
      </div>
    </header>
  );
}
