/**
 * Loop hold — cases found by the adversarial verification pass (2026-09-14).
 *
 *  1. A paginated walk or a chunked read is NOT a loop. The first cut ignored
 *     cursor-like keys (cursor, page, offset, before, after...) when
 *     fingerprinting, which made page 1, page 2, page 3 of one listing — and
 *     `Read({file_path, offset: 0 | 2000 | 4000})` — fingerprint identically:
 *     the third page was HELD under a banner claiming "identical arguments".
 *  2. MCP request metadata is not an argument. An MCP client with progress
 *     enabled stamps `_meta.progressToken` (unique per request) onto every
 *     tools/call; the proxy's tool input is the whole params object, so the
 *     same tool with the same arguments never looked identical and the proxy
 *     never held. `_meta` (reserved by the MCP spec for protocol metadata) is
 *     the default ignore key now.
 *  3. An input that cannot be canonicalised (a throwing getter / Proxy) is not
 *     "identical" to the next one: it breaks the streak instead of building a
 *     phantom one.
 *  4. A run that is still looping is not forgotten because many other runs
 *     started meanwhile (least-recently-used eviction, not oldest-created).
 *  5. The loop details handed to the next hold never leak onto an unrelated
 *     breakpoint hold, and the loop warning never carries an argument.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP_IGNORE_KEYS,
  canonicalize,
  createSession,
  fingerprintCall,
  type LoopGuardOptions,
  type Session,
  type SessionOptions,
} from '../src/index.js';
import { LoopGuard, MAX_LOOP_RUNS, resolveLoopGuard } from '../src/loop-guard.js';
import type { GateNode } from '../src/gate-engine.js';
import type { WebSocketConstructor, WebSocketLike } from '../src/transport.js';
import { FakeViewer, tick, waitUntil } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const READ: GateNode = { nodeId: 'tool:Read', kind: 'tool', name: 'Read' };
const LIST: GateNode = { nodeId: 'tool:list_issues', kind: 'tool', name: 'list_issues' };
const ECHO: GateNode = { nodeId: 'tool:echo', kind: 'tool', name: 'echo' };
const OTHER: GateNode = { nodeId: 'tool:other', kind: 'tool', name: 'other' };

let instances = 0;

function call(session: Session, node: GateNode, input: unknown) {
  session.emit('node.started', {
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    instanceId: `v${(instances += 1)}`,
    input,
  });
  return session.gate('before', node);
}

async function startViewer(options: Parameters<typeof FakeViewer.start>[0] = {}): Promise<FakeViewer> {
  const viewer = await FakeViewer.start(options);
  cleanups.push(() => viewer.close());
  return viewer;
}

async function attachedSession(viewer: FakeViewer, extra: SessionOptions = {}): Promise<Session> {
  const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {}, ...extra });
  cleanups.push(() => session.dispose());
  session.emit('graph.hint', { nodes: [] });
  await waitUntil(() => session.attached, 3000, 'session attach');
  return session;
}

class NeverConnectsWS implements WebSocketLike {
  readonly readyState = 0;
  constructor(_url: string) {}
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

describe('loop hold — a walk is not a loop', () => {
  it('a chunked read (offset 0, 2000, 4000...) and a paginated listing (page / cursor) are never held', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    for (const offset of [0, 2000, 4000, 6000, 8000]) {
      const decision = await settledWithin(call(session, READ, { file_path: '/repo/big.ts', offset, limit: 2000 }), 300);
      expect(decision, `offset ${offset}`).toEqual({ action: 'continue' });
    }
    for (const page of [1, 2, 3, 4]) {
      const decision = await settledWithin(call(session, LIST, { owner: 'gm', repo: 'gm', page }), 300);
      expect(decision, `page ${page}`).toEqual({ action: 'continue' });
    }
    for (const cursor of ['c1', 'c2', 'c3', 'c4']) {
      const decision = await settledWithin(call(session, LIST, { owner: 'gm', repo: 'gm', cursor }), 300);
      expect(decision, `cursor ${cursor}`).toEqual({ action: 'continue' });
    }
    // Date windows (`before` / `after`) are different questions too.
    for (const [after, before] of [['2026-09-01', '2026-09-07'], ['2026-09-08', '2026-09-14'], ['2026-09-15', '2026-09-21']]) {
      const decision = await settledWithin(call(session, LIST, { owner: 'gm', repo: 'gm', after, before }), 300);
      expect(decision).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);

    // ...while re-reading the SAME chunk is still the loop it looks like.
    await call(session, READ, { file_path: '/repo/big.ts', offset: 0, limit: 2000 });
    await call(session, READ, { file_path: '/repo/big.ts', offset: 0, limit: 2000 });
    const third = call(session, READ, { file_path: '/repo/big.ts', offset: 0, limit: 2000 });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ nodeId: 'tool:Read', reason: 'loop', loop: { repeats: 3 } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await third).toEqual({ action: 'continue' });
  });

  it('pagination keys stay part of the fingerprint unless the caller opts in to ignoring them', () => {
    expect(DEFAULT_LOOP_IGNORE_KEYS).toEqual(['_meta']);
    const d = resolveLoopGuard(undefined, {});
    expect(fingerprintCall(LIST.nodeId, { q: 'x', page: 1 }, d.ignoreKeys)).not.toBe(
      fingerprintCall(LIST.nodeId, { q: 'x', page: 2 }, d.ignoreKeys),
    );
    // Opting in is one option away (and replaces the default list).
    const optIn = resolveLoopGuard({ ignoreKeys: ['page', '_meta'] }, {});
    expect(fingerprintCall(LIST.nodeId, { q: 'x', page: 1 }, optIn.ignoreKeys)).toBe(
      fingerprintCall(LIST.nodeId, { q: 'x', page: 2 }, optIn.ignoreKeys),
    );
  });
});

describe('loop hold — MCP request metadata is not an argument', () => {
  it('a tools/call whose _meta.progressToken changes on every request is still the same call', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    // Exactly what @modelcontextprotocol/sdk's Client sends when `onprogress`
    // is set (progressToken = the JSON-RPC message id), plus a 2026-era
    // per-request envelope — and what the proxy hands the session as input.
    const params = (id: number) => ({
      name: 'echo',
      arguments: { text: 'same' },
      _meta: { progressToken: id, 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    expect(await call(session, ECHO, params(1))).toEqual({ action: 'continue' });
    expect(await call(session, ECHO, params(2))).toEqual({ action: 'continue' });
    const third = call(session, ECHO, params(3));
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ nodeId: 'tool:echo', reason: 'loop', loop: { repeats: 3 } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await third).toEqual({ action: 'continue' });

    // Different arguments under the same metadata are still different calls.
    expect(canonicalize(params(9), new Set(DEFAULT_LOOP_IGNORE_KEYS))).toBe('{"arguments":{"text":"same"},"name":"echo"}');
  });
});

describe('loop hold — inputs that cannot be compared', () => {
  it('an input that throws while being read breaks the streak instead of looking identical', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    const hostile = (n: number): unknown => ({
      n,
      get boom(): never {
        throw new Error('not initialised');
      },
    });
    for (let i = 0; i < 5; i += 1) {
      let decision: Promise<unknown> | undefined;
      expect(() => {
        decision = call(session, OTHER, hostile(i));
      }).not.toThrow();
      expect(await settledWithin(decision as Promise<unknown>, 300)).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);

    // And an uncomparable call in the middle of a real streak resets it.
    await call(session, ECHO, { text: 'same' });
    await call(session, ECHO, { text: 'same' });
    await call(session, ECHO, hostile(0));
    expect(await settledWithin(call(session, ECHO, { text: 'same' }), 300)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });
});

describe('loop hold — bounded memory keeps the runs that are still looping', () => {
  it('a run that keeps calling is not evicted because more than MAX_LOOP_RUNS other runs started meanwhile', () => {
    const guard = new LoopGuard(resolveLoopGuard(undefined, {}));
    let seq = 0;
    const record = (runId: string, input: unknown) =>
      guard.record(runId, 'tool', ECHO.nodeId, ECHO.name, input, (seq += 1));
    record('long', { text: 'same' });
    for (let i = 0; i < MAX_LOOP_RUNS * 2; i += 1) {
      record(`short-${i}`, { i });
      // The long run keeps calling: never more than MAX_LOOP_RUNS - 4 new runs
      // between two of its calls, but 128 new runs over its lifetime.
      if (i === 30 || i === 90) record('long', { text: 'same' });
    }
    // Oldest-CREATED eviction dropped `long` at the 64th short run and its
    // streak restarted; least-recently-used keeps it.
    const fourth = record('long', { text: 'same' });
    expect(fourth?.repeats).toBe(4);
    expect(guard.consult('long', 'tool', ECHO.nodeId, ECHO.name)?.repeats).toBe(4);
    expect(guard.trackedRuns).toBeLessThanOrEqual(MAX_LOOP_RUNS);
  });
});

describe('loop hold — a hostile option never throws into the host', () => {
  it('createSession survives a loopGuard option whose reads throw, and falls back to env / defaults', async () => {
    const hostile: unknown[] = [
      { get threshold(): never { throw new Error('getter'); } },
      new Proxy({}, { get: () => { throw new Error('trap'); } }),
      { kinds: new Proxy([], { get: (t, p) => { if (p === 'filter') throw new Error('filter'); return Reflect.get(t, p); } }) },
    ];
    const viewer = await startViewer();
    for (const loopGuard of hostile) {
      let session: Session | undefined;
      expect(() => {
        session = createSession({
          url: viewer.url,
          enabled: true,
          retryIntervalMs: 60_000,
          env: { GRAPHMIND_LOOP_THRESHOLD: '2' },
          loopGuard: loopGuard as LoopGuardOptions,
        });
      }).not.toThrow();
      const s = session as Session;
      cleanups.push(() => s.dispose());
      expect(s.stats().enabled).toBe(true);
      // The unreadable option is ignored; the env still configures the guard.
      const resolved = resolveLoopGuard(loopGuard as never, { GRAPHMIND_LOOP_THRESHOLD: '2' });
      expect(resolved.threshold).toBe(2);
      expect(resolved.mode).toBe('pause');
      expect([...resolved.kinds]).toEqual(['tool']);
    }
    expect(resolveLoopGuard({ get mode(): never { throw new Error('x'); } } as never, { get GRAPHMIND_ON_LOOP(): never { throw new Error('env'); } } as never)).toMatchObject({
      threshold: 3,
      mode: 'pause',
    });
  });
});

describe('loop hold — nothing leaks', () => {
  it('the loop details of one hold never appear on a later, unrelated breakpoint hold', async () => {
    const viewer = await startViewer({ breakpoints: [{ kind: 'tool', name: 'other', point: 'before' }] });
    const session = await attachedSession(viewer);
    await settledWithin(call(session, ECHO, { text: 'same' }), 100);
    await settledWithin(call(session, ECHO, { text: 'same' }), 100);
    const loopHold = call(session, ECHO, { text: 'same' });
    const first = await viewer.waitForType('exec.paused');
    expect(first.payload['reason']).toBe('loop');
    viewer.resume(first.payload['pauseId'] as string, 'continue');
    await loopHold;

    const bp = call(session, OTHER, { anything: 1 });
    const second = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:other');
    expect(second.payload['reason']).toBe('breakpoint'); // its own reason (0.6.0), not the loop's
    expect(second.payload['loop']).toBeUndefined();
    viewer.resume(second.payload['pauseId'] as string, 'continue');
    await bp;
  });

  it('the detached loop warning names the tool, never an argument', () => {
    const warnings: string[] = [];
    const session = createSession({
      enabled: true,
      env: {},
      webSocket: NeverConnectsWS as unknown as WebSocketConstructor,
      retryIntervalMs: 60_000,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => session.dispose());
    const secret = { email: 'alice@corp.example', token: 'sk-live-0123456789' };
    for (let i = 0; i < 4; i += 1) void call(session, ECHO, secret);
    const loop = warnings.filter((w) => w.includes('possible loop'));
    expect(loop).toHaveLength(1);
    expect(loop[0]).toContain('tool:echo');
    expect(loop[0]).not.toContain('alice');
    expect(loop[0]).not.toContain('sk-live');
    expect(loop[0]).not.toContain(fingerprintCall(ECHO.nodeId, secret));
  });
});
