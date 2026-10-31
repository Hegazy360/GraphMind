/**
 * One header, one section.
 *
 * The viewer used to frame its canvas on three sides — a run rail on the
 * left, a toolbar above, a debug bar below, an inspector on the right — and
 * ask a newcomer to work out which of the four they were supposed to be
 * looking at. It is now a stack of places with one on screen at a time:
 *
 *     runs  →  run  →  node
 *
 * plus the setup guide and the builder beside it. The header carries the
 * breadcrumb (which is the navigation), whether anything is attached, and
 * the menus; a held run gets a band under it, because a stopped process
 * outranks wherever you happen to be standing.
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  embeddedRun,
  isExportedRun,
  parseFixtureParam,
  useFixtureConnection,
  type FixtureName,
} from './connection/FixtureConnection.js';
import { useLiveConnection } from './connection/useLiveConnection.js';
import { routeFromHash } from './connection/auth.js';
import { resolveServerUrl } from './connection/ServerConnection.js';
import { parseStressParams, useStressRun } from './connection/StressConnection.js';
import { depthOf, formatHash, inRun, isAside, pageHash, parseHash } from './router.js';
import { canvasActions, copyText, deepLink } from './lib/commands.js';
import { controlAllows } from './lib/control.js';
import { canEditArgs } from './lib/editArgs.js';
import { heldGate, resumeGate, stepGate } from './lib/gate.js';
import { applyTheme, nextTheme, saveTheme } from './lib/theme.js';
import { collapsibleRoots } from './store/collapse.js';
import { useEditStore } from './store/editStore.js';
import { useRunStore } from './store/runStore.js';
import { collapsedFor, useUiStore } from './store/uiStore.js';
import { AppHeader } from './components/AppHeader.js';
import { CommandPalette } from './components/CommandPalette.js';
import { CustomizePanel } from './components/CustomizePanel.js';
import { HoldStrip } from './components/HoldStrip.js';
import { BuilderPage } from './builder/BuilderPage.js';
import { NodePage } from './pages/NodePage.js';
import { RunPage } from './pages/RunPage.js';
import { RunsPage } from './pages/RunsPage.js';
import { ConnectPage } from './pages/ConnectPage.js';
import { connectSeen, markConnectSeen, shouldOpenConnect } from './lib/firstRun.js';

/** How long "attached with nothing to show" must hold before it means it. */
const SETTLE_MS = 900;

/**
 * The place the page was *opened* at, if the reader named one.
 *
 * Read once, at module load, because the app starts writing its own place
 * into the hash immediately — so by the time the first-run check runs,
 * `location.hash` is `#/runs` and says nothing about what was asked for.
 * The token `graphmind serve` puts in the link is not a place, so it is
 * stripped: otherwise nobody arriving the normal way would ever be counted
 * as having arrived without one.
 */
const ARRIVED_AT = typeof location === 'undefined' ? '' : routeFromHash(location.hash);

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
  const page = useUiStore((s) => s.page);
  const theme = useUiStore((s) => s.theme);
  const connection = useUiStore((s) => s.connection);
  const runExists = useRunStore((s) =>
    selectedRunId !== undefined ? s.runs[selectedRunId] !== undefined : false,
  );
  const firstRunId = useRunStore((s) => Object.keys(s.runs)[0]);
  const runCount = useRunStore((s) => Object.keys(s.runs).length);

  // theme: the store is seeded from storage; keep <html> and storage in sync
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // hash → state (deep links, and the browser's own back button)
  useEffect(() => {
    const apply = () => {
      const route = parseHash(location.hash);
      const ui = useUiStore.getState();
      if (route.page === 'build' || route.page === 'connect' || route.page === 'runs') {
        ui.setPage(route.page);
        return;
      }
      if (route.runId === undefined) return;
      if (route.page === 'node' && route.nodeId !== undefined) {
        ui.selectNode(route.runId, route.nodeId);
      } else {
        ui.openRun(route.runId);
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  /**
   * state → hash. Going deeper pushes a history entry so the browser's back
   * button walks the stack the way the breadcrumb does; coming back up
   * replaces, so "back" never lands on a place you just left by hand.
   */
  const lastDepth = useRef<number | null>(null);
  useEffect(() => {
    const next = inRun(page)
      ? formatHash(selectedRunId, page === 'node' ? selectedNodeId : undefined)
      : pageHash(page);
    const depth = depthOf(page);
    if (next === location.hash) {
      lastDepth.current = depth;
      return;
    }
    const url = next === '' ? location.pathname + location.search : next;
    const forward = lastDepth.current !== null && depth > lastDepth.current;
    if (forward) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    lastDepth.current = depth;
  }, [page, selectedRunId, selectedNodeId]);

  /**
   * Open the first run to arrive, once.
   *
   * With one run on the machine, making someone click it is ceremony. But
   * it is an *opening* move, not a standing rule: a reader who asked for
   * `#/runs`, or who stepped back up to the list, has said which place they
   * want, and a run arriving later must not drag them out of it.
   */
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || ARRIVED_AT !== '') return;
    if (selectedRunId !== undefined || firstRunId === undefined) return;
    autoOpened.current = true;
    useUiStore.getState().selectRun(firstRunId);
  }, [selectedRunId, firstRunId]);

  /**
   * A cold start opens the setup guide instead of an empty page. Fires at
   * most once per browser, never over a deep link or an offline replay, and
   * never once a run exists.
   */
  const guideOffered = useRef(false);
  useEffect(() => {
    if (guideOffered.current || offline || ARRIVED_AT !== '') return;
    if (!shouldOpenConnect(connection, runCount, connectSeen())) return;
    // Wait out the handshake: the server replays history on subscribe, so
    // "attached with zero runs" is true for a moment on every connect.
    const timer = setTimeout(() => {
      const ui = useUiStore.getState();
      // Only from a standing start. Anyone who went somewhere in the
      // meantime — opened the builder, picked a run — has answered the
      // question the guide was about to ask.
      if (ui.page !== 'runs') return;
      if (Object.keys(useRunStore.getState().runs).length > 0) return;
      guideOffered.current = true;
      markConnectSeen();
      ui.setPage('connect');
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [connection, runCount, offline]);

  /**
   * A gate opening does *not* move you.
   *
   * The old layout opened the inspector beside the graph, which cost
   * nothing. Navigating now would cost the graph — and the moment a run
   * stops is exactly when you want to see where in the shape it stopped.
   * So the hold announces itself (the band under the header, the banner on
   * the card) and you choose to go in. `c` / `s` / `r` still release it from
   * right here without moving at all; only `i` and `e`, which need the
   * editor and the evidence, take you to the call.
   */

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
      // Escape is "up one step": close what is open, else leave the node for
      // the graph, else leave the run for the list.
      if (e.key === 'Escape') {
        if (ui.paletteOpen) ui.setPaletteOpen(false);
        else if (ui.customizeOpen) ui.setCustomizeOpen(false);
        else if (ui.page === 'node' && ui.selectedNodeId !== undefined) {
          // Back to the graph, landing on the node you were reading: the
          // selection survives the step, so it is still lit and centred —
          // which is also why the test here is the *place*, not the
          // selection, or a second Escape would step onto itself.
          ui.closeNode();
          ui.requestFocus(ui.selectedNodeId);
        } else if (isAside(ui.page)) {
          // A side trip comes back to where it was taken from, not to the
          // top: leaving Connect should land on the call you were reading.
          ui.leaveAside();
        } else if (ui.page === 'run') {
          ui.setPage('runs');
        }
        return;
      }
      if (typing || meta || e.altKey) return;
      // Outside a run the canvas shortcuts have nothing to act on.
      if (!inRun(ui.page)) return;

      // ── while a gate is held, the decision owns the keyboard ─────────────
      // c/s/r/i (and e, on an editable pause) are unbound the rest of the
      // time, and a held run is a full stop. Abort is deliberately not bound
      // — an irreversible action should cost a click.
      if (!e.shiftKey && ui.selectedRunId !== undefined) {
        const pause = heldGate(ui.selectedRunId);
        if (pause !== undefined) {
          const runId = ui.selectedRunId;
          const key1 = e.key.toLowerCase();
          // A tokenless tab has no Step or Inject (the server refuses them).
          const withheld =
            (key1 === 's' && !controlAllows(ui.control, 'debug')) ||
            (key1 === 'i' && !controlAllows(ui.control, 'inject'));
          if (!withheld && (key1 === 'c' || key1 === 's' || key1 === 'r' || key1 === 'i')) {
            e.preventDefault();
            if (key1 === 'c') resumeGate(runId, pause.pauseId, 'continue');
            else if (key1 === 's') stepGate(runId, pause.pauseId);
            else if (key1 === 'r') resumeGate(runId, pause.pauseId, 'retry');
            else {
              // Inject from the keyboard opens the editor beside the error
              // and the input you are about to substitute for.
              if (ui.selectedNodeId !== pause.nodeId) ui.selectNode(runId, pause.nodeId);
              ui.requestInject(pause.pauseId, 'panel');
            }
            return;
          }
          // `e` edits the held call's arguments (0.6.0) — only where the app
          // said it can (`exec.paused.editable`), never on an LLM step.
          if (key1 === 'e') {
            const node = useRunStore.getState().runs[runId]?.nodes[pause.nodeId];
            if (node !== undefined && canEditArgs(node, pause, isExportedRun(), ui.control)) {
              e.preventDefault();
              if (ui.selectedNodeId !== pause.nodeId) ui.selectNode(runId, pause.nodeId);
              useEditStore.getState().requestEditor(pause.pauseId);
              return;
            }
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
      if (key === 'l' && shift) {
        e.preventDefault();
        const runId = ui.selectedRunId;
        if (runId !== undefined) void copyText(deepLink(runId, ui.selectedNodeId));
        return;
      }
      if (key === 'd' && !shift) {
        ui.setTheme(nextTheme(useUiStore.getState().theme));
        return;
      }
      // The rest act on the canvas, which only exists on the run place.
      if (ui.page !== 'run') return;

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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fixtureAvailable = !demoRequested && fixtureParam === null && stress === null;
  const insideRun = inRun(page) && selectedRunId !== undefined && runExists;

  let main: React.ReactNode;
  if (page === 'build') main = <BuilderPage />;
  else if (page === 'connect') main = <ConnectPage />;
  else if (insideRun && page === 'node' && selectedNodeId !== undefined)
    main = <NodePage runId={selectedRunId} nodeId={selectedNodeId} />;
  else if (insideRun) main = <RunPage runId={selectedRunId} />;
  else main = <RunsPage fixtureAvailable={fixtureAvailable} />;

  return (
    <div className="gm-app">
      <AppHeader />
      <HoldStrip />
      <main className="gm-main">{main}</main>
      {paletteOpen && <CommandPalette />}
      <CustomizePanel />
    </div>
  );
}
