/**
 * Step three: one call.
 *
 * This was a 392px panel docked beside the graph, which is a hard place to
 * read a stack trace or a 60-line tool result in. As a place it gets the
 * window: a reading column wide enough for real payloads, the decision row
 * pinned at the top where the evidence is rather than buried under a scroll,
 * and — the thing the panel never had — a way to move to the next call
 * without going back to the graph and hunting for it.
 */
import { useEffect, useMemo } from 'react';
import { kindMeta } from '../lib/kinds.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { nodeStatus } from '../store/types.js';
import { HeldDecision, NodeDetail } from '../components/InspectorPanel.js';
import { IconArrowRight, IconLink } from '../components/Icons.js';
import { KindGlyph } from '../components/KindMark.js';
import { StatusPill } from '../components/nodes/nodeParts.js';
import { copyText, deepLink } from '../lib/commands.js';

/**
 * The run's nodes in execution order, so `[` and `]` mean something. Only
 * nodes that actually ran: stepping onto a `graph.hint` ghost that says
 * "not executed yet" is not progress.
 */
function useNeighbours(runId: string, nodeId: string) {
  const order = useRunStore((s) => s.runs[runId]?.order.join(' ') ?? '');
  return useMemo(() => {
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return { prev: undefined, next: undefined, parent: undefined, index: 0, total: 0 };
    const ran = order.split(' ').filter((id) => {
      const node = run.nodes[id];
      return id !== '' && node !== undefined && node.executions.length > 0;
    });
    const at = ran.indexOf(nodeId);
    const parentId = run.nodes[nodeId]?.parentId;
    const parent = parentId === undefined ? undefined : run.nodes[parentId];
    return {
      prev: at > 0 ? run.nodes[ran[at - 1] as string] : undefined,
      next: at >= 0 && at < ran.length - 1 ? run.nodes[ran[at + 1] as string] : undefined,
      parent,
      index: at < 0 ? 0 : at + 1,
      total: ran.length,
    };
  }, [runId, nodeId, order]);
}

export function NodePage({ runId, nodeId }: { runId: string; nodeId: string }) {
  const node = useRunStore((s) => s.runs[runId]?.nodes[nodeId]);
  const showIdentity = useUiStore((s) => s.panels.identity);
  const neighbours = useNeighbours(runId, nodeId);

  // `[` and `]` walk the run in execution order. Bound here rather than in
  // the global handler because they only mean anything on this place, and
  // the held-gate keys (c/s/r/i/e) must keep their precedence.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const go = event.key === '[' ? neighbours.prev : event.key === ']' ? neighbours.next : undefined;
      if (go === undefined) return;
      event.preventDefault();
      useUiStore.getState().selectNode(runId, go.nodeId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runId, neighbours]);

  // A node reached by a stale deep link, or one dropped by a new run.
  if (node === undefined) {
    return (
      <section className="gm-nodepage" aria-label="Call detail">
        <div className="gm-nodepage-missing">
          <p>
            This run has no node called <code className="gm-mono">{nodeId}</code>.
          </p>
          <button
            className="gm-action gm-action--primary"
            onClick={() => useUiStore.getState().selectNode(runId, undefined)}
          >
            Back to the graph
          </button>
        </div>
      </section>
    );
  }

  const status = nodeStatus(node);

  return (
    <section className="gm-nodepage" aria-label="Call detail">
      <header className="gm-nodehead">
        <span className={`gm-kind-badge gm-kind--${node.kind}`} title={kindMeta(node.kind).hint}>
          <KindGlyph kind={node.kind} size={11} />
          {kindMeta(node.kind).label}
        </span>
        <h1 className="gm-nodehead-name">{node.name}</h1>
        <StatusPill status={status} />

        {showIdentity && (
          <span className="gm-inspect-id gm-nodehead-id">
            <span className="gm-mono" title={node.nodeId}>
              {node.nodeId}
            </span>
          </span>
        )}

        <div className="gm-nodehead-nav">
          <button
            className="gm-iconbtn"
            onClick={() => void copyText(deepLink(runId, nodeId))}
            title={`Copy a deep link to this node — ${node.nodeId}`}
            aria-label="Copy a deep link to this node"
          >
            <IconLink />
          </button>
          {neighbours.total > 1 && (
            <>
              <span className="gm-nodehead-pos">
                {neighbours.index} / {neighbours.total}
              </span>
              <button
                className="gm-iconbtn"
                disabled={neighbours.prev === undefined}
                onClick={() =>
                  neighbours.prev !== undefined &&
                  useUiStore.getState().selectNode(runId, neighbours.prev.nodeId)
                }
                title={
                  neighbours.prev === undefined
                    ? 'This is the first call'
                    : `Previous call: ${neighbours.prev.name} ([)`
                }
                aria-label="Previous call"
              >
                <IconArrowRight style={{ transform: 'rotate(180deg)' }} />
              </button>
              <button
                className="gm-iconbtn"
                disabled={neighbours.next === undefined}
                onClick={() =>
                  neighbours.next !== undefined &&
                  useUiStore.getState().selectNode(runId, neighbours.next.nodeId)
                }
                title={
                  neighbours.next === undefined
                    ? 'This is the last call'
                    : `Next call: ${neighbours.next.name} (])`
                }
                aria-label="Next call"
              >
                <IconArrowRight />
              </button>
            </>
          )}
        </div>
      </header>

      {/* Held: the decision sits above the evidence, where it cannot be
          scrolled away from, and is the first thing on the page. */}
      <HeldDecision runId={runId} nodeId={nodeId} />

      <div className="gm-nodepage-body">
        <div className="gm-nodepage-column">
          <NodeDetail runId={runId} nodeId={nodeId} />
        </div>
      </div>
    </section>
  );
}
