/**
 * Scenario 5 — many runs on disk: the run list, retention and VACUUM.
 *
 * `GET /api/runs` is the viewer's home screen, and every row it returns is
 * built with two correlated subqueries that COUNT the run's events
 * (sqlite-storage.ts `RUN_COLUMNS`). So its cost is a function of *total
 * events in the database*, not of the number of runs — which is exactly the
 * shape that feels fine in a demo and terrible after a month of use. This
 * measures the curve, then measures what retention gives back.
 */
import { SoakServer } from '../server-handle.ts';
import { makeSession } from '../driver.ts';
import { drive } from '../driver.ts';
import { buildWorkload, DEFAULT_WORKLOAD } from '../workload.ts';
import { check, finding, row, section, type Section } from '../report.ts';
import { bool, fmtBytes, fmtMs, num, until, type Flags } from '../util.ts';

export async function retentionScenario(flags: Flags): Promise<Section> {
  const sec = section('retention — many runs, /api/runs cost, prune');
  const runCount = num(flags, 'runs', 200);
  const eventsPerRun = num(flags, 'small-run-events', 200);
  const bigRunEvents = num(flags, 'big-run-events', 20_000);

  // Retention 'on' so the prune path is the shipped one.
  const server = await SoakServer.start({ retention: 'on', verbose: bool(flags, 'verbose') });
  server.startPsSampler(250);

  try {
    const session = makeSession(server.ingestUrl, { bufferSize: 4000 });
    check(sec, 'client attached', await session.ready({ timeoutMs: 5000 }));

    const small = buildWorkload({
      ...DEFAULT_WORKLOAD,
      events: eventsPerRun,
      toolNodes: 20,
      tokenBatchesPerStep: 6,
    });
    const perRun = small.events.length + 2;

    const curve: { runs: number; events: number; ms: number; bytes: number }[] = [];
    for (let index = 0; index < runCount; index += 1) {
      await drive(session, `hist-${index}`, small.events, { yieldEvery: 128 });
      if ((index + 1) % 25 === 0 || index + 1 === runCount) {
        await until(
          async () => {
            const response = await server.api<{ runs: { eventCount: number }[] }>('/api/runs');
            return response.body.runs.length >= index + 1;
          },
          { timeoutMs: 30_000, intervalMs: 50, label: 'run list to settle' },
        ).catch(() => 0);
        // Three calls, keep the median: this endpoint is cheap enough that
        // one sample is mostly noise.
        const samples: number[] = [];
        let bytes = 0;
        for (let s = 0; s < 3; s += 1) {
          const call = await server.api('/api/runs');
          samples.push(call.ms);
          bytes = call.bytes;
        }
        samples.sort((a, b) => a - b);
        curve.push({
          runs: index + 1,
          events: (index + 1) * perRun,
          ms: samples[1] as number,
          bytes,
        });
      }
    }

    for (const point of curve) {
      row(
        sec,
        `GET /api/runs @ ${point.runs} runs`,
        fmtMs(point.ms),
        `${point.events.toLocaleString('en-US')} events in db, ${fmtBytes(point.bytes)} response`,
      );
    }

    const first = curve[0];
    const last = curve[curve.length - 1];
    if (first !== undefined && last !== undefined && first.ms > 0) {
      const runRatio = last.runs / first.runs;
      const msRatio = last.ms / first.ms;
      row(
        sec,
        'run-list scaling',
        `${runRatio.toFixed(0)}x runs -> ${msRatio.toFixed(1)}x time`,
        msRatio > runRatio * 1.5 ? 'superlinear' : 'linear or better',
      );
      sec.data['runListScaling'] = { runRatio, msRatio };
    }

    // One heavy run on top: if /api/runs is O(total events) rather than
    // O(runs), a single fat run slows down the whole home screen.
    const beforeBig = await server.api('/api/runs');
    const big = buildWorkload({ ...DEFAULT_WORKLOAD, events: bigRunEvents, toolNodes: 300 });
    const bigResult = await drive(session, 'one-fat-run', big.events, { yieldEvery: 64 });
    await until(
      async () => {
        const response = await server.api<{ runs: { id: string; eventCount: number }[] }>('/api/runs');
        const run = response.body.runs.find((r) => r.id === bigResult.runId);
        return run !== undefined && run.eventCount >= big.events.length + 2;
      },
      { timeoutMs: 120_000, intervalMs: 100, label: 'the fat run to persist' },
    );
    const afterBigSamples: number[] = [];
    for (let s = 0; s < 3; s += 1) afterBigSamples.push((await server.api('/api/runs')).ms);
    afterBigSamples.sort((a, b) => a - b);
    const afterBig = afterBigSamples[1] as number;
    row(
      sec,
      'GET /api/runs after one 20k-event run',
      fmtMs(afterBig),
      `was ${fmtMs(beforeBig.ms)} with ${runCount} small runs`,
    );
    if (afterBig > beforeBig.ms * 2 && afterBig > 20) {
      finding(
        sec,
        `one fat run made the run list ${(afterBig / beforeBig.ms).toFixed(1)}x slower ` +
          `(${fmtMs(beforeBig.ms)} -> ${fmtMs(afterBig)}): /api/runs counts every event of every run ` +
          'on every call, so the home screen degrades with total events stored, not runs.',
      );
    }

    const dbBefore = await server.dbSizes();
    row(sec, 'sqlite before prune', fmtBytes(dbBefore.total), `${runCount + 1} runs`);

    // Retention: keep the 50 most recent runs.
    const keepRuns = num(flags, 'keep-runs', 50);
    const pruned = await server.prune({ keepRuns, keepDays: 30 });
    row(
      sec,
      `prune(keepRuns=${keepRuns})`,
      `${String(pruned['runsDeleted'])} runs, ${Number(pruned['eventsDeleted']).toLocaleString('en-US')} events`,
      `${fmtMs(Number(pruned['ms']))}, db now ${fmtBytes(Number(pruned['total']))}`,
    );
    check(
      sec,
      'prune deleted the expected number of runs',
      Number(pruned['runsDeleted']) === runCount + 1 - keepRuns,
      `deleted ${String(pruned['runsDeleted'])}, expected ${runCount + 1 - keepRuns}`,
    );

    const afterPrune = await server.dbSizes();
    row(
      sec,
      'sqlite after prune (no vacuum)',
      fmtBytes(afterPrune.total),
      `${(((dbBefore.total - afterPrune.total) / dbBefore.total) * 100).toFixed(1)}% reclaimed on disk`,
    );
    if (afterPrune.total > dbBefore.total * 0.8) {
      finding(
        sec,
        'prune deletes rows but the file does not shrink — SQLite keeps the free pages. ' +
          'Nothing in the server ever calls vacuum(), so the database only ever grows on disk.',
      );
    }

    const vacuumed = await server.vacuum();
    row(
      sec,
      'sqlite after VACUUM',
      fmtBytes(Number(vacuumed['total'])),
      `${fmtMs(Number(vacuumed['ms']))} to run`,
    );

    const afterPruneList = await server.api<{ runs: unknown[] }>('/api/runs');
    row(
      sec,
      'GET /api/runs after prune',
      fmtMs(afterPruneList.ms),
      `${afterPruneList.body.runs.length} runs left`,
    );
    check(
      sec,
      'the run list still works after pruning',
      afterPruneList.status === 200 && afterPruneList.body.runs.length === keepRuns,
      `${afterPruneList.body.runs.length} runs`,
    );

    sec.data['retention'] = {
      curve,
      afterBigMs: afterBig,
      beforeBigMs: beforeBig.ms,
      dbBefore: dbBefore.total,
      dbAfterPrune: afterPrune.total,
      dbAfterVacuum: Number(vacuumed['total']),
      pruned,
    };

    await session.dispose();
    return sec;
  } finally {
    await server.close();
    server.cleanup();
  }
}
