/**
 * Can one ingest connection reach into another one's run?
 *
 * This is the question the whole protocol boundary rests on. GraphMind is
 * local-first with no auth, which is a defensible posture for reading — every
 * process on the machine can already read `~/.graphmind/graphmind.db`. It is
 * a different posture for *writing*, because `/ingest` is not a log sink: it
 * decides which process a `exec.resume` is delivered to, and therefore which
 * process gets to keep running.
 *
 * `Hub.handleIngestFrame` used to assign run ownership by last writer:
 *
 *     const previousOwner = this.runOwners.get(envelope.runId);
 *     if (previousOwner !== conn) { ...; this.runOwners.set(envelope.runId, conn); }
 *
 * with no check that `conn` had anything to do with `envelope.runId`. The
 * comment above it explained why — a reconnecting client must be able to
 * re-claim its own run — and that is a real requirement. The consequence was
 * that *any* connected peer could claim *any* run by naming it once, and with
 * it take delivery of the operator's `exec.resume` (injected value included),
 * fabricate nodes into someone else's canvas, wedge that agent at a gate
 * forever, and mark a live run failed.
 *
 * A run is now claimed by the token that first wrote to it (`hello.ack` mints
 * it; `hello.resumeToken` proves continuity across a reconnect), and writes
 * from anyone else are refused. See `Hub.checkClaim`.
 *
 * The tests below run the original attack end to end against a real victim: a
 * real `@graphmind-ai/client` session, holding a real gate, with a real
 * viewer driving it. Each one states a property that must hold. The
 * non-vacuity guards before them assert the attack setup still reaches a real
 * hold — without them every property below could pass for the wrong reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, type Session } from '@graphmind-ai/client';
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';
import { RawIngest, RawViewer, WireServer, drainIngest, sleep, waitForEvents, type WireFrame } from '../src/wire.js';

const INJECTED = 'value-the-operator-chose-for-the-victim';

interface Attack {
  victimRunId: string;
  /** The viewer saw the victim's gate: the attack is being run against a real hold. */
  sawPause: boolean;
  pauseId: string;
  /** The viewer received the attacker's fabricated node inside the victim's run. */
  viewerSawFabrication: boolean;
  /** Envelopes the ATTACKER received after claiming the run. */
  attackerInbound: { type?: unknown; payload?: unknown }[];
  /** Did the victim's gate ever release after the operator resumed it? */
  gateReleased: boolean;
  /** Was the victim still held at the moment the attacker named its run? */
  victimHeldAtClaim: boolean;
  /** Status of the victim's run after the attacker forged `run.finished`. */
  statusAfterForgery: string;
  /** Was the victim still actually running at that point? */
  victimStillRunning: boolean;
  /** Relays an unrelated connection receives (breakpoints, mode). */
  relayTypes: string[];
}

let server: WireServer;
let victim: Session;
let viewer: RawViewer;
let attacker: RawIngest;
let attack: Attack;
let runSettled = false;

beforeAll(async () => {
  server = await WireServer.boot();
  viewer = await RawViewer.operator(server);
  await sleep(50);

  // The operator arms a breakpoint before every tool call, then starts the app.
  viewer.control('*', 'breakpoint.set', { matcher: { kind: 'tool', point: 'before' } });
  await sleep(100);

  victim = createSession({ url: server.ingestUrl, appName: 'victim-app' });
  await victim.ready({ timeoutMs: 5_000 });

  let victimRunId = '';
  const runPromise = victim
    .run('charge-the-card', async (ctx) => {
      victimRunId = ctx.runId;
      victim.emit('node.started', {
        nodeId: 'tool:charge',
        kind: 'tool',
        name: 'charge',
        instanceId: 'charge-1',
        input: { amount: 1 },
      });
      // A real hold: this promise does not resolve until something releases it.
      await victim.gate('before', { nodeId: 'tool:charge', kind: 'tool', name: 'charge' });
      return 'charged';
    })
    .then(
      () => {
        runSettled = true;
      },
      () => {
        runSettled = true;
      },
    );
  void runPromise;

  await waitForEvents(server, await waitForRunId(() => victimRunId), 1);
  viewer.subscribe(victimRunId);
  await sleep(300);

  const pauseFrame = viewer
    .eventsFor(victimRunId)
    .find((envelope) => envelope.type === 'exec.paused');
  const pauseId = (pauseFrame?.payload as { pauseId?: string } | undefined)?.pauseId ?? '';

  // ---- the attack ----------------------------------------------------
  attacker = await RawIngest.connect(server, { app: 'evil' });
  await sleep(100);

  // 1. one frame naming the victim's run: claims ownership and fabricates a node
  attacker.send(
    JSON.stringify({
      gm: PROTOCOL_VERSION,
      seq: 900_000,
      ts: Date.now(),
      runId: victimRunId,
      type: 'node.started',
      payload: {
        nodeId: 'tool:fabricated',
        kind: 'tool',
        name: 'FABRICATED',
        instanceId: 'evil-1',
        input: { planted: true },
      },
    }),
  );
  await sleep(300);
  const viewerSawFabrication = viewer
    .eventsFor(victimRunId)
    .some((envelope) => (envelope.payload as { name?: string })?.name === 'FABRICATED');
  // Sampled HERE, not at the end: once the resume is routed correctly the
  // victim finishes normally, so "still held" is only meaningful at the
  // moment the attacker tried to take the run.
  const victimHeldAtClaim = !runSettled;

  // 2. the operator releases the gate with a value of their choosing
  attacker.received.length = 0;
  viewer.control(victimRunId, 'exec.resume', {
    pauseId,
    action: 'inject',
    output: INJECTED,
  });
  await sleep(600);
  const gateReleased = runSettled;
  const attackerInbound = attacker.inbound();

  // 3. the attacker declares the victim's run failed
  attacker.send(
    JSON.stringify({
      gm: PROTOCOL_VERSION,
      seq: 900_001,
      ts: Date.now(),
      runId: victimRunId,
      type: 'run.finished',
      payload: { status: 'error', error: { name: 'Fabricated', message: 'never happened' } },
    }),
  );
  await sleep(400);
  const runs = await server.runs();
  const row = runs.find((run) => run.id === victimRunId);

  // 4. what does an unrelated connection get told about operator state?
  attacker.received.length = 0;
  viewer.control('*', 'mode.set', { mode: 'step' });
  viewer.control('*', 'breakpoint.set', { matcher: { kind: 'llm', name: 'secret-node-name' } });
  await sleep(300);

  attack = {
    victimRunId,
    sawPause: pauseFrame !== undefined,
    pauseId,
    viewerSawFabrication,
    attackerInbound,
    gateReleased,
    victimHeldAtClaim,
    statusAfterForgery: row?.status ?? 'missing',
    victimStillRunning: !runSettled,
    relayTypes: attacker.inbound().map((frame) => String(frame.type)),
  };
}, 90_000);

afterAll(async () => {
  attacker?.close();
  viewer?.close();
  await victim?.dispose();
  await server?.close();
});

/** Poll until the run callback has published its id. */
async function waitForRunId(read: () => string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = read();
    if (id !== '') return id;
    if (Date.now() > deadline) throw new Error('the victim run never started');
    await sleep(20);
  }
}

describe('the attack setup is real (non-vacuity guard)', () => {
  it('a real victim run reached a real gate and the viewer saw it', () => {
    expect(attack.victimRunId).not.toBe('');
    expect(attack.sawPause).toBe(true);
    expect(attack.pauseId).not.toBe('');
  });

  it('the victim was genuinely still held when the attacker named its run', () => {
    expect(attack.victimHeldAtClaim).toBe(true);
  });
});

describe('an ingest connection cannot reach into another connection’s run', () => {
  it('the attack lands nothing at all', () => {
    // The summary assertion: everything below is a consequence of this one
    // fact, and it should be impossible to lose track of.
    expect(attack.viewerSawFabrication).toBe(false);
    expect(attack.attackerInbound.filter((frame) => frame.type === 'exec.resume')).toEqual([]);
  });

  it('an event from an unrelated connection does not appear inside a run', () => {
    // What used to happen: the viewer rendered a tool node named FABRICATED,
    // with an attacker-chosen input, inside the victim's run —
    // indistinguishable on the canvas from something the app actually did.
    expect(attack.viewerSawFabrication).toBe(false);
  });

  it('a resume reaches the app that owns the run, not the last writer', () => {
    // What used to happen: `exec.resume` was routed to the attacker, carrying
    // the value the operator typed into the debugger. A peer that never ran
    // anything read the operator's injected tool result for someone else's
    // agent.
    const resumes = attack.attackerInbound.filter((frame) => frame.type === 'exec.resume');
    expect(resumes).toEqual([]);
  });

  it('the injected value is not readable by another connection', () => {
    const leaked = JSON.stringify(attack.attackerInbound).includes(INJECTED);
    expect(leaked).toBe(false);
  });

  it('a gate the operator released actually releases', () => {
    // The most damaging consequence of the theft: the victim agent was wedged
    // forever at a gate nobody could reach any more. Fail-open does not cover
    // it — from the client's point of view the debugger is still attached and
    // simply has not answered.
    expect(attack.gateReleased).toBe(true);
  });

  it('another connection cannot mark a live run finished', () => {
    // `run.finished` from the attacker used to set the run's terminal status
    // while the real app was still executing it: the runs list, the REST API
    // and the viewer all reported a failure that never happened. The run now
    // ends the way it actually ended — the operator injected a value and the
    // agent ran to completion.
    expect(attack.statusAfterForgery).toBe('ok');
  });
});

describe('what an unrelated connection is told by design', () => {
  it('receives every breakpoint and mode change the operator makes', () => {
    // Not a defect — `relayToAllIngest` is how a newly-armed breakpoint
    // reaches every attached app — but worth stating: breakpoint matchers
    // carry node names, so a connected peer learns the shape of every other
    // app being debugged on this machine.
    expect(attack.relayTypes).toContain('mode.set');
    expect(attack.relayTypes).toContain('breakpoint.set');
  });

  it('is never sent another run’s events', () => {
    // The one isolation that does hold: ingest sockets are write-only for
    // run data. An attacker reads control traffic, not the trace.
    const types = attack.attackerInbound.map((frame) => String(frame.type));
    expect(types).not.toContain('node.started');
    expect(types).not.toContain('node.finished');
  });
});

describe('seq squatting cannot suppress a run that is already claimed', () => {
  const RUN = 'contested-run';
  let squatted: { names: string[]; total: number };

  beforeAll(async () => {
    // Dedup is `(runId, seq)` INSERT OR IGNORE (decisions.md #5), which is
    // what makes reconnect-and-replay safe. It also means whoever writes a
    // `seq` first owns it — so a peer that pre-claimed the low sequence
    // numbers of a run in flight used to delete the beginning of that run
    // from history, with no error anywhere and nothing for the real app to
    // notice.
    //
    // This is the realistic ordering: the app is already streaming its run,
    // and the squatter joins afterwards. (Run ids are random, so an attacker
    // does not guess one — it reads the local REST API, which is readable by
    // any process on the machine by design.)
    const real = await RawIngest.connect(server, { app: 'real-app' });
    await sleep(50);
    for (let seq = 0; seq < 5; seq += 1) real.node(RUN, seq, 'REAL', 'tool:real');
    await waitForEvents(server, RUN, 5);

    const squatter = await RawIngest.connect(server, { app: 'squatter' });
    await sleep(50);
    for (let seq = 0; seq < 10; seq += 1) squatter.node(RUN, seq, 'SQUATTED', 'tool:squat');
    await sleep(400);

    // ...and the real app keeps streaming afterwards, unaffected.
    for (let seq = 5; seq < 8; seq += 1) real.node(RUN, seq, 'REAL', 'tool:real');
    await waitForEvents(server, RUN, 8);

    const events = await server.events(RUN);
    squatted = {
      names: events.map((event) => String((event.payload as { name?: string }).name)),
      total: events.length,
    };
    squatter.close();
    real.close();
  }, 60_000);

  it('both peers really did send (non-vacuity guard)', () => {
    expect(squatted.total).toBe(8);
  });

  it('the real app’s events are not swallowed, and none are fabricated', () => {
    expect(squatted.names).toEqual(Array.from({ length: 8 }, () => 'REAL'));
  });
});

// The claim table is bounded (5,000). Flooding fresh run ids used to evict
// "the oldest claim of a run nobody holds" — which is exactly a LIVE run whose
// claim-aware app is between a dropped socket and its reconnect (the 15 s
// abandon grace). The flooder then wrote into that run, owned it, received
// the operator's resume, and locked the real app out; the same flood reopened
// finished and abandoned runs. See `Hub.evictClaimFor`.
describe('a run-id flood cannot take a live run in its reconnect window, or reopen an ended one', () => {
  const CLAIM_AWARE = ['pause', 'inject', 'retry', 'abort', 'edit-input', 'run-claim'];
  const PEER_CAPS = ['pause', 'inject', 'retry', 'abort', 'edit-input']; // no run-claim, no credential
  const opened: { close(): void }[] = [];
  const booted: WireServer[] = [];
  afterAll(async () => {
    for (const socket of opened) socket.close();
    for (const s of booted) await s.close();
  });

  async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  }
  const tokenOf = (socket: RawIngest): string | undefined =>
    (socket.inbound().find((f) => f.type === 'hello.ack')?.payload as { sessionToken?: string } | undefined)?.sessionToken;
  const hasNode = (events: WireFrame[], type: string, nodeId: string): boolean =>
    events.some((e) => e.type === type && (e.payload as { nodeId?: string } | undefined)?.nodeId === nodeId);
  const frame = (socket: RawIngest, seq: number, runId: string, type: string, payload: unknown): void =>
    socket.send(JSON.stringify({ gm: PROTOCOL_VERSION, seq, ts: Date.now(), runId, type, payload }));

  async function flood(s: WireServer, peer: RawIngest, prefix: string): Promise<void> {
    for (let i = 0; i < 5_000; i += 1) {
      peer.frame({ runId: `${prefix}-${i}`, type: 'run.started', payload: { app: 'peer', sdk: { name: 'x', version: '0' } } });
    }
    await until(() => s.server.storage.getRun(`${prefix}-4999`) !== undefined, 'the flood stored', 60_000);
  }

  async function connect(s: WireServer, app: string, caps: string[], resumeToken?: string): Promise<RawIngest> {
    const socket = await RawIngest.connect(s, { hello: false });
    opened.push(socket);
    socket.hello(app, { capabilities: caps, ...(resumeToken === undefined ? {} : { resumeToken }) });
    await until(() => tokenOf(socket) !== undefined, `${app} hello.ack`);
    return socket;
  }

  it('the flooder’s frames never land in the live run; the reconnected app keeps it and gets the resume', async () => {
    const RUN = 'victim-run';
    const s = await WireServer.boot(); // default 15 s abandon grace
    booted.push(s);
    const victim = await connect(s, 'victim-app', CLAIM_AWARE);
    const resumeToken = tokenOf(victim) as string;
    victim.frame({ runId: RUN, type: 'run.started', payload: { app: 'victim-app', sdk: { name: 'x', version: '0' } } });
    victim.frame({ runId: RUN, type: 'node.started', payload: { nodeId: 'tool:shell', kind: 'tool', name: 'shell', instanceId: 's1', input: { cmd: 'ls' } } });
    victim.frame({ runId: RUN, type: 'exec.paused', payload: { pauseId: 'p1', nodeId: 'tool:shell', point: 'before' } });
    await waitForEvents(s, RUN, 3);
    // A transport blip: the socket drops; the run stays `running` through the grace.
    victim.close();
    await until(() => s.server.hub.listPauses(RUN).length === 0, 'the dropped socket processed');

    const peer = await connect(s, 'peer', PEER_CAPS);
    await flood(s, peer, 'flood');
    frame(peer, 800_000, RUN, 'exec.paused', { pauseId: 'p-evil', nodeId: 'tool:shell', point: 'before', editable: true });
    peer.node(RUN, 800_001, 'FABRICATED');
    await drainIngest(s, peer);
    expect((await s.runs()).find((r) => r.id === RUN)?.status).toBe('running'); // still inside the grace
    expect(hasNode(await s.events(RUN), 'node.started', 'tool:FABRICATED')).toBe(false);
    expect(s.server.hub.listPauses(RUN)).toEqual([]);

    // The real app comes back with its resumeToken: its frames land.
    const back = await connect(s, 'victim-app', CLAIM_AWARE, resumeToken);
    expect(tokenOf(back)).toBe(resumeToken);
    frame(back, 10, RUN, 'node.finished', { nodeId: 'tool:shell', instanceId: 's1', output: 'real', durationMs: 5, status: 'ok' });
    frame(back, 11, RUN, 'exec.paused', { pauseId: 'p2', nodeId: 'tool:shell', point: 'after' });
    await until(() => s.server.hub.listPauses(RUN).some((p) => p.pauseId === 'p2'), 'the real app’s pause open');
    expect(hasNode(await s.events(RUN), 'node.finished', 'tool:shell')).toBe(true);

    // The operator's resume, edited input and all, reaches the real app only.
    const viewer = await RawViewer.operator(s);
    opened.push(viewer);
    await sleep(50);
    peer.received.length = 0;
    viewer.control(RUN, 'exec.resume', { pauseId: 'p2', action: 'continue' });
    await until(() => back.inbound().some((f) => f.type === 'exec.resume'), 'the resume delivered to the real app', 5_000);
    expect(peer.inbound().some((f) => f.type === 'exec.resume')).toBe(false);
  }, 120_000);

  it('the flood does not reopen a finished run, or append to and revive an abandoned one', async () => {
    const s = await WireServer.boot({ abandonGraceMs: 0 });
    booted.push(s);
    const victim = await connect(s, 'victim-app', CLAIM_AWARE);
    victim.frame({ runId: 'done-run', type: 'run.started', payload: { app: 'victim-app', sdk: { name: 'x', version: '0' } } });
    victim.frame({ runId: 'done-run', type: 'run.finished', payload: { status: 'ok' } });
    victim.frame({ runId: 'gone-run', type: 'run.started', payload: { app: 'victim-app', sdk: { name: 'x', version: '0' } } });
    await waitForEvents(s, 'done-run', 2);
    await waitForEvents(s, 'gone-run', 1);
    victim.close();
    await until(async () => (await s.runs()).find((r) => r.id === 'gone-run')?.status === 'abandoned', 'gone-run abandoned');

    const peer = await connect(s, 'peer', PEER_CAPS);
    await flood(s, peer, 'flood2');
    peer.node('done-run', 800_000, 'FABRICATED');
    peer.node('gone-run', 800_000, 'FABRICATED');
    await drainIngest(s, peer, 'marker-2');
    expect(hasNode(await s.events('done-run'), 'node.started', 'tool:FABRICATED')).toBe(false);
    expect(hasNode(await s.events('gone-run'), 'node.started', 'tool:FABRICATED')).toBe(false);
    expect((await s.runs()).find((r) => r.id === 'gone-run')?.status).toBe('abandoned');
  }, 120_000);
});
