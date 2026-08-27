/**
 * Scenario 3 — disconnect and reconnect mid-run.
 *
 * Four separate questions, because "reconnect" means two different things:
 *
 *  A. the APP's socket drops mid-run and comes back. Events emitted while
 *     detached live only in the client's ring buffer (default 2000). What
 *     survives, and what silently does not?
 *  B. the same, with more events lost than the buffer can hold — how big is
 *     the hole, and does anything anywhere notice?
 *  C. the VIEWER disconnects and reconnects: replay-on-attach must give it
 *     the whole run exactly once, in order (decisions.md #5).
 *  D. how long is an app dark after a blip if nobody calls `ready()` again —
 *     i.e. what does the shipped default actually cost?
 */
import { SoakServer } from '../server-handle.ts';
import { UiProbe } from '../ui-probe.ts';
import { makeSession } from '../driver.ts';
import { TrackedWebSocket } from '../tracked-ws.ts';
import { fetchAllEvents, verifyTrace } from '../verify.ts';
import { check, finding, row, section, type Section } from '../report.ts';
import { bool, delay, fmtMs, num, until, type Flags } from '../util.ts';

/** Emit `count` ordinal-stamped token events starting at `from`. */
function emitBatch(
  session: { emit: (type: 'node.token', payload: never) => void },
  nodeId: string,
  from: number,
  count: number,
): void {
  for (let i = 0; i < count; i += 1) {
    session.emit('node.token', {
      nodeId,
      deltas: [{ t: 'text', v: `chunk-${from + i}` }],
      i: from + i,
    } as never);
  }
}

interface GapReport {
  stored: number;
  expected: number;
  missing: number[];
  duplicates: number;
  inversions: number;
}

async function collectOrdinals(server: SoakServer, runId: string, expected: number): Promise<GapReport> {
  const { events } = await fetchAllEvents(server, runId);
  const seen = new Map<number, number>();
  let inversions = 0;
  let last = -1;
  for (const event of events) {
    const payload = event.payload as { i?: unknown } | null;
    if (payload === null || typeof payload?.i !== 'number') continue;
    seen.set(payload.i, (seen.get(payload.i) ?? 0) + 1);
    if (payload.i < last) inversions += 1;
    last = payload.i;
  }
  const missing: number[] = [];
  let duplicates = 0;
  for (let i = 0; i < expected; i += 1) {
    const count = seen.get(i) ?? 0;
    if (count === 0) missing.push(i);
    else if (count > 1) duplicates += count - 1;
  }
  return { stored: seen.size, expected, missing, duplicates, inversions };
}

export async function reconnectScenario(flags: Flags): Promise<Section> {
  const sec = section('reconnect — app blips and viewer reloads');
  const server = await SoakServer.start({ verbose: bool(flags, 'verbose') });

  try {
    // ---- A: app blip, loss inside the ring buffer -------------------------
    {
      TrackedWebSocket.reset();
      const probe = await UiProbe.connect(server.uiUrl);
      probe.subscribe('*');
      const session = makeSession(server.ingestUrl, {
        webSocket: TrackedWebSocket,
        bufferSize: 2000,
        retryIntervalMs: 500,
      });
      await session.ready({ timeoutMs: 5000 });

      const before = num(flags, 'before', 500);
      const dark = num(flags, 'dark', 300);
      const after = num(flags, 'after', 500);
      let runId = '';
      await session.run('blip-small', async (ctx) => {
        runId = ctx.runId;
        session.emit('node.started', {
          nodeId: 'llm:step',
          kind: 'llm',
          name: 'step',
          instanceId: 's0',
        });
        emitBatch(session as never, 'llm:step', 0, before);
        await delay(300);
        TrackedWebSocket.latest?.terminate();
        await delay(150);
        check(sec, 'A: client noticed the drop', !session.attached);
        emitBatch(session as never, 'llm:step', before, dark);
        const reattached = await session.ready({ timeoutMs: 5000 });
        check(sec, 'A: client reattached', reattached);
        emitBatch(session as never, 'llm:step', before + dark, after);
        await delay(600);
      });

      const total = before + dark + after;
      await until(
        async () => (await collectOrdinals(server, runId, total)).stored >= total,
        { timeoutMs: 15_000, intervalMs: 100, label: 'stored ordinals to settle' },
      ).catch(() => 0);
      const gap = await collectOrdinals(server, runId, total);
      row(
        sec,
        `A: ${dark} events emitted while dark (buffer 2000)`,
        `${gap.stored}/${total} stored`,
        `${gap.missing.length} lost, ${gap.duplicates} duplicated`,
      );
      check(
        sec,
        'A: nothing lost when the dark window fits the ring buffer',
        gap.missing.length === 0,
        `${gap.missing.length} missing`,
      );
      check(
        sec,
        'A: replay-on-attach did not duplicate anything in storage',
        gap.duplicates === 0 && gap.inversions === 0,
        `${gap.duplicates} dup, ${gap.inversions} inversions`,
      );
      const trace = probe.runs.get(runId);
      const traced = verifyTrace(trace?.order ?? [], total);
      check(
        sec,
        'A: the attached viewer saw no duplicates either',
        traced.duplicates === 0,
        `${traced.duplicates} duplicated, ${traced.missing} missing at the viewer`,
      );
      sec.data['blipSmall'] = gap;
      await probe.close();
      await session.dispose();
    }

    // ---- B: app blip wider than the ring buffer ---------------------------
    {
      TrackedWebSocket.reset();
      const bufferSize = num(flags, 'buffer', 500);
      const session = makeSession(server.ingestUrl, {
        webSocket: TrackedWebSocket,
        bufferSize,
        retryIntervalMs: 500,
      });
      await session.ready({ timeoutMs: 5000 });
      const before = 200;
      const dark = num(flags, 'dark-big', 3000);
      const after = 200;
      let runId = '';
      await session.run('blip-overflow', async (ctx) => {
        runId = ctx.runId;
        session.emit('node.started', {
          nodeId: 'llm:step',
          kind: 'llm',
          name: 'step',
          instanceId: 's0',
        });
        emitBatch(session as never, 'llm:step', 0, before);
        await delay(300);
        TrackedWebSocket.latest?.terminate();
        await delay(150);
        emitBatch(session as never, 'llm:step', before, dark);
        await session.ready({ timeoutMs: 5000 });
        emitBatch(session as never, 'llm:step', before + dark, after);
        await delay(800);
      });
      const total = before + dark + after;
      const gap = await collectOrdinals(server, runId, total);
      const stats = session.stats();
      row(
        sec,
        `B: ${dark} events emitted while dark (buffer ${bufferSize})`,
        `${gap.stored}/${total} stored`,
        `${gap.missing.length} lost for good; client counted ${stats.dropped} ring-buffer drops`,
      );
      check(
        sec,
        'B: the client reports the loss it caused',
        stats.dropped > 0,
        `session.stats().dropped = ${stats.dropped}`,
      );
      if (gap.missing.length > 0) {
        finding(
          sec,
          `a disconnect longer than the ring buffer loses events with no gap marker anywhere: ` +
            `${gap.missing.length} of ${total} never reached the server, and neither the stored run ` +
            `(seq numbers simply skip) nor the viewer has any way to know. Only session.stats().dropped ` +
            `knows, and nothing emits it.`,
        );
      }
      sec.data['blipOverflow'] = { ...gap, dropped: stats.dropped, bufferSize };
      await session.dispose();
    }

    // ---- C: viewer reloads mid-run ----------------------------------------
    {
      TrackedWebSocket.reset();
      const first = await UiProbe.connect(server.uiUrl);
      first.subscribe('*');
      const session = makeSession(server.ingestUrl, { webSocket: TrackedWebSocket });
      await session.ready({ timeoutMs: 5000 });
      const total = num(flags, 'viewer-events', 3000);
      let runId = '';
      await session.run('viewer-reload', async (ctx) => {
        runId = ctx.runId;
        session.emit('node.started', {
          nodeId: 'llm:step',
          kind: 'llm',
          name: 'step',
          instanceId: 's0',
        });
        emitBatch(session as never, 'llm:step', 0, Math.floor(total * 0.4));
        await delay(250);
        await first.close(); // the viewer tab goes away mid-run
        emitBatch(session as never, 'llm:step', Math.floor(total * 0.4), Math.ceil(total * 0.6));
        await delay(400);
      });

      const second = await UiProbe.connect(server.uiUrl);
      second.subscribe('*');
      await until(() => (second.runs.get(runId)?.order.length ?? 0) >= total, {
        timeoutMs: 20_000,
        intervalMs: 50,
        label: 'the reloaded viewer to replay the whole run',
      });
      const trace = second.runs.get(runId);
      const traced = verifyTrace(trace?.order ?? [], total);
      row(
        sec,
        'C: viewer reconnect replay',
        `${trace?.order.length ?? 0} frames for ${total} events`,
        `replay window ${(trace?.replayStarts ?? []).join(',')}, ${trace?.replayEnds ?? 0} replay.end`,
      );
      check(
        sec,
        'C: a reloaded viewer gets the whole run exactly once, in order',
        traced.missing === 0 && traced.duplicates === 0 && traced.inversions === 0,
        `missing ${traced.missing}, dup ${traced.duplicates}, inversions ${traced.inversions}`,
      );
      const firstTrace = first.runs.get(runId);
      row(
        sec,
        'C: first viewer before it closed',
        `${firstTrace?.order.length ?? 0} frames`,
      );
      sec.data['viewerReload'] = traced;
      await second.close();
      await session.dispose();
    }

    // ---- D: what a blip costs with the shipped defaults --------------------
    {
      TrackedWebSocket.reset();
      const session = makeSession(server.ingestUrl, { webSocket: TrackedWebSocket }); // default 10s retry
      await session.ready({ timeoutMs: 5000 });
      let runId = '';
      let darkMs = 0;
      await session.run('default-retry', async (ctx) => {
        runId = ctx.runId;
        session.emit('node.started', {
          nodeId: 'llm:step',
          kind: 'llm',
          name: 'step',
          instanceId: 's0',
        });
        await delay(200);
        TrackedWebSocket.latest?.terminate();
        await until(() => !session.attached, {
          timeoutMs: 5000,
          intervalMs: 10,
          label: 'the client to notice the drop',
        });
        const droppedAt = performance.now();
        // No ready() this time: a real agent just keeps working.
        const timer = setInterval(() => {
          session.emit('node.token', {
            nodeId: 'llm:step',
            deltas: [{ t: 'text', v: 'tick' }],
          } as never);
        }, 100);
        try {
          await until(() => session.attached, {
            timeoutMs: 30_000,
            intervalMs: 50,
            label: 'the background retry to reconnect',
          });
          darkMs = performance.now() - droppedAt;
        } finally {
          clearInterval(timer);
        }
        await delay(400);
      });
      row(
        sec,
        'D: dark time after a blip (defaults)',
        fmtMs(darkMs),
        'no ready() call — just the built-in background retry',
      );
      check(sec, 'D: the client reconnects on its own', darkMs > 0 && session.attached);
      if (darkMs > 5000) {
        finding(
          sec,
          `retryIntervalMs defaults to 10s and there is no backoff ramp *down*: an app is blind for ` +
            `${fmtMs(darkMs)} after any blip, and at production rates that is more than the 2000-event ` +
            `ring buffer holds — so a blip on a busy run is data loss, not just delay.`,
        );
      }
      const { events } = await fetchAllEvents(server, runId);
      row(sec, 'D: events stored for that run', String(events.length));
      sec.data['defaultRetry'] = { darkMs };
      await session.dispose();
    }

    return sec;
  } finally {
    await server.close();
    server.cleanup();
  }
}
