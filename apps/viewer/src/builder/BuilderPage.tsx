/**
 * The Build page: describe an agent on the left, see the graph it will
 * make and the code it becomes on the right, then write it to disk and run
 * it from here. Everything happens against the local `graphmind serve`
 * that served this page; nothing leaves the machine.
 *
 * The code preview is the server's own generator (POST /api/builder/preview,
 * debounced), so what is shown is byte-for-byte what Create writes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { onViewerTokenChange, viewerToken } from '../connection/auth.js';
import { isExportedRun } from '../connection/FixtureConnection.js';
import { useUiStore } from '../store/uiStore.js';
import { IconClose } from '../components/Icons.js';
import { BuilderApiError, fetchTargets, previewProject } from './api.js';
import { useBuilderStore } from './builderStore.js';
import { CodePanel } from './CodePanel.js';
import { localIssues, targetMeta } from './model.js';
import { RunPanel } from './RunPanel.js';
import { SpecForm } from './SpecForm.js';
import type { PreviewResponse, SpecIssue } from './types.js';
import { WorkflowPreview } from './WorkflowPreview.js';

const PREVIEW_DEBOUNCE_MS = 350;

export function BuilderPage() {
  const spec = useBuilderStore((s) => s.spec);
  const reset = useBuilderStore((s) => s.reset);
  const connection = useUiStore((s) => s.connection);
  const [token, setToken] = useState(() => viewerToken());
  const [workflowsDir, setWorkflowsDir] = useState<string | undefined>(undefined);
  const [pythonNote, setPythonNote] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<PreviewResponse | undefined>(undefined);
  const [serverIssues, setServerIssues] = useState<SpecIssue[]>([]);
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => onViewerTokenChange(setToken), []);

  const recorded = isExportedRun();
  const offline = connection === 'off' || connection === 'detached';
  const blockedNote = recorded
    ? 'This page is an exported run; there is no server to build with.'
    : offline
      ? 'No debugger server: start `npx graphmind-ai` and this page connects on its own.'
      : token === undefined
        ? 'This tab has no viewer token. Open the viewer from the link `graphmind serve` printed (or its redirect file) to create and run projects.'
        : undefined;
  const canAct = blockedNote === undefined;

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

  const local = useMemo(() => localIssues(spec), [spec]);

  // Debounced preview from the server's generator.
  useEffect(() => {
    if (!canAct) {
      setPending(false);
      return;
    }
    if (local.length > 0) {
      // Not worth a round trip; keep the last good preview on screen.
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
              setPreviewError(error.unauthorized ? 'The server refused this tab (no viewer token).' : error.message);
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

  const issues = useMemo(() => [...local, ...serverIssues], [local, serverIssues]);
  const target = targetMeta(spec.target);

  return (
    <div className="gm-builder">
      <header className="gm-topbar gm-builder-bar">
        <div className="gm-topbar-title">
          <span className="gm-pill gm-pill--idle">build</span>
          <h1>New workflow</h1>
          <span className="gm-builder-sub">
            {target.language === 'typescript' ? 'TypeScript' : 'Python'} · {target.framework} · {spec.provider}
          </span>
        </div>
        <div className="gm-topbar-actions">
          <button className="gm-toolbtn" onClick={() => reset()} title="Back to the starter spec">
            <span className="gm-toolbtn-label">Reset</span>
          </button>
          <a className="gm-toolbtn" href={target.docs} target="_blank" rel="noreferrer" title="The adapter's documentation">
            <span className="gm-toolbtn-label">Docs</span>
          </a>
          <button
            className="gm-iconbtn"
            onClick={() => useUiStore.getState().setPage('debug')}
            title="Back to the debugger"
            aria-label="Close the builder"
          >
            <IconClose />
          </button>
        </div>
      </header>

      {blockedNote !== undefined && (
        <div className="gm-builder-blocked" role="status">
          {blockedNote}
          {!recorded && !offline && (
            <>
              {' '}
              The form and the diagram still work; the code preview, Create and Run need the token.
            </>
          )}
        </div>
      )}

      <div className="gm-builder-body">
        <aside className="gm-builder-form">
          <SpecForm issues={issues} />
        </aside>
        <main className="gm-builder-main">
          <section className="gm-builder-preview" aria-label="Workflow shape">
            <div className="gm-section-label">The run this makes</div>
            <WorkflowPreview spec={spec} />
            <div className="gm-builder-preview-note">
              One node per code location; executions light it up when the project runs. Errors pause before your code sees them.
            </div>
          </section>
          <CodePanel preview={preview} pending={pending} error={previewError} />
          <RunPanel
            preview={preview}
            workflowsDir={workflowsDir}
            canAct={canAct}
            blockedNote={blockedNote}
            toolchainNote={target.language === 'python' ? pythonNote : undefined}
          />
        </main>
      </div>
    </div>
  );
}
