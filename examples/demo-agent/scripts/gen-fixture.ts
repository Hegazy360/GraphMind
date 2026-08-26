/**
 * Regenerates the demo fixture bundled inside packages/cli.
 *
 * Procedure (all real, nothing synthesized except the splice):
 *  1. Start an in-process graphmind-ai server (ephemeral port, tmp db).
 *  2. Run the mock trip planner against it TWICE, with a headless debugger
 *     on the UI socket resolving the planted-bug pause differently:
 *       run A -> `inject` (corrected budget-check result)  — happy ending
 *       run B -> `continue`                                — error ending
 *  3. Read both runs' persisted envelope streams back from storage and
 *     splice them:
 *       base     = run A up to (and including) its `exec.paused`
 *       inject   = run A after the pause (leading `exec.resumed` stripped —
 *                  the replayer synthesizes it from the live resume)
 *       continue = run B after its pause (ditto), re-keyed onto run A's
 *                  runId + the failing node's instanceId
 *  4. Attach `branch` + `dt` (ms since the previous event of the branch)
 *     and write:
 *       packages/cli/src/demo/demo-run.ndjson   (the NDJSON fixture)
 *       packages/cli/src/demo/fixture-data.ts   (same bytes, importable —
 *                                                this is what ships in dist)
 *
 * Prereq: built workspace packages (`pnpm -r build` at the repo root) —
 * this script imports the `graphmind-ai` package entry. Run with:
 *   pnpm --filter demo-agent gen:fixture
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, parseEnvelope } from '@graphmind/schema';
import { startServer, type StoredEvent } from 'graphmind-ai';
import WebSocket from 'ws';
import { runTripPlanner } from '../src/agent.js';

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'packages', 'cli', 'src', 'demo',
);

/** The corrected result the demo debugger injects (matches checkBudget's ok shape). */
const INJECTED_OUTPUT = {
  ok: true,
  totalUsd: 2693.4,
  budgetUsd: 3800,
  remainingUsd: 1106.6,
  note: 'corrected by the debugger — convertCurrency inverted the rate',
};

interface FixtureLine {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: unknown;
  branch: 'base' | 'inject' | 'continue';
  dt: number;
}

/** Headless viewer that resolves the first pause with `action`. */
function startDebugger(port: number, action: 'inject' | 'continue') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`);
  const subscribed = new Set<string>();
  let seq = 0;
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  const ready = new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      send({ type: 'subscribe', runId: '*' });
      resolve();
    });
    ws.once('error', reject);
  });
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Record<string, any>;
    if (frame['type'] === 'runs' || frame['type'] === 'run.update') {
      const runs = frame['type'] === 'runs' ? frame['runs'] : [frame['run']];
      for (const run of runs) {
        if (run !== undefined && run !== null && !subscribed.has(run.id)) {
          subscribed.add(run.id);
          send({ type: 'subscribe', runId: run.id });
        }
      }
    }
    if (frame['type'] === 'event' && frame['envelope']?.type === 'exec.paused') {
      const env = frame['envelope'];
      send({
        type: 'control',
        envelope: {
          gm: PROTOCOL_VERSION,
          seq: seq++,
          ts: Date.now(),
          runId: env.runId,
          type: 'exec.resume',
          payload: {
            pauseId: env.payload.pauseId,
            action,
            ...(action === 'inject' ? { output: INJECTED_OUTPUT } : {}),
          },
        },
      });
    }
  });
  return { ready, close: () => ws.close() };
}

/**
 * Split a captured run at its pause. Events that landed BETWEEN
 * `exec.paused` and `exec.resumed` (e.g. the llm step's `node.finished` —
 * its stream completes concurrently while the tool gate holds) are folded
 * into the head just before the pause, so the replayed base is silent while
 * held, exactly like the recorded hold was.
 */
function splitAtPause(events: StoredEvent[], label: string) {
  const pauseIdx = events.findIndex((e) => e.type === 'exec.paused');
  if (pauseIdx === -1) throw new Error(`${label}: no exec.paused captured`);
  const resumedIdx = events.findIndex((e, i) => i > pauseIdx && e.type === 'exec.resumed');
  if (resumedIdx === -1) throw new Error(`${label}: no exec.resumed captured`);
  const held = events.slice(pauseIdx + 1, resumedIdx);
  return {
    head: [...events.slice(0, pauseIdx), ...held, events[pauseIdx] as StoredEvent],
    tail: events.slice(resumedIdx + 1),
    pause: events[pauseIdx] as StoredEvent,
  };
}

function withDt(events: StoredEvent[], branch: FixtureLine['branch'], anchorTs: number): {
  lines: Omit<FixtureLine, 'seq' | 'runId'>[];
} {
  let prev = anchorTs;
  return {
    lines: events.map((e) => {
      const dt = Math.max(0, Math.round(e.ts - prev));
      prev = e.ts;
      return { gm: PROTOCOL_VERSION, ts: e.ts, type: e.type, payload: e.payload, branch, dt };
    }),
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-fixture-'));
  const server = await startServer({
    port: 0,
    dbPath: join(dir, 'capture.db'),
    viewerDist: join(dir, 'no-viewer'),
    log: () => {},
  });
  const url = `ws://127.0.0.1:${server.port}/ingest`;

  const capture = async (action: 'inject' | 'continue'): Promise<StoredEvent[]> => {
    const before = new Set(server.storage.listRuns().map((r) => r.id));
    const dbg = startDebugger(server.port, action);
    await dbg.ready;
    const result = await runTripPlanner({ mode: 'mock', url });
    dbg.close();
    const run = server.storage.listRuns().find((r) => !before.has(r.id));
    if (run === undefined) throw new Error(`capture(${action}): run not found in storage`);
    if (run.status !== 'ok') throw new Error(`capture(${action}): run ended ${run.status}`);
    console.log(`capture(${action}): run ${run.id}, ${run.eventCount} events`);
    console.log(`  final text: ${result.text.slice(0, 90)}…`);
    return server.storage.listEvents(run.id).events;
  };

  const eventsA = await capture('inject');
  const eventsB = await capture('continue');
  await server.close();
  rmSync(dir, { recursive: true, force: true });

  const a = splitAtPause(eventsA, 'run A (inject)');
  const b = splitAtPause(eventsB, 'run B (continue)');

  const runStarted = a.head[0] as StoredEvent;
  const runId = runStarted.runId;
  const pausedNodeId = (a.pause.payload as Record<string, unknown>)['nodeId'];
  const startedIdx = a.head.findLastIndex(
    (e) => e.type === 'node.started' && (e.payload as Record<string, unknown>)['nodeId'] === pausedNodeId,
  );
  if (startedIdx === -1) throw new Error('paused node has no node.started in base');
  const instanceA = (a.head[startedIdx]?.payload as Record<string, unknown>)['instanceId'];

  // (The schema once dropped agent-node and error-path envelopes as invalid —
  // fixed by making input/output optional in @graphmind/schema; everything
  // below is captured from the real pipeline, nothing synthesized.)
  // Sanity: the inject branch really is the happy path, continue the sad one.
  const lastTextOf = (events: StoredEvent[]): string =>
    events
      .filter((e) => e.type === 'node.token')
      .flatMap((e) => ((e.payload as any).deltas as { v: string }[]).map((d) => d.v))
      .join('');
  if (!lastTextOf(a.tail).includes('fits the budget')) {
    throw new Error('inject branch does not contain the happy ending');
  }
  if (!lastTextOf(b.tail).includes('convertCurrency')) {
    throw new Error('continue branch does not name the buggy tool');
  }

  // Re-key run B's continuation onto run A's identity.
  const contTail: StoredEvent[] = b.tail.map((e) => {
    let payload = e.payload as Record<string, unknown>;
    if (payload['nodeId'] === pausedNodeId && typeof payload['instanceId'] === 'string') {
      payload = { ...payload, instanceId: instanceA };
    }
    return { ...e, payload };
  });

  const lines: FixtureLine[] = [];
  let seq = 1;
  const push = (batch: Omit<FixtureLine, 'seq' | 'runId'>[]) => {
    for (const line of batch) lines.push({ ...line, seq: seq++, runId });
  };
  push(withDt(a.head, 'base', (a.head[0] as StoredEvent).ts).lines);
  push(withDt(a.tail, 'inject', a.pause.ts).lines);
  push(withDt(contTail, 'continue', b.pause.ts).lines);

  // Every line must be a valid schema envelope (the cli test re-checks this).
  for (const line of lines) {
    const parsed = parseEnvelope(line);
    if (parsed.kind !== 'ok') {
      throw new Error(`generated line failed validation (${parsed.kind}): ${JSON.stringify(line).slice(0, 200)}`);
    }
  }

  // Scrub the recording machine's filesystem paths out of stack traces —
  // the fixture ships in the npm package and must not leak local paths.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const ndjson =
    lines
      .map((line) => JSON.stringify(line).replaceAll(repoRoot, '/graphmind'))
      .join('\n') + '\n';
  writeFileSync(join(OUT_DIR, 'demo-run.ndjson'), ndjson);
  writeFileSync(
    join(OUT_DIR, 'fixture-data.ts'),
    '/**\n' +
      ' * GENERATED — do not edit. The bundled demo fixture as NDJSON (same bytes\n' +
      ' * as demo-run.ndjson). Regenerate with `pnpm --filter demo-agent gen:fixture`.\n' +
      ' */\n' +
      `export const DEMO_FIXTURE_NDJSON: string = ${JSON.stringify(ndjson)};\n`,
  );
  console.log(
    `wrote ${lines.length} events (${lines.filter((l) => l.branch === 'base').length} base / ` +
      `${lines.filter((l) => l.branch === 'inject').length} inject / ` +
      `${lines.filter((l) => l.branch === 'continue').length} continue) to ${OUT_DIR}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
