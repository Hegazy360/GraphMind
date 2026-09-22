/**
 * Edited input through a live session (contract C2): what is announced, when
 * a pause is offered as `editable`, every refusal (the gate stays held under
 * the same pauseId), acceptance (`decision.input` + `exec.resumed.edited`),
 * fail-open while validating, held time across refusals, requestId echo, and
 * the client-side inject guard. Proven against a real WebSocket viewer double
 * that plays a 0.6 debugger (hello.ack.hubCapabilities) or a 0.5 one (none).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
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

  it.each<[string, unknown, string]>([
    ['the placeholder as a value', { query: REDACTED }, 'placeholder'],
    ['the placeholder in a nested value', { filter: { tags: ['a', `x${REDACTED}`] } }, 'placeholder'],
    ['the placeholder as a nested key', { filter: { [REDACTED]: 'x' } }, 'placeholder'],
    ['a shrink marker', { filter: { __graphmindTruncated: true, bytes: 900000, preview: '{' } }, 'truncated'],
    ['a truncated string', { query: 'AMS…[graphmind: truncated]' }, 'truncated'],
    ['a LangGraph preview', { state: { __graphmind: 'truncated', preview: '{', chars: 30000 } }, 'truncated'],
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

  it('an implausibly long requestId is not echoed', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('before', TOOL, toolEdit().options);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'continue', input: { query: 3 }, requestId: 'x'.repeat(257) });
    expect((await viewer.waitForType('exec.refused')).payload['requestId']).toBeUndefined();
    viewer.resumeWith({ pauseId, action: 'continue', requestId: 'y'.repeat(256) });
    await gate;
    expect((await viewer.waitForType('exec.resumed')).payload['requestId']).toBe('y'.repeat(256));
  });
});

describe('inject guard (client side, 0.6 debuggers)', () => {
  it.each([
    ['the placeholder', { hits: [REDACTED] }, 'placeholder'],
    ['a shrink marker', { __graphmindTruncated: true, bytes: 1, preview: '' }, 'truncated'],
    ['a truncated string', 'long…[graphmind: truncated]', 'truncated'],
  ])('an inject output holding %s is refused and the gate stays held', async (_label, output, code) => {
    const { viewer, session } = await setup();
    const gate = session.gate('after', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resumeWith({ pauseId, action: 'inject', output, requestId: 'inj' });
    const refused = await viewer.waitForType('exec.refused');
    expect(refused.payload).toMatchObject({ pauseId, code, requestId: 'inj' });
    expect(await settledWithin(gate, 30)).toBe('pending');
    viewer.resume(pauseId, 'inject', { hits: ['real'] });
    expect(await gate).toEqual({ action: 'inject', output: { hits: ['real'] } });
  });

  it('under a 0.5 debugger inject keeps its 0.5 behaviour', async () => {
    const { viewer, session } = await setup({ hubCapabilities: undefined });
    const gate = session.gate('after', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resume(pauseId, 'inject', 'long…[graphmind: truncated]');
    expect(await gate).toEqual({ action: 'inject', output: 'long…[graphmind: truncated]' });
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
  });

  it('a clean inject passes', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('after', TOOL);
    const pauseId = pauseIdOf(await viewer.waitForType('exec.paused'));
    viewer.resume(pauseId, 'inject', { ok: 1 });
    expect(await gate).toEqual({ action: 'inject', output: { ok: 1 } });
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
