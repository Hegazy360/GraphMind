/**
 * `?stress=300` — feed a synthetic large run through the real ingest path.
 *
 * This is not a demo: it is the measurement harness for the scaling work.
 * Events go through `ingestValue` exactly like live socket traffic, so what
 * you see is the true cost of the reducer, the token registry, the layout
 * and the canvas. Timings land in `window.__graphmindStress` and in the
 * console so a run can be reported rather than claimed.
 *
 * `&pace=0` blasts every event in one frame (worst case); higher values feed
 * n events per frame so you can watch it grow.
 */
import { useEffect } from 'react';
import { useUiStore } from '../store/uiStore.js';
import { ingestEnvelope } from './ingest.js';

export interface StressReport {
  runId: string;
  nodes: number;
  events: number;
  generateMs: number;
  ingestMs: number;
  eventsPerSecond: number;
}

export interface StressOptions {
  nodes: number;
  events: number;
  /** Envelopes per animation frame; 0 = everything at once. */
  pace: number;
}

/** Parse `?stress=300&events=5000&pace=250`. */
export function parseStressParams(search: string): StressOptions | null {
  const params = new URLSearchParams(search);
  const raw = params.get('stress');
  if (raw === null || raw === '') return null;
  const nodes = raw === '1' ? 300 : Math.max(8, Math.min(4000, Number(raw) || 300));
  const events = Math.max(nodes * 4, Number(params.get('events')) || 5000);
  const paceRaw = params.get('pace');
  const pace = paceRaw === null ? 120 : Math.max(0, Number(paceRaw) || 0);
  return { nodes, events, pace };
}

/**
 * Module-level, deliberately: this runs once per page load and must survive
 * StrictMode's mount/unmount/mount (a cancel-on-unmount effect would abort
 * the generation before the second mount ever sees it).
 */
let stressStarted = false;

export async function runStressOnce(options: StressOptions): Promise<StressReport | undefined> {
  if (stressStarted) return undefined;
  stressStarted = true;

  const { generateStressRun } = await import('../store/synthetic.js');
  const generateStart = performance.now();
  const generated = generateStressRun({ nodes: options.nodes, events: options.events });
  const generateMs = performance.now() - generateStart;
  const total = generated.envelopes.length;
  useUiStore.getState().setConnection('replaying');
  const t0 = performance.now();

  const finish = (): StressReport => {
    const ingestMs = performance.now() - t0;
    const report: StressReport = {
      runId: generated.runId,
      nodes: generated.nodeCount,
      events: total,
      generateMs,
      ingestMs,
      eventsPerSecond: Math.round(total / (ingestMs / 1000)),
    };
    (window as unknown as Record<string, unknown>)['__graphmindStress'] = report;
    console.info('[graphmind] stress run ingested', report);
    useUiStore.getState().setConnection('off');
    useUiStore.getState().selectRun(generated.runId);
    return report;
  };

  if (options.pace === 0) {
    for (const envelope of generated.envelopes) ingestEnvelope(envelope, 'fixture');
    return finish();
  }

  return await new Promise<StressReport>((resolve) => {
    let index = 0;
    const pump = () => {
      const end = Math.min(total, index + options.pace);
      for (; index < end; index++) {
        const envelope = generated.envelopes[index];
        if (envelope !== undefined) ingestEnvelope(envelope, 'fixture');
      }
      if (index < total) requestAnimationFrame(pump);
      else resolve(finish());
    };
    requestAnimationFrame(pump);
  });
}

/** Runs once per page load — the caller memoizes `options` from the URL. */
export function useStressRun(options: StressOptions | null): void {
  useEffect(() => {
    if (options === null) return;
    void runStressOnce(options);
  }, [options]);
}
