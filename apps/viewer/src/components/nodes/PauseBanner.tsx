/**
 * The held-gate banner rendered inside a paused node.
 *
 * In an exported run (`graphmind record --html`) the same `exec.paused`
 * event is a historical fact, not a live hold: nothing is executing and no
 * control can reach anything. There the banner degrades to a past-tense
 * marker — offering Continue/Abort buttons that silently do nothing would
 * be worse than offering none. That distinction lives in `PauseActions`.
 */
import { useRunStore } from '../../store/runStore.js';
import type { NodeState, Pause } from '../../store/types.js';
import { PauseActions } from './PauseActions.js';

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
  return (
    <div className="gm-pause-banner nodrag" onClick={(e) => e.stopPropagation()}>
      <PauseActions runId={runId} node={node} pause={pause} variant="card" autoFocus />
    </div>
  );
}
