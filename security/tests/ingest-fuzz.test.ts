/**
 * The server's ingest path, attacked.
 *
 * `WS /ingest` is the widest door GraphMind has: every byte on it comes from
 * a process the server does not control, and — as of the MCP work — can come
 * from a client two hops away that nobody controls. Until this file, the only
 * thing that had ever spoken it was the SDK, which cannot produce a malformed
 * frame even on purpose.
 *
 * Four invariants, asserted after every batch of hostile traffic:
 *
 *   1. **the server does not die and does not wedge** — `/health` still
 *      answers, promptly;
 *   2. **one bad frame does not kill a good connection** — the socket it
 *      arrived on keeps working, and the frames after it are stored;
 *   3. **a bad frame never touches an unrelated run** — a healthy run
 *      streaming on another socket keeps every event, in order;
 *   4. **everything stored is still an envelope the viewer can parse** —
 *      because an event the viewer's own `parseEnvelope` rejects is an event
 *      that disappears from the canvas on reload.
 *
 * Cross-run *attacks* (a client that deliberately claims someone else's run)
 * live in run-isolation.test.ts; this file is about malformed input.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROTOCOL_VERSION, parseEnvelope } from '@graphmind-ai/schema';
import { hostileText, hostileTextArb, prototypeSnapshot } from '../src/fuzz.js';
import {
  RawIngest,
  WireServer,
  drainIngest,
  sleep,
  waitForEvents,
  type WireFrame,
} from '../src/wire.js';

const CONTROL_RUN = 'control-run';
/** The run that deliberately trips the 512 KB truncation defect, pinned below. */
const OVERSIZED_REQUIRED_RUN = 'oversized-required';
const CONTROL_EVENTS = 40;

let server: WireServer;
/** The well-behaved app whose run must survive everything below. */
let control: RawIngest;
/** The hostile peer. Reconnected whenever the server closes it on us. */
let attacker: RawIngest;

async function reconnectAttackerIfNeeded(): Promise<void> {
  if (attacker.open) return;
  attacker = await RawIngest.connect(server, { app: 'attacker' });
  await sleep(50);
}

/**
 * Push everything queued through the server and back out again.
 *
 * Uses an ordered marker on the attacker's own socket where possible: the
 * socket is ordered, so once the marker is stored, every frame sent before it
 * has been processed — including the dropped ones. A fixed sleep would be
 * both slower and flakier.
 */
async function settle(): Promise<void> {
  if (attacker.open) {
    await drainIngest(server, attacker);
    return;
  }
  await sleep(250);
}

beforeAll(async () => {
  server = await WireServer.boot();
  control = await RawIngest.connect(server, { app: 'control' });
  attacker = await RawIngest.connect(server, { app: 'attacker' });
  await sleep(100);
  for (let seq = 0; seq < CONTROL_EVENTS; seq += 1) {
    control.node(CONTROL_RUN, seq, `ok-${seq}`);
  }
  await waitForEvents(server, CONTROL_RUN, CONTROL_EVENTS);
}, 60_000);

afterAll(async () => {
  control.close();
  attacker.close();
  await server.close();
});

/** Every event of the control run, exactly once, in ascending seq order. */
async function controlRunIsIntact(): Promise<{ ok: boolean; detail: string }> {
  const events = await server.events(CONTROL_RUN);
  const seqs = events.map((event) => event.seq as number);
  const expected = Array.from({ length: CONTROL_EVENTS }, (_, i) => i);
  const sorted = [...seqs].sort((a, b) => a - b);
  const inOrder = seqs.every((seq, i) => i === 0 || seq > (seqs[i - 1] as number));
  const exact = JSON.stringify(sorted) === JSON.stringify(expected);
  const names = events.map((event) => (event.payload as { name?: string }).name);
  const untouched = names.every((name, i) => name === `ok-${i}`);
  return {
    ok: exact && inOrder && untouched,
    detail: `${events.length} events, exact=${exact} ordered=${inOrder} untouched=${untouched}`,
  };
}

describe('the ingest path survives malformed frames', () => {
  it('the control run really is streaming (non-vacuity guard)', async () => {
    const state = await controlRunIsIntact();
    expect(state.detail).toContain(`${CONTROL_EVENTS} events`);
    expect(state.ok).toBe(true);
  });

  it('survives the whole hostile corpus, one frame at a time', async () => {
    const corpus = hostileText();
    expect(corpus.length).toBeGreaterThan(50);
    for (const [index, text] of corpus.entries()) {
      await reconnectAttackerIfNeeded();
      attacker.send(text);
      // Health after EVERY frame: a 100k-deep document or a 2 MB string that
      // pins the event loop is a denial of service even if nothing throws.
      expect(await server.alive(), `frame #${index}: ${text.slice(0, 60)}`).toBe(true);
    }
    await settle();
    expect((await controlRunIsIntact()).ok).toBe(true);
  }, 120_000);

  it('survives 400 randomly generated hostile frames (property)', async () => {
    const frames: string[] = [];
    fc.assert(
      fc.property(hostileTextArb, (text) => {
        frames.push(text);
      }),
      { numRuns: 400 },
    );
    for (const text of frames) {
      await reconnectAttackerIfNeeded();
      attacker.send(text);
    }
    await settle();
    expect(await server.alive()).toBe(true);
    expect((await controlRunIsIntact()).ok).toBe(true);
  }, 120_000);

  it('a bad frame does not kill the connection it arrived on', async () => {
    await reconnectAttackerIfNeeded();
    const run = 'interleaved';
    const good = 100;
    for (let i = 0; i < good; i += 1) {
      attacker.send('}}} not json {{{');
      attacker.send('{"gm":1,"seq":0}');
      attacker.node(run, i, `good-${i}`);
    }
    const events = await waitForEvents(server, run, good);
    expect(events.length).toBe(good);
    expect(attacker.open).toBe(true);
  }, 60_000);

  it('a foreign protocol version closes that connection and nothing else', async () => {
    // The one frame the server answers by closing: a peer speaking a
    // different `gm` cannot be understood, so it is told so (1002) rather
    // than silently ignored. Everyone else must be unaffected.
    const stranger = await RawIngest.connect(server, { app: 'v2-speaker' });
    await sleep(50);
    stranger.send(
      `{"gm":${PROTOCOL_VERSION + 1},"seq":0,"ts":1,"runId":"v2","type":"node.started","payload":{}}`,
    );
    await sleep(300);
    expect(stranger.open).toBe(false);
    expect(stranger.closes[0]?.code).toBe(1002);
    expect(await server.alive()).toBe(true);
    expect((await controlRunIsIntact()).ok).toBe(true);
    stranger.close();
  }, 30_000);

  it('never pollutes Object.prototype in the server process', async () => {
    // The server runs in this process, so a prototype-pollution payload that
    // landed would be observable right here.
    const before = prototypeSnapshot();
    await reconnectAttackerIfNeeded();
    for (const text of hostileText().filter((t) => t.includes('proto') || t.includes('constructor'))) {
      attacker.send(text);
    }
    await settle();
    expect(prototypeSnapshot()).toBe(before);
    expect(Object.hasOwn(Object.prototype, 'pwned')).toBe(false);
  }, 60_000);
});

describe('everything the server stores is still a valid envelope', () => {
  /**
   * The load-bearing invariant of the whole storage layer. The viewer runs
   * `parseEnvelope` over every replayed event and drops what it rejects, so a
   * stored envelope that no longer validates is an event that silently
   * vanishes from the canvas on reload — a node stuck "running" forever, or
   * an error that never appears.
   */
  async function everyStoredEventParses(): Promise<{ bad: WireFrame[]; total: number }> {
    const runs = await server.runs();
    const bad: WireFrame[] = [];
    let total = 0;
    for (const run of runs) {
      // Excluded by name, not by luck of ordering: the run below deliberately
      // triggers the truncation defect the next describe block pins.
      if (run.id === OVERSIZED_REQUIRED_RUN) continue;
      for (const event of await server.events(run.id)) {
        total += 1;
        const result = parseEnvelope(event);
        // `unknown-type` is contractually fine: the protocol requires
        // receivers to tolerate types they do not know. `invalid` is not.
        if (result.kind === 'invalid') bad.push(event);
      }
    }
    return { bad, total };
  }

  it('holds across everything this file has already sent', async () => {
    const { bad, total } = await everyStoredEventParses();
    expect(total).toBeGreaterThan(CONTROL_EVENTS);
    expect(
      bad.map((event) => ({ type: event.type, seq: event.seq, runId: event.runId })),
    ).toEqual([]);
  }, 60_000);

  it('holds for randomly generated payloads on valid envelopes (property)', async () => {
    await reconnectAttackerIfNeeded();
    const run = 'payload-fuzz';
    const payloads: unknown[] = [];
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        payloads.push(value);
      }),
      { numRuns: 250 },
    );
    payloads.forEach((payload, seq) => {
      attacker.send(
        JSON.stringify({
          gm: PROTOCOL_VERSION,
          seq,
          ts: Date.now(),
          runId: run,
          type: 'node.finished',
          payload: { nodeId: 'n', instanceId: 'i', durationMs: 1, status: 'ok', output: payload },
        }),
      );
    });
    await settle();
    const events = await server.events(run);
    expect(events.length).toBeGreaterThan(0);
    const bad = events.filter((event) => parseEnvelope(event).kind === 'invalid');
    expect(bad.map((event) => event.seq)).toEqual([]);
  }, 120_000);

  it('an oversized payload keeps the fields its own schema requires', async () => {
    // The 512 KB storage guard truncates rather than dropping, precisely so
    // the stored envelope stays valid. `output` is optional, so trimming it
    // must leave `nodeId` / `durationMs` / `status` intact.
    await reconnectAttackerIfNeeded();
    const run = 'oversized-optional';
    attacker.send(
      JSON.stringify({
        gm: PROTOCOL_VERSION,
        seq: 0,
        ts: Date.now(),
        runId: run,
        type: 'node.finished',
        payload: {
          nodeId: 'tool:big',
          instanceId: 'i',
          durationMs: 5,
          status: 'ok',
          output: 'A'.repeat(600 * 1024),
        },
      }),
    );
    const [event] = await waitForEvents(server, run, 1);
    expect(event).toBeDefined();
    expect(parseEnvelope(event as WireFrame).kind).toBe('ok');
    const payload = (event as WireFrame).payload as Record<string, unknown>;
    expect(payload['nodeId']).toBe('tool:big');
    expect(payload['status']).toBe('ok');
    expect(payload['__graphmindTruncated']).toBe(true);
  }, 60_000);
});

describe('the 512 KB guard preserves the fields the schema requires', () => {
  /**
   * `serializePayload` in packages/cli/src/storage.ts trims an oversized
   * payload field by field rather than discarding the payload whole, because
   * a payload replaced wholesale no longer satisfies its own schema — the
   * viewer's parser rejects the replayed envelope and the node is stuck
   * "running" forever on reload.
   *
   * It used to replace the offending field with a marker OBJECT, which has
   * exactly the same consequence whenever the biggest field is one the schema
   * requires to be a string. `node.error` was the case that mattered: its
   * payload is `{ nodeId, error }`, so a >512 KB error message made `error`
   * the biggest field, `error` became an object of the wrong shape, and
   * `ErrorInfoSchema` rejected the stored envelope. A debugger silently lost
   * precisely the error event, with no attacker involved — a provider
   * returning a large error body was enough.
   *
   * Truncation is now type-preserving (`shrinkValue`): a string stays a
   * string, an array stays an array, an object keeps its own fields with the
   * marker merged in. These five cases are the regression net; each one is an
   * envelope shape where a required field is the biggest field.
   */
  const RUN = OVERSIZED_REQUIRED_RUN;
  const BIG = 'A'.repeat(600 * 1024);
  let stored: WireFrame[] = [];

  const byType = (type: string, nodeId: string): WireFrame | undefined =>
    stored.find(
      (event) =>
        event.type === type && (event.payload as { nodeId?: string })?.nodeId === nodeId,
    );

  beforeAll(async () => {
    await reconnectAttackerIfNeeded();
    const send = (seq: number, type: string, payload: unknown): void =>
      attacker.send(
        JSON.stringify({ gm: PROTOCOL_VERSION, seq, ts: Date.now(), runId: RUN, type, payload }),
      );
    send(0, 'node.error', { nodeId: 'err', error: { name: 'Error', message: BIG } });
    send(1, 'node.started', { nodeId: BIG, kind: 'tool', name: 'x', instanceId: 'i', input: 1 });
    send(2, 'node.started', { nodeId: 'longname', kind: 'tool', name: BIG, instanceId: 'i', input: 1 });
    send(3, 'node.finished', { nodeId: 'inst', instanceId: BIG, durationMs: 1, status: 'ok' });
    send(4, 'run.finished', { status: 'error', error: { name: 'Error', message: BIG } });
    stored = await waitForEvents(server, RUN, 5, 60_000);
  }, 90_000);

  it('all five oversized events really were stored (non-vacuity guard)', () => {
    expect(stored.length).toBe(5);
    expect(stored.every((event) => (event.payload as Record<string, unknown>)['__graphmindTruncated'] === true)).toBe(true);
  });

  it('a node.error with an oversized message stays a valid envelope', () => {
    const event = byType('node.error', 'err');
    expect(event).toBeDefined();
    expect(parseEnvelope(event as WireFrame).kind).toBe('ok');
  });

  it('a run.finished with an oversized error stays a valid envelope', () => {
    const event = stored.find((candidate) => candidate.type === 'run.finished');
    expect(event).toBeDefined();
    expect(parseEnvelope(event as WireFrame).kind).toBe('ok');
  });

  it('a node.started with an oversized nodeId stays a valid envelope', () => {
    const event = stored.find((candidate) => candidate.seq === 1);
    expect(event).toBeDefined();
    expect(parseEnvelope(event as WireFrame).kind).toBe('ok');
  });

  it('a node.started with an oversized name stays a valid envelope', () => {
    const event = byType('node.started', 'longname');
    expect(event).toBeDefined();
    expect(parseEnvelope(event as WireFrame).kind).toBe('ok');
  });

  it('a node.finished with an oversized instanceId stays a valid envelope', () => {
    const event = byType('node.finished', 'inst');
    expect(event).toBeDefined();
    expect(parseEnvelope(event as WireFrame).kind).toBe('ok');
  });

});

describe('hostile values in the fields the server itself reads', () => {
  it('a run id full of unicode nastiness round-trips through storage and REST', async () => {
    await reconnectAttackerIfNeeded();
    // Deliberately excludes lone surrogates: SQLite normalises those (pinned
    // separately below), so they are not a round-trip case.
    const ids = [
      'run  ',
      'run‮gnp.exe',
      "run'; DROP TABLE events; --",
      'run../../etc/passwd',
      'run mid',
      '__proto__',
      'constructor',
    ];
    for (const [index, runId] of ids.entries()) {
      attacker.node(runId, index, `u-${index}`);
    }
    await settle();
    const runs = await server.runs();
    for (const runId of ids) {
      const found = runs.find((run) => run.id === runId);
      expect(found, `run id ${JSON.stringify(runId)} was not stored verbatim`).toBeDefined();
      const events = await server.events(runId);
      expect(events.length).toBe(1);
      expect(parseEnvelope(events[0] as WireFrame).kind).toBe('ok');
    }
    expect(await server.alive()).toBe(true);
  }, 60_000);

  it('a lone surrogate in a run id is refused, not silently rewritten', async () => {
    // It used to be stored: SQLite's text binding substitutes U+FFFD, so the
    // app streamed under one run id and the server kept another, and
    // `subscribe` with the original id tailed an empty run. The envelope is
    // now rejected at the parse boundary instead — nothing legitimate
    // generates a lone surrogate in an id, so refusing is the honest answer.
    await reconnectAttackerIfNeeded();
    attacker.send(
      `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"lone\\ud800id","type":"node.started",` +
        '"payload":{"nodeId":"n","kind":"tool","name":"x","instanceId":"i","input":null}}',
    );
    await settle();
    const runs = await server.runs();
    expect(runs.some((run) => run.id === 'lone\ud800id')).toBe(false);
    expect(runs.some((run) => run.id === 'lone�id')).toBe(false);
    // ...and the connection survives it: one bad frame is not a session.
    expect(await server.alive()).toBe(true);
  }, 60_000);

  it('a hostile `ts` cannot make the run list nonsensical', async () => {
    // `ts` used to be bounded only by `z.number()`, and `ensureRun` uses it
    // as the run's `startedAt` — which the run list sorts by. One frame with
    // `ts: 1e300` therefore pinned that run to the top of the operator's list
    // until it was pruned: a peer choosing where it appears in the UI.
    // `ts` is epoch milliseconds, so it is now required to be a non-negative
    // SAFE integer, and 1e300 is not one.
    await reconnectAttackerIfNeeded();
    attacker.send(
      `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1e300,"runId":"far-future","type":"node.started",` +
        '"payload":{"nodeId":"n","kind":"tool","name":"x","instanceId":"i","input":null}}',
    );
    await settle();
    const runs = await server.runs();
    expect(runs.some((run) => run.id === 'far-future')).toBe(false);
    expect(await server.alive()).toBe(true);
  }, 60_000);

  it('rejects non-finite timestamps outright', async () => {
    await reconnectAttackerIfNeeded();
    for (const ts of ['1e999', '-1e999']) {
      attacker.send(
        `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":${ts},"runId":"nonfinite","type":"node.started",` +
          '"payload":{"nodeId":"n","kind":"tool","name":"x","instanceId":"i","input":null}}',
      );
    }
    await settle();
    expect((await server.runs()).some((run) => run.id === 'nonfinite')).toBe(false);
  }, 60_000);
});
