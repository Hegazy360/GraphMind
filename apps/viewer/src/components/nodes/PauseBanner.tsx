/**
 * The resume-action bar rendered inside a paused node: Continue / Step /
 * Retry / Inject / Abort. Inject opens a small JSON editor prefilled from
 * the paused call's output (or input, as the shape hint).
 */
import { useMemo, useState } from 'react';
import { sendControl } from '../../connection/ServerConnection.js';
import { useRunStore } from '../../store/runStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { latestExecution, type NodeState, type Pause, type RunSource } from '../../store/types.js';

interface PauseBannerProps {
  runId: string;
  node: NodeState;
}

export function PauseBanner({ runId, node }: PauseBannerProps) {
  const pauseId = node.activePauseId;
  const pause = useRunStore((s) =>
    pauseId !== undefined ? s.runs[runId]?.pauses[pauseId] : undefined,
  );
  if (pause === undefined || !pause.active) return null;
  return <PauseBannerInner runId={runId} node={node} pause={pause} />;
}

function PauseBannerInner({ runId, node, pause }: PauseBannerProps & { pause: Pause }) {
  const source: RunSource = useRunStore((s) => s.runs[runId]?.meta.source ?? 'live');
  const setMode = useUiStore((s) => s.setMode);
  const [injecting, setInjecting] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);

  const exec = latestExecution(node);
  const error = exec?.error ?? node.lastError;

  const prefill = useMemo(() => {
    const shape = exec?.output !== undefined && exec.output !== null ? exec.output : exec?.input;
    try {
      return JSON.stringify(shape ?? {}, null, 2);
    } catch {
      return '{}';
    }
  }, [exec]);

  const resume = (action: 'continue' | 'retry' | 'abort') => {
    sendControl(source, 'exec.resume', { pauseId: pause.pauseId, action }, runId);
  };

  const step = () => {
    setMode('step');
    sendControl(source, 'mode.set', { mode: 'step' });
    sendControl(source, 'exec.resume', { pauseId: pause.pauseId, action: 'continue' }, runId);
  };

  const openInject = () => {
    setDraft(prefill);
    setInvalid(false);
    setInjecting(true);
  };

  const applyInject = () => {
    let output: unknown;
    try {
      output = JSON.parse(draft);
    } catch {
      setInvalid(true);
      return;
    }
    sendControl(source, 'exec.resume', { pauseId: pause.pauseId, action: 'inject', output }, runId);
    setInjecting(false);
  };

  const pointLabel =
    pause.point === 'error' ? 'Paused on error' : pause.point === 'before' ? 'Paused before call' : 'Paused after call';

  return (
    <div className="gm-pause-banner nodrag" onClick={(e) => e.stopPropagation()}>
      <div
        className="gm-pause-label"
        title="Held by the debugger. Note: user-configured totalMs/stepMs/chunkMs timeouts can still abort a run during a long hold (per-tool toolMs is neutralized)."
      >
        <span className="gm-dot gm-dot--paused" />
        {pointLabel}
      </div>
      {pause.point === 'error' && error !== undefined && (
        <div className="gm-pause-error" title={`${error.name}: ${error.message}`}>
          {error.name}: {error.message}
        </div>
      )}
      <div className="gm-actions" style={{ marginBottom: 5 }}>
        <button className="gm-action gm-action--primary" onClick={() => resume('continue')}>
          Continue
        </button>
        <button className="gm-action" onClick={step}>
          Step
        </button>
        <button className="gm-action" onClick={() => resume('retry')}>
          Retry
        </button>
      </div>
      <div className="gm-actions">
        <button className="gm-action" onClick={openInject}>
          Inject…
        </button>
        <button className="gm-action gm-action--danger" onClick={() => resume('abort')}>
          Abort
        </button>
      </div>

      {injecting && (
        <div className="gm-inject nowheel" onClick={(e) => e.stopPropagation()}>
          <div className="gm-section-label" style={{ marginBottom: 6 }}>
            Inject output for {node.name}
          </div>
          <textarea
            className={invalid ? 'gm-invalid' : ''}
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="gm-actions" style={{ marginTop: 8 }}>
            <button className="gm-action gm-action--primary" onClick={applyInject}>
              {invalid ? 'Invalid JSON' : 'Inject & resume'}
            </button>
            <button className="gm-action" onClick={() => setInjecting(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
