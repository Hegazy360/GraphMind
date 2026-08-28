/**
 * Scenario 8 — what a hostile peer costs the server.
 *
 * Every other scenario measures GraphMind under load it was designed for.
 * This one measures it under load designed to hurt: a peer on `/ingest` that
 * is not the SDK, does not care about the protocol, and is trying to make the
 * server expensive rather than useful. Local-first with no auth means every
 * process on the machine — and, through the MCP work, a client two hops away
 * — can be that peer.
 *
 * The correctness half of this work lives in `security/` and runs in CI
 * (`pnpm test:security`): parser fuzzing, run isolation, stored-envelope
 * validity. What that suite cannot measure is *cost*, because the server
 * shares its process with the test runner. Here the server is out of process
 * with an external RSS sampler, so "a 96 MB frame moves the server from 95 MB
 * to 400 MB, permanently" is a number rather than a guess.
 *
 * Five levers, in increasing order of what they buy an attacker:
 *
 *   1. oversized frames        — memory, per frame, permanently
 *   2. connection storms       — memory, per connection
 *   3. garbage floods          — the operator's terminal and event loop
 *   4. backlog vs. the pinger  — silent data loss on the peer's own run
 *   5. slowloris / silent TCP  — sockets held open for free
 *
 * Run it with:
 *   pnpm --filter soak start -- --scenario=adversarial
 *   pnpm --filter soak start -- --scenario=adversarial --max-frame=96
 */
import { connect, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import { MAX_FRAME_BYTES } from 'graphmind-ai';
import { SoakServer } from '../server-handle.ts';
import { check, finding, row, section, type Section } from '../report.ts';
import { bool, delay, fmtBytes, fmtMs, num, until, type Flags } from '../util.ts';

const MB = 1024 * 1024;
const PROTOCOL_VERSION = 1;

/**
 * A raw ingest peer. Deliberately not `@graphmind-ai/client`: the client
 * cannot produce a hostile frame, which is the whole point.
 */
class RawPeer {
  private constructor(readonly ws: WebSocket) {}

  static async connect(url: string, app: string | undefined): Promise<RawPeer> {
    // 128 MB so the attacker's own library never refuses first.
    const ws = new WebSocket(url, { maxPayload: 128 * MB });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ingest upgrade timed out')), 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    ws.on('error', () => {
      /* 'close' follows */
    });
    const peer = new RawPeer(ws);
    if (app !== undefined) peer.hello(app);
    return peer;
  }

  hello(app: string): void {
    this.send(
      JSON.stringify({
        gm: PROTOCOL_VERSION,
        seq: 0,
        ts: Date.now(),
        runId: '*',
        type: 'hello',
        payload: {
          versions: { protocol: PROTOCOL_VERSION, client: '0.0.0-raw' },
          capabilities: [],
          app,
        },
      }),
    );
  }

  send(text: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(text);
  }

  node(runId: string, seq: number, name: string): void {
    this.send(
      JSON.stringify({
        gm: PROTOCOL_VERSION,
        seq,
        ts: Date.now(),
        runId,
        type: 'node.started',
        payload: { nodeId: `tool:${name}`, kind: 'tool', name, instanceId: `${name}-${seq}`, input: null },
      }),
    );
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** `/health` round-trip time; -1 when the server did not answer in time. */
async function healthMs(url: string, timeoutMs = 5_000): Promise<number> {
  const started = performance.now();
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return -1;
    await response.text();
    return performance.now() - started;
  } catch {
    return -1;
  }
}

async function eventCount(url: string, runId: string): Promise<number> {
  try {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/events?limit=1`);
    if (!response.ok) return 0;
    return ((await response.json()) as { total?: number }).total ?? 0;
  } catch {
    return 0;
  }
}

/** Highest external RSS sample since `mark`. */
function peakRssSince(server: SoakServer, mark: number): number {
  let peak = 0;
  for (const sample of server.psSince(mark)) peak = Math.max(peak, sample.rss);
  return peak;
}

/** Settle: the external sampler needs a couple of ticks to see a spike. */
async function settleRss(server: SoakServer): Promise<number> {
  await delay(900);
  const recent = server.psRss.slice(-3);
  return recent.length === 0 ? 0 : Math.max(...recent.map((sample) => sample.rss));
}

export async function adversarialScenario(flags: Flags): Promise<Section> {
  const sec = section('adversarial — what a hostile peer costs the server');
  const maxFrameMb = num(flags, 'max-frame', 64);
  const garbage = num(flags, 'garbage', 5_000);
  const storm = num(flags, 'connections', 500);
  const reapPing = num(flags, 'reap-ping', 200);

  const server = await SoakServer.start({ verbose: bool(flags, 'verbose') });
  server.startPsSampler(150);
  const peers: RawPeer[] = [];
  const rawSockets: Socket[] = [];

  try {
    await delay(600);
    const idleRss = await settleRss(server);
    const idleHealth = await healthMs(server.url);
    row(sec, 'server idle RSS', fmtBytes(idleRss));
    row(sec, 'GET /health idle', fmtMs(idleHealth));

    // ---- 1. oversized frames ------------------------------------------
    //
    // MAX_PAYLOAD_BYTES is 512 KB, but that guard runs *after* the frame has
    // been received, decoded to a string and JSON-parsed. The only cap on the
    // wire is `ws`'s default maxPayload, 100 MiB — 200x the storage budget.
    const giant = await RawPeer.connect(server.ingestUrl, 'giant');
    peers.push(giant);
    await delay(100);
    const ladder = [1, 8, 32, 64, 96].filter((mb) => mb <= maxFrameMb);
    const frameRss: { mb: number; rss: number; accepted: boolean; ms: number }[] = [];
    let seq = 0;
    for (const mb of ladder) {
      if (!giant.open) break;
      const before = await eventCount(server.url, 'giant-run');
      const mark = Date.now();
      const started = performance.now();
      const filler = 'A'.repeat(mb * MB);
      giant.send(
        `{"gm":${PROTOCOL_VERSION},"seq":${seq},"ts":${Date.now()},"runId":"giant-run",` +
          `"type":"node.finished","payload":{"nodeId":"n${seq}","instanceId":"i","durationMs":1,` +
          `"status":"ok","output":"${filler}"}}`,
      );
      seq += 1;
      let accepted = false;
      try {
        await until(async () => (await eventCount(server.url, 'giant-run')) > before, {
          timeoutMs: 30_000,
          intervalMs: 100,
          label: `the ${mb}MB frame to be stored`,
        });
        accepted = true;
      } catch {
        accepted = false;
      }
      const ms = performance.now() - started;
      await settleRss(server);
      frameRss.push({ mb, rss: peakRssSince(server, mark), accepted, ms });
      row(
        sec,
        `frame ${String(mb).padStart(3)} MB`,
        `${accepted ? 'accepted' : 'refused '}  peak RSS ${fmtBytes(peakRssSince(server, mark))}`,
        `${fmtMs(ms)}, /health ${fmtMs(await healthMs(server.url))}`,
      );
    }
    const biggestAccepted = frameRss.filter((entry) => entry.accepted).at(-1);
    check(
      sec,
      'the server survives every frame it accepts',
      frameRss.every((entry) => entry.rss > 0),
    );
    check(sec, 'the server still answers after the frame ladder', (await healthMs(server.url)) >= 0);

    // Repeat the largest accepted frame: is the memory a plateau or a leak?
    let repeatRss = 0;
    if (biggestAccepted !== undefined && giant.open) {
      const filler = 'A'.repeat(biggestAccepted.mb * MB);
      for (let i = 0; i < 3; i += 1) {
        giant.send(
          `{"gm":${PROTOCOL_VERSION},"seq":${seq},"ts":${Date.now()},"runId":"giant-run",` +
            `"type":"node.finished","payload":{"nodeId":"r${i}","instanceId":"i","durationMs":1,` +
            `"status":"ok","output":"${filler}"}}`,
        );
        seq += 1;
        await delay(700);
      }
      repeatRss = await settleRss(server);
      row(
        sec,
        `${biggestAccepted.mb} MB x3 more`,
        `RSS ${fmtBytes(repeatRss)}`,
        repeatRss > biggestAccepted.rss * 1.5 ? 'still climbing' : 'plateau, not a leak',
      );
    }
    const afterGc = await server.gc();
    row(
      sec,
      'RSS after a forced GC',
      fmtBytes(afterGc.rss),
      `${fmtBytes(afterGc.rss - idleRss)} above idle`,
    );
    if (biggestAccepted !== undefined && afterGc.rss > idleRss * 1.5) {
      finding(
        sec,
        `one ${biggestAccepted.mb} MB frame moves the server from ${fmtBytes(idleRss)} to ` +
          `${fmtBytes(afterGc.rss)} and it does not come back after GC. Bounded since 0.4.0: ` +
          `the wire caps a frame at ${fmtBytes(MAX_FRAME_BYTES)} (it was the ws default of ` +
          `100 MiB against a 512 KB storage budget), so this is the cost of a frame the ` +
          `server has agreed to accept, not an unbounded one.`,
      );
    }
    giant.close();

    // ---- 2. connection storm ------------------------------------------
    const preStormRss = await settleRss(server);
    const stormStarted = performance.now();
    const crowd: RawPeer[] = [];
    let opened = 0;
    for (let i = 0; i < storm; i += 1) {
      try {
        const peer = await RawPeer.connect(server.ingestUrl, `storm-${i}`);
        crowd.push(peer);
        peers.push(peer);
        opened += 1;
      } catch {
        break;
      }
    }
    const stormMs = performance.now() - stormStarted;
    const stormRss = await settleRss(server);
    const stormHealth = await healthMs(server.url);
    row(
      sec,
      `${opened} ingest connections`,
      `RSS ${fmtBytes(stormRss)}`,
      `${fmtMs(stormMs)} to open, ${fmtBytes((stormRss - preStormRss) / Math.max(1, opened))}/conn ` +
        `above the ${fmtBytes(preStormRss)} it was already holding, /health ${fmtMs(stormHealth)}`,
    );
    // Not `opened === storm`: a runner with a low file-descriptor limit
    // legitimately refuses some, and that is not a GraphMind defect. What
    // must hold is that the server keeps serving whatever it accepted.
    check(
      sec,
      'a large connection storm is accepted without incident',
      opened >= Math.min(storm, 100),
      `${opened}/${storm} opened`,
    );
    check(sec, 'the server answers while every connection is held', stormHealth >= 0);
    // An honest run must still get through the crowd.
    const honest = crowd[0];
    if (honest !== undefined) {
      for (let i = 0; i < 20; i += 1) honest.node('crowded-run', i, `honest-${i}`);
      let stored = 0;
      try {
        await until(
          async () => {
            stored = await eventCount(server.url, 'crowded-run');
            return stored >= 20;
          },
          { timeoutMs: 20_000, intervalMs: 100, label: 'the honest run to land' },
        );
      } catch {
        /* reported by the check below */
      }
      check(sec, 'an honest run still lands with the crowd attached', stored === 20, `${stored}/20`);
    }
    for (const peer of peers) peer.close();
    peers.length = 0;
    await delay(800);
    const afterStorm = await server.gc();
    row(
      sec,
      'RSS after the crowd leaves',
      fmtBytes(afterStorm.rss),
      `${fmtBytes(afterStorm.rss - preStormRss)} vs before the crowd, ` +
        `${fmtBytes(afterStorm.rss - idleRss)} vs idle`,
    );

    // ---- 3. garbage flood ---------------------------------------------
    //
    // `Hub.handleIngestFrame` logs one line per dropped frame, and `graphmind
    // serve` hands it `console.log` — a synchronous write to the operator's
    // TTY. A peer that sends garbage at line rate is spending the operator's
    // event loop and burying the log they are reading.
    const noisy = await RawPeer.connect(server.ingestUrl, 'noisy');
    peers.push(noisy);
    await delay(100);
    const logsBefore = server.logs.length;
    const floodStarted = performance.now();
    for (let i = 0; i < garbage; i += 1) noisy.send('}}} not json at all {{{');
    const queueMs = performance.now() - floodStarted;
    const duringHealth = await healthMs(server.url);
    noisy.node('flood-marker', 0, 'marker');
    try {
      await until(async () => (await eventCount(server.url, 'flood-marker')) >= 1, {
        timeoutMs: 60_000,
        intervalMs: 100,
        label: 'the flood to drain',
      });
    } catch {
      /* reported below */
    }
    const drainMs = performance.now() - floodStarted;
    // The child ships log lines to this process over IPC, asynchronously: the
    // count is only meaningful once that queue has drained too.
    await until(() => server.logs.length - logsBefore >= garbage, {
      timeoutMs: 20_000,
      intervalMs: 100,
      label: 'the log lines to arrive over IPC',
    }).catch(() => undefined);
    await delay(500);
    const logLines = server.logs.length - logsBefore;
    row(
      sec,
      `${garbage} garbage frames`,
      `${logLines} log lines`,
      `${(logLines / Math.max(1, garbage)).toFixed(2)} lines/frame, queued in ${fmtMs(queueMs)}, ` +
        `drained in ${fmtMs(drainMs)}, /health during ${fmtMs(duringHealth)}`,
    );
    check(sec, 'the server stays responsive during a garbage flood', duringHealth >= 0);
    check(sec, 'the garbage flood drains', (await eventCount(server.url, 'flood-marker')) >= 1);
    if (logLines >= garbage) {
      finding(
        sec,
        `every dropped frame costs exactly one log line (${logLines} for ${garbage} frames), ` +
          'unthrottled and unaggregated — `graphmind serve` writes them synchronously to the ' +
          "operator's terminal. A rate limit belongs in Hub.handleIngestFrame.",
      );
    }
    noisy.close();
    peers.length = 0;

    await server.close();
    server.cleanup();

    // ---- 4. backlog vs. the liveness pinger ----------------------------
    //
    // `Hub.pingAll` terminates a socket that has not ponged since the previous
    // tick. The pong sits behind that peer's own frames in the same TCP
    // stream, so a peer with more than ~two ping intervals of queued work is
    // reaped BECAUSE the server is busy with it — and everything still in
    // flight is dropped with no error and no gap marker. A short interval is
    // used here to make the threshold measurable in seconds; the shipped
    // default is 30s, which needs roughly a million queued events.
    const reaper = await SoakServer.start({
      pingIntervalMs: reapPing,
      verbose: bool(flags, 'verbose'),
    });
    try {
      const flooder = await RawPeer.connect(reaper.ingestUrl, 'busy');
      await delay(100);
      const target = 60_000;
      for (let i = 0; i < target; i += 1) {
        flooder.send(
          `{"gm":${PROTOCOL_VERSION},"seq":${i},"ts":1,"runId":"reaped","type":"node.token",` +
            '"payload":{"nodeId":"n","deltas":[{"t":"text","v":"x"}]}}',
        );
      }
      let stored = -1;
      let stable = 0;
      for (let i = 0; i < 80 && stable < 4; i += 1) {
        await delay(500);
        const now = await eventCount(reaper.url, 'reaped');
        stable = now === stored ? stable + 1 : 0;
        stored = now;
        if (stored >= target) break;
      }
      const lost = target - stored;
      row(
        sec,
        `${target} queued frames, ping ${reapPing}ms`,
        `${stored} stored, ${lost} lost`,
        flooder.open ? 'socket survived' : 'socket terminated by the pinger',
      );
      check(sec, 'the server survives the backlog', (await healthMs(reaper.url)) >= 0);
      if (lost > 0) {
        finding(
          sec,
          `${lost} of ${target} events were dropped when the liveness pinger terminated the ` +
            'peer it was busiest with. Nothing reports the loss: no error to the app, no gap in ' +
            'the viewer, one `app detached` line in the log. Same silent-loss class as the ' +
            'ring-buffer overflow in finding #1.',
        );
      }
      flooder.close();
    } finally {
      await reaper.close();
      reaper.cleanup();
    }

    // ---- 5. slowloris --------------------------------------------------
    const slow = await SoakServer.start({ verbose: bool(flags, 'verbose') });
    try {
      slow.startPsSampler(200);
      await delay(400);
      const slowIdle = await settleRss(slow);
      for (let i = 0; i < 200; i += 1) {
        const socket = connect(slow.port, '127.0.0.1');
        socket.on('error', () => {
          /* the server may reset it */
        });
        rawSockets.push(socket);
      }
      // One half-sent upgrade that then stalls forever.
      const partial = connect(slow.port, '127.0.0.1');
      partial.on('error', () => {});
      rawSockets.push(partial);
      await new Promise<void>((resolve) => partial.once('connect', () => resolve()));
      partial.write('GET /ingest HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n');
      await delay(1_500);
      const slowRss = await settleRss(slow);
      const slowHealth = await healthMs(slow.url);
      row(
        sec,
        '200 silent TCP sockets + 1 partial upgrade',
        `RSS ${fmtBytes(slowRss)}`,
        `${fmtBytes(slowRss - slowIdle)} above idle, /health ${fmtMs(slowHealth)}`,
      );
      check(sec, 'silent and half-open TCP connections do not affect the server', slowHealth >= 0);
      // A real app still connects and streams through the crowd.
      const worker = await RawPeer.connect(slow.ingestUrl, 'worker');
      for (let i = 0; i < 10; i += 1) worker.node('slowloris-run', i, `w-${i}`);
      let landed = 0;
      try {
        await until(
          async () => {
            landed = await eventCount(slow.url, 'slowloris-run');
            return landed >= 10;
          },
          { timeoutMs: 20_000, intervalMs: 100, label: 'the worker run to land' },
        );
      } catch {
        /* reported by the check */
      }
      check(sec, 'a real app still connects and streams', landed === 10, `${landed}/10`);
      worker.close();
    } finally {
      for (const socket of rawSockets) socket.destroy();
      rawSockets.length = 0;
      await slow.close();
      slow.cleanup();
    }

    sec.data['idleRss'] = idleRss;
    sec.data['frames'] = frameRss;
    sec.data['repeatRss'] = repeatRss;
    sec.data['stormConnections'] = opened;
    sec.data['stormRss'] = stormRss;
    sec.data['garbageFrames'] = garbage;
    sec.data['garbageLogLines'] = logLines;

    finding(
      sec,
      'The correctness findings this scenario was written alongside — a peer claiming ' +
        "another process's run and stealing its `exec.resume`, and the 512 KB guard " +
        'producing stored envelopes the viewer rejects — were fixed in 0.4.0 and are held ' +
        'by tests in `security/` (`pnpm test:security`), not here.',
    );
    return sec;
  } catch (error) {
    check(sec, 'scenario completed', false, error instanceof Error ? error.message : String(error));
    return sec;
  } finally {
    for (const peer of peers) peer.close();
    for (const socket of rawSockets) socket.destroy();
    try {
      await server.close();
    } catch {
      /* already closed above */
    }
    server.cleanup();
  }
}
