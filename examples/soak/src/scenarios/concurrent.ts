/**
 * Scenario 4 — several sessions, several runs each, all at once.
 *
 * Three things can only break under concurrency: run ownership (which ingest
 * socket owns which runId, and therefore where `exec.resume` is routed),
 * fan-out routing (does run A's event ever reach a viewer subscribed only to
 * run B), and the shared per-session `seq` counter (one session interleaving
 * several runs mints seqs from one sequence, so each run sees an ascending
 * but *sparse* seq series — storage must not care).
 */
import { SoakServer } from '../server-handle.ts';
import { UiProbe } from '../ui-probe.ts';
import { drive, makeSession } from '../driver.ts';
import { buildWorkload, DEFAULT_WORKLOAD } from '../workload.ts';
import { verifyRun, verifyTrace } from '../verify.ts';
import { check, finding, row, section, type Section } from '../report.ts';
import { bool, fmtBytes, fmtMs, fmtRate, num, percentiles, until, type Flags } from '../util.ts';

export async function concurrentScenario(flags: Flags): Promise<Section> {
  const sec = section('concurrency — many sessions, many runs');
  const sessionCount = num(flags, 'sessions', 4);
  const runsPerSession = num(flags, 'runs-per-session', 3);
  const eventsPerRun = num(flags, 'events-per-run', 2000);
  const viewerCount = num(flags, 'viewers', 3);

  const server = await SoakServer.start({ verbose: bool(flags, 'verbose') });
  server.startPsSampler(100);

  try {
    const viewers: UiProbe[] = [];
    for (let v = 0; v < viewerCount; v += 1) {
      const probe = await UiProbe.connect(server.uiUrl);
      probe.subscribe('*');
      viewers.push(probe);
    }
    // One extra viewer pinned to a single run: it must never see anything else.
    const pinned = await UiProbe.connect(server.uiUrl, { autoSubscribe: false });

    const plan = buildWorkload({
      ...DEFAULT_WORKLOAD,
      events: eventsPerRun,
      toolNodes: 60,
      tokenBatchesPerStep: 12,
    });
    const expectedPerRun = plan.events.length + 2;

    const sessions = Array.from({ length: sessionCount }, (_, index) =>
      makeSession(server.ingestUrl, { appName: `soak-app-${index}`, bufferSize: 4000 }),
    );
    const attached = await Promise.all(sessions.map((session) => session.ready({ timeoutMs: 8000 })));
    check(sec, 'every session attached', attached.every(Boolean), `${attached.filter(Boolean).length}/${sessionCount}`);

    const baseline = await server.gc();
    const markedAt = Date.now();
    const started = performance.now();

    const results = await Promise.all(
      sessions.flatMap((session, sessionIndex) =>
        Array.from({ length: runsPerSession }, (_unused, runIndex) =>
          drive(session, `s${sessionIndex}-r${runIndex}`, plan.events, {
            yieldEvery: 32,
            rate: num(flags, 'rate', 0),
          }),
        ),
      ),
    );
    const emitMs = performance.now() - started;

    // Pin the extra viewer to the first run only, after the fact.
    const pinnedRunId = (results[0] as { runId: string }).runId;
    pinned.subscribe(pinnedRunId);

    const totalEvents = results.length * expectedPerRun;
    const drainMs = await until(
      async () => {
        const response = await server.api<{ runs: { id: string; eventCount: number }[] }>('/api/runs');
        const byId = new Map(response.body.runs.map((run) => [run.id, run.eventCount]));
        return results.every((result) => (byId.get(result.runId) ?? 0) >= expectedPerRun);
      },
      { timeoutMs: 180_000, intervalMs: 100, label: 'all runs to persist' },
    );

    const wallMs = emitMs + drainMs;
    row(
      sec,
      'shape',
      `${sessionCount} sessions x ${runsPerSession} runs x ${expectedPerRun.toLocaleString('en-US')} events`,
      `${totalEvents.toLocaleString('en-US')} events, ${results.length} concurrent runs`,
    );
    row(sec, 'emit loop (all runs)', fmtMs(emitMs));
    row(sec, 'server drain', fmtMs(drainMs));
    row(sec, 'aggregate throughput', fmtRate((totalEvents / wallMs) * 1000));

    // Correctness, run by run.
    const problems: string[] = [];
    for (const result of results) {
      const verified = await verifyRun(server, result.runId, {
        ordinals: plan.events.length,
        total: expectedPerRun,
        errors: plan.stats.errorEvents,
      });
      if (!verified.ok) problems.push(`${result.runId}: ${verified.problems.join(', ')}`);
    }
    check(
      sec,
      'every concurrent run stored exactly once, in order, with matching counts',
      problems.length === 0,
      problems.length === 0 ? `${results.length} runs verified` : problems.slice(0, 3).join(' | '),
    );

    // Fan-out routing: each viewer got every run; the pinned one got only its run.
    let viewerProblems = 0;
    for (const viewer of viewers) {
      for (const result of results) {
        const trace = viewer.runs.get(result.runId);
        const traced = verifyTrace(trace?.order ?? [], plan.events.length);
        if (traced.duplicates > 0 || traced.inversions > 0) viewerProblems += 1;
      }
    }
    check(
      sec,
      `${viewerCount} viewers each saw every run without duplicates or reordering`,
      viewerProblems === 0,
      `${viewerProblems} problem run/viewer pairs`,
    );
    const strayRuns = [...pinned.runs.keys()].filter((id) => id !== pinnedRunId);
    check(
      sec,
      'a viewer subscribed to one run receives only that run',
      strayRuns.length === 0,
      strayRuns.length === 0 ? 'no cross-talk' : `leaked ${strayRuns.length} other run(s)`,
    );

    // Latency under concurrency, across every viewer/run pair.
    const latencies: number[] = [];
    for (const viewer of viewers) {
      for (const trace of viewer.runs.values()) latencies.push(...trace.liveLatencies);
    }
    let replayedFrames = 0;
    let liveFrames = 0;
    for (const viewer of viewers) {
      for (const trace of viewer.runs.values()) {
        for (const wasReplay of trace.replayed) {
          if (wasReplay) replayedFrames += 1;
          else liveFrames += 1;
        }
      }
    }
    row(
      sec,
      'viewer delivery split',
      `${liveFrames.toLocaleString('en-US')} live / ${replayedFrames.toLocaleString('en-US')} replayed`,
      'replayed = the viewer subscribe was serviced after those events were already stored',
    );
    if (replayedFrames > liveFrames * 4) {
      finding(
        sec,
        `at saturation the viewer stops being live: ${((replayedFrames / (replayedFrames + liveFrames)) * 100).toFixed(0)}% ` +
          'of frames arrived as catch-up replay rather than live tail, because the subscribe was only ' +
          'serviced once the ingest backlog had drained. Paced below the ingest ceiling (--rate) the ' +
          'same workload delivers ~98% live.',
      );
    }
    const stats = percentiles(latencies);
    row(
      sec,
      'end-to-end latency',
      `p50 ${fmtMs(stats.p50)}  p95 ${fmtMs(stats.p95)}  p99 ${fmtMs(stats.p99)}  max ${fmtMs(stats.max)}`,
      `${stats.count.toLocaleString('en-US')} samples across ${viewerCount} viewers`,
    );

    const during = server.psSince(markedAt);
    const after = await server.gc();
    let peak = Math.max(baseline.rss, after.rss);
    for (const sample of during) peak = Math.max(peak, sample.rss);
    row(
      sec,
      'server RSS',
      `${fmtBytes(baseline.rss)} -> ${fmtBytes(peak)} peak -> ${fmtBytes(after.rss)} after GC`,
    );

    const db = await server.dbSizes();
    row(sec, 'sqlite on disk', fmtBytes(db.total), `${(db.total / totalEvents).toFixed(0)} B/event`);

    const runsCall = await server.api('/api/runs');
    row(sec, 'GET /api/runs', fmtMs(runsCall.ms), `${results.length} runs, ${fmtBytes(runsCall.bytes)}`);
    if (runsCall.ms > 100) {
      finding(
        sec,
        `GET /api/runs took ${fmtMs(runsCall.ms)} for only ${results.length} runs — it counts every ` +
          'event of every run with two correlated subqueries per row (sqlite-storage.ts RUN_COLUMNS).',
      );
    }

    sec.data['concurrent'] = {
      sessions: sessionCount,
      runsPerSession,
      eventsPerRun: expectedPerRun,
      totalEvents,
      emitMs,
      drainMs,
      eventsPerSecond: (totalEvents / wallMs) * 1000,
      latency: stats,
      rssBaseline: baseline.rss,
      rssPeak: peak,
      rssAfterGc: after.rss,
      dbBytes: db.total,
      apiRunsMs: runsCall.ms,
      problems,
    };

    await Promise.all([...viewers, pinned].map((viewer) => viewer.close()));
    await Promise.all(sessions.map((session) => session.dispose()));
    return sec;
  } finally {
    await server.close();
    server.cleanup();
  }
}
