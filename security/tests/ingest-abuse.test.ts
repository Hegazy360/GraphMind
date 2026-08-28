/**
 * Not "what does a bad frame do" but "what does a bad *client* do".
 *
 * A malicious or merely broken instrumented app has an unauthenticated socket
 * into the debugger the developer is watching their production incident on.
 * The bar here is availability: it may waste its own time, it may not take
 * the server down or make it stop answering.
 *
 * Everything expensive to measure — RSS after a 96 MB frame, throughput
 * under flood, whether one peer starves another — is measured out of process
 * by `examples/soak --scenario=adversarial`, where the server's memory is not
 * mixed with the driver's. This file keeps the fast, deterministic half so it
 * can run on every CI push.
 */
import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, WILDCARD_RUN_ID } from '@graphmind-ai/schema';
import { RawIngest, WireServer, sleep, waitForEvents } from '../src/wire.js';

let server: WireServer;
const sockets: Socket[] = [];

beforeAll(async () => {
  // Shipped defaults, including the 30s ping interval — the reaper's
  // behaviour under load is a defect of its own and gets a dedicated server
  // below rather than being baked into every test here.
  server = await WireServer.boot();
}, 60_000);

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await server.close();
});

describe('oversized frames', () => {
  it('accepts a single frame 16x larger than the entire storage budget', async () => {
    // MAX_PAYLOAD_BYTES is 512 KB. The socket's limit is `ws`'s default
    // maxPayload, 100 MiB — 200x higher — so the server buffers, decodes and
    // JSON-parses the whole thing before the guard it does have ever runs.
    // That work is what a flooding client is really buying.
    const attacker = await RawIngest.connect(server, { app: 'giant' });
    await sleep(50);
    const output = 'A'.repeat(8 * 1024 * 1024);
    attacker.send(
      `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"giant","type":"node.finished",` +
        `"payload":{"nodeId":"n","instanceId":"i","durationMs":1,"status":"ok","output":"${output}"}}`,
    );
    const events = await waitForEvents(server, 'giant', 1, 30_000);
    expect(events.length).toBe(1);
    // The storage guard did its job: what was kept is small.
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload['__graphmindTruncated']).toBe(true);
    expect(attacker.open).toBe(true);
    expect(await server.alive()).toBe(true);
    attacker.close();
  }, 90_000);
});

describe('connection abuse', () => {
  it('survives 300 simultaneous ingest connections', async () => {
    const peers: RawIngest[] = [];
    for (let i = 0; i < 300; i += 1) {
      peers.push(await RawIngest.connect(server, { app: `storm-${i}` }));
    }
    expect(peers.filter((peer) => peer.open).length).toBe(300);
    expect(await server.alive()).toBe(true);
    // And a real run still gets through while they are all attached.
    const worker = peers[0] as RawIngest;
    worker.node('storm-run', 0, 'still-working');
    await waitForEvents(server, 'storm-run', 1);
    for (const peer of peers) peer.close();
    await sleep(300);
    expect(await server.alive()).toBe(true);
  }, 120_000);

  it('survives raw TCP connections that never send a byte (slowloris)', async () => {
    for (let i = 0; i < 60; i += 1) {
      const socket = connect(server.port, '127.0.0.1');
      socket.on('error', () => {
        /* the server may reset it; that is fine */
      });
      sockets.push(socket);
    }
    await sleep(400);
    expect(await server.alive()).toBe(true);
  }, 60_000);

  it('survives a half-sent upgrade request that then stalls', async () => {
    const socket = connect(server.port, '127.0.0.1');
    socket.on('error', () => {});
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write('GET /ingest HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n');
    await sleep(400);
    expect(await server.alive()).toBe(true);
  }, 60_000);

  it('ignores everything an unattached connection sends before `hello`', async () => {
    const quiet = await RawIngest.connect(server, { hello: false });
    for (let seq = 0; seq < 20; seq += 1) quiet.node('pre-hello', seq, 'should-not-exist');
    await sleep(400);
    expect((await server.runs()).some((run) => run.id === 'pre-hello')).toBe(false);
    expect(await server.alive()).toBe(true);
    quiet.close();
  }, 60_000);

  it('keeps a connected-but-silent client forever (documented, not a defect today)', async () => {
    // The ping/pong reaper terminates sockets that stop answering. A `ws`
    // client answers pings automatically without the application doing
    // anything, so a peer that connects, says `hello` and then goes silent is
    // never reaped and holds its slot indefinitely. Harmless while there is
    // no connection limit; it becomes the other half of a resource-exhaustion
    // bug the day one is added.
    const quick = await WireServer.boot({ pingIntervalMs: 200 });
    try {
      const idle = await RawIngest.connect(quick, { app: 'idle' });
      await sleep(1_200); // 6x the ping interval
      expect(idle.open).toBe(true);
      idle.close();
    } finally {
      await quick.close();
    }
  }, 60_000);
});

describe('the liveness reaper does not kill the peer it is busiest with', () => {
  /**
   * `Hub.pingAll` sets `alive = false`, pings, and terminates any socket that
   * has not ponged by the next tick. Liveness used to be judged on the PONG
   * alone — and a pong arrives on the same TCP stream as that peer's own
   * frames, *behind* them, so the server only saw it after draining that
   * peer's entire backlog. A peer with more than ~two ping intervals of
   * queued work was therefore reaped **because** the server was busy with it,
   * and everything still in flight was dropped: no error to the app, no gap
   * in the viewer, nothing in the log but `app detached`. Measured at 26,570
   * of 60,000 events lost at a 200ms ping interval.
   *
   * Liveness is now judged on reading any bytes from the socket, which is
   * precisely what a busy peer is doing. This floods hard enough to have
   * triggered the old behaviour and asserts nothing is lost.
   */
  it('drains a flood that outlasts several ping intervals, losing nothing', async () => {
    const quick = await WireServer.boot({ pingIntervalMs: 200 });
    try {
      const flooder = await RawIngest.connect(quick, { app: 'busy' });
      await sleep(50);
      const count = 60_000;
      for (let seq = 0; seq < count; seq += 1) {
        flooder.send(
          `{"gm":${PROTOCOL_VERSION},"seq":${seq},"ts":1,"runId":"reaped","type":"node.token",` +
            '"payload":{"nodeId":"n","deltas":[{"t":"text","v":"x"}]}}',
        );
      }
      // Wait for the stored count to stop moving: either it reached `count`
      // or the socket was terminated part-way.
      let stored = -1;
      let stable = 0;
      for (let i = 0; i < 120 && stable < 4; i += 1) {
        await sleep(500);
        const now = await quick.eventCount('reaped');
        stable = now === stored ? stable + 1 : 0;
        stored = now;
        if (stored >= count) break;
      }
      expect(stored).toBe(count);
      expect(flooder.open).toBe(true);
      expect(await quick.alive()).toBe(true);
    } finally {
      await quick.close();
    }
  }, 120_000);
});

describe('flooding', () => {
  it('stays responsive and loses nothing under a 20k frame flood', async () => {
    const flooder = await RawIngest.connect(server, { app: 'flood' });
    await sleep(50);
    const count = 20_000;
    for (let seq = 0; seq < count; seq += 1) {
      flooder.send(
        `{"gm":${PROTOCOL_VERSION},"seq":${seq},"ts":1,"runId":"flood","type":"node.token",` +
          '"payload":{"nodeId":"n","deltas":[{"t":"text","v":"x"}]}}',
      );
    }
    // Responsiveness DURING the drain is the real question: a server that
    // only answers once the backlog clears has stopped being a live debugger.
    expect(await server.alive(5_000)).toBe(true);
    const events = await waitForEvents(server, 'flood', count, 120_000);
    expect(events.length).toBe(count);
    flooder.close();
  }, 180_000);

  it('a flood on one connection does not lose another connection’s events', async () => {
    const flooder = await RawIngest.connect(server, { app: 'flood2' });
    const honest = await RawIngest.connect(server, { app: 'honest' });
    await sleep(50);
    for (let seq = 0; seq < 8_000; seq += 1) {
      flooder.send(
        `{"gm":${PROTOCOL_VERSION},"seq":${seq},"ts":1,"runId":"flood2","type":"node.token",` +
          '"payload":{"nodeId":"n","deltas":[{"t":"text","v":"y"}]}}',
      );
    }
    for (let seq = 0; seq < 25; seq += 1) honest.node('honest-run', seq, `honest-${seq}`);
    const events = await waitForEvents(server, 'honest-run', 25, 120_000);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    flooder.close();
    honest.close();
  }, 180_000);

  it('a flood of garbage frames does not become a flood of log lines', async () => {
    // `Hub.handleIngestFrame` used to log on every invalid frame, and
    // `graphmind serve` passes `console.log`, which writes synchronously to a
    // TTY. A peer sending garbage at line rate therefore spent the operator's
    // event loop and buried the log they were reading — measured at exactly
    // 1.00 lines per frame, unthrottled. Logging is now rate-limited per
    // message kind and carries a suppressed count, so the operator is told
    // what is happening once and keeps their terminal.
    const noisy = await RawIngest.connect(server, { app: 'noisy' });
    await sleep(50);
    const before = server.logLines().length;
    const garbage = 2_000;
    for (let i = 0; i < garbage; i += 1) noisy.send('}}} not json {{{');
    // Ordered marker: once this lands, all the garbage above has been handled.
    noisy.node('noisy-marker', 0, 'marker');
    await waitForEvents(server, 'noisy-marker', 1, 60_000);
    const emitted = server.logLines().length - before;
    // A few throttle windows' worth, not one line per frame.
    expect(emitted).toBeLessThan(50);
    // ...and the operator is still told that frames are being dropped.
    expect(server.logLines().join('\n')).toContain('dropping invalid frame');
    noisy.close();
  }, 120_000);

  it('DEFECT: a repeated `hello` is answered every time, unthrottled', async () => {
    // `hello` is the one frame handled before attachment, and it is handled
    // again on every arrival: each one allocates and sends a `hello.ack` and
    // writes a log line. A peer can loop it.
    const chatty = await RawIngest.connect(server, { hello: false });
    const before = server.logLines().length;
    for (let i = 0; i < 500; i += 1) {
      chatty.send(
        JSON.stringify({
          gm: PROTOCOL_VERSION,
          seq: i,
          ts: Date.now(),
          runId: WILDCARD_RUN_ID,
          type: 'hello',
          payload: {
            versions: { protocol: PROTOCOL_VERSION, client: '0.0.0' },
            capabilities: [],
            app: 'chatty',
          },
        }),
      );
    }
    chatty.node('chatty-marker', 0, 'marker');
    await waitForEvents(server, 'chatty-marker', 1, 60_000);
    const acks = chatty.inbound().filter((frame) => frame.type === 'hello.ack');
    expect(acks.length).toBeGreaterThanOrEqual(500);
    expect(server.logLines().length - before).toBeGreaterThanOrEqual(500);
    expect(await server.alive()).toBe(true);
    chatty.close();
  }, 120_000);
});
