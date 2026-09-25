/**
 * The held-gate banner rendered inside a paused node.
 *
 * In an exported run (`graphmind record --html`) the same `exec.paused`
 * event is a historical fact, not a live hold: nothing is executing and no
 * control can reach anything. There the banner degrades to a past-tense
 * marker — offering Continue/Abort buttons that silently do nothing would
 * be worse than offering none. That distinction lives in `PauseActions`.
 *
 * Parallel calls of one tool can hold at once. The card has room for one
 * row: it shows the pause the keyboard acts on (`shownPause` — the
 * execution picked in the inspector, else the newest hold) and counts the
 * others; the inspector's footer lists every one.
 */
import { shownPause } from '../../lib/gate.js';
import { useRunStore } from '../../store/runStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { activePausesOf, type NodeState, type Pause } from '../../store/types.js';
import { PauseActions } from './PauseActions.js';

interface PauseBannerProps {
  runId: string;
  node: NodeState;
}

export function PauseBanner({ runId, node }: PauseBannerProps) {
  const instanceIdx = useUiStore((s) =>
    s.selectedRunId === runId && s.selectedNodeId === node.nodeId ? s.selectedInstanceIdx : undefined,
  );
  const pause = useRunStore((s) => shownPause(s.runs[runId], node.nodeId, instanceIdx));
  const heldCount = useRunStore((s) => {
    const run = s.runs[runId];
    // No `activePauseId` means nothing holds the node: skip the scan.
    if (run === undefined || run.nodes[node.nodeId]?.activePauseId === undefined) return 0;
    return activePausesOf(run, node.nodeId).length;
  });
  if (pause === undefined || !pause.active) return null;
  return <PauseBannerInner runId={runId} node={node} pause={pause} moreHeld={heldCount - 1} />;
}

function PauseBannerInner({ runId, node, pause, moreHeld }: PauseBannerProps & { pause: Pause; moreHeld: number }) {
  return (
    <div className="gm-pause-banner nodrag" onClick={(e) => e.stopPropagation()}>
      <PauseActions runId={runId} node={node} pause={pause} variant="card" autoFocus moreHeld={moreHeld} />
    </div>
  );
}
