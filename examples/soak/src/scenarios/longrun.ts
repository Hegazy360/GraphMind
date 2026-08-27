/**
 * Scenario 7 — the long-lived run (minutes of wall clock, with idle gaps).
 *
 * The server pings every socket every 30s and terminates any socket that
 * missed the previous ping (hub.pingAll). Nothing in the client answers those
 * pings explicitly: it relies on the WebSocket implementation replying with a
 * pong at protocol level. If that assumption is wrong on any runtime, an
 * agent that sits idle for two ping intervals — a human thinking at a gate, a
 * cron-driven agent, an overnight batch — gets silently detached and every
 * later event is lost. This is the scenario that finds out, using the DEFAULT
 * platform WebSocket, because that is what a real instrumented app gets.
 *
 * It also answers: does anything drift over minutes (RSS, sockets, timers),
 * and does the control path (breakpoint -> gate hold -> exec.resume) still
 * route back into the app after long idleness?
 */
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';
import { WebSocket } from 'ws';
import { SoakServer } from '../server-handle.ts';
import { UiProbe } from '../ui-probe.ts';
import { makeSession } from '../driver.ts';
import { fetchAllEvents } from '../verify.ts';
import { check, finding, row, section, type Section } from '../report.ts';
import { bool, delay, fmtBytes, fmtMs, num, percentiles, until, type Flags } from '../util.ts';

export async function longRunScenario(flags: Flags): Promise<Section> {
  const sec = section('long run — idle gaps, ping reaping, drift');
  const gapSeconds = num(flags, 'gap', 75);
  const gapCount = num(flags, 'gaps', 3);
  const burstEvents = num(flags, 'burst', 400);
  const pingIntervalMs = num(flags, 'ping-interval', 30_000);

  // The real default ping interval, on purpose: the reaping window is
  // 2 x pingInterval, and a gap has to be wider than that to prove anything.
  const server = await SoakServer.start({
    pingIntervalMs,
    memIntervalMs: 1000,
    verbose: bool(flags, 'verbose'),
  });
  server.startPsSampler(1000);

  try {
    const probe = await UiProbe.connect(server.uiUrl);
    probe.subscribe('*');
    // A second viewer that answers pauses, so the gate check at the end has
    // someone on the other side of it.
    const resumer = autoResumer(server.uiUrl);
    // Default platform WebSocket (undici on Node >= 22) — no injection.
    const session = makeSession(server.ingestUrl, { bufferSize: 4000 });
    const attached = await session.ready({ timeoutMs: 5000 });
    check(sec, 'client attached', attached);

    const baseline = await server.gc();
    const startedAt = Date.now();
    let runId = '';
    let ordinal = 0;
    const phases: {
      phase: string;
      attachedAfter: boolean;
      storedAfter: number;
      rss: number;
      lagMs: number;
    }[] = [];
    let detachments = 0;

    const emitBurst = (count: number): void => {
      for (let i = 0; i < count; i += 1) {
        session.emit('node.token', {
          nodeId: 'llm:step',
          deltas: [{ t: 'text', v: `t${ordinal}` }],
          i: ordinal,
        } as never);
        ordinal += 1;
      }
    };

    row(
      sec,
      'plan',
      `${gapCount} idle gaps of ${gapSeconds}s around ${burstEvents}-event bursts`,
      `server ping interval ${fmtMs(pingIntervalMs)}, reaped after ${fmtMs(pingIntervalMs * 2)} silent`,
    );

    await session.run('long-lived', async (ctx) => {
      runId = ctx.runId;
      session.emit('node.started', {
        nodeId: 'llm:step',
        kind: 'llm',
        name: 'step',
        instanceId: 's0',
      });

      for (let phase = 0; phase <= gapCount; phase += 1) {
        emitBurst(burstEvents);
        const expected = ordinal;
        const lag = await until(
          async () => {
            const events = await fetchAllEvents(server, ctx.runId);
            let max = -1;
            for (const event of events.events) {
              const payload = event.payload as { i?: unknown } | null;
              if (payload !== null && typeof payload?.i === 'number') max = Math.max(max, payload.i);
            }
            return max >= expected - 1;
          },
          { timeoutMs: 30_000, intervalMs: 200, label: `burst ${phase} to land` },
        ).catch(() => -1);

        const stored = (await fetchAllEvents(server, ctx.runId)).events.length;
        phases.push({
          phase: `burst ${phase}`,
          attachedAfter: session.attached,
          storedAfter: stored,
          rss: server.psRss[server.psRss.length - 1]?.rss ?? 0,
          lagMs: lag,
        });
        if (!session.attached) detachments += 1;

        if (phase < gapCount) {
          // Idle: no events at all, longer than the reaping window.
          await delay(gapSeconds * 1000);
          phases.push({
            phase: `after ${gapSeconds}s idle`,
            attachedAfter: session.attached,
            storedAfter: stored,
            rss: server.psRss[server.psRss.length - 1]?.rss ?? 0,
            lagMs: 0,
          });
          if (!session.attached) detachments += 1;
        }
      }

      // Control path after all that idleness: pause-on-error is armed by
      // default (decisions.md #8), so an `error` gate must hold, and the
      // viewer's exec.resume must find its way back into this process.
      const pausePromise = session.gate('error', {
        nodeId: 'tool:flaky',
        kind: 'tool',
        name: 'flaky',
      });
      const resumed = await Promise.race([
        pausePromise.then(() => 'resumed' as const),
        delay(8000).then(() => 'timeout' as const),
      ]);
      check(
        sec,
        'a gate still holds and resumes after minutes of idleness',
        resumed === 'resumed',
        resumed,
      );
    });

    for (const phase of phases) {
      row(
        sec,
        phase.phase,
        phase.attachedAfter ? 'attached' : 'DETACHED',
        `${phase.storedAfter.toLocaleString('en-US')} events stored, RSS ${fmtBytes(phase.rss)}` +
          (phase.lagMs > 0 ? `, burst landed in ${fmtMs(phase.lagMs)}` : ''),
      );
    }

    check(
      sec,
      'the app stayed attached across every idle gap',
      detachments === 0,
      `${detachments} detachment(s) observed`,
    );
    if (detachments > 0) {
      finding(
        sec,
        'the default platform WebSocket did not keep the connection alive through the server ping ' +
          'reaper: an idle agent is silently detached after two ping intervals and everything it emits ' +
          'afterwards is buffered, then lost if the gap outlives the ring buffer.',
      );
    }

    const stored = await fetchAllEvents(server, runId);
    const seen = new Set<number>();
    for (const event of stored.events) {
      const payload = event.payload as { i?: unknown } | null;
      if (payload !== null && typeof payload?.i === 'number') seen.add(payload.i);
    }
    const missing: number[] = [];
    for (let i = 0; i < ordinal; i += 1) if (!seen.has(i)) missing.push(i);
    check(
      sec,
      'every event emitted across the whole session survived',
      missing.length === 0,
      `${seen.size}/${ordinal} present, ${missing.length} lost`,
    );

    // The viewer socket has to survive the same gaps.
    check(sec, 'the viewer socket survived the idle gaps', probe.open);

    // Was the run still shown as live at the end?
    const runsCall = await server.api<{ runs: { id: string; live: boolean; status: string }[] }>(
      '/api/runs',
    );
    const runInfo = runsCall.body.runs.find((run) => run.id === runId);
    row(sec, 'run at the end', `${runInfo?.status ?? 'missing'}, live=${String(runInfo?.live)}`);

    const totalMinutes = (Date.now() - startedAt) / 60_000;
    const after = await server.gc();
    const rssSamples = server.psSince(startedAt).map((sample) => sample.rss);
    const rssStats = percentiles(rssSamples);
    row(
      sec,
      `RSS over ${totalMinutes.toFixed(1)} minutes`,
      `${fmtBytes(baseline.rss)} start -> ${fmtBytes(rssStats.max)} peak -> ${fmtBytes(after.rss)} end (after GC)`,
      `${rssSamples.length} samples, median ${fmtBytes(rssStats.p50)}`,
    );
    check(
      sec,
      'no unbounded memory growth over the session',
      after.rss - baseline.rss < 80 * 1024 * 1024,
      `drift ${fmtBytes(after.rss - baseline.rss)}`,
    );

    sec.data['longrun'] = {
      minutes: totalMinutes,
      gapSeconds,
      gapCount,
      events: ordinal,
      detachments,
      missing: missing.length,
      rssBaseline: baseline.rss,
      rssPeak: rssStats.max,
      rssEnd: after.rss,
      phases,
      serverLogs: server.logs.slice(-20),
    };

    resumer.close();
    await probe.close();
    await session.dispose();
    return sec;
  } finally {
    await server.close();
    server.cleanup();
  }
}

/**
 * A viewer that resumes any pause it sees. The long run needs one so the gate
 * check at the end has someone to answer it.
 */
export function autoResumer(url: string): { close: () => void } {
  const socket = new WebSocket(url);
  let seq = 0;
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', runId: '*' })));
  const subscribed = new Set<string>();
  socket.on('message', (data) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame['type'] === 'runs' || frame['type'] === 'run.update') {
      const runs = (frame['type'] === 'runs' ? frame['runs'] : [frame['run']]) as { id: string }[];
      for (const run of runs) {
        if (run !== undefined && !subscribed.has(run.id)) {
          subscribed.add(run.id);
          socket.send(JSON.stringify({ type: 'subscribe', runId: run.id }));
        }
      }
      return;
    }
    if (frame['type'] !== 'event') return;
    const envelope = frame['envelope'] as { type: string; runId: string; payload: { pauseId: string } };
    if (envelope.type !== 'exec.paused') return;
    socket.send(
      JSON.stringify({
        type: 'control',
        envelope: {
          gm: PROTOCOL_VERSION,
          seq: seq++,
          ts: Date.now(),
          runId: envelope.runId,
          type: 'exec.resume',
          payload: { pauseId: envelope.payload.pauseId, action: 'continue' },
        },
      }),
    );
  });
  return { close: () => socket.close() };
}
