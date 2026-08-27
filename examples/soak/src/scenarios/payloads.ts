/**
 * Scenario 2 — oversized and pathological payloads.
 *
 * `MAX_PAYLOAD_BYTES` in packages/cli/src/storage.ts is 512KB: past that the
 * server stores a truncation marker instead of the payload. This walks the
 * size ladder either side of that guard and up to multi-megabyte frames, and
 * separately walks JSON nesting depth, asking four questions of each case:
 *
 *   1. does the instrumented app survive (never throws into the host)?
 *   2. what does storage hold afterwards?
 *   3. does a viewer watching live see the SAME thing it gets on replay?
 *   4. can the viewer still PARSE what it gets on replay?
 *
 * Cases are matched positionally: the whole payload is replaced when it is
 * truncated, so a marker field inside the payload cannot survive to identify
 * it. Each case emits `node.started` (small, intact) then `node.finished`
 * (the specimen), so the specimen is the next `node.finished` in seq order.
 */
import { parseEnvelope } from '@graphmind-ai/schema';
import { SoakServer } from '../server-handle.ts';
import { UiProbe } from '../ui-probe.ts';
import { makeSession } from '../driver.ts';
import { fetchAllEvents, type StoredEnvelope } from '../verify.ts';
import { check, finding, row, section, type Section } from '../report.ts';
import { bool, deepObject, delay, filler, fmtBytes, until, type Flags } from '../util.ts';

const KB = 1024;

interface Specimen {
  label: string;
  nodeId: string;
  /** Approximate serialized size of the payload we emit. */
  sentBytes: number;
}

const SIZE_LADDER = [64 * KB, 256 * KB, 511 * KB, 513 * KB, 2048 * KB, 8192 * KB, 32768 * KB];
const DEPTH_LADDER = [64, 512, 4_096, 20_000, 100_000];

function isTruncated(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __graphmindTruncated?: unknown }).__graphmindTruncated === true
  );
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null');
  } catch {
    return -1;
  }
}

/**
 * Walk events in order; every `node.started` names the case, and the next
 * `node.finished` is that case's specimen.
 */
function pairUp(events: readonly { type: string; payload: unknown }[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let pending: string | undefined;
  for (const event of events) {
    const payload = event.payload as { nodeId?: unknown } | null;
    if (event.type === 'node.started' && payload !== null && typeof payload?.nodeId === 'string') {
      pending = payload.nodeId;
      continue;
    }
    if (event.type === 'node.finished' && pending !== undefined) {
      out.set(pending, event.payload);
      pending = undefined;
    }
  }
  return out;
}

export async function payloadsScenario(flags: Flags): Promise<Section> {
  const sec = section('payloads — oversized and deeply nested');
  const server = await SoakServer.start({ verbose: bool(flags, 'verbose') });
  server.startPsSampler(250);

  try {
    const probe = await UiProbe.connect(server.uiUrl, { keepRaw: true });
    probe.subscribe('*');
    const session = makeSession(server.ingestUrl);
    const attached = await session.ready({ timeoutMs: 5000 });
    check(sec, 'client attached', attached);

    const specimens: Specimen[] = [];
    const rssAfter = new Map<string, number>();
    let hostThrew: string | undefined;
    let runId = '';

    const baseline = await server.gc();

    await session.run('payload-ladder', async (ctx) => {
      runId = ctx.runId;
      session.emit('node.started', {
        nodeId: 'agent:payloads',
        kind: 'agent',
        name: 'payloads',
        instanceId: 'run-0',
      });
      session.emit('node.finished', {
        nodeId: 'agent:payloads',
        instanceId: 'run-0',
        durationMs: 0,
        status: 'ok',
      });
      await until(() => probe.runs.get(ctx.runId) !== undefined, {
        timeoutMs: 5000,
        intervalMs: 20,
        label: 'viewer to subscribe',
      });

      const emitCase = async (label: string, nodeId: string, output: unknown): Promise<void> => {
        try {
          session.emit('node.started', {
            nodeId,
            parentId: 'agent:payloads',
            kind: 'tool',
            name: label,
            instanceId: `${nodeId}#0`,
          });
          session.emit('node.finished', {
            nodeId,
            instanceId: `${nodeId}#0`,
            output,
            durationMs: 1,
            status: 'ok',
          });
        } catch (error) {
          hostThrew = `${label}: ${String(error)}`;
        }
        specimens.push({ label, nodeId, sentBytes: jsonBytes(output) });
        await delay(400);
        rssAfter.set(nodeId, (await server.gc()).rss);
      };

      for (const bytes of SIZE_LADDER) {
        await emitCase(`${fmtBytes(bytes)}`, `tool:size-${bytes}`, {
          body: filler(bytes, 'x'.repeat(64)),
        });
      }
      for (const depth of DEPTH_LADDER) {
        await emitCase(`depth ${depth}`, `tool:depth-${depth}`, deepObject(depth));
      }

      // Cyclic payload: JSON.stringify throws. The client must swallow it.
      const cyclic: Record<string, unknown> = { name: 'cycle' };
      cyclic['self'] = cyclic;
      try {
        session.emit('node.started', {
          nodeId: 'tool:cyclic',
          parentId: 'agent:payloads',
          kind: 'tool',
          name: 'cyclic',
          instanceId: 'cyclic#0',
        });
        session.emit('node.finished', {
          nodeId: 'tool:cyclic',
          instanceId: 'cyclic#0',
          output: cyclic,
          durationMs: 1,
          status: 'ok',
        });
      } catch (error) {
        hostThrew = `cyclic: ${String(error)}`;
      }
      await delay(400);
    });

    check(sec, 'session.emit never threw into the host app', hostThrew === undefined, hostThrew);

    await delay(600);
    const stored = await fetchAllEvents(server, runId);
    const storedByNode = pairUp(stored.events);
    const trace = probe.runs.get(runId);
    const liveByNode = pairUp(
      (trace?.raw ?? []) as { type: string; payload: unknown }[],
    );
    /** Whether the viewer's own parser accepts the replayed envelope. */
    const parseable = new Map<string, boolean>();
    {
      let pending: string | undefined;
      for (const event of stored.events) {
        const payload = event.payload as { nodeId?: unknown } | null;
        if (event.type === 'node.started' && typeof payload?.nodeId === 'string') {
          pending = payload.nodeId;
          continue;
        }
        if (event.type === 'node.finished' && pending !== undefined) {
          parseable.set(pending, parseEnvelope(event as StoredEnvelope).kind === 'ok');
          pending = undefined;
        }
      }
    }

    const rows: Record<string, unknown>[] = [];
    let divergedCases = 0;
    let unparseableCases = 0;
    let firstDivergence: { label: string; live: number; storedSize: number } | undefined;

    for (const specimen of specimens) {
      const storedPayload = storedByNode.get(specimen.nodeId);
      const livePayload = liveByNode.get(specimen.nodeId);
      const storedSize = storedPayload === undefined ? 0 : jsonBytes(storedPayload);
      const liveSize = livePayload === undefined ? 0 : jsonBytes(livePayload);
      const truncated = isTruncated(storedPayload);
      const ok = parseable.get(specimen.nodeId);
      if (storedPayload !== undefined && livePayload !== undefined && liveSize > storedSize * 2) {
        divergedCases += 1;
        firstDivergence ??= { label: specimen.label, live: liveSize, storedSize };
      }
      if (storedPayload !== undefined && ok === false) unparseableCases += 1;
      rows.push({
        label: specimen.label,
        sentBytes: specimen.sentBytes,
        storedBytes: storedSize,
        liveBytes: liveSize,
        truncated,
        parseable: ok,
        rss: rssAfter.get(specimen.nodeId) ?? 0,
      });
      row(
        sec,
        specimen.label,
        storedPayload === undefined
          ? 'NOT STORED'
          : `stored ${fmtBytes(storedSize)}${truncated ? ' (marker)' : ''}`,
        `${livePayload === undefined ? 'not seen live' : `live ${fmtBytes(liveSize)}`}` +
          `${ok === false ? ', viewer CANNOT parse the replay' : ''}` +
          `, server RSS ${fmtBytes(rssAfter.get(specimen.nodeId) ?? 0)}`,
      );
    }

    const under = rows.find((r) => r['label'] === fmtBytes(511 * KB));
    const over = rows.find((r) => r['label'] === fmtBytes(513 * KB));
    check(
      sec,
      '511KB payload stored intact',
      under !== undefined && Number(under['storedBytes']) > 500 * KB && under['truncated'] === false,
      under === undefined ? 'missing' : fmtBytes(Number(under['storedBytes'])),
    );
    check(
      sec,
      '513KB payload replaced by the truncation marker',
      over !== undefined && over['truncated'] === true,
      over === undefined ? 'missing' : fmtBytes(Number(over['storedBytes'])),
    );

    row(
      sec,
      'live vs replay',
      divergedCases === 0
        ? 'identical for every case'
        : `${divergedCases} case(s) differ, first ${firstDivergence?.label}: live ${fmtBytes(firstDivergence?.live ?? 0)} vs stored ${fmtBytes(firstDivergence?.storedSize ?? 0)}`,
      'the storage guard is not applied to the fan-out path',
    );
    if (divergedCases > 0) {
      finding(
        sec,
        'the 512KB guard protects SQLite but not the socket: hub.ts fans out the ORIGINAL envelope ' +
          `(up to ${fmtBytes(32 * 1024 * KB)} here) to every attached viewer before storage trims it. ` +
          'A live viewer renders detail that vanishes on reload, and one huge tool result is relayed ' +
          'in full to every open viewer with no size cap.',
      );
    }

    check(
      sec,
      'every stored event is still a valid envelope the viewer can parse',
      unparseableCases === 0,
      unparseableCases === 0 ? 'all parseable' : `${unparseableCases} case(s) rejected by parseEnvelope`,
    );
    if (unparseableCases > 0) {
      finding(
        sec,
        'a truncated payload replaces the WHOLE payload object, so the stored node.finished loses ' +
          'nodeId/status/durationMs and fails its own schema on replay. ingest.ts drops it as invalid: ' +
          'the node never leaves the "running" state when the run is reloaded.',
      );
    }

    // The point of keeping the small fields: a truncated event must still tell
    // the viewer which node finished and how.
    const oversized = storedByNode.get(`tool:size-${2048 * KB}`) as Record<string, unknown> | undefined;
    check(
      sec,
      'a truncated event still carries the fields the canvas needs',
      oversized !== undefined &&
        oversized['nodeId'] === `tool:size-${2048 * KB}` &&
        oversized['status'] === 'ok' &&
        typeof oversized['durationMs'] === 'number',
      oversized === undefined
        ? 'missing'
        : `nodeId=${String(oversized['nodeId'])} status=${String(oversized['status'])} truncated fields=${JSON.stringify(oversized['fields'])}`,
    );

    // Is the RSS high-water mark a leak or a plateau? Repeat the biggest frame
    // the process has already survived and watch whether it keeps climbing.
    const plateau: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      await session.run(`plateau-${round}`, async () => {
        session.emit('node.started', {
          nodeId: 'tool:plateau',
          kind: 'tool',
          name: 'plateau',
          instanceId: `p${round}`,
        });
        session.emit('node.finished', {
          nodeId: 'tool:plateau',
          instanceId: `p${round}`,
          output: { body: filler(8 * 1024 * KB, 'x'.repeat(64)) },
          durationMs: 1,
          status: 'ok',
        });
        await delay(400);
      });
      plateau.push((await server.gc()).rss);
    }
    row(
      sec,
      '8MB frame repeated 4x',
      plateau.map((rss) => fmtBytes(rss)).join(' -> '),
      'RSS after a forced GC each round',
    );
    const climbed = (plateau[plateau.length - 1] ?? 0) - (plateau[0] ?? 0);
    check(
      sec,
      'repeated oversized frames do not leak (RSS plateaus)',
      climbed < 40 * 1024 * KB,
      `${fmtBytes(climbed)} across 4 rounds`,
    );
    sec.data['plateau'] = plateau;

    // Everything after the biggest frame must still work.
    let afterOk = false;
    await session.run('after-the-storm', async (ctx) => {
      session.emit('node.started', {
        nodeId: 'tool:after',
        kind: 'tool',
        name: 'after',
        instanceId: 'a0',
      });
      await until(
        async () => {
          const response = await server.api<{ runs: { id: string; eventCount: number }[] }>('/api/runs');
          const run = response.body.runs.find((r) => r.id === ctx.runId);
          afterOk = run !== undefined && run.eventCount >= 2;
          return afterOk;
        },
        { timeoutMs: 10_000, intervalMs: 50, label: 'a later run to land' },
      ).catch(() => 0);
    });
    check(sec, 'ingest still healthy after the largest frame', afterOk);

    const after = await server.gc();
    const db = await server.dbSizes();
    row(
      sec,
      'server RSS',
      `${fmtBytes(baseline.rss)} idle -> ${fmtBytes(after.rss)} after GC`,
      `retained ${fmtBytes(after.rss - baseline.rss)} after one pass of the ladder`,
    );
    row(sec, 'sqlite on disk', fmtBytes(db.total));
    if (server.logs.length > 0) row(sec, 'server log', server.logs.slice(-3).join(' | '));

    if (after.rss - baseline.rss > 100 * 1024 * 1024) {
      finding(
        sec,
        `${fmtBytes(after.rss - baseline.rss)} of RSS survives a forced GC after the size ladder — ` +
          'a handful of multi-MB frames permanently inflate the server process.',
      );
    }

    sec.data['payloads'] = { rows, baselineRss: baseline.rss, afterRss: after.rss, dbBytes: db.total };

    await probe.close();
    await session.dispose();
    return sec;
  } finally {
    await server.close();
    server.cleanup();
  }
}
