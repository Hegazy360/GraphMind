/**
 * Smart breakpoints (0.6.0, contract C4): `error-result` at a tool's `after`
 * gate and `truncated-tool-call` at an LLM step's `after` gate. The strict
 * shapes (positive and negative), the default-on env switches and the session
 * option, detached no-op, value-free details and their redaction.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { createSession, type GateNode, type Session, type SessionOptions } from '../src/index.js';
import {
  errorResultDetector,
  errorResultShape,
  parseBreakOn,
  resolveSmartBreakpoints,
  truncatedDetail,
  truncatedToolCall,
  truncatedToolCallDetector,
} from '../src/smart.js';
import type { WebSocketConstructor, WebSocketLike } from '../src/transport.js';
import { FakeViewer, tick, waitUntil } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOOL: GateNode = { nodeId: 'tool:shell', kind: 'tool', name: 'shell' };
const LLM: GateNode = { nodeId: 'llm:step', kind: 'llm', name: 'step' };
const SECRET = 'sk-live-0123456789';

const throwing = (key: string): object =>
  Object.defineProperty({}, key, {
    enumerable: true,
    get(): never {
      throw new Error('getter');
    },
  });

describe('error-result: the strict shape', () => {
  it.each<[string, unknown, string]>([
    ['isError true', { isError: true, content: [{ type: 'text', text: 'x' }] }, 'isError'],
    ['success false', { success: false, data: null }, 'success'],
    ['exit_code 2', { exit_code: 2, stdout: '' }, 'exit_code'],
    ['exitCode -1', { exitCode: -1 }, 'exitCode'],
    ['exitStatus 127', { exitStatus: 127 }, 'exitStatus'],
    ['exitCode Infinity', { exitCode: Number.POSITIVE_INFINITY }, 'exitCode'],
    ['only error (string)', { error: 'ENOENT' }, 'error'],
    ['only error (object)', { error: { code: 'E' } }, 'error'],
    ['only error (0)', { error: 0 }, 'error'],
    ['null-prototype only error', Object.assign(Object.create(null) as object, { error: 'x' }), 'error'],
    ['isError on a class instance', new (class R { isError = true })(), 'isError'],
  ])('%s is error-shaped', (_label, result, shape) => {
    expect(errorResultShape(result)).toBe(shape);
  });

  it.each<[string, unknown]>([
    ['isError false', { isError: false }],
    ['isError "true"', { isError: 'true' }],
    ['isError 1', { isError: 1 }],
    ['success true', { success: true }],
    ['success "false"', { success: 'false' }],
    ['success undefined', { success: undefined }],
    ['exitCode 0', { exitCode: 0 }],
    ['exitCode -0', { exitCode: -0 }],
    ['exitCode NaN', { exitCode: Number.NaN }],
    ['exitCode "1"', { exitCode: '1' }],
    ['exit_code null', { exit_code: null }],
    ['{error, other}', { error: 'x', other: 'y' }],
    ['{error: null}', { error: null }],
    ['{error: undefined}', { error: undefined }],
    ['{error: false}', { error: false }],
    ['a class instance whose only field is error', new (class E { error = 'x' })()],
    ['an Error object', new Error('boom')],
    ['a string containing error', 'Error: command failed with exit code 1'],
    ['the word error', 'error'],
    ['an object with an error message', { message: 'error', status: 'error' }],
    ['a nested isError', { result: { isError: true } }],
    ['null', null],
    ['undefined', undefined],
    ['0', 0],
    ['false', false],
    ['an array', [{ isError: true }]],
    ['an empty array', []],
    ['an empty object', {}],
    ['a Map', new Map([['isError', true]])],
  ])('%s is not error-shaped', (_label, result) => {
    expect(errorResultShape(result)).toBeUndefined();
  });

  it('getters and Proxy traps that throw: not error-shaped, never a throw', () => {
    expect(errorResultShape(throwing('isError'))).toBeUndefined();
    expect(errorResultShape(throwing('error'))).toBeUndefined();
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        getPrototypeOf() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    expect(() => errorResultShape(trap)).not.toThrow();
    expect(errorResultShape(trap)).toBeUndefined();
  });

  it('the detector: tool nodes only, value-free detail', () => {
    const ctx = (node: GateNode, result: unknown) => ({ runId: 'r', node, result });
    expect(errorResultDetector(ctx(TOOL, { isError: true, content: SECRET }))).toEqual({
      rule: 'error-result',
      detail: 'the tool returned a result with isError: true',
    });
    expect(errorResultDetector(ctx(TOOL, { exitCode: 3, stderr: SECRET }))?.detail).toBe(
      'the tool returned a result with a non-zero exitCode',
    );
    expect(errorResultDetector(ctx(TOOL, { error: SECRET }))?.detail).not.toContain(SECRET);
    expect(errorResultDetector(ctx(LLM, { isError: true }))).toBeUndefined();
    expect(errorResultDetector(ctx({ nodeId: 'custom:x', kind: 'custom', name: 'x' }, { isError: true }))).toBeUndefined();
  });
});

describe('truncated-tool-call', () => {
  const call = (extra: object = {}) => ({ id: 'c1', name: 'write_file', input: { path: 'a' }, ...extra });

  it.each<[string, unknown, { finishReason: string; toolCalls: number; unparsed: number }]>([
    ['length + 1 call', { finishReason: 'length', toolCalls: [call()] }, { finishReason: 'length', toolCalls: 1, unparsed: 0 }],
    ['content-filter + 2 calls', { finishReason: 'content-filter', toolCalls: [call(), call()] }, { finishReason: 'content-filter', toolCalls: 2, unparsed: 0 }],
    ['length + unparsed', { finishReason: 'length', rawFinishReason: 'max_tokens', toolCalls: [call({ inputText: '{"path":"a' })] }, { finishReason: 'length', toolCalls: 1, unparsed: 1 }],
    ['text around it', { text: 'Let me write', finishReason: 'length', toolCalls: [call(), call({ inputText: '{' })] }, { finishReason: 'length', toolCalls: 2, unparsed: 1 }],
  ])('%s fires', (_label, result, expected) => {
    expect(truncatedToolCall(result)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ['length, no calls', { finishReason: 'length', toolCalls: [] }],
    ['length, calls absent', { finishReason: 'length' }],
    ['length, calls null', { finishReason: 'length', toolCalls: null }],
    ['length, calls an object', { finishReason: 'length', toolCalls: { 0: call() } }],
    ['stop + calls', { finishReason: 'stop', toolCalls: [call()] }],
    ['tool-calls + unparsed', { finishReason: 'tool-calls', toolCalls: [call({ inputText: '{' })] }],
    ['stop + unparsed', { finishReason: 'stop', toolCalls: [call({ inputText: '{' })] }],
    ['error + unparsed (Gemini MALFORMED_FUNCTION_CALL)', { finishReason: 'error', toolCalls: [call({ inputText: '{' })] }],
    ['other + unparsed', { finishReason: 'other', toolCalls: [call({ inputText: '{' })] }],
    ['error', { finishReason: 'error', toolCalls: [call()] }],
    ['other', { finishReason: 'other', toolCalls: [call()] }],
    ['raw only', { rawFinishReason: 'length', toolCalls: [call()] }],
    ['provider spelling', { finishReason: 'max_tokens', toolCalls: [call()] }],
    ['uppercase', { finishReason: 'LENGTH', toolCalls: [call()] }],
    ['a string', 'length'],
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ finishReason: 'length', toolCalls: [call()] }]],
    ['a getter that throws', throwing('finishReason')],
    ['toolCalls getter that throws', Object.defineProperty({ finishReason: 'length' }, 'toolCalls', { get: () => { throw new Error('x'); } })],
  ])('%s does not fire (and never throws)', (_label, result) => {
    expect(() => truncatedToolCall(result)).not.toThrow();
    expect(truncatedToolCall(result)).toBeUndefined();
  });

  it('a tool call whose inputText getter throws does not break the rule', () => {
    const hostile = { finishReason: 'length', toolCalls: [call(), throwing('inputText')] };
    expect(truncatedToolCall(hostile)).toBeUndefined(); // any throw -> no verdict
  });

  it('the detector: LLM nodes only; detail is counts and our own words', () => {
    const ctx = (node: GateNode, result: unknown) => ({ runId: 'r', node, result });
    const result = { finishReason: 'length', toolCalls: [call({ input: { secret: SECRET }, inputText: `{"secret":"${SECRET}` })] };
    const hit = truncatedToolCallDetector(ctx(LLM, result));
    expect(hit).toEqual({
      rule: 'truncated-tool-call',
      detail: 'the model was stopped at the token limit with 1 tool call requested; 1 call has arguments that did not parse',
    });
    expect(JSON.stringify(hit)).not.toContain(SECRET);
    expect(truncatedToolCallDetector(ctx(TOOL, result))).toBeUndefined();
    expect(truncatedDetail({ finishReason: 'content-filter', toolCalls: 3, unparsed: 0 })).toBe(
      'the model was stopped by the content filter with 3 tool calls requested',
    );
  });
});

// The rule is the finish reason AND a tool call (contract C4, the loop-kinds
// fixture): a call whose arguments did not parse under any other finish reason
// is not a truncation. The docs once also promised an `inputText`-alone branch
// the code never had.
describe('truncated-tool-call: what the docs say', () => {
  const doc = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('the client README and the smart.ts header describe the AND form only', () => {
    const row = doc('../README.md')
      .split('\n')
      .find((line) => line.startsWith("| `smart.rule: 'truncated-tool-call'`"));
    expect(row).toBeDefined();
    expect(row).toMatch(/`length` or `content-filter` and it requested at least one tool call/);
    expect(row).not.toMatch(/\(or a call's arguments did not parse/);
    const header = doc('../src/smart.ts').slice(0, doc('../src/smart.ts').indexOf('import '));
    expect(header).not.toMatch(/or a tool\s+\*?\s*call's arguments did not parse/);
  });
});

describe('switches', () => {
  it.each<[string | undefined, boolean]>([
    [undefined, true],
    ['', true],
    ['  ', true],
    ['0', false],
    ['false', false],
    ['False', false],
    [' OFF ', false],
    ['no', false],
    ['NO', false],
    ['1', true],
    ['true', true],
    ['on', true],
    ['yes', true],
    ['nope', true],
  ])('GRAPHMIND_BREAK_ON_*=%j -> %s', (raw, on) => {
    expect(parseBreakOn(raw)).toBe(on);
    expect(resolveSmartBreakpoints(undefined, { GRAPHMIND_BREAK_ON_ERROR_RESULT: raw })).toEqual({ errorResult: on, truncatedToolCall: true });
    expect(resolveSmartBreakpoints(undefined, { GRAPHMIND_BREAK_ON_TRUNCATED: raw })).toEqual({ errorResult: true, truncatedToolCall: on });
  });

  it('a boolean option beats the env; anything else leaves the env in charge; hostile inputs never throw', () => {
    expect(resolveSmartBreakpoints({ breakOnErrorResult: true }, { GRAPHMIND_BREAK_ON_ERROR_RESULT: 'off' }).errorResult).toBe(true);
    expect(resolveSmartBreakpoints({ breakOnErrorResult: false }, {}).errorResult).toBe(false);
    expect(resolveSmartBreakpoints({ breakOnTruncated: false }, { GRAPHMIND_BREAK_ON_TRUNCATED: '1' }).truncatedToolCall).toBe(false);
    expect(
      resolveSmartBreakpoints({ breakOnErrorResult: 'false' as unknown as boolean }, { GRAPHMIND_BREAK_ON_ERROR_RESULT: 'on' }).errorResult,
    ).toBe(true);
    const hostile = new Proxy({}, { get: () => { throw new Error('x'); } });
    expect(resolveSmartBreakpoints(hostile, hostile as never)).toEqual({ errorResult: true, truncatedToolCall: true });
  });
});

// -- through a live session --------------------------------------------------------

async function setup(sessionOptions: SessionOptions = {}): Promise<{ viewer: FakeViewer; session: Session }> {
  const viewer = await FakeViewer.start();
  cleanups.push(() => viewer.close());
  const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {}, ...sessionOptions });
  cleanups.push(() => session.dispose());
  expect(await session.ready()).toBe(true);
  return { viewer, session };
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

class NeverConnectsWS implements WebSocketLike {
  readonly readyState = 0;
  constructor(_url: string) {}
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

describe('smart holds through a live session', () => {
  it('error-result holds a tool after-gate with reason breakpoint + smart; every action keeps its meaning', async () => {
    const { viewer, session } = await setup();
    expect(await session.gate('after', TOOL, { result: { exitCode: 0, stdout: 'ok' } })).toEqual({ action: 'continue' });
    const gate = session.gate('after', TOOL, { result: { exitCode: 1, stderr: SECRET } });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toEqual({
      pauseId: paused.payload['pauseId'],
      nodeId: TOOL.nodeId,
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'error-result', detail: 'the tool returned a result with a non-zero exitCode' },
    });
    expect(parseEnvelope(paused).kind).toBe('ok');
    expect(JSON.stringify(paused)).not.toContain(SECRET);
    viewer.resume(paused.payload['pauseId'] as string, 'inject', { exitCode: 0 });
    expect(await gate).toEqual({ action: 'inject', output: { exitCode: 0 } });
  });

  it('truncated-tool-call holds an LLM after-gate; the same result at a tool gate does not', async () => {
    const { viewer, session } = await setup();
    const result = { finishReason: 'length', toolCalls: [{ name: 'write', input: {}, inputText: '{"a' }] };
    expect(await settledWithin(session.gate('after', TOOL, { result }), 200)).toEqual({ action: 'continue' });
    const gate = session.gate('after', LLM, { result });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({
      nodeId: LLM.nodeId,
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'truncated-tool-call' },
    });
    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    expect(await gate).toEqual({ action: 'retry' });
  });

  it('never at before gates, never without a result, never on a non-error result', async () => {
    const { viewer, session } = await setup();
    const bad = { isError: true };
    expect(await settledWithin(session.gate('before', TOOL, { result: bad }), 200)).toEqual({ action: 'continue' });
    // At an error gate only a RETURNED shape is a smart hold; {error} is how an
    // adapter wraps a thrown error, which is the pause-on-error breakpoint's business.
    expect(await settledWithin(session.gate('error', TOOL, { result: { error: 'thrown' } }), 200)).toEqual({ action: 'continue' });
    expect(await settledWithin(session.gate('error', LLM, { result: bad }), 200)).toEqual({ action: 'continue' });
    expect(await settledWithin(session.gate('after', TOOL), 200)).toEqual({ action: 'continue' });
    expect(await settledWithin(session.gate('after', TOOL, { editable: true }), 200)).toEqual({ action: 'continue' });
    for (const result of [{ isError: false }, 'error', null, undefined, [bad], { error: 'x', data: 1 }]) {
      expect(await settledWithin(session.gate('after', TOOL, { result }), 200)).toEqual({ action: 'continue' });
    }
    const options = {
      get result(): unknown {
        throw new Error('boom');
      },
    };
    expect(await settledWithin(session.gate('after', TOOL, options), 200)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('at a tool error gate handed a result (mcp-proxy isError), a returned error shape is reported with the rule', async () => {
    const { viewer, session } = await setup();
    const gate = session.gate('error', TOOL, { result: { isError: true, content: [{ type: 'text', text: SECRET }] } });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toEqual({
      pauseId: paused.payload['pauseId'],
      nodeId: TOOL.nodeId,
      point: 'error',
      reason: 'breakpoint',
      smart: { rule: 'error-result', detail: 'the tool returned a result with isError: true' },
    });
    expect(JSON.stringify(paused)).not.toContain(SECRET);
    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    expect(await gate).toEqual({ action: 'retry' });

    // Switched off: the error gate is an ordinary gate again (no breakpoint armed -> no hold).
    const off = await setup({ breakOnErrorResult: false });
    expect(await settledWithin(off.session.gate('error', TOOL, { result: { isError: true } }), 200)).toEqual({ action: 'continue' });
    expect(off.viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('with pause-on-error armed, a thrown error at the error gate is reason error, an isError result is the smart rule', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ point: 'error' }] });
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {} });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    const thrown = session.gate('error', TOOL);
    const first = await viewer.waitForType('exec.paused');
    expect(first.payload['reason']).toBe('error');
    expect(first.payload).not.toHaveProperty('smart');
    viewer.resume(first.payload['pauseId'] as string, 'continue');
    await thrown;
    const returned = session.gate('error', TOOL, { result: { exitCode: 1 } });
    const second = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['pauseId'] !== first.payload['pauseId']);
    expect(second.payload).toMatchObject({ reason: 'breakpoint', smart: { rule: 'error-result' } });
    viewer.resume(second.payload['pauseId'] as string, 'continue');
    await returned;
  });

  it.each<[string, SessionOptions]>([
    ['GRAPHMIND_BREAK_ON_ERROR_RESULT=0', { env: { GRAPHMIND_BREAK_ON_ERROR_RESULT: '0' } }],
    ['GRAPHMIND_BREAK_ON_ERROR_RESULT=off', { env: { GRAPHMIND_BREAK_ON_ERROR_RESULT: ' Off ' } }],
    ['breakOnErrorResult: false', { breakOnErrorResult: false }],
    ['breakOnErrorResult: false beats env on', { breakOnErrorResult: false, env: { GRAPHMIND_BREAK_ON_ERROR_RESULT: '1' } }],
  ])('%s: no error-result hold (truncated still on)', async (_label, options) => {
    const { viewer, session } = await setup(options);
    expect(await settledWithin(session.gate('after', TOOL, { result: { isError: true } }), 200)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    const gate = session.gate('after', LLM, { result: { finishReason: 'length', toolCalls: [{ name: 'a', input: {} }] } });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['smart']).toMatchObject({ rule: 'truncated-tool-call' });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
  });

  it.each<[string, SessionOptions]>([
    ['GRAPHMIND_BREAK_ON_TRUNCATED=false', { env: { GRAPHMIND_BREAK_ON_TRUNCATED: 'false' } }],
    ['GRAPHMIND_BREAK_ON_TRUNCATED=no', { env: { GRAPHMIND_BREAK_ON_TRUNCATED: 'NO' } }],
    ['breakOnTruncated: false', { breakOnTruncated: false }],
  ])('%s: no truncated hold (error-result still on)', async (_label, options) => {
    const { viewer, session } = await setup(options);
    const result = { finishReason: 'length', toolCalls: [{ name: 'a', input: {} }] };
    expect(await settledWithin(session.gate('after', LLM, { result }), 200)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    const gate = session.gate('after', TOOL, { result: { success: false } });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['smart']).toMatchObject({ rule: 'error-result' });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
  });

  it('an unexpected spelling keeps the rule on', async () => {
    const { viewer, session } = await setup({ env: { GRAPHMIND_BREAK_ON_ERROR_RESULT: 'disable' } });
    const gate = session.gate('after', TOOL, { result: { isError: true } });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['smart']).toMatchObject({ rule: 'error-result' });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
  });

  it('detached: never holds and the gate stays on the fast path', async () => {
    const session = createSession({
      enabled: true,
      env: {},
      webSocket: NeverConnectsWS as unknown as WebSocketConstructor,
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => session.dispose());
    const result = { isError: true };
    const llm = { finishReason: 'length', toolCalls: [{ name: 'a', input: {} }] };
    for (let i = 0; i < 100; i += 1) await session.gate('after', TOOL, { result });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      expect(await session.gate('after', TOOL, { result })).toEqual({ action: 'continue' });
      expect(await session.gate('after', LLM, { result: llm })).toEqual({ action: 'continue' });
    }
    expect((performance.now() - t0) / 2000).toBeLessThan(1);
    expect(session.stats().heldGates).toBe(0);
  });

  it('disabled sessions never consult anything', async () => {
    const session = createSession({ env: { GRAPHMIND_DISABLED: '1' } });
    cleanups.push(() => session.dispose());
    expect(await session.gate('after', TOOL, { result: { isError: true } })).toEqual({ action: 'continue' });
  });

  it.each<[string, SessionOptions, GateNode, boolean]>([
    ['no switch (tool)', {}, TOOL, true],
    ['HIDE_TOOL_RESULTS (tool)', { hideToolResults: true }, TOOL, false],
    ['HIDE_TOOL_ARGS (tool)', { env: { GRAPHMIND_HIDE_TOOL_ARGS: 'on' } }, TOOL, false],
    ['HIDE_OUTPUTS (tool)', { hideOutputs: true }, TOOL, false],
    ['HIDE_INPUTS (tool)', { env: { GRAPHMIND_HIDE_INPUTS: '1' } }, TOOL, false],
    ['no switch (llm)', {}, LLM, true],
    ['HIDE_OUTPUTS (llm)', { hideOutputs: true }, LLM, false],
    ['HIDE_INPUTS (llm)', { hideInputs: true }, LLM, false],
    ['HIDE_TOOL_ARGS (llm)', { hideToolArgs: true }, LLM, true],
  ])('detail under %s: kept=%s; the rule always survives', async (_label, options, node, kept) => {
    const { viewer, session } = await setup(options);
    const result =
      node.kind === 'tool'
        ? { isError: true, content: SECRET }
        : { finishReason: 'content-filter', toolCalls: [{ name: 'a', input: { k: SECRET } }] };
    const gate = session.gate('after', node, { result });
    const paused = await viewer.waitForType('exec.paused');
    const smart = paused.payload['smart'] as { rule: string; detail?: string };
    expect(smart.rule).toBe(node.kind === 'tool' ? 'error-result' : 'truncated-tool-call');
    if (kept) expect(typeof smart.detail).toBe('string');
    else expect(smart).not.toHaveProperty('detail');
    expect(JSON.stringify(paused)).not.toContain(SECRET);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
    await waitUntil(() => viewer.ofType('exec.resumed').length === 1, 3000, 'resumed');
  });
});
