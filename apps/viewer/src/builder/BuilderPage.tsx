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
import { useEffect, useMemo, useState } from 'react';
import { isExportedRun } from '../connection/FixtureConnection.js';
import { useUiStore } from '../store/uiStore.js';
import { IconClose, IconPlus } from '../components/Icons.js';
import { generateProject, platformOf } from '@workflow/codegen/index.js';
import { parseSpec } from '@workflow/spec.js';
import { fetchTargets } from './api.js';
import { useBuilderStore } from './builderStore.js';
import { BuilderCanvas } from './BuilderCanvas.js';
import { CodePanel } from './CodePanel.js';
import { Inspector } from './Inspector.js';
import { ROOT_ID, attributeIssues, compile, issuesByNode, localIssues, ownerOf, targetMeta, type NodeKind } from './graph.js';
import { RunPanel } from './RunPanel.js';
import { BlockedNotice, type Blocked } from './BlockedNotice.js';
import type { PreviewResponse, SpecIssue } from './types.js';

type Tab = 'node' | 'code' | 'run';

/** The palette: one button per node kind you can add. */
const ADDABLE: Exclude<NodeKind, 'agent'>[] = ['tool', 'mcp', 'subagent'];
const ADD_LABEL: Record<Exclude<NodeKind, 'agent'>, string> = {
  tool: 'Tool',
  mcp: 'MCP server',
  subagent: 'Sub-agent',
};
const ADD_HINT: Record<Exclude<NodeKind, 'agent'>, string> = {
  tool: 'A function the model can call — starts as a stub you replace',
  mcp: 'An MCP server to connect to; its tools join the agent',
  subagent: 'A nested agent the root can delegate a task to',
};

/** The rail's three panels, in the order the work happens. */
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'node', label: 'Node', hint: 'The selected card\'s fields' },
  { id: 'code', label: 'Code', hint: 'The project this canvas becomes' },
  { id: 'run', label: 'Run', hint: 'Write it to disk and run it here' },
];

export function BuilderPage() {
  const graph = useBuilderStore((s) => s.graph);
  const selectedId = useBuilderStore((s) => s.selectedId);
  const addNode = useBuilderStore((s) => s.addNode);
  const reset = useBuilderStore((s) => s.reset);
  const jobPhase = useBuilderStore((s) => s.job?.phase);
  const connection = useUiStore((s) => s.connection);
  const [tab, setTab] = useState<Tab>('node');
  const [workflowsDir, setWorkflowsDir] = useState<string | undefined>(undefined);
  const [pythonNote, setPythonNote] = useState<string | undefined>(undefined);

  const recorded = isExportedRun();
  const offline = connection === 'off' || connection === 'detached';
  // Why the page cannot act, if it cannot. No credential is involved: the
  // builder needs a server to generate against, and nothing else.
  const blocked: Blocked | undefined = recorded
    ? {
        kind: 'recorded',
        text: 'This page is an exported run. Draw and read the code freely; writing it to disk and running it need a server.',
      }
    : offline
      ? {
          kind: 'offline',
          text: 'No debugger server is attached. The canvas and the code work anyway — Create, Run and Test connection are what need one.',
        }
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

  /**
   * The project this canvas becomes — generated here, in the browser.
   *
   * It is the same generator the server runs for Create (aliased straight
   * from the CLI's source), so the code on screen is byte for byte what
   * Create writes. Running it locally is what makes the page useful with no
   * server attached at all: draw a workflow, read the code, copy it. Create,
   * Run and Test connection reach for the server, because writing files,
   * spawning processes and opening a stdio MCP server are things a browser
   * cannot do.
   */
  const { preview, specIssues } = useMemo((): {
    preview: PreviewResponse | undefined;
    specIssues: SpecIssue[];
  } => {
    if (local.length > 0) return { preview: undefined, specIssues: [] };
    const parsed = parseSpec(spec);
    if (!parsed.ok) return { preview: undefined, specIssues: parsed.issues };
    const project = generateProject(parsed.spec, platformOf());
    return {
      preview: {
        spec: parsed.spec,
        target: project.target,
        source: project.source,
        files: project.files,
        install: project.install.map((command) => command.label),
        start: project.start.label,
        envKeys: project.envKeys,
      },
      specIssues: [],
    };
  }, [spec, local.length]);

  const issues = useMemo(
    () => [...local, ...attributeIssues(specIssues, nodeByPath)],
    [local, specIssues, nodeByPath],
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

  const jobTone =
    jobPhase === undefined
      ? undefined
      : jobPhase === 'running' || jobPhase === 'installing'
        ? 'running'
        : jobPhase === 'exited'
          ? 'ok'
          : jobPhase === 'stopped'
            ? 'idle'
            : 'error';

  return (
    <div className="gm-builder">
      {/* The bar names the thing being built, not the page: the crumb
          already says "Build a workflow", and what you want to see at a
          glance while you edit is the project and its target. */}
      <header className="gm-topbar gm-builder-bar">
        <div className="gm-topbar-title">
          <span className="gm-pill gm-pill--idle">build</span>
          <h1 title="The project name — edit it on the agent card">{graph.name || 'workflow'}</h1>
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

      {/* One quiet line, not a banner: the canvas and the code work with
          nothing attached, so this is a note about two buttons on the Run
          tab — which repeat it where they are — not a warning about the
          page. */}
      {blocked !== undefined && (
        <div className="gm-builder-blocked" role="status">
          <span className="gm-conn gm-conn--detached" aria-hidden="true" />
          <span className="gm-builder-blocked-text">{blocked.text}</span>
          {blocked.kind === 'offline' && (
            <span className="gm-builder-blocked-how">
              Start it: <code>npx graphmind-ai</code> — this page connects on its own.
            </span>
          )}
        </div>
      )}

      <div className="gm-builder-body">
        <main className="gm-builder-stage">
          <div className="gm-bpalette" role="toolbar" aria-label="Add a node">
            <span className="gm-bpalette-label">
              <IconPlus width={12} height={12} />
              Add
            </span>
            {ADDABLE.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`gm-bpalette-btn gm-bpalette-btn--${kind}`}
                title={ADD_HINT[kind]}
                aria-label={`+ ${ADD_LABEL[kind]}`}
                onClick={() => add(kind)}
              >
                <span className="gm-bpalette-dot" aria-hidden="true" />
                {ADD_LABEL[kind]}
              </button>
            ))}
            <span className="gm-bpalette-hint">
              Each one arrives wired to the selected agent. Drag from a card's right edge to wire it elsewhere.
            </span>
          </div>
          {loose.length > 0 && (
            <div className="gm-bloose" role="status">
              {loose.map((issue) => `${issue.path}: ${issue.message}`).join(' · ')}
            </div>
          )}
          <BuilderCanvas problems={problems} />
        </main>

        <aside className="gm-builder-rail">
          {/* Three panels in the order the work happens, each carrying the
              one fact worth knowing before you open it: how many cards have
              a problem, how many files the code is, how the run is going. */}
          <div className="gm-brail-tabs" role="tablist" aria-label="Builder panels">
            {TABS.map(({ id, label, hint }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                aria-label={label}
                title={hint}
                className={`gm-brail-tab${tab === id ? ' gm-brail-tab--on' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
                {id === 'node' && issues.length > 0 && (
                  <span className="gm-brail-badge gm-brail-badge--err">{issues.length}</span>
                )}
                {id === 'code' && preview !== undefined && (
                  <span className="gm-brail-badge">{preview.files.length}</span>
                )}
                {id === 'run' && jobTone !== undefined && (
                  <span className={`gm-dot gm-dot--${jobTone === 'idle' ? '' : jobTone}`} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          <div className="gm-builder-railbody">
            {tab === 'node' && <Inspector issues={issues} canAct={canAct} blocked={blocked} />}
            {tab === 'code' && <CodePanel preview={preview} />}
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
