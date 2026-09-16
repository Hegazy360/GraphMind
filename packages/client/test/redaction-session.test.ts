/**
 * The kill switches applied where they must be: inside the session, before
 * the ring buffer. Proven against a real WebSocket viewer double:
 *
 *  - frames on the wire carry only the placeholder;
 *  - frames REPLAYED from the ring buffer on attach are already redacted
 *    (a debugger that attaches late must not receive the raw payloads);
 *  - env and option both work, and compose with the rest of the pipeline
 *    (heldMs stamping, duration normalisation, loose fields);
 *  - nothing on the host side changes: return values and thrown errors are
 *    untouched, and a disabled session stays a no-op.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED, createSession } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const SECRET_IN = 'INPUT-CANARY-7d9a1';
const SECRET_OUT = 'OUTPUT-CANARY-31bc4';
const SECRET_TOK = 'TOKEN-CANARY-c0ffee';

async function attachedViewer(): Promise<FakeViewer> {
  const viewer = await FakeViewer.start();
  cleanups.push(() => viewer.close());
  return viewer;
}

function frameJson(frames: ReceivedFrame[]): string {
  return JSON.stringify(frames);
}

/** Emit the same small run every test uses: llm step with tokens, then a tool. */
function emitRun(session: ReturnType<typeof createSession>): Promise<string> {
  return session.run('r', async (ctx) => {
    session.emit('node.started', {
      nodeId: 'llm:step',
      kind: 'llm',
      name: 'step',
      instanceId: 'l1',
      input: { messages: [SECRET_IN] },
    });
    session.emit('node.token', { nodeId: 'llm:step', deltas: [{ t: 'text', v: SECRET_TOK }] });
    session.emit('node.finished', {
      nodeId: 'llm:step',
      instanceId: 'l1',
      output: { text: SECRET_OUT },
      usage: { inputTokens: 11, outputTokens: 4 },
      durationMs: 3.14159,
      status: 'ok',
    });
    session.emit('node.started', {
      nodeId: 'tool:search',
      kind: 'tool',
      name: 'search',
      instanceId: 't1',
      input: { q: SECRET_IN },
    });
    session.emit('node.finished', {
      nodeId: 'tool:search',
      instanceId: 't1',
      output: { hits: [SECRET_OUT] },
      durationMs: 2,
      status: 'ok',
    });
    return ctx.runId;
  });
}

describe('redaction inside the session', () => {
  it('GRAPHMIND_HIDE_INPUTS via env: the wire never carries the input, everything else survives', async () => {
    const viewer = await attachedViewer();
    const session = createSession({ url: viewer.url, env: { GRAPHMIND_HIDE_INPUTS: '1' } });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    await emitRun(session);
    await viewer.waitForType('run.finished');

    const all = frameJson(viewer.received);
    expect(all).not.toContain(SECRET_IN);
    expect(all).toContain(SECRET_OUT); // outputs are not hidden by this switch
    expect(all).toContain(SECRET_TOK);
    const starts = viewer.ofType('node.started');
    expect(starts).toHaveLength(2);
    for (const s of starts) {
      expect(s.payload['input']).toBe(REDACTED);
      expect(s.payload['redaction']).toEqual({ count: 1, keys: ['input'] });
    }
    expect(starts.map((s) => [s.payload['kind'], s.payload['name']])).toEqual([
      ['llm', 'step'],
      ['tool', 'search'],
    ]);
  });

  it('hideOutputs as a session option: outputs and token text gone, usage/duration/heldMs intact', async () => {
    const viewer = await attachedViewer();
    const session = createSession({ url: viewer.url, env: {}, hideOutputs: true });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    await emitRun(session);
    await viewer.waitForType('run.finished');

    const all = frameJson(viewer.received);
    expect(all).not.toContain(SECRET_OUT);
    expect(all).not.toContain(SECRET_TOK);
    expect(all).toContain(SECRET_IN);
    const [llm, tool] = viewer.ofType('node.finished');
    expect(llm?.payload).toMatchObject({
      output: REDACTED,
      usage: { inputTokens: 11, outputTokens: 4 },
      durationMs: 3.14, // still normalised by the duration block
      heldMs: 0, // still stamped by the held-time block
      redaction: { count: 1, keys: ['output'] },
    });
    expect(tool?.payload).toMatchObject({ output: REDACTED, durationMs: 2 });
    const tok = viewer.ofType('node.token')[0];
    expect(tok?.payload['deltas']).toEqual([{ t: 'text', v: '', chars: SECRET_TOK.length }]);
    expect(tok?.payload['redaction']).toEqual({ count: 1, keys: ['deltas'] });
  });

  it('GRAPHMIND_HIDE_TOOL_ARGS / _TOOL_RESULTS: only the tool node is affected', async () => {
    const viewer = await attachedViewer();
    const session = createSession({
      url: viewer.url,
      env: { GRAPHMIND_HIDE_TOOL_ARGS: 'true', GRAPHMIND_HIDE_TOOL_RESULTS: 'TRUE' },
    });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    await emitRun(session);
    await viewer.waitForType('run.finished');

    const byNode = (type: string, nodeId: string) =>
      viewer.ofType(type).find((f) => f.payload['nodeId'] === nodeId)?.payload;
    expect(byNode('node.started', 'llm:step')?.['input']).toEqual({ messages: [SECRET_IN] });
    expect(byNode('node.finished', 'llm:step')?.['output']).toEqual({ text: SECRET_OUT });
    expect(byNode('node.started', 'tool:search')?.['input']).toBe(REDACTED);
    expect(byNode('node.finished', 'tool:search')?.['output']).toBe(REDACTED);
    expect(byNode('node.token', 'llm:step')?.['deltas']).toEqual([{ t: 'text', v: SECRET_TOK }]);
  });

  it('applies BEFORE the ring buffer: events emitted while detached are replayed redacted on attach', async () => {
    // autoAck:false keeps the session detached (connected, no hello.ack), so
    // every emit lands in the ring buffer; the manual ack then triggers
    // replay-on-attach — the exact path a late-attaching debugger takes.
    const viewer = await FakeViewer.start({ autoAck: false });
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      env: { GRAPHMIND_HIDE_INPUTS: '1', GRAPHMIND_HIDE_OUTPUTS: '1' },
    });
    cleanups.push(() => session.dispose());
    session.ready({ timeoutMs: 50 }).catch(() => {});
    await viewer.waitForType('hello');
    await emitRun(session);
    expect(session.attached).toBe(false);
    expect(session.stats().buffered).toBeGreaterThan(0);
    expect(viewer.ofType('node.started')).toHaveLength(0);

    viewer.sendControl('hello.ack', {
      versions: { protocol: 1, viewer: 'fake' },
      capabilities: [],
      breakpoints: [],
      mode: 'run',
    });
    await waitUntil(() => viewer.ofType('run.finished').length === 1, 5000, 'replay');

    const all = frameJson(viewer.received);
    expect(all).not.toContain(SECRET_IN);
    expect(all).not.toContain(SECRET_OUT);
    expect(all).not.toContain(SECRET_TOK);
    expect(viewer.ofType('node.started').every((f) => f.payload['input'] === REDACTED)).toBe(true);
    expect(viewer.ofType('node.finished').every((f) => f.payload['output'] === REDACTED)).toBe(true);
  });

  it('an env switch is a floor: hideInputs:false in code cannot lower GRAPHMIND_HIDE_INPUTS=1', async () => {
    const viewer = await attachedViewer();
    const session = createSession({
      url: viewer.url,
      env: { GRAPHMIND_HIDE_INPUTS: '1' },
      hideInputs: false,
    });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    await emitRun(session);
    await viewer.waitForType('run.finished');
    expect(frameJson(viewer.received)).not.toContain(SECRET_IN);
  });

  it('is invisible to the host: return values, thrown errors and node.error text are unchanged', async () => {
    const viewer = await attachedViewer();
    const session = createSession({
      url: viewer.url,
      env: { GRAPHMIND_HIDE_INPUTS: '1', GRAPHMIND_HIDE_OUTPUTS: '1' },
    });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    const runId = await emitRun(session);
    expect(runId).toMatch(/^run_/);
    await expect(
      session.run('fails', async () => {
        session.emit('node.error', {
          nodeId: 'tool:x',
          instanceId: '1',
          error: { name: 'Boom', message: `echoing ${SECRET_OUT}` },
        });
        throw new Error('host error');
      }),
    ).rejects.toThrow('host error');
    await waitUntil(() => viewer.ofType('run.finished').length === 2, 5000, 'second run');
    const err = viewer.ofType('node.error')[0];
    // Documented: node.error is NOT redacted — messages may echo data.
    expect(err?.payload['error']).toEqual({ name: 'Boom', message: `echoing ${SECRET_OUT}` });
  });

  it('a disabled session with switches set stays a complete no-op', async () => {
    const viewer = await attachedViewer();
    const session = createSession({
      url: viewer.url,
      env: { GRAPHMIND_DISABLED: '1', GRAPHMIND_HIDE_INPUTS: '1' },
    });
    cleanups.push(() => session.dispose());
    expect(session.enabled).toBe(false);
    await emitRun(session);
    await tick(50);
    expect(viewer.connectionCount).toBe(0);
    expect(session.stats().buffered).toBe(0);
  });
});

// ── Fails closed on internal error, end to end (decisions.md, BINDING) ────────
describe('redaction fails closed inside the session', () => {
  const SECRET = 'FAILCLOSED-CANARY-a41d';

  function throwingOn<T extends object>(target: T, keys: string[]): T {
    return new Proxy(target, {
      get(t, key, receiver) {
        if (typeof key === 'string' && keys.includes(key)) throw new Error(`no ${key}`);
        return Reflect.get(t, key, receiver);
      },
    });
  }

  it('hostile payloads never put a hidden value on the wire (live and replayed), warn rate-limited, and the session keeps working', async () => {
    const { parseEnvelope } = await import('@graphmind-ai/schema');
    const viewer = await FakeViewer.start({ autoAck: false });
    cleanups.push(() => viewer.close());
    const warnings: string[] = [];
    const session = createSession({
      url: viewer.url,
      env: {},
      hideInputs: true,
      hideOutputs: true,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => session.dispose());
    session.ready({ timeoutMs: 50 }).catch(() => {});
    await viewer.waitForType('hello');

    const emitHostile = (tag: string): void => {
      // input / output / deltas reads throw -> failed form
      session.emit(
        'node.started',
        throwingOn({ nodeId: `tool:${tag}`, kind: 'tool', name: tag, instanceId: `${tag}1`, input: { k: SECRET } }, ['input']) as never,
      );
      session.emit(
        'node.token',
        throwingOn({ nodeId: `tool:${tag}`, deltas: [{ t: 'text', v: SECRET }] }, ['deltas']) as never,
      );
      session.emit(
        'node.finished',
        throwingOn({ nodeId: `tool:${tag}`, instanceId: `${tag}1`, output: SECRET, durationMs: 2, status: 'ok' }, ['output']) as never,
      );
      // only nodeId throws -> cannot be valid -> dropped
      session.emit('node.started', throwingOn({ nodeId: 'x', kind: 'tool', name: 'x', instanceId: 'x', input: SECRET }, ['nodeId']) as never);
      // a payload that is not an object -> dropped
      session.emit('node.started', SECRET as never);
      session.emit('node.finished', [SECRET] as never);
    };

    // Detached: into the ring buffer...
    emitHostile('detached');
    expect(session.attached).toBe(false);
    viewer.sendControl('hello.ack', { versions: { protocol: 1, viewer: 'fake' }, capabilities: [], breakpoints: [], mode: 'run' });
    await waitUntil(() => session.attached, 3000, 'attach');
    // ...and live.
    emitHostile('live');
    // The session is still healthy: a normal event after all that arrives, redacted.
    session.emit('node.started', { nodeId: 'tool:after', kind: 'tool', name: 'after', instanceId: 'a1', input: { k: SECRET } });
    await waitUntil(
      () => viewer.ofType('node.started').some((f) => f.payload['nodeId'] === 'tool:after'),
      3000,
      'the normal event after the hostile ones',
    );

    expect(frameJson(viewer.received)).not.toContain(SECRET);
    const failed = viewer.received.filter((f) => (f.payload?.['redaction'] as { failed?: boolean } | undefined)?.failed === true);
    // 3 failed forms per burst (started, token, finished), 2 bursts.
    expect(failed.map((f) => f.type).sort()).toEqual(
      ['node.finished', 'node.finished', 'node.started', 'node.started', 'node.token', 'node.token'],
    );
    for (const frame of viewer.received) {
      expect(parseEnvelope(frame).kind, `${frame.type} #${frame.seq} is a valid envelope`).toBe('ok');
    }
    expect(viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:live')?.payload).toEqual({
      nodeId: 'tool:live',
      kind: 'tool',
      name: 'live',
      instanceId: 'live1',
      input: REDACTED,
      redaction: { count: 0, keys: ['input', 'output', 'deltas'], failed: true },
    });
    // No dropped event reached the wire: 2 failed starts + tool:after.
    expect(viewer.ofType('node.started')).toHaveLength(3);
    expect(viewer.ofType('node.finished')).toHaveLength(2);
    // heldMs bookkeeping ran on the failed forms like on any finished node.
    expect(viewer.ofType('node.finished').every((f) => f.payload['durationMs'] === 2)).toBe(true);

    // Rate-limited through the session's warner: one line per kind of failure, not one per event.
    expect(warnings.join('\n')).not.toContain(SECRET);
    const dropped = warnings.filter((w) => w.includes('dropped'));
    const failedWarn = warnings.filter((w) => w.includes('redaction failed'));
    expect(dropped).toHaveLength(1);
    expect(failedWarn).toHaveLength(1);

    // Gates still work.
    expect(await session.gate('before', { nodeId: 'tool:after', kind: 'tool', name: 'after' })).toEqual({ action: 'continue' });
  });

  it('never throws into the host, even when the logger throws too', async () => {
    const viewer = await attachedViewer();
    const session = createSession({
      url: viewer.url,
      env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' },
      logger: () => {
        throw new Error('logger down');
      },
    });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    expect(() => {
      session.emit('node.started', throwingOn({ nodeId: 'tool:a', kind: 'tool', name: 'a', instanceId: '1', input: SECRET }, ['input', 'kind']) as never);
      session.emit('node.token', 'SECRET' as never);
      session.emit('node.token', { nodeId: 'llm:a', deltas: [{ t: 'tool-args', v: { q: SECRET } }] } as never);
    }).not.toThrow();
    session.emit('graph.hint', { nodes: [] });
    await viewer.waitForType('graph.hint');
    expect(frameJson(viewer.received)).not.toContain(SECRET);
    expect(viewer.ofType('node.token')).toEqual([
      expect.objectContaining({ payload: { nodeId: 'llm:a', deltas: [], redaction: { count: 0, keys: ['input', 'output', 'deltas'], failed: true } } }),
    ]);
  });
});

// Verifier pass (loop v3 / fail-closed, 2026-09-14). The switches decide by
// identity fields — a start's `kind`, the `nodeId`/`instanceId` a result's kind
// is looked up by, a delta's `t` — but JSON.stringify serialises a String
// object, or any object with a `toJSON`, as a plain string. Before the fix the
// redactor compared the object (`kind === 'tool'` is false for
// `new String('tool')`), left the value visible, and the envelope on the wire
// said `"kind":"tool"` with the tool arguments in it — a schema-valid event.
describe('redaction fails closed on identity fields that are not strings', () => {
  const CANARY = 'COERCED-CANARY-5e1d';

  it('a String object or toJSON where a string identity belongs never smuggles a hidden value onto the wire', async () => {
    const { parseEnvelope } = await import('@graphmind-ai/schema');
    const viewer = await attachedViewer();
    const warnings: string[] = [];
    const session = createSession({
      url: viewer.url,
      env: { GRAPHMIND_HIDE_TOOL_ARGS: '1', GRAPHMIND_HIDE_TOOL_RESULTS: '1' },
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    const asString = (text: string): string => new String(text) as unknown as string;
    const viaToJSON = (text: string): string => ({ toJSON: () => text }) as unknown as string;

    expect(() => {
      // a start's kind
      session.emit('node.started', { nodeId: 'tool:a', kind: asString('tool') as never, name: 'a', instanceId: 'a1', input: { q: CANARY } });
      session.emit('node.started', { nodeId: 'tool:b', kind: viaToJSON('tool') as never, name: 'b', instanceId: 'b1', input: { q: CANARY } });
      // a start whose nodeId is boxed cannot be a valid failed form either: dropped
      session.emit('node.started', { nodeId: asString('mcp:c'), kind: 'tool', name: 'c', instanceId: 'c1', input: { q: CANARY } });
      session.emit('node.finished', { nodeId: asString('mcp:c'), instanceId: 'c1', durationMs: 1, status: 'ok', output: { r: CANARY } });
      // a result whose own nodeId / instanceId is boxed
      session.emit('node.started', { nodeId: 'mcp:d', kind: 'tool', name: 'd', instanceId: 'd1', input: 1 });
      session.emit('node.finished', { nodeId: asString('mcp:d'), instanceId: 'd1', durationMs: 1, status: 'ok', output: { r: CANARY } });
      session.emit('node.started', { nodeId: 'mcp:e', kind: 'tool', name: 'e', instanceId: 'e1', input: 1 });
      session.emit('node.started', { nodeId: 'mcp:e', kind: 'llm', name: 'e', instanceId: 'e2', input: 1 });
      session.emit('node.finished', { nodeId: 'mcp:e', instanceId: viaToJSON('e1'), durationMs: 1, status: 'ok', output: { r: CANARY } });
      // tokens: a boxed nodeId of a tool, a boxed tool-args channel
      session.emit('node.token', { nodeId: viaToJSON('mcp:e'), deltas: [{ t: 'text', v: CANARY }] });
      session.emit('node.token', { nodeId: 'llm:f', deltas: [{ t: asString('tool-args') as never, v: CANARY }] });
      session.emit('node.token', { nodeId: 'llm:f', deltas: [{ t: viaToJSON('tool-args') as never, v: CANARY }] });
    }).not.toThrow();

    // The session keeps streaming, and still redacts a well-formed tool call.
    session.emit('node.started', { nodeId: 'tool:after', kind: 'tool', name: 'after', instanceId: 'z1', input: { q: CANARY } });
    await waitUntil(
      () => viewer.ofType('node.started').some((f) => f.payload['nodeId'] === 'tool:after'),
      3000,
      'the well-formed event after the coerced ones',
    );
    expect(frameJson(viewer.received)).not.toContain(CANARY);
    for (const frame of viewer.received) {
      expect(parseEnvelope(frame).kind, `${frame.type} #${frame.seq} is a valid envelope`).toBe('ok');
    }
    expect(warnings.join('\n')).not.toContain(CANARY);
    expect(viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:after')?.payload['input']).toBe(REDACTED);
    // Exactly what happened to each: a start or result whose REQUIRED identity is
    // not a string is dropped; an optional one (a result's instanceId, a delta's
    // channel) gives the failed form.
    expect(viewer.ofType('node.started').map((f) => f.payload['nodeId'])).toEqual(['mcp:d', 'mcp:e', 'mcp:e', 'tool:after']);
    const FAILED_FORM = { count: 0, keys: ['input', 'output', 'deltas'], failed: true };
    expect(viewer.ofType('node.finished').map((f) => f.payload)).toEqual([
      // heldMs: the session's held-time stamp runs on the failed form like on any result.
      { nodeId: 'mcp:e', durationMs: 1, status: 'ok', output: REDACTED, redaction: FAILED_FORM, heldMs: 0 },
    ]);
    expect(viewer.ofType('node.token').map((f) => f.payload)).toEqual([
      { nodeId: 'llm:f', deltas: [], redaction: FAILED_FORM },
      { nodeId: 'llm:f', deltas: [], redaction: FAILED_FORM },
    ]);
    expect(warnings.filter((w) => w.includes('dropped'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('redaction failed'))).toHaveLength(1);
  });
});
