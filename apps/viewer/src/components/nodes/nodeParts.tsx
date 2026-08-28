/**
 * Shared building blocks for the node cards.
 */
import { useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { hasChildren } from '../../store/derived.js';
import { useRunStore } from '../../store/runStore.js';
import { collapsedFor, useUiStore, type LodLevel } from '../../store/uiStore.js';
import { nodeStatus, type NodeLifeStatus, type NodeState } from '../../store/types.js';

/** Select one node's state; re-renders only that card. */
export function useNodeState(runId: string, nodeId: string): NodeState | undefined {
  return useRunStore((s) => s.runs[runId]?.nodes[nodeId]);
}

export function useIsSelected(runId: string, nodeId: string): boolean {
  return useUiStore((s) => s.selectedRunId === runId && s.selectedNodeId === nodeId);
}

/**
 * Current level of detail. Quantized (three steps), so crossing a threshold
 * re-renders the cards once instead of on every zoom frame.
 */
export function useLod(): LodLevel {
  return useUiStore((s) => s.lod);
}

/** How long a state-change flourish stays on a card. */
const FLASH_MS = 620;

/**
 * A one-shot class marking the *moment* a card changed state.
 *
 * The steady-state classes (`gm-node--ok`, `--error`, `--paused`) say what a
 * node is; on a canvas with thirty settled cards they say nothing about what
 * just happened. Watching a run is watching transitions, so each one gets a
 * single short cue — a green ring collapsing inward as a call succeeds, a red
 * one snapping shut when it throws, an amber one opening when a gate holds —
 * and then the card goes quiet. Nothing loops except the two states that
 * genuinely are ongoing (running, held).
 *
 * Costs one timer per transition per card, which is bounded by the event rate
 * and not by the graph size; a node that never changes never schedules one.
 */
export function useStatusFlash(status: NodeLifeStatus): string {
  const previous = useRef<NodeLifeStatus | undefined>(undefined);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    const from = previous.current;
    previous.current = status;
    // First paint is an arrival, not a transition — the card's entrance
    // animation is already carrying that.
    if (from === undefined || from === status) return;
    const next =
      status === 'ok'
        ? 'gm-node--settled'
        : status === 'error'
          ? 'gm-node--struck'
          : status === 'paused'
            ? 'gm-node--held'
            : '';
    if (next === '') {
      setFlash('');
      return;
    }
    setFlash(next);
    const timer = setTimeout(() => setFlash(''), FLASH_MS);
    return () => clearTimeout(timer);
  }, [status]);

  return flash;
}

export function statusClass(status: NodeLifeStatus, selected: boolean, flash = ''): string {
  const classes = ['gm-node', `gm-node--${status}`];
  if (selected) classes.push('gm-node--selected');
  if (flash !== '') classes.push(flash);
  return classes.join(' ');
}

export function StatusDot({ status }: { status: NodeLifeStatus }) {
  const variant =
    status === 'running' || status === 'paused' || status === 'error'
      ? status
      : status === 'ok'
        ? 'ok'
        : 'idle';
  return <span className={`gm-dot gm-dot--${variant}`} aria-hidden />;
}

export function StatusPill({ status }: { status: NodeLifeStatus }) {
  const variant =
    status === 'ghost' ? 'idle' : status === 'aborted' ? 'idle' : status;
  const label = status === 'ghost' ? 'idle' : status === 'ok' ? 'done' : status;
  return <span className={`gm-pill gm-pill--${variant}`}>{label}</span>;
}

export function InstanceBadge({ node }: { node: NodeState }) {
  if (node.executions.length <= 1) return null;
  return <span className="gm-badge-count" title={`${node.executions.length} executions`}>×{node.executions.length}</span>;
}

/**
 * Fold/unfold a node's subtree. Only rendered for nodes that actually own
 * children — the store's child index is cheap to consult per card.
 */
export function CollapseToggle({ runId, nodeId }: { runId: string; nodeId: string }) {
  // O(1) per store notification — see store/derived.ts for why that matters.
  const foldable = useRunStore((s) => {
    const run = s.runs[runId];
    return run !== undefined && hasChildren(run, nodeId);
  });
  const collapsed = useUiStore((s) => collapsedFor(s, runId).includes(nodeId));
  if (!foldable) return null;
  return (
    <button
      className={`gm-fold nodrag${collapsed ? ' gm-fold--on' : ''}`}
      title={collapsed ? 'Expand this group' : 'Collapse this group'}
      aria-label={collapsed ? `Expand ${nodeId}` : `Collapse ${nodeId}`}
      aria-expanded={!collapsed}
      onClick={(e) => {
        e.stopPropagation();
        useUiStore.getState().toggleCollapse(runId, nodeId);
      }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="m6 9 6 6 6-6" />}
      </svg>
    </button>
  );
}

/** Invisible flow handles — edges dock to node borders. */
export function FlowHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}

export { nodeStatus };
