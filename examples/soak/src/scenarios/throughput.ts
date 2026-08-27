/**
 * Scenario 1 — the big run.
 *
 * One run, 10k+ events, several hundred logical nodes, heavy token
 * streaming, a viewer attached the whole time. Measures ingest throughput,
 * end-to-end latency, server RSS across the burst, SQLite growth, and how
 * long the two REST endpoints the viewer depends on take at that size.
 * Then proves the storage contract: exactly once, in order, counts agree.
 */
import { SoakServer } from '../server-handle.ts';
import { UiProbe } from '../ui-probe.ts';
import { drive, makeSession } from '../driver.ts';
import { buildWorkload, DEFAULT_WORKLOAD } from '../workload.ts';
import { verifyRun, verifyTrace, fetchAllEvents } from '../verify.ts';
import { check, finding, row, section, type Section } from '../report.ts';
import {
  bool,
  fmtBytes,
  fmtMs,
  fmtRate,
  num,
  percentiles,
  until,
  type Flags,
} from '../util.ts';

export async function throughputScenario(flags: Flags): Promise<Section> {
  const sec = section('throughput — one big run');
  const events = num(flags, 'events', DEFAULT_WORKLOAD.events);
  const toolNodes = num(flags, 'nodes', DEFAULT_WORKLOAD.toolNodes);
  const yieldEvery = num(flags, 'yield', 64);
  const rate = num(flags, 'rate', 0);
  const keepViewer = !bool(flags, 'no-viewer');

  const plan = buildWorkload({
    ...DEFAULT_WORKLOAD,
    events,
    toolNodes,
    tokenBatchesPerStep: num(flags, 'token-batches', DEFAULT_WORKLOAD.tokenBatchesPerStep),
  });

  const server = await SoakServer.start({ memIntervalMs: 250, verbose: bool(flags, 'verbose') });
  server.startPsSampler(100);
  try {
    const probe = keepViewer
      ? await UiProbe.connect(server.uiUrl)
      : undefined;
    probe?.subscribe('*');

    const session = makeSession(server.ingestUrl, { bufferSize: 4000 });
    const attached = await session.ready({ timeoutMs: 5000 });
    check(sec, 'client attached to server', attached);

    const baseline = await server.gc();
    const markedAt = Date.now();

    const result = await drive(session, 'soak-big', plan.events, { yieldEvery, rate });
    const expectedTotal = plan.events.length + 2; // + run.started/run.finished

    // The server is caught up when the run summary reports every event.
    const drainMs = await until(
      async () => {
        const response = await server.api<{ runs: { id: string; eventCount: number }[] }>('/api/runs');
        const run = response.body.runs.find((r) => r.id === result.runId);
        return run !== undefined && run.eventCount >= expectedTotal;
      },
      { timeoutMs: 120_000, intervalMs: 50, label: 'server to persist every event' },
    );

    if (probe !== undefined) {
      await until(() => (probe.runs.get(result.runId)?.order.length ?? 0) >= expectedTotal, {
        timeoutMs: 60_000,
        intervalMs: 50,
        label: 'viewer to receive every event',
      });
    }

    const wallMs = result.emitMs + drainMs;
    const perSecond = (expectedTotal / wallMs) * 1000;
    const bytesPerSecond = (plan.stats.bytes / wallMs) * 1000;

    row(sec, 'events', `${expectedTotal.toLocaleString('en-US')}`, `${plan.stats.logicalNodes} logical nodes, ${plan.stats.tokenEvents.toLocaleString('en-US')} token frames`);
    row(sec, 'payload bytes', fmtBytes(plan.stats.bytes));
    row(sec, 'emit loop', fmtMs(result.emitMs), `${fmtMs(result.inEmitMs)} inside session.emit (${((result.inEmitMs / result.emitMs) * 100).toFixed(1)}% of it)`);
    row(sec, 'server drain after emit', fmtMs(drainMs), 'queue still in flight when the emit loop returned');
    row(sec, 'ingest throughput', fmtRate(perSecond), `${fmtBytes(bytesPerSecond)}/s`);
    row(sec, 'per-event client cost', fmtMs(result.inEmitMs / plan.events.length));

    if (probe !== undefined) {
      const trace = probe.runs.get(result.runId);
      const live = percentiles(trace?.liveLatencies ?? []);
      row(
        sec,
        'end-to-end latency',
        `p50 ${fmtMs(live.p50)}  p95 ${fmtMs(live.p95)}  p99 ${fmtMs(live.p99)}  max ${fmtMs(live.max)}`,
        `${live.count.toLocaleString('en-US')} live samples, emit -> viewer socket`,
      );
      const replayedCount = (trace?.replayed ?? []).filter(Boolean).length;
      row(
        sec,
        'viewer delivery split',
        `${(trace?.order.length ?? 0) - replayedCount} live / ${replayedCount} replayed`,
        `replay windows: ${(trace?.replayStarts ?? []).join(', ') || 'none'}`,
      );
      sec.data['latency'] = live;
      const traced = verifyTrace(trace?.order ?? [], plan.events.length);
      check(
        sec,
        'viewer socket saw every event exactly once, in order',
        traced.missing === 0 && traced.duplicates === 0 && traced.inversions === 0,
        `missing ${traced.missing}, dup ${traced.duplicates}, inversions ${traced.inversions}`,
      );
    }

    // Memory across the burst, then after a forced GC.
    const during = server.psSince(markedAt);
    const after = await server.gc();
    let peak = Math.max(baseline.rss, after.rss);
    for (const sample of during) peak = Math.max(peak, sample.rss);
    row(
      sec,
      'server RSS',
      `${fmtBytes(baseline.rss)} idle -> ${fmtBytes(peak)} peak -> ${fmtBytes(after.rss)} after GC`,
      `retained ${fmtBytes(after.rss - baseline.rss)} (${during.length} samples)`,
    );
    row(sec, 'server heap after GC', fmtBytes(after.heapUsed), `baseline ${fmtBytes(baseline.heapUsed)}`);

    const db = await server.dbSizes();
    row(
      sec,
      'sqlite on disk',
      fmtBytes(db.total),
      `db ${fmtBytes(db.db)} + wal ${fmtBytes(db.wal)}; ${(db.total / expectedTotal).toFixed(0)} B/event`,
    );

    // The two endpoints the viewer's history pane depends on.
    const runsCall = await server.api('/api/runs');
    const firstPage = await server.api(
      `/api/runs/${encodeURIComponent(result.runId)}/events?afterSeq=-1&limit=1000`,
    );
    const bigPage = await server.api(
      `/api/runs/${encodeURIComponent(result.runId)}/events?afterSeq=-1&limit=5000`,
    );
    row(sec, 'GET /api/runs', fmtMs(runsCall.ms), `${fmtBytes(runsCall.bytes)}, 1 run`);
    row(sec, 'GET events (limit 1000)', fmtMs(firstPage.ms), fmtBytes(firstPage.bytes));
    row(sec, 'GET events (limit 5000)', fmtMs(bigPage.ms), fmtBytes(bigPage.bytes));

    const verified = await verifyRun(server, result.runId, {
      ordinals: plan.events.length,
      total: expectedTotal,
      errors: plan.stats.errorEvents,
    });
    row(
      sec,
      'full history read',
      fmtMs(verified.fetchMs),
      `${verified.pages} page(s), ${fmtBytes(verified.fetchBytes)}`,
    );
    check(
      sec,
      'every event stored exactly once, in order',
      verified.ok,
      verified.problems.join('; ') || `${verified.storedTotal} events`,
    );

    // Second pass, paced below the ingest ceiling: the number above is what a
    // burst costs (it is mostly queueing); this is what a viewer actually feels
    // while an agent streams at a realistic rate.
    const pacedRate = num(flags, 'paced-rate', 2000);
    const pacedPlan = buildWorkload({
      ...DEFAULT_WORKLOAD,
      events: Math.min(4000, plan.events.length),
      toolNodes: 40,
      tokenBatchesPerStep: 12,
    });
    const paced = await drive(session, 'soak-paced', pacedPlan.events, {
      yieldEvery: 16,
      rate: pacedRate,
    });
    await until(
      () => (probe?.runs.get(paced.runId)?.order.length ?? 0) >= pacedPlan.events.length + 2,
      { timeoutMs: 60_000, intervalMs: 50, label: 'paced run to reach the viewer' },
    ).catch(() => 0);
    const pacedTrace = probe?.runs.get(paced.runId);
    const pacedLive = percentiles(pacedTrace?.liveLatencies ?? []);
    const pacedReplayed = (pacedTrace?.replayed ?? []).filter(Boolean).length;
    row(
      sec,
      `paced at ${pacedRate}/s latency`,
      `p50 ${fmtMs(pacedLive.p50)}  p95 ${fmtMs(pacedLive.p95)}  p99 ${fmtMs(pacedLive.p99)}  max ${fmtMs(pacedLive.max)}`,
      `${pacedLive.count.toLocaleString('en-US')} live samples, ${pacedReplayed} replayed`,
    );
    sec.data['pacedLatency'] = { rate: pacedRate, ...pacedLive };

    // Cost of paginating the whole run at the viewer's default page size.
    const paged = await fetchAllEvents(server, result.runId, 1000);
    const pageStats = percentiles(paged.pageMs);
    row(
      sec,
      'paginated read (1000/page)',
      `${paged.pageMs.length} pages, p50 ${fmtMs(pageStats.p50)} max ${fmtMs(pageStats.max)}`,
    );

    if (peak - baseline.rss > 400 * 1024 * 1024) {
      finding(sec, `server RSS grew ${fmtBytes(peak - baseline.rss)} during the burst`);
    }
    if (after.rss - baseline.rss > 150 * 1024 * 1024) {
      finding(sec, `${fmtBytes(after.rss - baseline.rss)} still resident after a forced GC`);
    }

    sec.data['throughput'] = {
      events: expectedTotal,
      logicalNodes: plan.stats.logicalNodes,
      payloadBytes: plan.stats.bytes,
      emitMs: result.emitMs,
      inEmitMs: result.inEmitMs,
      drainMs,
      eventsPerSecond: perSecond,
      rssBaseline: baseline.rss,
      rssPeak: peak,
      rssAfterGc: after.rss,
      dbBytes: db.total,
      apiRunsMs: runsCall.ms,
      apiEvents1000Ms: firstPage.ms,
      apiEvents5000Ms: bigPage.ms,
      fullReadMs: verified.fetchMs,
      pageMs: pageStats,
      problems: verified.problems,
    };

    await probe?.close();
    await session.dispose();
    return sec;
  } finally {
    await server.close();
    server.cleanup();
  }
}
