/**
 * The Build page: place the nodes you want to test, see the code they
 * become, and run it from here.
 *
 * The canvas is the thing being edited — an agent, the tools it can call,
 * the MCP servers it connects to, the sub-agents it delegates to — and the
 * right rail shows the selected node's fields, the generated code, and the
 * run. Everything happens against the local `graphmind serve` that served
 * this page; nothing leaves the machine.
 *
 * The code is the server's own generator (POST /api/builder/preview,
 * debounced), so what is shown is byte-for-byte what Create writes and what
 * the snippet gives you if you copy it somewhere else.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { isExportedRun } from '../connection/FixtureConnection.js';
import { useUiStore } from '../store/uiStore.js';
import { IconClose } from '../components/Icons.js';
import { BuilderApiError, fetchTargets, previewProject } from './api.js';
import { useBuilderStore } from './builderStore.js';
import { BuilderCanvas } from './BuilderCanvas.js';
import { CodePanel } from './CodePanel.js';
import { Inspector } from './Inspector.js';
import { ROOT_ID, attributeIssues, compile, issuesByNode, localIssues, ownerOf, targetMeta, type NodeKind } from './graph.js';
import { RunPanel } from './RunPanel.js';
import { BlockedNotice, type Blocked } from './BlockedNotice.js';
import type { PreviewResponse, SpecIssue } from './types.js';

const PREVIEW_DEBOUNCE_MS = 350;

type Tab = 'node' | 'code' | 'run';

/** The palette: one button per node kind you can add. */
const ADDABLE: Exclude<NodeKind, 'agent'>[] = ['tool', 'mcp', 'subagent'];
const ADD_LABEL: Record<Exclude<NodeKind, 'agent'>, string> = {
  tool: '+ Tool',
  mcp: '+ MCP server',
  subagent: '+ Sub-agent',
};

export function BuilderPage() {
  const graph = useBuilderStore((s) => s.graph);
  const selectedId = useBuilderStore((s) => s.selectedId);
  const addNode = useBuilderStore((s) => s.addNode);
  const reset = useBuilderStore((s) => s.reset);
  const connection = useUiStore((s) => s.connection);
  const [tab, setTab] = useState<Tab>('node');
  const [workflowsDir, setWorkflowsDir] = useState<string | undefined>(undefined);
  const [pythonNote, setPythonNote] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<PreviewResponse | undefined>(undefined);
  const [serverIssues, setServerIssues] = useState<SpecIssue[]>([]);
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const recorded = isExportedRun();
  const offline = connection === 'off' || connection === 'detached';
  // Why the page cannot act, if it cannot. No credential is involved: the
  // builder needs a server to generate against, and nothing else.
  const blocked: Blocked | undefined = recorded
    ? { kind: 'recorded', text: 'This page is an exported run; there is no server to build with.' }
    : offline
      ? { kind: 'offline', text: 'No debugger server is attached, so nothing here can be generated, created or run.' }
      : undefined;
  const blockedNote = blocked?.text;
  const canAct = blocked === undefined;

  // Where projects go, from the server.
  useEffect(() => {
    if (!canAct) return;
    let cancelled = false;
    fetchTargets()
      .then((result) => {
        if (cancelled) return;
        setWorkflowsDir(result.workflowsDir);
        setPythonNote(
          result.python === null
            ? 'No Python 3.10+ found on this machine: a Python project can be created and copied, but Run needs uv (https://docs.astral.sh/uv/) or GRAPHMIND_PYTHON set to a 3.10+ interpreter. The system Python is never touched.'
            : `Python projects run with ${result.python.describe}.`,
        );
      })
      .catch(() => {
        // the placeholder in the directory field is enough
      });
    return () => {
      cancelled = true;
    };
  }, [canAct]);

  const { spec, nodeByPath } = useMemo(() => compile(graph), [graph]);
  const local = useMemo(() => localIssues(graph), [graph]);

  // Debounced preview from the server's generator.
  useEffect(() => {
    if (!canAct) {
      setPending(false);
      return;
    }
    if (local.length > 0) {
      // Not worth a round trip; keep the last good code on screen.
      setServerIssues([]);
      setPending(false);
      return;
    }
    setPending(true);
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      previewProject(spec, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setPreview(result);
          setServerIssues([]);
          setPreviewError(undefined);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof BuilderApiError) {
            if (error.issues.length > 0) {
              setServerIssues(error.issues);
              setPreviewError(undefined);
            } else {
              setPreviewError(error.message);
            }
          } else {
            setPreviewError(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [spec, local.length, canAct]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const issues = useMemo(
    () => [...local, ...attributeIssues(serverIssues, nodeByPath)],
    [local, serverIssues, nodeByPath],
  );
  const problems = useMemo(() => issuesByNode(issues), [issues]);
  const target = targetMeta(graph.target);
  // Project-wide messages have no node to sit on; they go above the canvas.
  const loose = issues.filter((issue) => issue.nodeId === undefined);

  /**
   * Add a node wired to the agent the selection belongs to (graph.ts
   * `ownerOf`), in that agent's column, below what it already owns — so it
   * lands where its edge can be seen, and adding three tools to a sub-agent
   * is three clicks, not three clicks and three re-selections.
   */
  const add = (kind: Exclude<NodeKind, 'agent'>) => {
    const parentId = ownerOf(graph, selectedId);
    const parent = graph.nodes.find((node) => node.id === parentId) ?? graph.nodes.find((node) => node.id === ROOT_ID);
    const owned = graph.edges.filter((edge) => edge.from === parentId);
    const column = (parent?.x ?? 0) + 340;
    const lowestInColumn = graph.nodes
      .filter((node) => Math.abs(node.x - column) < 40)
      .reduce((max, node) => Math.max(max, node.y), Number.NEGATIVE_INFINITY);
    const y = Number.isFinite(lowestInColumn) ? lowestInColumn + 130 : (parent?.y ?? 0) + owned.length * 130;
    addNode(kind, { x: column, y }, parentId);
    setTab('node');
  };

  return (
    <div className="gm-builder">
      <header className="gm-topbar gm-builder-bar">
        <div className="gm-topbar-title">
          <span className="gm-pill gm-pill--idle">build</span>
          <h1>Workflow</h1>
          <span className="gm-builder-sub">
            {target.language === 'typescript' ? 'TypeScript' : 'Python'} · {target.framework} · {graph.provider}
          </span>
        </div>
        <div className="gm-topbar-actions">
          <button className="gm-toolbtn" onClick={() => reset()} title="Back to the starter graph">
            <span className="gm-toolbtn-label">Reset</span>
          </button>
          <a className="gm-toolbtn" href={target.docs} target="_blank" rel="noreferrer" title="The adapter's documentation">
            <span className="gm-toolbtn-label">Docs</span>
          </a>
          <button
            className="gm-iconbtn"
            onClick={() => useUiStore.getState().setPage('runs')}
            title="Back to the debugger"
            aria-label="Close the builder"
          >
            <IconClose />
          </button>
        </div>
      </header>

      {blocked !== undefined && (
        <div className="gm-builder-blocked">
          <BlockedNotice blocked={blocked} />
        </div>
      )}

      <div className="gm-builder-body">
        <main className="gm-builder-stage">
          <div className="gm-bpalette" role="toolbar" aria-label="Add a node">
            {ADDABLE.map((kind) => (
              <button key={kind} type="button" className={`gm-bpalette-btn gm-bpalette-btn--${kind}`} onClick={() => add(kind)}>
                {ADD_LABEL[kind]}
              </button>
            ))}
            <span className="gm-bpalette-hint">Drag from a card's right edge to wire it to another.</span>
          </div>
          {loose.length > 0 && (
            <div className="gm-bloose" role="status">
              {loose.map((issue) => `${issue.path}: ${issue.message}`).join(' · ')}
            </div>
          )}
          <BuilderCanvas problems={problems} />
        </main>

        <aside className="gm-builder-rail">
          <div className="gm-brail-tabs gm-bcode-tabs" role="tablist" aria-label="Builder panels">
            {(['node', 'code', 'run'] as Tab[]).map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={`gm-bcode-tab${tab === id ? ' gm-bcode-tab--on' : ''}`}
                onClick={() => setTab(id)}
              >
                {id === 'node' ? 'Node' : id === 'code' ? 'Code' : 'Run'}
              </button>
            ))}
          </div>
          <div className="gm-builder-railbody">
            {tab === 'node' && <Inspector issues={issues} canAct={canAct} blocked={blocked} />}
            {tab === 'code' && <CodePanel preview={preview} pending={pending} error={previewError} />}
            {tab === 'run' && (
              <RunPanel
                spec={spec}
                preview={preview}
                workflowsDir={workflowsDir}
                canAct={canAct}
                blocked={blocked}
                blockedNote={blockedNote}
                toolchainNote={target.language === 'python' ? pythonNote : undefined}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
