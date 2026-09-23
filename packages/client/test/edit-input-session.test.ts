/**
 * Edited input through a live session (contract C2): what is announced, when
 * a pause is offered as `editable`, every refusal (the gate stays held under
 * the same pauseId), acceptance (`decision.input` + `exec.resumed.edited`),
 * fail-open while validating, held time across refusals, requestId echo, and
 * the client-side inject guard. Proven against a real WebSocket viewer double
 * that plays a 0.6 debugger (hello.ack.hubCapabilities) or a 0.5 one (none).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ControlPayloadSchemas,
  EventPayloadSchemas,
  MAX_PAYLOAD_BYTES,
  MCP_PREVIEW_NOTE_PREFIX,
  TRUNCATION_SUFFIX,
  parseEnvelope,
} from '@graphmind-ai/schema';
import {
  REDACTED,
  VALIDATION_TIMEOUT_MS,
  createSession,
  mergeToolInput,
  type GateDecision,
  type GateNode,
  type GateOptions,
  type InputValidation,
  type Session,
  type SessionOptions,
} from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions, type ReceivedFrame } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOOL: GateNode = { nodeId: 'tool:search', kind: 'tool', name: 'search' };
const LLM: GateNode = { nodeId: 'llm:step', kind: 'llm', name: 'step' };
const EDIT_HUB = ['edit-input'];
/** Pause every tool at every point. */
const TOOL_EVERYWHERE = [
  { kind: 'tool' as const },
  { kind: 'tool' as const, point: 'after' as const },
  { kind: 'tool' as const, point: 'error' as const },
];

async function setup(
  viewerOptions: FakeViewerOptions = {},
  sessionOptions: SessionOptions = {},
): Promise<{ viewer: FakeViewer; session: Session }> {
  const viewer = await FakeViewer.start({ hubCapabilities: EDIT_HUB, breakpoints: TOOL_EVERYWHERE, ...viewerOptions });
  cleanups.push(() => viewer.close());
  const session = createSession({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    env: {},
    ...sessionOptions,
  });
  cleanups.push(() => session.dispose());
  expect(await session.ready()).toBe(true);
  return { viewer, session };
}

/** The live tool arguments and the adapter's validator for them (the W2 recipe). */
function toolEdit(live: Record<string, unknown> = { query: 'AMS', limit: 5 }, extra: Partial<GateOptions> = {}) {
  const seen: unknown[] = [];
  const options: GateOptions = {
    editable: true,
    validateInput: (proposed) => {
      seen.push(proposed);
      const merged = mergeToolInput(live, proposed);
      if (!merged.ok) return merged;
      const value = merged.value as Record<string, unknown>;
      if (typeof value['query'] !== 'string') return { ok: false, code: 'schema', message: 'query must be a string' };
      return merged;
    },
    ...extra,
  };
  return { live, options, seen };
}

async function nthOfType(viewer: FakeViewer, type: string, n: number): Promise<ReceivedFrame> {
  await waitUntil(() => viewer.ofType(type).length >= n, 5000, `${type} #${n}`);
  return viewer.ofType(type)[n - 1] as ReceivedFrame;
}

const pauseIdOf = (frame: ReceivedFrame): string => frame.payload['pauseId'] as string;

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

function expectAllValid(viewer: FakeViewer): void {
  for (const frame of viewer.received) expect(parseEnvelope(frame).kind, frame.type).toBe('ok');
}

/** Frames replayed on re-attach keep their seq: count each once. */
function unique(frames: ReceivedFrame[]): ReceivedFrame[] {
  return [...new Map(frames.map((frame) => [frame.seq, frame])).values()];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Block the event loop, as a CPU-bound validator (or a first-call schema compile) does. */
function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin: nothing can interrupt synchronous validator work
  }
}

/** The first answer to a resume: exec.refused (gate still held) or exec.resumed (released). */
async function firstAnswer(viewer: FakeViewer, timeoutMs: number): Promise<{ type: string; payload: unknown }> {
  const frame = await viewer.waitFor((f) => f.type === 'exec.refused' || f.type === 'exec.resumed', timeoutMs);
  return { type: frame.type, payload: frame.payload };
}

/** Did the edit run (the gate released with it) or was it refused (gate still held)? */
async function outcomeOf(
  viewer: FakeViewer,
  gate: Promise<GateDecision>,
): Promise<{ kind: 'ran'; decision: GateDecision } | { kind: 'refused'; payload: Record<string, unknown> }> {
  return await Promise.race([
    gate.then((decision) => ({ kind: 'ran' as const, decision })),
    viewer.waitForType('exec.refused', 3000).then((frame) => ({ kind: 'refused' as const, payload: frame.payload })),
  ]);
}

/** Byte-for-byte what the read-only MCP server's `compactPayload(value, 4000)` returns for a big value. */
function mcpPreview(value: unknown, maxChars = 4000): { truncated: true; note: string; preview: string } {
  const json = JSON.stringify(value);
  return {
    truncated: true,
    note: `payload truncated: showing first ${maxChars} of ${json.length} JSON characters — open the deep link in the GraphMind viewer for the full payload`,
    preview: json.slice(0, maxChars),
  };
}

describe('announcement: hello.capabilities', () => {
  it('announces edit-input by default', async () => {
    const { viewer } = await setup();
    const hello = await viewer.waitForType('hello');
    expect(hello.payload['capabilities']).toContain('edit-input');
  });

  it.each(['1', 'yes', 'on', 'TRUE ', ' true', 'anything', 'Y', 'disabled'])(
    'GRAPHMIND_DISABLE_EDIT_INPUT=%j is ON: edit-input is not announced',
    async (value) => {
      const { viewer } = await setup({}, { env: { GRAPHMIND_DISABLE_EDIT_INPUT: value } });
      const hello = await viewer.waitForType('hello');
      const capabilities = hello.payload['capabilities'] as string[];
      expect(capabilities).not.toContain('edit-input');
      expect(capabilities).toEqual(expect.arrayContaining(['pause', 'step', 'inject', 'retry', 'abort']));
    },
  );

  it.each(['', '0', 'false', 'off', 'no', ' OFF ', 'No', 'FALSE'])(
    'GRAPHMIND_DISABLE_EDIT_INPUT=%j is off: edit-input is announced',
    async (value) => {
      const { viewer } = await setup({}, { env: { GRAPHMIND_DISABLE_EDIT_INPUT: value } });
      const hello = await viewer.waitForType('hello');
      expect(hello.payload['capabilities']).toContain('edit-input');
    },
  );
});

describe('exec.paused.editable', () => {
  it('is true when the adapter says so, the app announced it and the debugger lists it', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL, toolEdit().options);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toEqual({ pauseId: pauseIdOf(paused), nodeId: TOOL.nodeId, point: 'before', editable: true });
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await gate).toEqual({ action: 'continue' });
  });

  it.each<[string, GateOptions | undefined]>([
    ['no options', undefined],
    ['editable omitted', { validateInput: () => ({ ok: true, value: 1 }) }],
    ['editable false', { editable: false }],
    ['editable as a string', { editable: 'true' as unknown as boolean }],
    ['only a result', { result: { ok: true } }],
  ])('is absent with %s', async (_label, options) => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL, options);
    const paused = await viewer.waitForType('exec.paused');
    expect(Object.keys(paused.payload)).toEqual(['pauseId', 'nodeId', 'point']);
    viewer.resume(pauseIdOf(paused), 'continue');
    await gate;
  });

  it('a 0.5 debugger (no hubCapabilities) never sees editable — the frame is the 0.5 frame', async () => {
    const { viewer, session } = await setup({ hubCapabilities: undefined });
    const gate = session.gate('before', TOOL, toolEdit().options);
    const paused = await viewer.waitForType('exec.paused');
    expect(Object.keys(paused.payload)).toEqual(['pauseId', 'nodeId', 'point']);
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await gate).toEqual({ action: 'continue' });
  });

  it('a debugger whose hubCapabilities lack edit-input never sees editable', async () => {
    const { viewer, session } = await setup({ hubCapabilities: ['something-else'] });
    const gate = session.gate('before', TOOL, toolEdit().options);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resume(pauseIdOf(paused), 'continue');
    await gate;
  });

  it('the echoed `capabilities` do not count as the debugger supporting edits', async () => {
    // A 0.5 hub echoes the app's own list back — edit-input included.
    const { viewer, session } = await setup({ hubCapabilities: undefined, echoCapabilities: true });
    const gate = session.gate('before', TOOL, toolEdit().options);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['editable']).toBeUndefined();
    const pauseId = pauseIdOf(paused);
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 'LIS' } });
    expect((await viewer.waitForType('exec.refused')).payload).toMatchObject({ pauseId, code: 'disabled' });
    viewer.resume(pauseId, 'continue');
    await gate;
  });

  it('is absent under the kill switch even when the debugger supports edits', async () => {
    const { viewer, session } = await setup({}, { env: { GRAPHMIND_DISABLE_EDIT_INPUT: 'yes' } });
    const gate = session.gate('before', TOOL, toolEdit().options);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resume(pauseIdOf(paused), 'continue');
    await gate;
  });

  it('options whose getters throw: the gate still holds, not editable, nothing thrown', async () => {
    const { viewer, session } = await setup();
    const hostile = new Proxy({} as GateOptions, {
      get() {
        throw new Error('boom');
      },
      has() {
        throw new Error('boom');
      },
    });
    const gate = session.gate('before', TOOL, hostile);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['editable']).toBeUndefined();
    viewer.resume(pauseIdOf(paused), 'continue');
    expect(await gate).toEqual({ action: 'continue' });
  });

  it('detached, gate() with options never reads them and resolves continue', async () => {
    const session = createSession({ enabled: true, env: {}, webSocket: undefined, logger: () => {} });
    cleanups.push(() => session.dispose());
    const hostile = new Proxy({} as GateOptions, {
      get() {
        throw new Error('read while detached');
      },
      has() {
        throw new Error('read while detached');
      },
    });
    expect(await session.gate('before', TOOL, hostile)).toEqual({ action: 'continue' });
    expect(await session.gate('after', TOOL, hostile)).toEqual({ action: 'continue' });
  });
});

describe('an accepted edit', () => {
  it('continue + input at before: decision.input is the validated value; exec.resumed records it', async () => {
    const { viewer, session } = await setup();
    const { options, seen } = toolEdit({ query: 'AMS', limit: 5 });
    const gate = session.gate('before', TOOL, options);
    const paused = await viewer.waitForType('exec.paused');
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { query: 'LIS' }, requestId: 'req-1' });
    const decision = await gate;
    expect(decision).toEqual({ action: 'continue', input: { query: 'LIS', limit: 5 } });
    expect(seen).toEqual([{ query: 'LIS' }]);
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload).toEqual({
      pauseId: pauseIdOf(paused),
      action: 'continue',
      edited: { after: { query: 'LIS', limit: 5 } },
      requestId: 'req-1',
    });
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
    expect(session.stats().heldGates).toBe(0);
    expectAllValid(viewer);
  });

  it('retry + input at after', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('after', TOOL, toolEdit().options);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['point']).toBe('after');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { limit: 1 } });
    expect(await gate).toEqual({ action: 'retry', input: { query: 'AMS', limit: 1 } });
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload).toEqual({ pauseId: pauseIdOf(paused), action: 'retry', edited: { after: { query: 'AMS', limit: 1 } } });
  });

  it('retry + input at error', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('error', TOOL, toolEdit().options);
    const paused = await viewer.waitForType('exec.paused');
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { query: 'OPO' } });
    expect(await gate).toEqual({ action: 'retry', input: { query: 'OPO', limit: 5 } });
  });

  it('without a validator the proposed input is used as it is', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL, { editable: true });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: ['any', { json: 1 }] });
    expect(await gate).toEqual({ action: 'continue', input: ['any', { json: 1 }] });
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload['edited']).toEqual({ after: ['any', { json: 1 }] });
  });

  it('an async validator is awaited', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL, {
      editable: true,
      validateInput: async (proposed) => {
        await tick(30);
        return { ok: true, value: { wrapped: proposed } };
      },
    });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { a: 1 } });
    expect(await gate).toEqual({ action: 'continue', input: { wrapped: { a: 1 } } });
  });

  it('decision.input is the validator value itself; the wire gets its JSON copy', async () => {
    const { viewer, session } = await setup();
    const when = new Date(0);
    const value = { when, query: 'LIS' };
    const gate = session.gate('before', TOOL, { editable: true, validateInput: () => ({ ok: true, value }) });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { query: 'LIS' } });
    const decision = await gate;
    expect(decision.action === 'continue' && decision.input).toBe(value);
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload['edited']).toEqual({ after: { when: '1970-01-01T00:00:00.000Z', query: 'LIS' } });
  });

  it("the validator runs in the gated call's async context, not the transport's", async () => {
    const { viewer, session } = await setup();
    let seenRun: string | undefined = 'never called';
    const runId = await session.run('host-run', async (ctx) => {
      const gate = session.gate('before', TOOL, {
        editable: true,
        validateInput: (proposed) => {
          seenRun = session.currentRun()?.runId;
          return { ok: true, value: proposed };
        },
      });
      const paused = await viewer.waitForType('exec.paused');
      viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { q: 1 } });
      await gate;
      return ctx.runId;
    });
    expect(seenRun).toBe(runId);
  });

  // A validator may return any PromiseLike. A lazy thenable (knex / drizzle /
  // mongoose / Prisma query builders start their work inside then()) must be
  // adopted in the gated call's async context too, not in the WebSocket
  // message handler's: host AsyncLocalStorage stores (OTel context, tenant or
  // transaction scope) and session.currentRun() are the host's.
  interface SeenContext {
    host: string | undefined;
    run: string | undefined;
  }

  it("a lazy thenable's then() runs in the gated call's async context (host stores, currentRun)", async () => {
    const { viewer, session } = await setup();
    const hostAls = new AsyncLocalStorage<string>();
    let inBody: SeenContext | undefined;
    let inThen: SeenContext | undefined;
    const runId = await hostAls.run('host-request-42', () =>
      session.run('host-run', async (ctx) => {
        const gate = session.gate('before', TOOL, {
          editable: true,
          validateInput: (proposed) => {
            inBody = { host: hostAls.getStore(), run: session.currentRun()?.runId };
            const lazy: PromiseLike<InputValidation> = {
              then(onFulfilled, onRejected) {
                inThen = { host: hostAls.getStore(), run: session.currentRun()?.runId };
                return Promise.resolve<InputValidation>({ ok: true, value: proposed }).then(onFulfilled, onRejected);
              },
            };
            return lazy;
          },
        });
        const paused = await viewer.waitForType('exec.paused');
        viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { q: 1 } });
        expect(await gate).toEqual({ action: 'continue', input: { q: 1 } });
        return ctx.runId;
      }),
    );
    expect(inBody).toEqual({ host: 'host-request-42', run: runId });
    expect(inThen).toEqual({ host: 'host-request-42', run: runId });
  });

  it("a thenable's `then` getter is read in the gated call's async context", async () => {
    const { viewer, session } = await setup();
    const hostAls = new AsyncLocalStorage<string>();
    let inGetter: SeenContext | undefined;
    const runId = await hostAls.run('host-request-42', () =>
      session.run('host-run', async (ctx) => {
        const gate = session.gate('before', TOOL, {
          editable: true,
          validateInput: (proposed) => {
            const verdict: InputValidation = { ok: true, value: proposed };
            return {
              get then() {
                inGetter ??= { host: hostAls.getStore(), run: session.currentRun()?.runId };
                const p = Promise.resolve(verdict);
                return p.then.bind(p);
              },
            } as PromiseLike<InputValidation>;
          },
        });
        const paused = await viewer.waitForType('exec.paused');
        viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { q: 2 } });
        expect(await gate).toEqual({ action: 'continue', input: { q: 2 } });
        return ctx.runId;
      }),
    );
    expect(inGetter).toEqual({ host: 'host-request-42', run: runId });
  });
});

describe('a refused edit keeps the gate held under the same pauseId', () => {
  it('refuse, then accept', async () => {
    const { viewer, session } = await setup();
    const { options, seen } = toolEdit();
    let settled = false;
    const gate = session.gate('before', TOOL, options).then((d) => {
      settled = true;
      return d;
    });
    const paused = await viewer.waitForType('exec.paused');
    const pauseId = pauseIdOf(paused);
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 42 }, requestId: 'r1' });
    const refused = await viewer.waitForType('exec.refused');
    expect(refused.payload).toEqual({ pauseId, code: 'schema', message: 'query must be a string', requestId: 'r1' });
    await tick(30);
    expect(settled).toBe(false);
    expect(session.stats().heldGates).toBe(1);

    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 'LIS' }, requestId: 'r2' });
    expect(await gate).toEqual({ action: 'continue', input: { query: 'LIS', limit: 5 } });
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload).toMatchObject({ pauseId, requestId: 'r2', edited: { after: { query: 'LIS', limit: 5 } } });
    expect(seen).toHaveLength(2);
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
    expect(viewer.ofType('exec.resumed')).toHaveLength(1);
    expectAllValid(viewer);
  });

  it('refuse, then continue without input: the original input runs', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL, toolEdit().options);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: 'not an object' });
    const refused = await viewer.waitForType('exec.refused');
    expect(refused.payload).toMatchObject({ pauseId, code: 'shape' });
    viewer.resume(pauseId, 'continue');
    const decision = await gate;
    expect(decision).toEqual({ action: 'continue' });
    expect('input' in decision).toBe(false);
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload).toEqual({ pauseId, action: 'continue' });
  });

  it('two refusals, then abort', async () => {
    const { viewer, session } = await setup();
    const verdicts: InputValidation[] = [
      { ok: false, code: 'schema', message: 'first' },
      { ok: false, code: 'shape' },
    ];
    const outcome = session.run('r', async (ctx) => {
      const gate = session.gate('before', TOOL, {
        editable: true,
        validateInput: () => verdicts.shift() ?? { ok: true, value: 1 },
      });
      const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
      viewer.resumeWith({ pauseId, action: 'continue', input: { q: 1 } });
      await nthOfType(viewer, 'exec.refused', 1);
      viewer.resumeWith({ pauseId, action: 'continue', input: { q: 2 } });
      await nthOfType(viewer, 'exec.refused', 2);
      expect(session.stats().heldGates).toBe(1);
      viewer.resume(pauseId, 'abort');
      const decision: GateDecision = await gate;
      expect(ctx.signal.aborted).toBe(true);
      return decision;
    });
    expect(await outcome).toEqual({ action: 'abort' });
    const refusals = viewer.ofType('exec.refused').map((f) => f.payload);
    expect(refusals).toEqual([
      { pauseId: refusals[0]?.['pauseId'], code: 'schema', message: 'first' },
      { pauseId: refusals[0]?.['pauseId'], code: 'shape' },
    ]);
    await viewer.waitForType('exec.resumed');
    expect(viewer.ofType('exec.resumed').map((f) => f.payload['action'])).toEqual(['abort']);
  });

  const WRONG: [string, 'before' | 'after' | 'error', 'continue' | 'retry' | 'inject' | 'abort'][] = [
    ['retry at before', 'before', 'retry'],
    ['inject at before', 'before', 'inject'],
    ['abort at before', 'before', 'abort'],
    ['continue at after', 'after', 'continue'],
    ['inject at after', 'after', 'inject'],
    ['abort at after', 'after', 'abort'],
    ['continue at error', 'error', 'continue'],
    ['inject at error', 'error', 'inject'],
    ['abort at error', 'error', 'abort'],
  ];
  it.each(WRONG)('input with %s is refused (shape) and nothing else happens', async (_label, point, action) => {
    const { viewer, session } = await setup();
    const { options, seen } = toolEdit();
    const gate = session.gate(point, TOOL, options);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action, input: { query: 'LIS' }, output: { injected: true } });
    const refused = await viewer.waitForType('exec.refused');
    expect(refused.payload).toMatchObject({ pauseId, code: 'shape' });
    expect(await settledWithin(gate, 30)).toBe('pending');
    expect(seen).toEqual([]); // the validator is never consulted
    viewer.resume(pauseId, 'continue');
    expect(await gate).toEqual({ action: 'continue' });
  });

  it.each<[string, FakeViewerOptions, SessionOptions, GateOptions | undefined, string]>([
    ['the app turned edits off (kill switch)', {}, { env: { GRAPHMIND_DISABLE_EDIT_INPUT: 'on' } }, undefined, 'disabled'],
    ['the debugger lacks edit-input', { hubCapabilities: [] }, {}, undefined, 'disabled'],
    ['a 0.5 debugger (no hubCapabilities)', { hubCapabilities: undefined }, {}, undefined, 'disabled'],
    ['the pause is not editable', {}, {}, { validateInput: () => ({ ok: true, value: 1 }) }, 'unsupported'],
  ])('refused when %s', async (_label, viewerOptions, sessionOptions, gateOptions, code) => {
    const { viewer, session } = await setup(viewerOptions, sessionOptions);
    const { options, seen } = toolEdit();
    const gate = session.gate('before', TOOL, gateOptions ?? options);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 'LIS' } });
    const refused = await viewer.waitForType('exec.refused');
    expect(refused.payload).toMatchObject({ pauseId, code });
    expect(typeof refused.payload['message']).toBe('string');
    expect(await settledWithin(gate, 30)).toBe('pending');
    expect(seen).toEqual([]);
    viewer.resume(pauseId, 'continue');
    expect(await gate).toEqual({ action: 'continue' });
  });

  // A misconfigured safety hook fails CLOSED: a `validateInput` that is present
  // but is not a function (a JS adapter, or a cast) is not "no validator" —
  // otherwise the raw edit would run unmerged (live keys dropped) and unchecked.
  it.each<[string, unknown]>([
    ['a zod-like schema object', { safeParse: () => ({ success: false, error: new Error('invalid') }) }],
    ['an object with a refusing validate method', { validate: () => ({ ok: false, code: 'schema' }) }],
    ['a string', 'mergeToolInput'],
    ['true', true],
    ['null', null],
  ])(
    'validateInput as %s: not editable, an edit is refused (unsupported), the live input still runs',
    async (_label, validateInput) => {
      const warnings: string[] = [];
      const { viewer, session } = await setup({}, { logger: (message) => warnings.push(message) });
      const live = { query: 'AMS', limit: 5 };
      const options = { editable: true, validateInput } as unknown as GateOptions;
      let decision: unknown = 'pending';
      const gate = session.gate('before', TOOL, options).then((d) => {
        decision = d;
        return d;
      });
      const paused = await viewer.waitForType('exec.paused');
      const pauseId = pauseIdOf(paused);
      expect(paused.payload['editable']).toBeUndefined();
      // The edit drops `query` and `limit` and adds a key the tool schema forbids.
      viewer.resumeWith({ pauseId, action: 'continue', input: { anything: 'goes' }, requestId: 'req-4' });
      await waitUntil(
        () => decision !== 'pending' || viewer.ofType('exec.refused').length > 0,
        3000,
        'a verdict on the edit',
      );
      expect(decision).toBe('pending');
      expect(viewer.ofType('exec.resumed')).toHaveLength(0);
      const refused = viewer.ofType('exec.refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]?.payload).toMatchObject({ pauseId, code: 'unsupported', requestId: 'req-4' });
      expect(session.stats().heldGates).toBe(1);
      expect(warnings.filter((w) => w.includes('validateInput is not a function'))).toHaveLength(1);
      expect(await settledWithin(gate, 50)).toBe('pending');
      viewer.resume(pauseId, 'continue');
      expect(await gate).toEqual({ action: 'continue' });
      expect(live).toEqual({ query: 'AMS', limit: 5 });
    },
  );

  it.each<[string, unknown, string]>([
    ['the placeholder as a value', { query: REDACTED }, 'placeholder'],
    ['the placeholder in a nested value', { filter: { tags: ['a', `x${REDACTED}`] } }, 'placeholder'],
    ['the placeholder as a nested key', { filter: { [REDACTED]: 'x' } }, 'placeholder'],
    ['a shrink marker', { filter: { __graphmindTruncated: true, bytes: 900000, preview: '{' } }, 'truncated'],
    ['a truncated string', { query: 'AMS…[graphmind: truncated]' }, 'truncated'],
    ['a LangGraph preview', { state: { __graphmind: 'truncated', preview: '{', chars: 30000 } }, 'truncated'],
    ['an MCP get_node preview', mcpPreview({ query: 'AMS', content: 'y'.repeat(10_000) }), 'truncated'],
    ['an MCP get_node preview in a nested value', { query: 'AMS', doc: mcpPreview({ body: 'z'.repeat(5000) }) }, 'truncated'],
  ])('refused when the input holds %s; the validator is never consulted', async (_label, input, code) => {
    const { viewer, session } = await setup();
    const { options, seen } = toolEdit();
    const gate = session.gate('before', TOOL, options);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input });
    const refused = await viewer.waitForType('exec.refused');
    expect(refused.payload).toMatchObject({ pauseId, code });
    expect(seen).toEqual([]);
    expect(await settledWithin(gate, 30)).toBe('pending');
    viewer.resume(pauseId, 'continue');
    await gate;
  });

  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  const thenableThrows = {
    get then(): unknown {
      throw new Error('then getter');
    },
  };
  it.each<[string, GateOptions['validateInput']]>([
    [
      'throws',
      () => {
        throw new Error('SECRET-FROM-VALIDATOR');
      },
    ],
    ['returns undefined', () => undefined as unknown as InputValidation],
    ['returns null', () => null as unknown as InputValidation],
    ['returns ok as a string', () => ({ ok: 'yes' }) as unknown as InputValidation],
    ['returns an unknown code', () => ({ ok: false, code: 'nope' }) as unknown as InputValidation],
    ['rejects', () => Promise.reject(new Error('SECRET-FROM-VALIDATOR'))],
    ['resolves garbage', () => Promise.resolve(42 as unknown as InputValidation)],
    ['returns a thenable whose `then` getter throws', () => thenableThrows as unknown as InputValidation],
    ['accepts a value with no JSON form (a cycle)', () => ({ ok: true, value: circular })],
    ['accepts a BigInt', () => ({ ok: true, value: { n: 1n } })],
  ])('a validator that %s refuses the edit (shape); nothing reaches the host', async (_label, validateInput) => {
    const warnings: string[] = [];
    const { viewer, session } = await setup({}, { logger: (message) => warnings.push(message) });
    const gate = session.gate('before', TOOL, { editable: true, ...(validateInput ? { validateInput } : {}) });
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: 1 } });
    const refused = await viewer.waitForType('exec.refused');
    expect(refused.payload).toMatchObject({ pauseId, code: 'shape' });
    expect(JSON.stringify(refused.payload)).not.toContain('SECRET-FROM-VALIDATOR');
    expect(await settledWithin(gate, 30)).toBe('pending');
    viewer.resume(pauseId, 'continue');
    expect(await gate).toEqual({ action: 'continue' });
    expect(warnings.join('\n')).not.toContain('SECRET-FROM-VALIDATOR');
  });

  it('a validator message is sanitised and cut to 200 characters', async () => {
    const { viewer, session } = await setup();
    const ESC = String.fromCharCode(0x1b);
    const gate = session.gate('before', TOOL, {
      editable: true,
      validateInput: () => ({ ok: false, code: 'schema', message: `${ESC}[31mbad${'!'.repeat(500)}` }),
    });
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: 1 } });
    const refused = await viewer.waitForType('exec.refused');
    const message = refused.payload['message'] as string;
    expect(message.length).toBe(200);
    expect(message.includes(ESC)).toBe(false);
    expect(message.startsWith('[31mbad')).toBe(true);
    viewer.resume(pauseId, 'continue');
    await gate;
  });

  it(
    `a validator that never settles is refused after ${VALIDATION_TIMEOUT_MS} ms; the gate stays usable`,
    async () => {
      const { viewer, session } = await setup();
      const gate = session.gate('before', TOOL, { editable: true, validateInput: () => new Promise<InputValidation>(() => {}) });
      const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
      const sentAt = Date.now();
      viewer.resumeWith({ pauseId, action: 'continue', input: { q: 1 }, requestId: 'slow' });
      const refused = await viewer.waitForType('exec.refused', VALIDATION_TIMEOUT_MS + 3000);
      expect(Date.now() - sentAt).toBeGreaterThanOrEqual(VALIDATION_TIMEOUT_MS - 50);
      expect(refused.payload).toMatchObject({ pauseId, code: 'shape', requestId: 'slow' });
      expect(session.stats().heldGates).toBe(1);
      viewer.resume(pauseId, 'continue');
      expect(await gate).toEqual({ action: 'continue' });
    },
    VALIDATION_TIMEOUT_MS + 8000,
  );

  it('a resume arriving while an edit is validating is ignored', async () => {
    const { viewer, session } = await setup();
    const verdict = deferred<InputValidation>();
    let calls = 0;
    const gate = session.gate('before', TOOL, {
      editable: true,
      validateInput: () => {
        calls += 1;
        return verdict.promise;
      },
    });
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: 'first' } });
    await waitUntil(() => calls === 1, 3000, 'validator called');
    viewer.resume(pauseId, 'abort');
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: 'second' } });
    await tick(50);
    expect(await settledWithin(gate, 10)).toBe('pending');
    expect(calls).toBe(1);
    verdict.resolve({ ok: true, value: { q: 'first' } });
    expect(await gate).toEqual({ action: 'continue', input: { q: 'first' } });
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
  });
});

// The session guards every edit against the two standard deep-merge
// pollution payloads, whatever the adapter validates: an own "__proto__" key
// and a "constructor": {"prototype": ...} path, at any depth (lodash
// defaultsDeep CVE-2019-10744, the minimist CVE-2020-7598 bypass). A JSON
// `__proto__` arrives off the wire as an own key.
describe('prototype-pollution keys are refused on every edit (shape)', () => {
  const PROTO_NESTED = '{"opts":{"__proto__":{"isAdmin":true}}}';
  const PROTO_TOP = '{"query":"LIS","__proto__":{"isAdmin":true}}';
  const CONSTRUCTOR_PROTOTYPE = '{"query":"LIS","constructor":{"prototype":{"gmPolluted":true}}}';
  const CONSTRUCTOR_PROTOTYPE_NESTED = '{"filter":{"and":[{"constructor":{"prototype":{"isAdmin":true}}}]}}';
  const passthrough: GateOptions['validateInput'] = (proposed) =>
    typeof proposed === 'object' && proposed !== null && !Array.isArray(proposed)
      ? { ok: true, value: proposed }
      : { ok: false, code: 'schema', message: 'expected an object' };

  it.each<[string, string, GateOptions]>([
    ['a nested own "__proto__" key, no validateInput', PROTO_NESTED, { editable: true }],
    ['a nested constructor.prototype path, no validateInput', CONSTRUCTOR_PROTOTYPE_NESTED, { editable: true }],
    ['a top-level "__proto__" key, a pass-through validator (zod passthrough / record)', PROTO_TOP, { editable: true, validateInput: passthrough }],
    ['a constructor.prototype path, the W2 recipe (mergeToolInput)', CONSTRUCTOR_PROTOTYPE, toolEdit().options],
  ])('%s: refused, nothing runs, nothing is recorded', async (_label, json, options) => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL, options);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    const input = JSON.parse(json) as unknown;
    viewer.resumeWith({ pauseId, action: 'continue', input, requestId: 'proto' });
    const outcome = await outcomeOf(viewer, gate);
    expect(outcome).toMatchObject({ kind: 'refused', payload: { pauseId, code: 'shape', requestId: 'proto' } });
    expect(viewer.ofType('exec.resumed')).toHaveLength(0);
    viewer.resume(pauseId, 'continue');
    expect(await gate).toEqual({ action: 'continue' });
    await waitUntil(() => viewer.ofType('exec.resumed').length === 1, 2000, 'exec.resumed');
    expect(viewer.ofType('exec.resumed')[0]?.payload).toEqual({ pauseId, action: 'continue' });
  });

  it('precondition: a JSON "__proto__" survives the wire as an own key', () => {
    const input = JSON.parse(PROTO_NESTED) as { opts: object };
    expect(Object.prototype.hasOwnProperty.call(input.opts, '__proto__')).toBe(true);
  });

  it('a key merely named "constructor" or "prototype" is fine', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL, { editable: true });
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    const input = { constructor: 'Point', prototype: { x: 1 }, nested: { constructor: { name: 'Point' } } };
    viewer.resumeWith({ pauseId, action: 'continue', input });
    expect(await gate).toEqual({ action: 'continue', input });
  });
});

// refute-security S4 / binding C2.5: when a GRAPHMIND_HIDE_* switch hides the
// paused call's input, a PARTIAL edit is never merged onto the hidden live
// arguments ("a full input replacement is still allowed"). Otherwise the
// answer (exec.refused vs exec.resumed) to a guess, repeated without limit on
// a held gate, would reveal a value the redactor promises never leaves the
// process. The validator follows the documented recipe, forwarding the
// session's context to mergeToolInput; its schema has a cross-field rule.
describe('a hidden input only takes a full replacement (C2.5 / S4)', () => {
  const TRANSFER: GateNode = { nodeId: 'tool:transfer', kind: 'tool', name: 'transfer' };
  /** The live arguments; hidden from the record under the switches below. */
  const LIVE = { account: 'ACC-7731', confirm: 'ACC-7731', amount: 10 };

  function transferOptions(live: Record<string, unknown>, seenContexts: unknown[] = []): GateOptions {
    return {
      editable: true,
      validateInput: (proposed, context) => {
        seenContexts.push(context);
        const merged = mergeToolInput(live, proposed, context);
        if (!merged.ok) return merged;
        const v = merged.value as Record<string, unknown>;
        if (typeof v['account'] !== 'string' || v['confirm'] !== v['account']) {
          return { ok: false, code: 'schema', message: 'confirm must equal account' };
        }
        if (typeof v['amount'] !== 'number') return { ok: false, code: 'schema', message: 'amount must be a number' };
        return merged;
      },
    };
  }

  interface Answer {
    type: string;
    payload: Record<string, unknown>;
  }

  /** The debugger's view of the answer to one edit: frame type and payload, ids removed. */
  async function answerTo(viewer: FakeViewer, pauseId: string, input: unknown, requestId: string): Promise<Answer> {
    viewer.resumeWith({ pauseId, action: 'continue', input, requestId });
    const frame = await viewer.waitFor(
      (f) => (f.type === 'exec.refused' || f.type === 'exec.resumed') && f.payload['requestId'] === requestId,
    );
    const payload: Record<string, unknown> = { ...frame.payload };
    delete payload['pauseId'];
    delete payload['requestId'];
    return { type: frame.type, payload };
  }

  /** One fresh session + held pause; the answer to a single partial edit. */
  async function answerToPartialEdit(sessionOptions: SessionOptions, confirm: string): Promise<Answer> {
    const { viewer, session } = await setup({ breakpoints: [{ kind: 'tool' }] }, sessionOptions);
    const gate = session.gate('before', TRANSFER, transferOptions({ ...LIVE }));
    const paused = await viewer.waitForType('exec.paused');
    const pauseId = pauseIdOf(paused);
    expect(paused.payload['editable']).toBe(true);
    const answer = await answerTo(viewer, pauseId, { confirm }, 'r1');
    if (answer.type === 'exec.refused') viewer.resume(pauseId, 'continue');
    await gate;
    return answer;
  }

  const covering: [string, SessionOptions][] = [
    ['GRAPHMIND_HIDE_TOOL_ARGS=1', { env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' } }],
    ['the hideToolArgs option', { hideToolArgs: true }],
    ['GRAPHMIND_HIDE_INPUTS=1', { env: { GRAPHMIND_HIDE_INPUTS: '1' } }],
  ];

  it.each(covering)('%s: the answer to a partial edit does not depend on the hidden value', async (_label, options) => {
    const wrong = await answerToPartialEdit(options, 'ACC-0001');
    const right = await answerToPartialEdit(options, LIVE.account);
    expect(right).toEqual(wrong);
    expect(right.type).toBe('exec.refused');
  });

  it('GRAPHMIND_HIDE_TOOL_ARGS=1: repeated partial edits on one held pause never single out the hidden value', async () => {
    const { viewer, session } = await setup({ breakpoints: [{ kind: 'tool' }] }, { env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' } });
    const gate = session.gate('before', TRANSFER, transferOptions({ ...LIVE }));
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    const answers: Answer[] = [];
    for (const [i, confirm] of ['ACC-0001', 'ACC-7730', LIVE.account].entries()) {
      const answer = await answerTo(viewer, pauseId, { confirm }, `g${i}`);
      answers.push(answer);
      if (answer.type === 'exec.resumed') break;
    }
    if (answers.every((a) => a.type === 'exec.refused')) viewer.resume(pauseId, 'continue');
    await gate;
    expect(answers.map((a) => a.type)).not.toContain('exec.resumed');
    expect(new Set(answers.map((a) => JSON.stringify(a.payload))).size).toBe(1);
  });

  it('under a covering switch a full input replacement is still allowed', async () => {
    const { viewer, session } = await setup({ breakpoints: [{ kind: 'tool' }] }, { env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' } });
    const gate = session.gate('before', TRANSFER, transferOptions({ ...LIVE }));
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    const full = { account: 'ACC-1000', confirm: 'ACC-1000', amount: 5 };
    const answer = await answerTo(viewer, pauseId, full, 'f1');
    expect(answer).toEqual({ type: 'exec.resumed', payload: { action: 'continue', edited: { after: REDACTED }, redaction: { count: 1, keys: ['edited'] } } });
    expect(await gate).toEqual({ action: 'continue', input: full });
  });

  it.each<[string, SessionOptions, GateNode, boolean]>([
    ['no switch', { env: {} }, TRANSFER, false],
    ['GRAPHMIND_HIDE_TOOL_ARGS on a tool', { env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' } }, TRANSFER, true],
    ['GRAPHMIND_HIDE_TOOL_ARGS on an LLM step', { env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' } }, LLM, false],
    ['GRAPHMIND_HIDE_INPUTS on an LLM step', { env: { GRAPHMIND_HIDE_INPUTS: '1' } }, LLM, true],
    ['GRAPHMIND_HIDE_OUTPUTS (does not cover the input)', { env: { GRAPHMIND_HIDE_OUTPUTS: '1' } }, TRANSFER, false],
  ])('the validator is told whether the input is hidden: %s', async (_label, sessionOptions, node, hidden) => {
    const { viewer, session } = await setup({ breakpoints: [{ kind: node.kind }] }, sessionOptions);
    const contexts: unknown[] = [];
    const gate = session.gate('before', node, transferOptions({ ...LIVE }, contexts));
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { amount: 20 } });
    await firstAnswer(viewer, 3000);
    expect(contexts).toEqual([{ inputHidden: hidden }]);
    if (hidden) {
      viewer.resume(pauseId, 'continue');
      expect(await gate).toEqual({ action: 'continue' });
    } else {
      // Not hidden: the partial edit merges onto the live arguments.
      expect(await gate).toEqual({ action: 'continue', input: { ...LIVE, amount: 20 } });
    }
  });
});

describe('fail-open while validating: the ORIGINAL input runs', () => {
  it('a disconnect during validation continues the gate; the late verdict changes nothing', async () => {
    const { viewer, session } = await setup();
    const verdict = deferred<InputValidation>();
    const gate = session.gate('before', TOOL, { editable: true, validateInput: () => verdict.promise });
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: 'edited' }, requestId: 'lost' });
    await tick(50);
    viewer.dropConnections();
    const decision = await gate;
    expect(decision).toEqual({ action: 'continue' });
    expect('input' in decision).toBe(false);
    verdict.resolve({ ok: true, value: { q: 'edited' } });
    await waitUntil(() => session.attached, 5000, 're-attach');
    await waitUntil(() => viewer.ofType('exec.resumed').length > 0, 5000, 'replayed exec.resumed');
    await tick(50);
    const resumed = unique(viewer.ofType('exec.resumed'));
    expect(resumed.map((f) => f.payload)).toEqual([{ pauseId, action: 'continue' }]);
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
    expect(session.stats().heldGates).toBe(0);
  });

  it('a disconnect during validation, then a late refusal: no exec.refused for a closed pause', async () => {
    const { viewer, session } = await setup();
    const verdict = deferred<InputValidation>();
    const gate = session.gate('before', TOOL, { editable: true, validateInput: () => verdict.promise });
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: 'edited' } });
    await tick(50);
    viewer.dropConnections();
    expect(await gate).toEqual({ action: 'continue' });
    verdict.resolve({ ok: false, code: 'schema', message: 'late' });
    await waitUntil(() => session.attached, 5000, 're-attach');
    await tick(100);
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
  });

  it('a pause timeout during validation continues the gate; no requestId, no edit, verdict dropped', async () => {
    const { viewer, session } = await setup({}, { pauseTimeoutMs: 300 });
    let validatedAt = 0;
    const gate = session.gate('before', TOOL, {
      editable: true,
      validateInput: async (proposed) => {
        await tick(700);
        validatedAt = Date.now();
        return { ok: true, value: proposed };
      },
    });
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: 'edited' }, requestId: 'too-late' });
    const decision = await gate;
    expect(decision).toEqual({ action: 'continue' });
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload).toEqual({ pauseId, action: 'continue' });
    await waitUntil(() => validatedAt > 0, 3000, 'late verdict');
    await tick(50);
    expect(viewer.ofType('exec.resumed')).toHaveLength(1);
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
    expect(session.stats().heldGates).toBe(0);
  });

  // Synchronous validator work blocks the event loop, so the pause-timeout
  // timer cannot fire while it runs; a verdict that lands after the pause
  // deadline must not be applied as if it were on time (C2: "A disconnect or
  // pause timeout during validation continues with the ORIGINAL input").
  const PAUSE_TIMEOUT_MS = 300;
  const SYNC_WORK_MS = 700;
  it.each<[string, (proposed: unknown) => InputValidation | Promise<InputValidation>]>([
    [
      'an async validator whose synchronous prefix',
      async (proposed) => {
        busyWait(SYNC_WORK_MS); // e.g. a first-call schema compile
        return { ok: true, value: proposed };
      },
    ],
    [
      'a synchronous validator that',
      (proposed) => {
        busyWait(SYNC_WORK_MS);
        return { ok: true, value: proposed };
      },
    ],
  ])('%s crosses the pause deadline: the ORIGINAL input runs, no refusal', async (_label, work) => {
    const { viewer, session } = await setup({}, { pauseTimeoutMs: PAUSE_TIMEOUT_MS });
    const gateOpenedAt = performance.now();
    let validatorStartedAfterMs: number | undefined;
    const gate = session.gate('before', TOOL, {
      editable: true,
      validateInput: (proposed) => {
        validatorStartedAfterMs = performance.now() - gateOpenedAt;
        return work(proposed);
      },
    });
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: 'edited' }, requestId: 'late' });
    const decision = await gate;
    const releasedAfterMs = performance.now() - gateOpenedAt;
    // Preconditions: the resume was handled well inside the pause window, and
    // the release came after the pause deadline had passed.
    expect(validatorStartedAfterMs).toBeDefined();
    expect(validatorStartedAfterMs as number).toBeLessThan(PAUSE_TIMEOUT_MS);
    expect(releasedAfterMs).toBeGreaterThan(PAUSE_TIMEOUT_MS);
    expect(decision).toEqual({ action: 'continue' });
    expect('input' in decision).toBe(false);
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload).toEqual({ pauseId, action: 'continue' });
    await tick(50);
    expect(viewer.ofType('exec.resumed')).toHaveLength(1);
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
    expect(session.stats().heldGates).toBe(0);
  });

  it('a synchronous validator that refuses after the pause deadline: continues, no exec.refused', async () => {
    const { viewer, session } = await setup({}, { pauseTimeoutMs: PAUSE_TIMEOUT_MS });
    const gate = session.gate('before', TOOL, {
      editable: true,
      validateInput: (): InputValidation => {
        busyWait(SYNC_WORK_MS);
        return { ok: false, code: 'schema', message: 'late refusal' };
      },
    });
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: 'edited' }, requestId: 'late' });
    expect(await gate).toEqual({ action: 'continue' });
    expect((await viewer.waitForType('exec.resumed')).payload).toEqual({ pauseId, action: 'continue' });
    await tick(50);
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
    expect(session.stats().heldGates).toBe(0);
  });

  it('the pause timeout is not restarted by a refusal', async () => {
    const { viewer, session } = await setup({}, { pauseTimeoutMs: 400 });
    const startedAt = Date.now();
    const gate = session.gate('before', TOOL, toolEdit().options);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    await tick(200);
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 7 } });
    await viewer.waitForType('exec.refused');
    expect(await gate).toEqual({ action: 'continue' });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(580 + 400);
  });
});

// VALIDATION_TIMEOUT_MS is measured from the moment the resume is handled, so
// it holds for synchronous validator work too (a synchronous validator, or
// the synchronous prefix of an async one): the work cannot be interrupted,
// but a verdict that arrives after the limit is refused, never applied — the
// debugger stopped waiting for the answer by then.
describe(`validation slower than VALIDATION_TIMEOUT_MS (${VALIDATION_TIMEOUT_MS} ms) is refused, even when synchronous`, () => {
  it.each<[string, (proposed: unknown) => InputValidation | Promise<InputValidation>, string]>([
    [
      'a synchronous validator that busy-waits past the limit',
      (proposed) => {
        busyWait(VALIDATION_TIMEOUT_MS + 300);
        return { ok: true, value: proposed };
      },
      'r1',
    ],
    [
      'an async validator whose synchronous prefix outlasts the limit (resolves in the next microtask)',
      async (proposed) => {
        busyWait(VALIDATION_TIMEOUT_MS + 300); // e.g. a first-call schema compile
        return { ok: true, value: proposed };
      },
      'r2',
    ],
  ])(
    '%s: exec.refused, the gate stays held, the edit never runs',
    async (_label, validateInput, requestId) => {
      const { viewer, session } = await setup();
      const gate = session.gate('before', TOOL, { editable: true, validateInput });
      const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
      viewer.resumeWith({ pauseId, action: 'continue', input: { q: 1 }, requestId });
      const answer = await firstAnswer(viewer, VALIDATION_TIMEOUT_MS + 5000);
      expect(answer).toEqual({
        type: 'exec.refused',
        payload: { pauseId, code: 'shape', message: expect.any(String), requestId },
      });
      expect(await settledWithin(gate, 50)).toBe('pending');
      expect(session.stats().heldGates).toBe(1);
      viewer.resume(pauseId, 'continue');
      const decision = await gate;
      expect(decision).toEqual({ action: 'continue' });
      expect('input' in decision).toBe(false);
    },
    VALIDATION_TIMEOUT_MS + 10_000,
  );
});

describe('edits compose with every kind of pause', () => {
  it('step mode', async () => {
    const { viewer, session } = await setup({ mode: 'step', breakpoints: [] });
    const gate = session.gate('before', TOOL, toolEdit().options);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { query: 'LIS' } });
    expect(await gate).toEqual({ action: 'continue', input: { query: 'LIS', limit: 5 } });
    // step mode still pauses the next call, which is editable again
    const next = session.gate('before', TOOL, toolEdit().options);
    const second = await nthOfType(viewer, 'exec.paused', 2);
    expect(second.payload['editable']).toBe(true);
    viewer.resume(pauseIdOf(second), 'continue');
    expect(await next).toEqual({ action: 'continue' });
  });

  it('a breakpoint on an LLM node (kind is not restricted by the session)', async () => {
    const { viewer, session } = await setup({ breakpoints: [{ kind: 'llm' }] });
    const gate = session.gate('before', LLM, { editable: true });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { prompt: 'x' } });
    expect(await gate).toEqual({ action: 'continue', input: { prompt: 'x' } });
  });

  it('a loop hold is editable, and the loop fingerprint keeps the input the model asked for', async () => {
    const { viewer, session } = await setup({ breakpoints: [] });
    let instance = 0;
    const call = (): Promise<GateDecision> => {
      session.emit('node.started', {
        nodeId: TOOL.nodeId,
        kind: 'tool',
        name: TOOL.name,
        instanceId: `i${(instance += 1)}`,
        input: { query: 'AMS', limit: 5 },
      });
      return session.gate('before', TOOL, toolEdit().options);
    };
    await session.run('looping', async () => {
      expect(await call()).toEqual({ action: 'continue' });
      expect(await call()).toEqual({ action: 'continue' });
      const third = call();
      const paused = await viewer.waitForType('exec.paused');
      expect(paused.payload).toMatchObject({ reason: 'loop', editable: true });
      viewer.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { query: 'LIS' } });
      expect(await third).toEqual({ action: 'continue', input: { query: 'LIS', limit: 5 } });
      // The model asks for the same arguments again: still the same loop.
      const fourth = call();
      const again = await nthOfType(viewer, 'exec.paused', 2);
      expect(again.payload).toMatchObject({ reason: 'loop', editable: true });
      expect((again.payload['loop'] as { repeats: number }).repeats).toBe(4);
      viewer.resume(pauseIdOf(again), 'continue');
      await fourth;
    });
  });
});

describe('held time across refuse / reopen', () => {
  it('heldMs is one interval from the pause to the final release, however many refusals', async () => {
    let now = 10_000;
    const { viewer, session } = await setup({}, { clock: () => now });
    await session.run('r', async () => {
      session.emit('node.started', { nodeId: TOOL.nodeId, kind: 'tool', name: TOOL.name, instanceId: 't1', input: { query: 'AMS' } });
      const gate = session.gate('before', TOOL, toolEdit().options);
      const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
      now += 50;
      viewer.resumeWith({ pauseId, action: 'continue', input: { query: 1 } });
      await nthOfType(viewer, 'exec.refused', 1);
      now += 150;
      viewer.resumeWith({ pauseId, action: 'continue', input: 'nope' });
      await nthOfType(viewer, 'exec.refused', 2);
      now += 200;
      viewer.resumeWith({ pauseId, action: 'continue', input: { query: 'LIS' } });
      await gate;
      now += 1000; // the tool runs; not held time
      session.emit('node.finished', { nodeId: TOOL.nodeId, instanceId: 't1', output: 'ok', durationMs: 1400, status: 'ok' });
    });
    const finished = await viewer.waitForType('node.finished');
    expect(finished.payload['heldMs']).toBe(400);
  });
});

describe('requestId', () => {
  it.each([
    ['continue', undefined],
    ['retry', undefined],
    ['inject', { injected: true }],
  ] as const)('is echoed on a plain %s', async (action, output) => {
    const { viewer, session } = await setup();
    const gate = session.gate('error', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action, requestId: `req-${action}`, ...(output === undefined ? {} : { output }) });
    await gate;
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload).toEqual({ pauseId, action, requestId: `req-${action}` });
  });

  it('is echoed on abort', async () => {
    const { viewer, session } = await setup();
    await session.run('r', async () => {
      const gate = session.gate('before', TOOL);
      const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
      viewer.resumeWith({ pauseId, action: 'abort', requestId: 'req-abort' });
      await gate;
    });
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload['requestId']).toBe('req-abort');
  });

  it('works under a 0.5 debugger too (no hubCapabilities)', async () => {
    const { viewer, session } = await setup({ hubCapabilities: undefined });
    const gate = session.gate('before', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', requestId: 'r' });
    await gate;
    expect((await viewer.waitForType('exec.resumed')).payload).toEqual({ pauseId, action: 'continue', requestId: 'r' });
  });

  it('absent from the resume: absent from exec.resumed (the 0.5 frame)', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resume(pauseId, 'continue');
    await gate;
    expect(Object.keys((await viewer.waitForType('exec.resumed')).payload)).toEqual(['pauseId', 'action']);
  });

  // The wire contract sets no length on requestId (schema: `z.string()`), and
  // the debugger forwards a resumer's own id: whatever arrives is echoed, or
  // the debugger could not correlate an answer the app really gave.
  const LONG_ID = `req-${'x'.repeat(296)}`; // 300 chars

  it('the wire contract accepts a 300-char requestId on exec.resume, exec.resumed and exec.refused', () => {
    expect(LONG_ID).toHaveLength(300);
    expect(ControlPayloadSchemas['exec.resume'].safeParse({ pauseId: 'p', action: 'continue', requestId: LONG_ID }).success).toBe(true);
    expect(EventPayloadSchemas['exec.resumed'].safeParse({ pauseId: 'p', action: 'continue', requestId: LONG_ID }).success).toBe(true);
    expect(EventPayloadSchemas['exec.refused'].safeParse({ pauseId: 'p', code: 'shape', requestId: LONG_ID }).success).toBe(true);
  });

  it('a long requestId is echoed on a plain resume', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', requestId: LONG_ID });
    expect(await gate).toEqual({ action: 'continue' });
    const resumed = await viewer.waitForType('exec.resumed');
    expect(parseEnvelope(resumed).kind).toBe('ok');
    expect(resumed.payload['requestId']).toBe(LONG_ID);
  });

  it('a long requestId is echoed on a refused edit, then on the accepted one', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL, toolEdit().options);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 42 }, requestId: LONG_ID });
    const refused = await viewer.waitForType('exec.refused');
    expect(refused.payload).toMatchObject({ pauseId, code: 'schema', requestId: LONG_ID });
    const accepted = `${LONG_ID}-2`;
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 'LIS' }, requestId: accepted });
    expect(await gate).toEqual({ action: 'continue', input: { query: 'LIS', limit: 5 } });
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload).toMatchObject({ pauseId, edited: { after: { query: 'LIS', limit: 5 } }, requestId: accepted });
  });
});

// C2 / refute-security C2.3 and S5: the client refuses a placeholder or a
// truncated preview as an inject output whatever the debugger's version. A
// 0.5 hub (or a hub with no W3 yet) guards only "__REDACTED__", so under one
// the client is the ONLY place a truncated preview can be stopped — and the
// viewer pre-fills its inject editor with the recorded output, which over
// 512 KB is a shrink preview. Refusing is fail-safe: the gate stays held and
// continue / retry / abort, the pause timeout and a disconnect still release it.
describe('inject guard (client side, every debugger)', () => {
  const BIG_OUTPUT = { content: 'x'.repeat(10_000), path: 'src/big.ts' };
  const DEBUGGERS: [string, string[] | undefined][] = [
    ['a 0.6 debugger', EDIT_HUB],
    ['a 0.5 debugger (no hubCapabilities)', undefined],
  ];
  const MARKED: [string, unknown, string][] = [
    ['the placeholder', { hits: [REDACTED] }, 'placeholder'],
    ['a shrink marker', { __graphmindTruncated: true, bytes: 600_000, preview: '{"rows":[' }, 'truncated'],
    ['a truncated string', `long${TRUNCATION_SUFFIX}`, 'truncated'],
    ['a nested truncated string', { hits: [`long${TRUNCATION_SUFFIX}`] }, 'truncated'],
    ['a LangGraph preview', { __graphmind: 'truncated', preview: 'partial' }, 'truncated'],
    ['an MCP get_node preview', mcpPreview(BIG_OUTPUT), 'truncated'],
  ];
  const CASES = DEBUGGERS.flatMap(([debugger_, hub]) =>
    MARKED.map(([label, output, code]) => [debugger_, label, hub, output, code] as const),
  );

  it.each(CASES)('under %s, an inject output holding %s is refused and the gate stays held', async (_d, _label, hub, output, code) => {
    const { viewer, session } = await setup({ hubCapabilities: hub }, { logger: () => {} });
    const gate = session.gate('after', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'inject', output, requestId: 'inj' });
    const refused = await viewer.waitForType('exec.refused');
    expect(refused.payload).toMatchObject({ pauseId, code, requestId: 'inj' });
    expect(await settledWithin(gate, 30)).toBe('pending');
    expect(viewer.ofType('exec.resumed')).toHaveLength(0);
    viewer.resume(pauseId, 'inject', { hits: ['real'] });
    expect(await gate).toEqual({ action: 'inject', output: { hits: ['real'] } });
  });

  it('the MCP marker in these tests is the wording the MCP server uses (shared constant)', () => {
    expect(mcpPreview(BIG_OUTPUT).note.startsWith(MCP_PREVIEW_NOTE_PREFIX)).toBe(true);
  });

  it('under a 0.5 debugger, which does not show exec.refused, the refusal is also in the app log', async () => {
    const warnings: string[] = [];
    const { viewer, session } = await setup({ hubCapabilities: undefined }, { logger: (m) => warnings.push(m) });
    const gate = session.gate('after', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resume(pauseId, 'inject', `long${TRUNCATION_SUFFIX}`);
    await viewer.waitForType('exec.refused');
    const lines = warnings.filter((w) => w.includes('inject'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('long');
    viewer.resume(pauseId, 'continue');
    expect(await gate).toEqual({ action: 'continue' });
  });

  it('under a 0.6 debugger the refusal is left to the debugger to show (no log line)', async () => {
    const warnings: string[] = [];
    const { viewer, session } = await setup({}, { logger: (m) => warnings.push(m) });
    const gate = session.gate('after', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resume(pauseId, 'inject', `long${TRUNCATION_SUFFIX}`);
    await viewer.waitForType('exec.refused');
    expect(warnings.filter((w) => w.includes('inject'))).toEqual([]);
    viewer.resume(pauseId, 'continue');
    await gate;
  });

  it('end to end under a 0.5 debugger: a recorded > 512 KB tool result, injected back verbatim, never becomes the result', async () => {
    const { viewer, session } = await setup({ hubCapabilities: undefined }, { logger: () => {} });
    let decision: Promise<GateDecision> | undefined;
    await session.run('r', async () => {
      session.emit('node.started', { nodeId: TOOL.nodeId, kind: 'tool', name: TOOL.name, instanceId: 'c1', input: {} });
      // A tool result over the 512 KB payload budget: what the debugger records
      // (and the viewer pre-fills its inject editor with) is a shrink preview.
      const big = { body: 'x'.repeat(MAX_PAYLOAD_BYTES + 1024) };
      session.emit('node.finished', { nodeId: TOOL.nodeId, instanceId: 'c1', output: big, durationMs: 5, status: 'ok' });
      decision = session.gate('after', TOOL, { result: big });
    });
    const finished = await viewer.waitForType('node.finished');
    const recorded = finished.payload['output'];
    expect(JSON.stringify(recorded)).toContain('__graphmindTruncated');
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    // The user presses "Inject & resume" unedited; a 0.5 hub relays it.
    viewer.resume(pauseId, 'inject', recorded);
    const outcome = await settledWithin(decision as Promise<GateDecision>, 100);
    // Compared by action only: the preview itself is ~512 KB of diff noise.
    expect(outcome === 'pending' ? 'pending' : outcome.action).toBe('pending');
    expect((await viewer.waitForType('exec.refused', 1000)).payload).toMatchObject({ pauseId, code: 'truncated' });
    expect(viewer.ofType('exec.resumed')).toHaveLength(0);
    viewer.resume(pauseId, 'continue');
    expect(await decision).toEqual({ action: 'continue' });
  });

  it.each(DEBUGGERS)('under %s a clean inject passes', async (_label, hub) => {
    const { viewer, session } = await setup({ hubCapabilities: hub });
    const gate = session.gate('after', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resume(pauseId, 'inject', { ok: 1 });
    expect(await gate).toEqual({ action: 'inject', output: { ok: 1 } });
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
  });

  it('a legitimate `truncated: true` field (no GraphMind note) is not refused', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('after', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    const output = { tree: [{ path: 'a.ts' }], truncated: true, note: 'GitHub API capped the listing' };
    viewer.resumeWith({ pauseId, action: 'inject', output });
    expect(await gate).toEqual({ action: 'inject', output });
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
  });
});

describe('re-attach', () => {
  it('hubCapabilities are re-read on every attach (a downgraded debugger gets no edits)', async () => {
    const { viewer, session } = await setup();
    const first = session.gate('before', TOOL, toolEdit().options);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['editable']).toBe(true);
    viewer.resume(pauseIdOf(paused), 'continue');
    await first;

    viewer.setHubCapabilities(undefined);
    viewer.dropConnections();
    await waitUntil(() => viewer.connectionCount === 2 && session.attached, 5000, 're-attach');
    const second = session.gate('before', TOOL, toolEdit().options);
    // (the replay on re-attach resends the first pause with its own seq)
    const again = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['pauseId'] !== pauseIdOf(paused));
    expect(again.payload['editable']).toBeUndefined();
    viewer.resumeWith({ pauseId: pauseIdOf(again), action: 'continue', input: { query: 'LIS' } });
    expect((await viewer.waitForType('exec.refused')).payload).toMatchObject({ code: 'disabled' });
    viewer.resume(pauseIdOf(again), 'continue');
    expect(await second).toEqual({ action: 'continue' });
  });
});

// The README is what an adapter author (and a debugger author) reads; it
// drifted from the code once (the inject guard shipped undocumented).
describe('README: the documented edit and inject behaviour', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  const lines = readme.split('\n');
  const editSection = readme.slice(readme.indexOf('### Edited input'));

  it('the gating table says an inject holding a placeholder or truncated preview is refused and the gate stays held', () => {
    const row = lines.find((line) => line.includes("`{action:'inject', output}`") && line.includes('skip execution'));
    expect(row).toBeDefined();
    expect(row).toMatch(/exec\.refused/);
    expect(row).toMatch(/stays held/);
  });

  it('the validator time limit is documented as covering synchronous work too', () => {
    expect(editSection).toMatch(/4 s/);
    expect(editSection).toMatch(/synchronous/);
  });

  it('the recipe forwards the validator context to mergeToolInput (a hidden input takes only a full replacement)', () => {
    expect(editSection).toContain('mergeToolInput(liveArgs, proposed, context)');
  });
});
