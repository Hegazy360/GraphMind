/**
 * A run is held. That outranks wherever you happen to be standing.
 *
 * With the viewer split into places, a hold is the one piece of state that
 * cannot wait for you to navigate to it: a process somewhere is stopped mid
 * call, and nothing else on screen matters as much. So it is a band directly
 * under the header, on every place, saying which call and why, with the way
 * to it one click away.
 *
 * On the node place for that very call it steps aside — the decision row is
 * already inline there, with the error and the input beside it, and two
 * copies of Continue on one screen is how you click the wrong one.
 */
import { heldGate } from '../lib/gate.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { executionError } from '../store/types.js';
import { IconArrowRight, IconPause } from './Icons.js';

export function HoldStrip() {
  const runId = useUiStore((s) => s.selectedRunId);
  const selectedNodeId = useUiStore((s) => s.selectedNodeId);
  const page = useUiStore((s) => s.page);
  // Re-read on every status change: a gate opening or closing bumps it.
  const statusVersion = useRunStore((s) => (runId === undefined ? 0 : s.runs[runId]?.statusVersion ?? 0));

  if (runId === undefined) return null;
  void statusVersion;

  const pause = heldGate(runId);
  if (pause === undefined) return null;

  const run = useRunStore.getState().runs[runId];
  const node = run?.nodes[pause.nodeId];
  if (run === undefined || node === undefined) return null;

  // Already looking at it: the inline decision row owns the screen. Being
  // *on* the call is the test, not merely having it selected — the
  // selection survives stepping back up to the graph, and a held run with
  // no way back into it is the one state this band exists to prevent.
  if (page === 'node' && selectedNodeId === pause.nodeId) return null;

  const exec = node.executions[node.executions.length - 1];
  const error = exec === undefined ? undefined : executionError(run, node, exec);
  const why =
    error !== undefined
      ? `${error.name}: ${error.message}`
      : pause.reason === 'loop'
        ? 'the same call is repeating with identical arguments'
        : pause.reason === 'breakpoint'
          ? 'a breakpoint matched'
          : pause.point === 'before'
            ? 'held before it runs'
            : 'held after it ran';

  return (
    <div className="gm-holdstrip" role="status" aria-label="A call is held">
      <IconPause width={13} height={13} />
      <span className="gm-holdstrip-what">
        Held at <strong>{node.name}</strong>
      </span>
      <span className="gm-holdstrip-why" title={why}>
        {why}
      </span>
      <button
        className="gm-action gm-action--primary gm-holdstrip-go"
        onClick={() => {
          const ui = useUiStore.getState();
          ui.selectNode(runId, pause.nodeId);
        }}
      >
        Open the held call
        <IconArrowRight width={13} height={13} />
      </button>
    </div>
  );
}
