/**
 * The waterfall. For a run with two hundred executions this answers the
 * questions the graph can't: what overlapped, where the wall-clock went, how
 * long the step waited before the first token, and when the gate held.
 *
 * Rendering notes:
 *  - one scroll container, labels `position: sticky; left: 0`, ruler sticky
 *    on top — so the row you are reading keeps its name at any scroll offset;
 *  - rows are virtualized (only the visible slice is in the DOM), so a
 *    thousand bars cost the same as thirty;
 *  - zoom is a pure multiplier on track width: wheel with ⌘/ctrl, the
 *    +/−/fit buttons, or drag a range on the ruler to zoom into it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtClockMs, fmtDuration, fmtExactMs, fmtOffset } from '../lib/format.js';
import { useRunStore } from '../store/runStore.js';
import { tokenBuffers } from '../store/tokenBuffers.js';
import {
  buildTimeline,
  ticksFor,
  type TimelineBar,
  type TimelineModel,
  type TimelineRow,
} from '../store/timeline.js';
import { useUiStore } from '../store/uiStore.js';
import { IconClose, IconFit, IconZoomIn } from './Icons.js';

const LABEL_WIDTH = 208;
const LANE_HEIGHT = 17;
const ROW_PADDING = 7;
const RULER_HEIGHT = 26;
const OVERSCAN = 6;

function rowHeight(row: TimelineRow): number {
  return ROW_PADDING + row.lanes * LANE_HEIGHT;
}

function barClass(bar: TimelineBar): string {
  if (bar.running) return 'gm-bar gm-bar--running';
  if (bar.status === 'error' || bar.error !== undefined) return 'gm-bar gm-bar--error';
  if (bar.status === 'aborted') return 'gm-bar gm-bar--aborted';
  return `gm-bar gm-bar--ok gm-bar--${bar.kind}`;
}

interface Tooltip {
  x: number;
  y: number;
  bar: TimelineBar;
  t0: number;
}

export function Timeline({ runId }: { runId: string }) {
  const structureVersion = useRunStore((s) => s.runs[runId]?.structureVersion ?? -1);
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? -1);
  const runStatus = useRunStore((s) => s.runs[runId]?.meta.status);
  const selectedNodeId = useUiStore((s) => s.selectedNodeId);
  const view = useUiStore((s) => s.view);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 900, height: 220 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [zoom, setZoom] = useState(1);
  const [tick, setTick] = useState(0);
  const [tooltip, setTooltip] = useState<Tooltip | undefined>(undefined);
  const [brush, setBrush] = useState<{ from: number; to: number } | undefined>(undefined);

  // A live run needs a heartbeat so open bars keep growing.
  const isLive = runStatus === 'running' || runStatus === 'pending';
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(timer);
  }, [isLive]);

  const model: TimelineModel = useMemo(() => {
    void structureVersion;
    void statusVersion;
    void tick;
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) {
      const now = Date.now();
      return { rows: [], markers: [], t0: now, t1: now + 1, live: false };
    }
    return buildTimeline(run, Date.now(), (nodeId, index, count) =>
      tokenBuffers.getInstanceTiming(runId, nodeId, index, count),
    );
  }, [runId, structureVersion, statusVersion, tick]);

  const span = Math.max(1, model.t1 - model.t0);
  const trackWidth = Math.max(320, (viewport.width - LABEL_WIDTH - 16) * zoom);
  const toX = useCallback((ts: number) => ((ts - model.t0) / span) * trackWidth, [model.t0, span, trackWidth]);

  // Row offsets for virtualization.
  const offsets = useMemo(() => {
    const out: number[] = [];
    let y = 0;
    for (const row of model.rows) {
      out.push(y);
      y += rowHeight(row);
    }
    out.push(y);
    return out;
  }, [model.rows]);
  const totalHeight = offsets[offsets.length - 1] ?? 0;

  const [firstRow, lastRow] = useMemo(() => {
    const top = scroll.top;
    const bottom = top + viewport.height;
    let start = 0;
    let end = model.rows.length;
    for (let i = 0; i < model.rows.length; i++) {
      const row = model.rows[i];
      if (row === undefined) continue;
      const y = offsets[i] ?? 0;
      const h = rowHeight(row);
      if (y + h < top) start = i + 1;
      if (y > bottom) {
        end = i;
        break;
      }
    }
    return [Math.max(0, start - OVERSCAN), Math.min(model.rows.length, end + OVERSCAN)];
  }, [scroll.top, viewport.height, offsets, model.rows]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    setViewport({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  // ⌘/ctrl + wheel zooms around the cursor, like every profiler.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const cursorX = event.clientX - rect.left - LABEL_WIDTH + element.scrollLeft;
      const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
      setZoom((current) => {
        const next = Math.min(64, Math.max(1, current * factor));
        const ratio = next / current;
        requestAnimationFrame(() => {
          element.scrollLeft = Math.max(0, cursorX * ratio - (event.clientX - rect.left - LABEL_WIDTH));
        });
        return next;
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    setScroll({ top: element.scrollTop, left: element.scrollLeft });
  }, []);

  const selectBar = useCallback(
    (bar: TimelineBar) => {
      const ui = useUiStore.getState();
      ui.selectNode(runId, bar.nodeId);
      ui.setInstanceIdx(bar.execIndex);
      ui.requestFocus(bar.nodeId);
    },
    [runId],
  );

  // Ruler drag = zoom to a time range.
  const brushRef = useRef<{ startX: number } | undefined>(undefined);
  const onRulerDown = (event: React.MouseEvent) => {
    const element = scrollRef.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const x = event.clientX - rect.left - LABEL_WIDTH + element.scrollLeft;
    brushRef.current = { startX: x };
    setBrush({ from: x, to: x });
    const move = (e: MouseEvent) => {
      const current = e.clientX - rect.left - LABEL_WIDTH + element.scrollLeft;
      const start = brushRef.current?.startX ?? current;
      setBrush({ from: Math.min(start, current), to: Math.max(start, current) });
    };
    const up = (e: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const current = e.clientX - rect.left - LABEL_WIDTH + element.scrollLeft;
      const start = brushRef.current?.startX ?? current;
      brushRef.current = undefined;
      setBrush(undefined);
      const from = Math.min(start, current);
      const to = Math.max(start, current);
      if (to - from < 12) return; // a click, not a drag
      const visible = Math.max(120, viewport.width - LABEL_WIDTH - 16);
      const factor = trackWidth / (to - from);
      const nextZoom = Math.min(64, zoom * factor);
      const nextTrack = Math.max(320, visible * nextZoom);
      setZoom(nextZoom);
      requestAnimationFrame(() => {
        element.scrollLeft = (from / trackWidth) * nextTrack;
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const ticks = useMemo(() => ticksFor(span, Math.max(4, Math.round(trackWidth / 130))), [span, trackWidth]);
  const nowX = model.live ? toX(Date.now()) : undefined;

  if (model.rows.length === 0) {
    return (
      <section className="gm-timeline" aria-label="Timeline">
        <TimelineHeader
          rows={0}
          span={0}
          zoom={zoom}
          onZoom={setZoom}
          showClose={view !== 'graph'}
        />
        <div className="gm-timeline-empty">
          Nothing has executed yet — the waterfall fills in as nodes start.
        </div>
      </section>
    );
  }

  return (
    <section className="gm-timeline" aria-label="Timeline">
      <TimelineHeader
        rows={model.rows.length}
        span={span}
        zoom={zoom}
        onZoom={setZoom}
        showClose={view !== 'graph'}
      />
      <div className="gm-timeline-scroll" ref={scrollRef} onScroll={onScroll}>
        <div style={{ width: LABEL_WIDTH + trackWidth, position: 'relative' }}>
          {/* ruler */}
          <div
            className="gm-timeline-ruler"
            style={{ width: LABEL_WIDTH + trackWidth }}
            onMouseDown={onRulerDown}
          >
            <div className="gm-timeline-ruler-corner" style={{ width: LABEL_WIDTH }}>
              <span>{model.rows.length} nodes</span>
            </div>
            <div style={{ position: 'relative', width: trackWidth, height: RULER_HEIGHT }}>
              {ticks.map((offset) => (
                <span
                  key={offset}
                  className="gm-timeline-tick"
                  style={{ left: (offset / span) * trackWidth }}
                >
                  {fmtOffset(offset)}
                </span>
              ))}
              {brush !== undefined && (
                <div
                  className="gm-timeline-brush"
                  style={{ left: brush.from, width: Math.max(1, brush.to - brush.from) }}
                />
              )}
            </div>
          </div>

          {/* rows */}
          <div style={{ height: totalHeight, position: 'relative' }}>
            {/* gridlines */}
            <div className="gm-timeline-grid" style={{ left: LABEL_WIDTH, width: trackWidth }}>
              {ticks.map((offset) => (
                <span key={offset} style={{ left: (offset / span) * trackWidth }} />
              ))}
              {model.markers.map((marker, i) => (
                <span
                  key={`${marker.ts}-${i}`}
                  className={`gm-timeline-marker gm-timeline-marker--${marker.kind}`}
                  style={{ left: toX(marker.ts) }}
                  title={`${marker.nodeId} — ${marker.label} @ ${fmtClockMs(marker.ts)}`}
                />
              ))}
              {nowX !== undefined && <span className="gm-timeline-now" style={{ left: nowX }} />}
            </div>

            {model.rows.slice(firstRow, lastRow).map((row, i) => {
              const index = firstRow + i;
              const top = offsets[index] ?? 0;
              const selected = row.nodeId === selectedNodeId;
              return (
                <div
                  key={row.nodeId}
                  className={`gm-timeline-row${selected ? ' gm-timeline-row--selected' : ''}`}
                  style={{ top, height: rowHeight(row) }}
                >
                  <button
                    className="gm-timeline-label"
                    style={{ width: LABEL_WIDTH, paddingLeft: 10 + Math.min(row.depth, 6) * 9 }}
                    onClick={() => {
                      const ui = useUiStore.getState();
                      ui.selectNode(runId, row.nodeId);
                      ui.requestFocus(row.nodeId);
                    }}
                    title={`${row.nodeId} — ${row.bars.length} execution${row.bars.length === 1 ? '' : 's'}, ${fmtDuration(row.totalMs)} total`}
                  >
                    <span className={`gm-timeline-kind gm-timeline-kind--${row.kind}`} aria-hidden />
                    <span className="gm-timeline-name">{row.name}</span>
                    {row.bars.length > 1 && <span className="gm-badge-count">×{row.bars.length}</span>}
                  </button>
                  <div className="gm-timeline-track" style={{ width: trackWidth }}>
                    {row.bars.map((bar) => {
                      const left = toX(bar.startTs);
                      const width = Math.max(2, toX(bar.endTs) - left);
                      const streamLeft =
                        bar.streamStartTs === undefined ? undefined : toX(bar.streamStartTs) - left;
                      const streamWidth =
                        bar.streamStartTs === undefined || bar.streamEndTs === undefined
                          ? undefined
                          : Math.max(1, toX(bar.streamEndTs) - toX(bar.streamStartTs));
                      return (
                        <button
                          key={bar.key}
                          className={barClass(bar)}
                          style={{
                            left,
                            width,
                            top: ROW_PADDING / 2 + bar.lane * LANE_HEIGHT,
                          }}
                          onClick={() => selectBar(bar)}
                          onMouseEnter={(e) =>
                            setTooltip({ x: e.clientX, y: e.clientY, bar, t0: model.t0 })
                          }
                          onMouseMove={(e) =>
                            setTooltip({ x: e.clientX, y: e.clientY, bar, t0: model.t0 })
                          }
                          onMouseLeave={() => setTooltip(undefined)}
                          aria-label={`${bar.name} execution ${bar.execIndex + 1}, ${fmtExactMs(bar.endTs - bar.startTs)}`}
                        >
                          {streamLeft !== undefined && streamWidth !== undefined && (
                            <span
                              className="gm-bar-stream"
                              style={{ left: Math.max(0, streamLeft), width: streamWidth }}
                            />
                          )}
                          {width > 46 && (
                            <span className="gm-bar-label">{fmtDuration(bar.endTs - bar.startTs)}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {tooltip !== undefined && <BarTooltip {...tooltip} />}
    </section>
  );
}

function TimelineHeader({
  rows,
  span,
  zoom,
  onZoom,
  showClose,
}: {
  rows: number;
  span: number;
  zoom: number;
  onZoom: (z: number) => void;
  showClose: boolean;
}) {
  return (
    <header className="gm-timeline-head">
      <span className="gm-section-label">Timeline</span>
      <span className="gm-timeline-meta">
        {rows} node{rows === 1 ? '' : 's'} · {fmtDuration(span)} span
      </span>
      <div className="gm-timeline-tools">
        <button className="gm-iconbtn" title="Zoom out" onClick={() => onZoom(Math.max(1, zoom / 1.6))}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>−</span>
        </button>
        <span className="gm-timeline-zoom">{zoom.toFixed(1)}×</span>
        <button className="gm-iconbtn" title="Zoom in" onClick={() => onZoom(Math.min(64, zoom * 1.6))}>
          <IconZoomIn />
        </button>
        <button className="gm-iconbtn" title="Fit the whole run" onClick={() => onZoom(1)}>
          <IconFit />
        </button>
        {showClose && (
          <button
            className="gm-iconbtn"
            title="Close the timeline"
            onClick={() => useUiStore.getState().setView('graph')}
          >
            <IconClose />
          </button>
        )}
      </div>
    </header>
  );
}

function BarTooltip({ x, y, bar, t0 }: Tooltip) {
  const duration = bar.endTs - bar.startTs;
  const wait =
    bar.streamStartTs === undefined ? undefined : Math.max(0, bar.streamStartTs - bar.startTs);
  return (
    <div className="gm-tooltip" style={{ left: x + 14, top: y - 12 }} role="tooltip">
      <div className="gm-tooltip-title">
        {bar.name}
        <span className="gm-node-kind">{bar.kind}</span>
      </div>
      <dl className="gm-tooltip-rows">
        <dt>started</dt>
        <dd>
          {fmtOffset(bar.startTs - t0)} · {fmtClockMs(bar.startTs)}
        </dd>
        <dt>duration</dt>
        <dd>{bar.running ? `${fmtExactMs(duration)} (running)` : fmtExactMs(duration)}</dd>
        {wait !== undefined && (
          <>
            <dt>first token</dt>
            <dd>{fmtExactMs(wait)} after start</dd>
          </>
        )}
        <dt>instance</dt>
        <dd className="gm-mono">{bar.instanceId}</dd>
        {bar.error !== undefined && (
          <>
            <dt>error</dt>
            <dd className="gm-tooltip-error">
              {bar.error.name}: {bar.error.message}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
