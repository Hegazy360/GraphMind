/**
 * `exec.paused.instanceId` (0.6.0): a gate whose adapter knows which
 * execution it holds names it, so a debugger can tell parallel calls of one
 * node apart (the viewer then targets that call exactly — its argument editor
 * is offered again for parallel calls of one tool). Optional on the wire: a
 * gate without it is byte-identical to before, and breakpoints never match
 * on it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { createSession, withInstanceId, type GateNode, type Session } from '../src/index.js';
import { FakeViewer } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOOL: GateNode = { nodeId: 'tool:search', kind: 'tool', name: 'search' };

async function setup(): Promise<{ viewer: FakeViewer; session: Session }> {
  const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool', name: 'search' }] });
  cleanups.push(() => viewer.close());
  const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {} });
  cleanups.push(() => session.dispose());
  expect(await session.ready()).toBe(true);
  return { viewer, session };
}

async function pausedPayload(viewer: FakeViewer, gate: Promise<unknown>, index: number): Promise<Record<string, unknown>> {
  const paused = await viewer.waitFor(
    (f) => f.type === 'exec.paused' && viewer.ofType('exec.paused').indexOf(f) === index,
  );
  expect(parseEnvelope(paused).kind).toBe('ok');
  viewer.resume(paused.payload['pauseId'] as string, 'continue');
  await gate;
  return paused.payload;
}

describe('exec.paused.instanceId', () => {
  it('is sent when the gate node names its execution, and left out when it does not', async () => {
    const { viewer, session } = await setup();
    session.emit('node.started', { ...TOOL, instanceId: 'call-a', input: { q: 1 } });
    session.emit('node.started', { ...TOOL, instanceId: 'call-b', input: { q: 2 } });
    const named = await pausedPayload(viewer, session.gate('before', withInstanceId(TOOL, 'call-a')), 0);
    expect(named).toEqual({
      pauseId: named['pauseId'],
      nodeId: 'tool:search',
      point: 'before',
      reason: 'breakpoint',
      instanceId: 'call-a',
    });
    const unnamed = await pausedPayload(viewer, session.gate('before', TOOL), 1);
    expect(unnamed).not.toHaveProperty('instanceId');
    expect(unnamed).toMatchObject({ nodeId: 'tool:search', point: 'before', reason: 'breakpoint' });
  });

  it('breakpoints match the node, never the instance', async () => {
    const { viewer, session } = await setup();
    // The breakpoint names no instance; a node carrying one still matches it.
    const payload = await pausedPayload(viewer, session.gate('before', { ...TOOL, instanceId: 'x-1' }), 0);
    expect(payload['instanceId']).toBe('x-1');
  });
});

describe('withInstanceId', () => {
  it('names the execution only for a non-empty string, and never mutates the node', () => {
    expect(withInstanceId(TOOL, 'i1')).toEqual({ ...TOOL, instanceId: 'i1' });
    expect(TOOL).not.toHaveProperty('instanceId');
    for (const value of [undefined, '', 42, null, {}]) expect(withInstanceId(TOOL, value)).toBe(TOOL);
  });
});
