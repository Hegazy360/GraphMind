/**
 * The viewer socket, attacked.
 *
 * `WS /ws/ui` is the second door into the server and the more dangerous one:
 * it is the endpoint that can *drive* an agent (`exec.resume`, including
 * `inject`), so its parser handles input from whoever got through the origin
 * guard — the CLI's own viewer, a developer's `wscat`, and anything else
 * running on the machine, since a loopback bind is not authentication.
 *
 * Unlike `/ingest`, this handler hand-rolls its dispatch (`JSON.parse`, a
 * `type` switch) instead of going through `parseEnvelope`, so it needs its
 * own fuzzing rather than inheriting the ingest tests' coverage.
 *
 * Invariants: the socket survives everything, the server survives everything,
 * every reply is itself well-formed JSON of a known UI message type, and no
 * frame reaches an app that did not ask for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MESSAGE_TYPES, PROTOCOL_VERSION, WILDCARD_RUN_ID } from '@graphmind-ai/schema';
import { NASTY_STRINGS, anyValueArb, hostileText, hostileTextArb, prototypeSnapshot } from '../src/fuzz.js';
import { RawIngest, RawViewer, WireServer, sleep, waitForEvents } from '../src/wire.js';

const UI_SERVER_TYPES = [
  'welcome',
  'state',
  'runs',
  'run.update',
  'replay.start',
  'event',
  'replay.end',
  'error',
];

let server: WireServer;
let viewer: RawViewer;
let app: RawIngest;

beforeAll(async () => {
  server = await WireServer.boot();
  app = await RawIngest.connect(server, { app: 'bystander' });
  await sleep(50);
  for (let seq = 0; seq < 20; seq += 1) app.node('bystander-run', seq, `ok-${seq}`);
  await waitForEvents(server, 'bystander-run', 20);
  viewer = await RawViewer.connect(server);
  await sleep(100);
}, 60_000);

afterAll(async () => {
  viewer.close();
  app.close();
  await server.close();
});

/** Every frame the server sent is well-formed JSON of a known UI type. */
function repliesAreWellFormed(target: RawViewer): { ok: boolean; detail: string } {
  for (const text of target.received) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, detail: `non-JSON frame: ${text.slice(0, 80)}` };
    }
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== 'string' || !UI_SERVER_TYPES.includes(type)) {
      return { ok: false, detail: `unknown UI message type: ${String(type)}` };
    }
  }
  return { ok: true, detail: `${target.received.length} frames` };
}

describe('the viewer socket survives malformed frames', () => {
  it('greets a fresh viewer with a welcome before anything is sent (non-vacuity guard)', () => {
    const first = viewer.json<{ type?: string }>()[0];
    expect(first?.type).toBe('welcome');
  });

  it('survives the hostile corpus and answers every frame in-protocol', async () => {
    for (const text of hostileText()) {
      viewer.send(text);
      expect(await server.alive(), `frame: ${text.slice(0, 60)}`).toBe(true);
    }
    await sleep(300);
    expect(viewer.open).toBe(true);
    expect(repliesAreWellFormed(viewer)).toEqual({ ok: true, detail: expect.any(String) });
  }, 120_000);

  it('survives 500 randomly generated frames (property)', async () => {
    const frames: string[] = [];
    fc.assert(
      fc.property(hostileTextArb, (text) => {
        frames.push(text);
      }),
      { numRuns: 500 },
    );
    for (const text of frames) viewer.send(text);
    await sleep(500);
    expect(viewer.open).toBe(true);
    expect(await server.alive()).toBe(true);
    expect(repliesAreWellFormed(viewer).ok).toBe(true);
  }, 120_000);

  it('survives arbitrary control envelopes (property)', async () => {
    const probe = await RawViewer.connect(server);
    const frames: string[] = [];
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...MESSAGE_TYPES), fc.string()),
        anyValueArb,
        fc.oneof(fc.string(), fc.constantFrom(...NASTY_STRINGS.filter((s) => s.length < 64))),
        (type, payload, runId) => {
          frames.push(
            JSON.stringify({
              type: 'control',
              envelope: { gm: PROTOCOL_VERSION, seq: 0, ts: 1, runId, type, payload },
            }),
          );
        },
      ),
      { numRuns: 600 },
    );
    for (const text of frames) probe.send(text);
    await sleep(600);
    expect(probe.open).toBe(true);
    expect(await server.alive()).toBe(true);
    expect(repliesAreWellFormed(probe).ok).toBe(true);
    probe.close();
  }, 120_000);

  it('refuses an event type dressed up as a control', async () => {
    // A viewer must not be able to write into a run: `node.started` is an
    // app-side type and the control switch has to reject it by name.
    const probe = await RawViewer.connect(server);
    await sleep(50);
    probe.control('bystander-run', 'node.started', {
      nodeId: 'tool:injected',
      kind: 'tool',
      name: 'INJECTED-BY-VIEWER',
      instanceId: 'x',
      input: null,
    });
    await sleep(300);
    expect(probe.errors().join('\n')).toContain('is not a control type');
    const events = await server.events('bystander-run');
    expect(events.length).toBe(20);
    expect(
      events.some((event) => (event.payload as { name?: string }).name === 'INJECTED-BY-VIEWER'),
    ).toBe(false);
    probe.close();
  }, 60_000);

  it('reports, rather than routes, a resume for a run nobody owns', async () => {
    const probe = await RawViewer.connect(server);
    await sleep(50);
    for (const runId of ['does-not-exist', '', WILDCARD_RUN_ID, '__proto__']) {
      probe.control(runId, 'exec.resume', { pauseId: 'p', action: 'continue' });
    }
    await sleep(300);
    expect(probe.errors().length).toBeGreaterThanOrEqual(4);
    expect(probe.open).toBe(true);
    expect(await server.alive()).toBe(true);
    probe.close();
  }, 60_000);

  it('never pollutes Object.prototype from the viewer side', async () => {
    const before = prototypeSnapshot();
    viewer.send('{"type":"__proto__"}');
    viewer.send('{"type":"subscribe","runId":"__proto__","__proto__":{"pwned":true}}');
    viewer.send('{"type":"control","envelope":{"__proto__":{"pwned":true}}}');
    viewer.send('{"__proto__":{"type":"subscribe","runId":"*"}}');
    await sleep(300);
    expect(prototypeSnapshot()).toBe(before);
    expect(Object.hasOwn(Object.prototype, 'pwned')).toBe(false);
  }, 60_000);

  it('one hostile viewer does not affect another viewer or the app', async () => {
    const bystander = await RawViewer.connect(server);
    await sleep(50);
    bystander.subscribe('bystander-run');
    await sleep(200);
    const before = bystander.eventsFor('bystander-run').length;
    expect(before).toBe(20);

    const hostile = await RawViewer.connect(server);
    for (const text of hostileText()) hostile.send(text);
    await sleep(500);

    app.node('bystander-run', 100, 'after-the-storm');
    await waitForEvents(server, 'bystander-run', 21);
    await sleep(200);
    expect(bystander.eventsFor('bystander-run').length).toBe(21);
    expect(bystander.open).toBe(true);
    hostile.close();
    bystander.close();
  }, 60_000);
});

describe('DEFECT: `subscribe` replays a whole run, unbounded, on demand', () => {
  /**
   * `Hub.handleSubscribe` calls `storage.listEvents(runId)` with no limit and
   * pushes every event, synchronously, in one tick — and it does that again
   * for every `subscribe` frame, including repeats of one already active.
   *
   * The REST route for the same data caps a page at 5,000 (`PAGE_LIMIT_MAX`)
   * and paginates. The socket route has no cap at all, so a peer that can
   * reach `/ws/ui` turns one small frame into an arbitrarily large amount of
   * server work and socket traffic, repeatable at line rate — the classic
   * amplification shape.
   *
   * The fix is the same paging the REST route already does (or refusing a
   * duplicate subscription); both live in packages/cli and are outside this
   * package's ownership.
   */
  const RUN = 'replay-amplification';
  const EVENTS = 2_000;
  const SUBSCRIBES = 20;
  let framesReceived = 0;

  beforeAll(async () => {
    const source = await RawIngest.connect(server, { app: 'bulk' });
    await sleep(50);
    for (let seq = 0; seq < EVENTS; seq += 1) source.node(RUN, seq, `e-${seq}`);
    await waitForEvents(server, RUN, EVENTS, 60_000);
    source.close();

    const greedy = await RawViewer.connect(server);
    await sleep(50);
    for (let i = 0; i < SUBSCRIBES; i += 1) greedy.subscribe(RUN);
    await sleep(2_000);
    framesReceived = greedy.received.length;
    greedy.close();
  }, 120_000);

  it('the run really holds the events (non-vacuity guard)', async () => {
    expect(await server.eventCount(RUN)).toBe(EVENTS);
  });

  it('the server survives the amplification', async () => {
    expect(await server.alive()).toBe(true);
  });

  it('a repeated subscribe does not replay the run again', () => {
    // One replay is correct and expected; twenty subscribes producing twenty
    // replays was the amplification. A repeat is now acknowledged with an
    // empty replay.start/replay.end pair instead. Allow the first replay plus
    // its markers, the welcome frame, and one marker pair per repeat.
    expect(framesReceived).toBeLessThan(EVENTS + 10 + SUBSCRIBES * 2);
  });
});
