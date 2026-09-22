/**
 * The after-gate plumbing W4's smart holds build on: `gate('after', node,
 * {result})` hands the result to the session's detectors (an internal list,
 * empty in 0.6's W0), a hit holds the gate with `reason: 'breakpoint'` and
 * `smart`, and a detector can never break a gate. With no detector, `after`
 * gates behave exactly as in 0.5.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import {
  createSession,
  type AfterGateContext,
  type GateDetector,
  type GateNode,
  type Session,
  type SessionOptions,
} from '../src/index.js';
import { FakeViewer, waitUntil } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOOL: GateNode = { nodeId: 'tool:run', kind: 'tool', name: 'run' };

/** W4 registers its detectors here; tests reach the internal list the same way. */
function detectorsOf(session: Session): GateDetector[] {
  return (session as unknown as { detectors: GateDetector[] }).detectors;
}

async function setup(sessionOptions: SessionOptions = {}, viewerOptions: Parameters<typeof FakeViewer.start>[0] = {}) {
  const viewer = await FakeViewer.start(viewerOptions);
  cleanups.push(() => viewer.close());
  const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {}, ...sessionOptions });
  cleanups.push(() => session.dispose());
  expect(await session.ready()).toBe(true);
  return { viewer, session };
}

describe('after-gate detectors', () => {
  it('the list is empty by default: after gates are unchanged', async () => {
    const { viewer, session } = await setup();
    expect(detectorsOf(session)).toEqual([]);
    expect(await session.gate('after', TOOL, { result: { isError: true } })).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('a detector sees {runId, node, result} only at after gates that passed a result', async () => {
    const { session } = await setup();
    const seen: AfterGateContext[] = [];
    detectorsOf(session).push((context) => {
      seen.push(context);
      return undefined;
    });
    const result = { exitCode: 2 };
    const runId = await session.run('r', async (ctx) => {
      await session.gate('after', TOOL, { result });
      await session.gate('after', TOOL); // no options
      await session.gate('after', TOOL, { editable: true }); // no result
      await session.gate('before', TOOL, { result });
      await session.gate('error', TOOL, { result });
      return ctx.runId;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.runId).toBe(runId);
    expect(seen[0]?.node).toEqual(TOOL);
    expect(seen[0]?.result).toBe(result);
    // `result: undefined` is still a result
    await session.gate('after', TOOL, { result: undefined });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.result).toBeUndefined();
  });

  it('a hit holds the gate with reason breakpoint + smart; resume works as usual', async () => {
    const { viewer, session } = await setup();
    detectorsOf(session).push(({ result }) =>
      (result as { isError?: boolean }).isError === true ? { rule: 'error-result', detail: 'isError is true' } : undefined,
    );
    expect(await session.gate('after', TOOL, { result: { isError: false } })).toEqual({ action: 'continue' });
    const gate = session.gate('after', TOOL, { result: { isError: true } });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toEqual({
      pauseId: paused.payload['pauseId'],
      nodeId: TOOL.nodeId,
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'error-result', detail: 'isError is true' },
    });
    expect(parseEnvelope(paused).kind).toBe('ok');
    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    expect(await gate).toEqual({ action: 'retry' });
  });

  it('a smart hold is editable like any other', async () => {
    const { viewer, session } = await setup({}, { hubCapabilities: ['edit-input'] });
    detectorsOf(session).push(() => ({ rule: 'error-result' }));
    const gate = session.gate('after', TOOL, { result: {}, editable: true });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ reason: 'breakpoint', smart: { rule: 'error-result' }, editable: true });
    viewer.resumeWith({ pauseId: paused.payload['pauseId'] as string, action: 'retry', input: { cmd: 'ls' } });
    expect(await gate).toEqual({ action: 'retry', input: { cmd: 'ls' } });
  });

  it('a throwing detector is skipped; the next one still runs', async () => {
    const { viewer, session } = await setup();
    detectorsOf(session).push(() => {
      throw new Error('detector bug');
    });
    expect(await session.gate('after', TOOL, { result: 1 })).toEqual({ action: 'continue' });
    detectorsOf(session).push(() => ({ rule: 'truncated-tool-call' }));
    const gate = session.gate('after', TOOL, { result: 1 });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['smart']).toEqual({ rule: 'truncated-tool-call' });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
  });

  it('a result getter that throws means no detection, never a throw', async () => {
    const { session } = await setup();
    let called = false;
    detectorsOf(session).push(() => {
      called = true;
      return { rule: 'error-result' };
    });
    const options = {
      get result(): unknown {
        throw new Error('boom');
      },
    };
    expect(await session.gate('after', TOOL, options)).toEqual({ action: 'continue' });
    expect(called).toBe(false);
  });

  it('detached: detectors are never consulted', async () => {
    const session = createSession({ enabled: true, env: {}, webSocket: undefined, logger: () => {} });
    cleanups.push(() => session.dispose());
    let called = false;
    detectorsOf(session).push(() => {
      called = true;
      return { rule: 'error-result' };
    });
    expect(await session.gate('after', TOOL, { result: { isError: true } })).toEqual({ action: 'continue' });
    expect(called).toBe(false);
  });

  it.each<[string, SessionOptions, GateNode, boolean]>([
    ['no switch', {}, TOOL, true],
    ['HIDE_TOOL_RESULTS on a tool', { hideToolResults: true }, TOOL, false],
    ['HIDE_TOOL_ARGS on a tool', { env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' } }, TOOL, false],
    ['HIDE_OUTPUTS', { hideOutputs: true }, TOOL, false],
    ['HIDE_INPUTS', { hideInputs: true }, TOOL, false],
    ['HIDE_TOOL_RESULTS on an llm', { hideToolResults: true }, { nodeId: 'llm:x', kind: 'llm', name: 'x' }, true],
  ])('smart.detail under %s', async (_label, sessionOptions, node, kept) => {
    const { viewer, session } = await setup(sessionOptions, { breakpoints: [] });
    const ESC = String.fromCharCode(0x1b);
    detectorsOf(session).push(() => ({ rule: 'error-result', detail: `exit code ${ESC}2` }));
    const gate = session.gate('after', node, { result: {} });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['smart']).toEqual(kept ? { rule: 'error-result', detail: 'exit code 2' } : { rule: 'error-result' });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
    await waitUntil(() => viewer.ofType('exec.resumed').length === 1, 3000, 'resumed');
  });
});
