/**
 * Create the project on disk and run it from here.
 *
 * The key field is `type="password"`, lives in this component's state for
 * the length of one request, is sent once (to loopback, with the viewer
 * token), and is cleared the moment the server answers. The server writes
 * it to the project's `.env` (owner-only) and only ever reports the NAME
 * back; the job log is scrubbed before it is stored. Nothing on this page
 * can display a key after it has been typed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { BuilderApiError, createProject, pollJob, startJob, stopJob, writeEnv } from './api.js';
import { useBuilderStore } from './builderStore.js';
import { isJobRun } from './model.js';
import type { EnvKey, PreviewResponse } from './types.js';

const POLL_MS = 600;

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'installing':
      return 'installing';
    case 'running':
      return 'running';
    case 'exited':
      return 'finished';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return phase;
  }
}

export function RunPanel({
  preview,
  workflowsDir,
  canAct,
  blockedNote,
  toolchainNote,
}: {
  preview: PreviewResponse | undefined;
  workflowsDir: string | undefined;
  canAct: boolean;
  /** Why Create/Run are disabled, when they are. */
  blockedNote: string | undefined;
  /** Which interpreter a Python project will run with, or why it cannot. */
  toolchainNote?: string | undefined;
}) {
  const spec = useBuilderStore((s) => s.spec);
  const created = useBuilderStore((s) => s.created);
  const job = useBuilderStore((s) => s.job);
  const lines = useBuilderStore((s) => s.lines);
  const setCreated = useBuilderStore((s) => s.setCreated);
  const setJob = useBuilderStore((s) => s.setJob);
  const appendLines = useBuilderStore((s) => s.appendLines);
  const resetJob = useBuilderStore((s) => s.resetJob);

  const [dir, setDir] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'create' | 'env' | 'start' | 'stop' | undefined>(undefined);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined);
  const logRef = useRef<HTMLDivElement>(null);

  const envKeys: EnvKey[] = preview?.envKeys ?? [];
  const requiredKeys = envKeys.filter((k) => k.required);
  // Created for THIS spec name? A rename after Create means a new project.
  const createdHere = created !== undefined && created.project.name === spec.name;
  const keysSet = createdHere ? created.project.envKeys : [];
  const missingKeys = requiredKeys.filter((k) => !keysSet.includes(k.name) && (secrets[k.name] ?? '') === '');
  const live = job !== undefined && (job.phase === 'installing' || job.phase === 'running');

  // The run this job produced, once it shows up over the live socket.
  const runId = useRunStore((s) => {
    if (job === undefined) return undefined;
    for (const run of Object.values(s.runs)) {
      if (isJobRun(run, job.name, job.startedAt)) return run.runId;
    }
    return undefined;
  });

  // Poll the job while it is live.
  useEffect(() => {
    if (job === undefined || !live) return;
    let cancelled = false;
    let after = (useBuilderStore.getState().lines.at(-1)?.i ?? -1) + 1;
    const tick = async () => {
      try {
        const result = await pollJob(job.id, after);
        if (cancelled) return;
        appendLines(result.lines);
        const last = result.lines.at(-1);
        if (last !== undefined) after = last.i + 1;
        setJob(result.job);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof BuilderApiError && error.status === 404) {
          setJob({ ...job, phase: 'failed', endedAt: Date.now() });
          setNotice({ tone: 'error', text: 'The server forgot this job (was it restarted?).' });
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job?.id, live, appendLines, setJob]);

  // Follow the log.
  useEffect(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const secretsToSend = useMemo(
    () => Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim() !== '')),
    [secrets],
  );

  const fail = (error: unknown) => {
    if (error instanceof BuilderApiError) {
      setNotice({
        tone: 'error',
        text: error.unauthorized
          ? 'This tab has no viewer token. Open the viewer from the link `graphmind serve` printed (or its redirect file).'
          : error.issues.length > 0
            ? `${error.message}: ${error.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`
            : error.message,
      });
    } else {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  };

  const create = async () => {
    setBusy('create');
    setNotice(undefined);
    try {
      const result = await createProject({
        spec,
        ...(dir.trim() === '' ? {} : { dir: dir.trim() }),
        ...(Object.keys(secretsToSend).length === 0 ? {} : { secrets: secretsToSend }),
        overwrite,
      });
      setSecrets({}); // the key has been written; it does not stay in memory here
      setCreated(result);
      resetJob();
      setNotice({
        tone: 'ok',
        text: `Wrote ${result.files.length} files to ${result.dir}${result.envWritten.length > 0 ? ` and set ${result.envWritten.join(', ')} in .env` : ''}.`,
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
    }
  };

  const saveEnv = async () => {
    if (!createdHere || created === undefined) return;
    setBusy('env');
    setNotice(undefined);
    try {
      const result = await writeEnv(created.dir, secretsToSend);
      setSecrets({});
      setCreated({ ...created, envWritten: result.keys, project: { ...created.project, envKeys: result.keys } });
      setNotice({ tone: 'ok', text: `.env now sets ${result.keys.join(', ') || 'nothing'}.` });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
    }
  };

  const start = async () => {
    if (!createdHere || created === undefined) return;
    setBusy('start');
    setNotice(undefined);
    try {
      resetJob();
      const result = await startJob(created.dir);
      setJob(result.job);
      // installing marks the project as installed for next time
      setCreated({ ...created, project: { ...created.project, installed: true } });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
    }
  };

  const stop = async () => {
    if (job === undefined) return;
    setBusy('stop');
    try {
      const result = await stopJob(job.id);
      setJob(result.job);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
    }
  };

  const openRun = () => {
    if (runId === undefined) return;
    const ui = useUiStore.getState();
    ui.selectRun(runId);
    ui.setPage('debug');
  };

  const disabledNote = blockedNote ?? (busy !== undefined ? 'Working…' : undefined);

  return (
    <section className="gm-brun" aria-label="Create and run">
      <div className="gm-section-label">Create the project</div>
      <label className="gm-bfield">
        <span className="gm-bfield-label">
          Directory <span className="gm-bfield-hint">absolute path; blank = the default</span>
        </span>
        <input
          className="gm-binput gm-binput--mono"
          value={dir}
          placeholder={workflowsDir !== undefined ? `${workflowsDir}/${spec.name}` : `~/.graphmind/workflows/${spec.name}`}
          spellCheck={false}
          onChange={(e) => setDir(e.target.value)}
        />
      </label>

      {envKeys.length > 0 && (
        <div className="gm-bsecrets">
          <div className="gm-bfield-label">
            Credentials <span className="gm-bfield-hint">written to .env (owner-only, git-ignored), never shown again</span>
          </div>
          {envKeys.map((key) => {
            const set = keysSet.includes(key.name);
            return (
              <label key={key.name} className="gm-bsecret" title={key.hint}>
                <span className="gm-bsecret-name">
                  {key.name}
                  {set ? <span className="gm-chip gm-chip--tiny gm-chip--on">set</span> : key.required ? <span className="gm-chip gm-chip--tiny">required</span> : null}
                </span>
                <input
                  className="gm-binput gm-binput--mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secrets[key.name] ?? ''}
                  placeholder={set ? '•••••••• (set; type to replace)' : key.required ? 'paste your key' : 'optional'}
                  aria-label={key.name}
                  onChange={(e) => setSecrets((s) => ({ ...s, [key.name]: e.target.value }))}
                />
              </label>
            );
          })}
        </div>
      )}

      <div className="gm-brun-actions">
        <label className="gm-bcheck" title="Rewrite the generated files if the directory already has them. Your .env and any file you added are left alone.">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          overwrite generated files
        </label>
        <button
          className="gm-action gm-action--primary"
          style={{ flex: 'none', padding: '7px 14px', fontSize: 12 }}
          onClick={() => void create()}
          disabled={!canAct || busy !== undefined || preview === undefined}
          title={disabledNote ?? (createdHere ? 'Write the files again (needs overwrite)' : 'Write the project to disk')}
        >
          {busy === 'create' ? 'Writing…' : createdHere ? 'Write again' : 'Create project'}
        </button>
        {createdHere && Object.keys(secretsToSend).length > 0 && (
          <button className="gm-action" style={{ flex: 'none' }} onClick={() => void saveEnv()} disabled={!canAct || busy !== undefined} title="Update .env without rewriting the code">
            {busy === 'env' ? 'Saving…' : 'Save credentials only'}
          </button>
        )}
      </div>

      <div className="gm-section-label" style={{ marginTop: 16 }}>
        Run it
      </div>
      {toolchainNote !== undefined && <div className="gm-brun-hint">{toolchainNote}</div>}
      <div className="gm-brun-actions">
        {live ? (
          <button className="gm-action gm-action--danger" style={{ flex: 'none', padding: '7px 14px', fontSize: 12 }} onClick={() => void stop()} disabled={busy !== undefined}>
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button
            className="gm-action gm-action--primary"
            style={{ flex: 'none', padding: '7px 14px', fontSize: 12 }}
            onClick={() => void start()}
            disabled={!canAct || !createdHere || busy !== undefined || missingKeys.length > 0}
            title={
              disabledNote ??
              (!createdHere
                ? 'Create the project first'
                : missingKeys.length > 0
                  ? `Set ${missingKeys.map((k) => k.name).join(', ')} first`
                  : created?.project.installed
                    ? 'Start the project; the run appears in the viewer'
                    : 'Install dependencies, then start; the run appears in the viewer')
            }
          >
            {busy === 'start' ? 'Starting…' : created?.project.installed || job !== undefined ? '▶ Run' : '▶ Install & run'}
          </button>
        )}
        {job !== undefined && (
          <span className={`gm-pill gm-pill--${job.phase === 'running' || job.phase === 'installing' ? 'running' : job.phase === 'exited' ? 'ok' : job.phase === 'stopped' ? 'idle' : 'error'}`}>
            {phaseLabel(job.phase)}
            {job.exitCode !== undefined && job.phase !== 'exited' ? ` · exit ${job.exitCode}` : ''}
          </span>
        )}
        {runId !== undefined && (
          <button className="gm-action" style={{ flex: 'none' }} onClick={openRun} title="Open this run in the debugger">
            Open the run →
          </button>
        )}
        {createdHere && !live && missingKeys.length > 0 && (
          <span className="gm-brun-hint">
            Set {missingKeys.map((k) => k.name).join(', ')} above and save it to run from here.
          </span>
        )}
      </div>

      {notice !== undefined && (
        <div className={`gm-bnotice gm-bnotice--${notice.tone}`} role="status">
          {notice.text}
        </div>
      )}

      {(job !== undefined || lines.length > 0) && (
        <div className="gm-blog" ref={logRef} aria-label="Process output" aria-live="polite">
          {lines.length === 0 ? (
            <div className="gm-blog-line gm-blog-line--sys">waiting for output…</div>
          ) : (
            lines.map((line) => (
              <div key={line.i} className={`gm-blog-line gm-blog-line--${line.stream}`}>
                {line.text}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
