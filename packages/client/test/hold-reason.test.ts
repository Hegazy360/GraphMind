/**
 * Every hold carries a reason (0.6.0, contract C4): `exec.paused.reason` is
 * `loop` (built-in loop hold), `breakpoint` (a matched breakpoint, or a smart
 * hold with `smart`), `step` (step mode) or `error` (a hold at an error
 * point). 0.5 hubs already accept all four values.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope, type BreakpointMatcher, type RunMode } from '@graphmind-ai/schema';
import { createSession, type GateNode, type Session } from '../src/index.js';
import { FakeViewer } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOOL: GateNode = { nodeId: 'tool:search', kind: 'tool', name: 'search' };
const LLM: GateNode = { nodeId: 'llm:step', kind: 'llm', name: 'step' };

async function setup(breakpoints: BreakpointMatcher[], mode: RunMode = 'run'): Promise<{ viewer: FakeViewer; session: Session }> {
  const viewer = await FakeViewer.start({ breakpoints, mode });
  cleanups.push(() => viewer.close());
  const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {} });
  cleanups.push(() => session.dispose());
  expect(await session.ready()).toBe(true);
  return { viewer, session };
}

async function reasonOf(viewer: FakeViewer, gate: Promise<unknown>, count: number): Promise<unknown> {
  const paused = await viewer.waitFor((f) => f.type === 'exec.paused' && viewer.ofType('exec.paused').indexOf(f) === count - 1);
  expect(parseEnvelope(paused).kind).toBe('ok');
  viewer.resume(paused.payload['pauseId'] as string, 'continue');
  await gate;
  return paused.payload['reason'];
}

describe('every hold carries a reason', () => {
  it('a matched breakpoint -> breakpoint (before and after)', async () => {
    const { viewer, session } = await setup([{ kind: 'tool' }, { kind: 'llm', point: 'after' }]);
    expect(await reasonOf(viewer, session.gate('before', TOOL), 1)).toBe('breakpoint');
    expect(await reasonOf(viewer, session.gate('after', LLM), 2)).toBe('breakpoint');
  });

  it('pause-on-error (a breakpoint at the error point) -> error', async () => {
    const { viewer, session } = await setup([{ point: 'error' }]);
    expect(await reasonOf(viewer, session.gate('error', TOOL), 1)).toBe('error');
  });

  it('step mode -> step at before, error at an error point', async () => {
    const { viewer, session } = await setup([], 'step');
    expect(await reasonOf(viewer, session.gate('before', TOOL), 1)).toBe('step');
    expect(await reasonOf(viewer, session.gate('error', LLM), 2)).toBe('error');
  });

  it('step mode and a matching breakpoint -> breakpoint', async () => {
    const { viewer, session } = await setup([{ kind: 'tool', name: 'search' }], 'step');
    expect(await reasonOf(viewer, session.gate('before', TOOL), 1)).toBe('breakpoint');
    expect(await reasonOf(viewer, session.gate('before', LLM), 2)).toBe('step');
  });

  it('a breakpoint set live, then step mode set live', async () => {
    const { viewer, session } = await setup([]);
    viewer.setBreakpoint({ kind: 'llm' });
    viewer.setMode('step');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await reasonOf(viewer, session.gate('before', LLM), 1)).toBe('breakpoint');
    expect(await reasonOf(viewer, session.gate('before', TOOL), 2)).toBe('step');
  });

  it('a loop hold -> loop; a smart hold -> breakpoint + smart', async () => {
    const { viewer, session } = await setup([]);
    for (let i = 0; i < 3; i += 1) {
      session.emit('node.started', { ...TOOL, instanceId: `i${i}`, input: { q: 1 } });
      const gate = session.gate('before', TOOL);
      if (i < 2) await gate;
      else expect(await reasonOf(viewer, gate, 1)).toBe('loop');
    }
    const smart = session.gate('after', TOOL, { result: { isError: true } });
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused' && viewer.ofType('exec.paused').indexOf(f) === 1);
    expect(paused.payload).toMatchObject({ reason: 'breakpoint', smart: { rule: 'error-result' } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await smart;
  });
});
