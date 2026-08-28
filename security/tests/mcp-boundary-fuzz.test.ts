/**
 * The MCP boundary.
 *
 * `@graphmind-ai/mcp` is not a proxy — it instruments an MCP server
 * *in-process*, so there is no second JSON-RPC parser of GraphMind's to fuzz;
 * the SDK owns that. What it does own is the seam where somebody else's agent
 * meets GraphMind's wire: a `tools/call` from an untrusted client becomes a
 * `node.started` payload, the host's result becomes a `node.finished` payload,
 * and — the reason the package exists — the debugger's `inject` value is
 * coerced into an MCP result and handed to the SDK to validate and return.
 *
 * Three inputs, three invariants:
 *
 *   1. **hostile client arguments** must not throw into the host handler and
 *      must not produce an envelope the GraphMind server or the viewer
 *      rejects;
 *   2. **a hostile host result** (enormous, cyclic, unicode) must reach the
 *      client unchanged and be recorded without breaking anything;
 *   3. **an injected value** must become a valid MCP result whatever it is —
 *      the coercion in `src/coerce.ts` promises never to throw, and a schema
 *      error there would turn the killer feature into a broken request.
 *
 * `packages/mcp` is a sibling's package and is only read here, never edited:
 * everything below drives it through its published entry point.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseEnvelope } from '@graphmind-ai/schema';
import { NASTY_STRINGS, anyValueArb, prototypeSnapshot } from '../src/fuzz.js';
import { startMcpPeer, type McpPeer } from '../src/mcp-peer.js';
import { RawViewer, WireServer, sleep, type WireFrame } from '../src/wire.js';

let server: WireServer;
let peer: McpPeer;

/** Every envelope stored across every run, for the validity sweep. */
async function allStoredEvents(): Promise<WireFrame[]> {
  const out: WireFrame[] = [];
  for (const run of await server.runs()) out.push(...(await server.events(run.id)));
  return out;
}

/**
 * One tool call, with a hard deadline.
 *
 * Without it a single request that never returns (a gate nobody releases, a
 * hang in the adapter) leaves its promise pending, `peer.behaviour` un-reset,
 * and every later test failing for the wrong reason. A timeout is a result
 * here, not an accident.
 */
async function callEcho(payload: unknown): Promise<{ ok: boolean; text: string }> {
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('TIMED OUT: the tool call never returned')), 15_000).unref();
  });
  try {
    const result = (await Promise.race([
      peer.client.callTool({ name: 'echo', arguments: { payload } }),
      deadline,
    ])) as { content?: { type?: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? [])
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('');
    return { ok: result.isError !== true, text };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

beforeAll(async () => {
  // Pause-on-error off: several tests below make the host handler throw, and
  // the default error breakpoint would hold the request until a debugger
  // resumed it. The inject block arms its own `before` breakpoint.
  server = await WireServer.boot({ pauseOnError: 'off' });
  peer = await startMcpPeer(server);
}, 60_000);

afterAll(async () => {
  await peer?.close();
  await server?.close();
});

describe('the instrumented MCP server really is instrumented (non-vacuity guard)', () => {
  it('a plain tool call reaches the host and is recorded by GraphMind', async () => {
    const before = peer.handlerCalls.length;
    const result = await callEcho({ hello: 'world' });
    expect(result.ok).toBe(true);
    expect(peer.handlerCalls.length).toBe(before + 1);
    await sleep(400);
    const events = await allStoredEvents();
    const started = events.filter((event) => event.type === 'node.started');
    expect(started.length).toBeGreaterThan(0);
    expect(
      started.some((event) => (event.payload as { name?: string }).name === 'echo'),
    ).toBe(true);
  }, 30_000);
});

describe('hostile arguments from an untrusted MCP client', () => {
  it('every nasty string survives the round trip without touching the host', async () => {
    for (const value of NASTY_STRINGS) {
      const result = await callEcho(value);
      expect(result.ok, `payload of ${value.length} chars`).toBe(true);
    }
    expect(peer.hostErrors).toEqual([]);
    expect(await server.alive()).toBe(true);
  }, 120_000);

  it('survives generated JSON arguments (property)', async () => {
    const values: unknown[] = [];
    fc.assert(
      fc.property(anyValueArb, (value) => {
        values.push(value);
      }),
      { numRuns: 120 },
    );
    for (const value of values) {
      const result = await callEcho(value);
      expect(result.ok).toBe(true);
    }
    expect(peer.hostErrors).toEqual([]);
    expect(await server.alive()).toBe(true);
  }, 120_000);

  it('survives a deeply nested and an enormous argument', async () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 4_000; i += 1) deep = { a: deep };
    expect((await callEcho(deep)).ok).toBe(true);
    expect((await callEcho('A'.repeat(2 * 1024 * 1024))).ok).toBe(true);
    expect(peer.hostErrors).toEqual([]);
    expect(await server.alive()).toBe(true);
  }, 120_000);

  it('a `__proto__` argument does not pollute the host process', async () => {
    const before = prototypeSnapshot();
    expect((await callEcho(JSON.parse('{"__proto__":{"pwned":true}}') as unknown)).ok).toBe(true);
    expect(
      (await callEcho(JSON.parse('{"constructor":{"prototype":{"pwned":true}}}') as unknown)).ok,
    ).toBe(true);
    expect(prototypeSnapshot()).toBe(before);
    expect(Object.hasOwn(Object.prototype, 'pwned')).toBe(false);
  }, 60_000);

  it('a host handler that throws is still reported to the client as a tool error', async () => {
    // The fail-open rule cuts both ways: GraphMind must not swallow the
    // host's own failure either.
    peer.behaviour = { throws: new Error('the host said no') };
    const result = await callEcho({ x: 1 });
    peer.behaviour = {};
    expect(result.ok).toBe(false);
    expect(result.text).toContain('the host said no');
    expect(peer.hostErrors).toEqual([]);
  }, 30_000);

  it('everything GraphMind stored from this boundary is still a valid envelope', async () => {
    await sleep(600);
    const events = await allStoredEvents();
    expect(events.length).toBeGreaterThan(10);
    const bad = events.filter((event) => parseEnvelope(event).kind === 'invalid');
    expect(bad.map((event) => ({ type: event.type, seq: event.seq }))).toEqual([]);
  }, 60_000);
});

describe('a hostile host result', () => {
  it('reaches the client unchanged and is recorded without incident', async () => {
    peer.behaviour = { result: { text: '\ud800 ‮', big: 'B'.repeat(700 * 1024) } };
    const result = await callEcho({ ask: 'big' });
    peer.behaviour = {};
    expect(result.ok).toBe(true);
    // The client got the host's real answer — GraphMind is on the path, not
    // in the way.
    expect(result.text.length).toBeGreaterThan(700 * 1024);
    expect(peer.hostErrors).toEqual([]);
    expect(await server.alive()).toBe(true);
  }, 60_000);

  it('an oversized result is truncated in storage but delivered whole to the client', async () => {
    // GraphMind is on the path, not in the way. The 512 KB storage guard
    // decides what is *recorded*; it must never decide what the MCP client
    // receives.
    peer.behaviour = { result: { marker: 'oversized-result', big: 'C'.repeat(900 * 1024) } };
    const result = await callEcho({ ask: 'oversized' });
    peer.behaviour = {};
    expect(result.ok).toBe(true);
    expect(result.text.length).toBeGreaterThan(900 * 1024);
    await sleep(600);
    const finished = (await allStoredEvents()).filter((event) => event.type === 'node.finished');
    const truncated = finished.filter(
      (event) => (event.payload as Record<string, unknown>)['__graphmindTruncated'] === true,
    );
    expect(truncated.length).toBeGreaterThan(0);
    for (const event of truncated) expect(parseEnvelope(event).kind).toBe('ok');
    expect(peer.hostErrors).toEqual([]);
    expect(await server.alive()).toBe(true);
  }, 60_000);
});

describe('inject: whatever the operator types must become a valid MCP result', () => {
  /**
   * The feature the package exists for. `coerceInjected` lifts an arbitrary
   * debugger-supplied value into the result shape the request must return,
   * and the SDK validates that shape on the way out — so a coercion that
   * produced the wrong thing would surface here as a failed tool call, from
   * the client's point of view, for a request the host never even ran.
   */
  const injected: [string, unknown][] = [
    ['a bare string', 'just text'],
    ['a number', 42],
    ['null', null],
    ['an object', { price: 42, currency: 'EUR' }],
    ['an array', [1, 2, 3]],
    ['a real CallToolResult', { content: [{ type: 'text', text: 'hand-built' }] }],
    ['a lone surrogate', '\ud800'],
    ['U+2028 and an RTL override', ' ‮gnp.exe'],
    ['a NUL byte', `a${String.fromCharCode(0)}b`],
    ['a deeply nested object', { a: { b: { c: { d: { e: 'deep' } } } } }],
    ['a 1 MB string', 'C'.repeat(1024 * 1024)],
    ['a __proto__ key', JSON.parse('{"__proto__":{"pwned":true}}') as unknown],
  ];

  let viewer: RawViewer;
  const outcomes: { label: string; ok: boolean; text: string; ranHost: boolean }[] = [];

  /**
   * Find the pause a call is currently held at.
   *
   * Over REST rather than the viewer socket: every MCP request opens its own
   * run, so there is no run id to subscribe to before the call is made. The
   * server's own API is the authority on what is stored anyway.
   */
  async function findPause(
    known: Set<string>,
    timeoutMs = 10_000,
  ): Promise<{ runId: string; pauseId: string } | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const run of await server.runs()) {
        for (const event of await server.events(run.id)) {
          if (event.type !== 'exec.paused') continue;
          const pauseId = String((event.payload as { pauseId?: string }).pauseId);
          if (known.has(pauseId)) continue;
          return { runId: run.id, pauseId };
        }
      }
      await sleep(50);
    }
    return undefined;
  }

  beforeAll(async () => {
    viewer = await RawViewer.connect(server);
    await sleep(50);
    // Pause before every tool call, the way an operator debugging an MCP
    // server would.
    viewer.control('*', 'breakpoint.set', { matcher: { kind: 'tool', point: 'before' } });
    await sleep(400);

    const known = new Set<string>();
    for (const event of (await allStoredEvents()).filter((e) => e.type === 'exec.paused')) {
      known.add(String((event.payload as { pauseId?: string }).pauseId));
    }

    for (const [label, value] of injected) {
      const before = peer.handlerCalls.length;
      const call = callEcho({ label });
      const pause = await findPause(known);
      if (pause === undefined) {
        outcomes.push({ label, ok: false, text: 'never paused', ranHost: false });
        await call;
        continue;
      }
      known.add(pause.pauseId);
      viewer.control(pause.runId, 'exec.resume', {
        pauseId: pause.pauseId,
        action: 'inject',
        output: value,
      });
      const result = await call;
      outcomes.push({
        label,
        ok: result.ok,
        text: result.text,
        ranHost: peer.handlerCalls.length > before,
      });
    }

    viewer.control('*', 'breakpoint.clear', { matcher: { kind: 'tool', point: 'before' } });
    await sleep(200);
  }, 180_000);

  afterAll(() => {
    viewer?.close();
  });

  it('every gate was reached and released (non-vacuity guard)', () => {
    expect(outcomes.length).toBe(injected.length);
    expect(outcomes.filter((outcome) => outcome.text === 'never paused')).toEqual([]);
  });

  it('inject really replaced the host — the handler body never ran', () => {
    expect(outcomes.filter((outcome) => outcome.ranHost).map((outcome) => outcome.label)).toEqual(
      [],
    );
  });

  it('every injected value produced a result the client accepted', () => {
    expect(outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.label)).toEqual([]);
  });

  it('GraphMind never threw into the host across the whole inject pass', () => {
    expect(peer.hostErrors).toEqual([]);
  });

  it('the server and every stored envelope are unharmed', async () => {
    expect(await server.alive()).toBe(true);
    const events = await allStoredEvents();
    const bad = events.filter((event) => parseEnvelope(event).kind === 'invalid');
    expect(bad.map((event) => ({ type: event.type, seq: event.seq }))).toEqual([]);
  }, 60_000);

  it('injecting a __proto__ object does not pollute the host process', () => {
    expect(Object.hasOwn(Object.prototype, 'pwned')).toBe(false);
    expect(({} as Record<string, unknown>)['pwned']).toBeUndefined();
  });
});
