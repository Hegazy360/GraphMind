/**
 * Step two: the run.
 *
 * One summary line, then the graph, edge to edge. No rail on the left, no
 * inspector docked on the right — a seven-node run finally has room to
 * breathe and a three-hundred-node one gets the whole window instead of
 * two thirds of it.
 *
 * Clicking a node does not open a panel over the graph; it goes to the node
 * place. That is the trade this layout makes, and it is why the node place
 * had to get good.
 */
import { useCallback, useEffect, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { RunCanvas } from '../components/RunCanvas.js';
import { RunSummary } from '../components/RunSummary.js';
import { Timeline } from '../components/Timeline.js';
import { MIN_TIMELINE_HEIGHT, useUiStore } from '../store/uiStore.js';

/** The draggable divider between the graph and the waterfall. */
function TimelineSplitter({ onResize }: { onResize: (height: number) => void }) {
  const dragging = useRef(false);
  const onDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragging.current) return;
      onResize(window.innerHeight - event.clientY - 8);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onResize]);

  return (
    <div
      className="gm-splitter"
      onMouseDown={onDown}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the timeline"
      tabIndex={0}
      onKeyDown={(event) => {
        const height = useUiStore.getState().timelineHeight;
        if (event.key === 'ArrowUp') onResize(height + 24);
        if (event.key === 'ArrowDown') onResize(Math.max(MIN_TIMELINE_HEIGHT, height - 24));
      }}
    />
  );
}

export function RunPage({ runId }: { runId: string }) {
  const view = useUiStore((s) => s.view);
  const timelineHeight = useUiStore((s) => s.timelineHeight);
  const showTimeline = view === 'split' || view === 'timeline';

  return (
    <div className="gm-runpage">
      <RunSummary runId={runId} />
      <div className="gm-runpage-body">
        <ReactFlowProvider>
          {view !== 'timeline' && (
            <div className="gm-runpage-graph">
              <RunCanvas runId={runId} />
            </div>
          )}
          {showTimeline && (
            <>
              {view === 'split' && (
                <TimelineSplitter
                  onResize={(height) => useUiStore.getState().setTimelineHeight(height)}
                />
              )}
              <div
                className="gm-runpage-timeline"
                style={
                  view === 'timeline'
                    ? { flex: 1, minHeight: 0 }
                    : { height: timelineHeight, flexShrink: 0 }
                }
              >
                <Timeline runId={runId} />
              </div>
            </>
          )}
        </ReactFlowProvider>
      </div>
    </div>
  );
}
