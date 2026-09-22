/**
 * Redaction coverage for the two debugger events that carry input-shaped
 * values (contract C2): `exec.resumed.edited.after` is hidden exactly when the
 * paused node's input is (HIDE_INPUTS; HIDE_TOOL_ARGS on a tool), and
 * `exec.refused.message` is omitted under the same switches. Unit-level on
 * the Redactor (including its failed forms), then end to end through a live
 * session for every switch, from env and from options.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope, type EventPayloadMap, type NodeKind } from '@graphmind-ai/schema';
import {
  NO_REDACTION,
  REDACTED,
  Redactor,
  type RedactionSwitches,
} from '../src/redaction.js';
import { createSession, type GateNode, type SessionOptions } from '../src/index.js';
import { FakeViewer, waitUntil } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const CANARY = 'EDIT-CANARY-5e1f0';

function redactor(switches: Partial<RedactionSwitches>, warn?: (key: string, message: string) => void): Redactor {
  return new Redactor({ ...NO_REDACTION, ...switches }, undefined, warn);
}

const RESUMED: EventPayloadMap['exec.resumed'] = {
  pauseId: 'pause_1',
  action: 'continue',
  edited: { after: { q: CANARY } },
  requestId: 'req-1',
};
const REFUSED: EventPayloadMap['exec.refused'] = {
  pauseId: 'pause_1',
  code: 'schema',
  message: `q must not be ${CANARY}`,
  requestId: 'req-1',
};

describe('Redactor — exec.resumed / exec.refused', () => {
  const cases: [string, Partial<RedactionSwitches>, NodeKind | undefined, boolean][] = [
    ['HIDE_INPUTS on a tool', { hideInputs: true }, 'tool', true],
    ['HIDE_INPUTS on an llm', { hideInputs: true }, 'llm', true],
    ['HIDE_TOOL_ARGS on a tool', { hideToolArgs: true }, 'tool', true],
    ['HIDE_TOOL_ARGS on an llm', { hideToolArgs: true }, 'llm', false],
    ['HIDE_TOOL_ARGS, kind unknown (counts as a tool)', { hideToolArgs: true }, undefined, true],
    ['HIDE_OUTPUTS on a tool', { hideOutputs: true }, 'tool', false],
    ['HIDE_TOOL_RESULTS on a tool', { hideToolResults: true }, 'tool', false],
    ['every switch off', {}, 'tool', false],
  ];

  it.each(cases)('%s', (_label, switches, kind, covered) => {
    const r = redactor(switches);
    const resumed = r.apply('exec.resumed', RESUMED, 'run_1', kind);
    const refused = r.apply('exec.refused', REFUSED, 'run_1', kind);
    if (!covered) {
      // Not covered: the very same objects, nothing copied.
      expect(resumed).toBe(RESUMED);
      expect(refused).toBe(REFUSED);
      return;
    }
    expect(resumed).toEqual({
      pauseId: 'pause_1',
      action: 'continue',
      edited: { after: REDACTED },
      requestId: 'req-1',
      redaction: { count: 1, keys: ['edited'] },
    });
    expect(refused).toEqual({
      pauseId: 'pause_1',
      code: 'schema',
      requestId: 'req-1',
      redaction: { count: 1, keys: ['message'] },
    });
    expect(JSON.stringify([resumed, refused])).not.toContain(CANARY);
    // The adapter's objects are never modified.
    expect(RESUMED.edited).toEqual({ after: { q: CANARY } });
    expect(REFUSED.message).toContain(CANARY);
    for (const [type, payload] of [['exec.resumed', resumed], ['exec.refused', refused]] as const) {
      expect(parseEnvelope({ gm: 1, seq: 0, ts: 1, runId: 'run_1', type, payload }).kind).toBe('ok');
    }
  });

  it('a covered answer with nothing to hide is left as it is (no summary)', () => {
    const r = redactor({ hideInputs: true });
    expect(r.apply('exec.resumed', { pauseId: 'p', action: 'abort' }, 'run_1', 'tool')).toEqual({
      pauseId: 'p',
      action: 'abort',
    });
    expect(r.apply('exec.refused', { pauseId: 'p', code: 'disabled' }, 'run_1', 'tool')).toEqual({
      pauseId: 'p',
      code: 'disabled',
    });
  });

  it('an edit already hidden is left alone and not counted; a prior summary is merged', () => {
    const r = redactor({ hideInputs: true });
    const hidden = { pauseId: 'p', action: 'continue' as const, edited: { after: REDACTED } };
    expect(r.apply('exec.resumed', hidden, 'run_1', 'tool')).toEqual(hidden);
    const withPrior = { ...RESUMED, redaction: { count: 2, keys: ['other'] } };
    expect(r.apply('exec.resumed', withPrior, 'run_1', 'tool')).toMatchObject({
      redaction: { count: 3, keys: ['other', 'edited'] },
    });
  });

  it('extra fields inside `edited` are dropped with it (only `after` survives, as the placeholder)', () => {
    const r = redactor({ hideInputs: true });
    const out = r.apply('exec.resumed', { ...RESUMED, edited: { after: 1, before: CANARY } }, 'run_1', 'tool');
    expect(out).toMatchObject({ edited: { after: REDACTED } });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  describe('fails closed', () => {
    it('exec.resumed whose `edited` getter throws: failed form, edit hidden, identity kept', () => {
      const warnings: string[] = [];
      const r = redactor({ hideToolArgs: true }, (key) => warnings.push(key));
      const hostile = {
        pauseId: 'pause_9',
        action: 'retry',
        requestId: 'rq',
        get edited(): unknown {
          throw new Error(CANARY);
        },
      };
      const out = r.apply('exec.resumed', hostile as never, 'run_1', 'tool');
      expect(out).toEqual({
        pauseId: 'pause_9',
        action: 'retry',
        edited: { after: REDACTED },
        requestId: 'rq',
        redaction: { count: 0, keys: ['edited'], failed: true },
      });
      expect(warnings).toEqual(['redaction:failed']);
      expect(parseEnvelope({ gm: 1, seq: 0, ts: 1, runId: 'r', type: 'exec.resumed', payload: out }).kind).toBe('ok');
    });

    it('exec.refused with a non-string pauseId (a String object): the failed form cannot be built -> dropped', () => {
      const warnings: string[] = [];
      const r = redactor({ hideInputs: true }, (key) => warnings.push(key));
      const out = r.apply('exec.refused', { ...REFUSED, pauseId: new String('pause_1') } as never, 'run_1', 'tool');
      expect(out).toBeUndefined();
      expect(warnings).toEqual(['redaction:dropped']);
    });

    it('exec.refused whose message getter throws: failed form without a message', () => {
      const r = redactor({ hideInputs: true });
      const hostile = {
        pauseId: 'pause_2',
        code: 'schema',
        get message(): string {
          throw new Error('x');
        },
      };
      expect(r.apply('exec.refused', hostile as never, 'run_1', 'tool')).toEqual({
        pauseId: 'pause_2',
        code: 'schema',
        redaction: { count: 0, keys: ['message'], failed: true },
      });
    });

    it('invalid action / code in a hostile payload: dropped', () => {
      const r = redactor({ hideInputs: true });
      const throwing = (fields: Record<string, unknown>) =>
        new Proxy(fields, {
          ownKeys() {
            throw new Error('x');
          },
        });
      expect(r.apply('exec.resumed', throwing({ pauseId: 'p', action: 'explode' }) as never, 'r', 'tool')).toBeUndefined();
      expect(r.apply('exec.refused', throwing({ pauseId: 'p', code: 'nope' }) as never, 'r', 'tool')).toBeUndefined();
      expect(r.apply('exec.resumed', 'not an object' as never, 'r', 'tool')).toBeUndefined();
    });

    it('never throws', () => {
      const r = redactor({ hideInputs: true });
      const evil = new Proxy(
        {},
        {
          get() {
            throw new Error('x');
          },
          ownKeys() {
            throw new Error('x');
          },
          has() {
            throw new Error('x');
          },
        },
      );
      expect(() => r.apply('exec.resumed', evil as never, 'r', 'tool')).not.toThrow();
      expect(() => r.apply('exec.refused', evil as never, 'r', 'tool')).not.toThrow();
    });
  });
});

describe('redaction of edits through a live session', () => {
  const TOOL: GateNode = { nodeId: 'tool:search', kind: 'tool', name: 'search' };
  const LLM: GateNode = { nodeId: 'llm:step', kind: 'llm', name: 'step' };

  const cases: [string, SessionOptions, GateNode, boolean][] = [
    ['GRAPHMIND_HIDE_INPUTS, tool', { env: { GRAPHMIND_HIDE_INPUTS: '1' } }, TOOL, true],
    ['GRAPHMIND_HIDE_INPUTS=yes, llm', { env: { GRAPHMIND_HIDE_INPUTS: 'yes' } }, LLM, true],
    ['hideInputs option, tool', { hideInputs: true }, TOOL, true],
    ['GRAPHMIND_HIDE_TOOL_ARGS, tool', { env: { GRAPHMIND_HIDE_TOOL_ARGS: 'on' } }, TOOL, true],
    ['hideToolArgs option, tool', { hideToolArgs: true }, TOOL, true],
    ['GRAPHMIND_HIDE_TOOL_ARGS, llm (not covered)', { env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' } }, LLM, false],
    ['GRAPHMIND_HIDE_OUTPUTS, tool (not covered)', { env: { GRAPHMIND_HIDE_OUTPUTS: '1' } }, TOOL, false],
    ['GRAPHMIND_HIDE_TOOL_RESULTS, tool (not covered)', { env: { GRAPHMIND_HIDE_TOOL_RESULTS: '1' } }, TOOL, false],
    ['no switch', { env: {} }, TOOL, false],
  ];

  it.each(cases)('%s', async (_label, sessionOptions, node, covered) => {
    const viewer = await FakeViewer.start({ hubCapabilities: ['edit-input'], breakpoints: [{}] });
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {}, ...sessionOptions });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);

    let calls = 0;
    const gate = session.gate('before', node, {
      editable: true,
      validateInput: (proposed) => {
        calls += 1;
        return calls === 1
          ? { ok: false, code: 'schema', message: `rejected ${CANARY}` }
          : { ok: true, value: proposed };
      },
    });
    const paused = await viewer.waitForType('exec.paused');
    const pauseId = paused.payload['pauseId'] as string;
    expect(paused.payload['editable']).toBe(true);
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: CANARY } });
    const refused = await viewer.waitForType('exec.refused');
    viewer.resumeWith({ pauseId, action: 'continue', input: { q: CANARY } });
    const decision = await gate;
    // The host always runs with the real edit.
    expect(decision).toEqual({ action: 'continue', input: { q: CANARY } });
    const resumed = await viewer.waitForType('exec.resumed');

    if (covered) {
      expect(refused.payload).toEqual({ pauseId, code: 'schema', redaction: { count: 1, keys: ['message'] } });
      expect(resumed.payload).toEqual({
        pauseId,
        action: 'continue',
        edited: { after: REDACTED },
        redaction: { count: 1, keys: ['edited'] },
      });
      expect(JSON.stringify(viewer.received)).not.toContain(CANARY);
    } else {
      expect(refused.payload).toEqual({ pauseId, code: 'schema', message: `rejected ${CANARY}` });
      expect(resumed.payload).toEqual({ pauseId, action: 'continue', edited: { after: { q: CANARY } } });
    }
    for (const frame of viewer.received) expect(parseEnvelope(frame).kind).toBe('ok');
  });

  it('frames replayed on attach are already redacted', async () => {
    const viewer = await FakeViewer.start({ hubCapabilities: ['edit-input'], breakpoints: [{}] });
    cleanups.push(() => viewer.close());
    const session = createSession({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 60_000,
      env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' },
    });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    const gate = session.gate('before', TOOL, { editable: true });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resumeWith({ pauseId: paused.payload['pauseId'] as string, action: 'continue', input: { q: CANARY } });
    await gate;
    await viewer.waitForType('exec.resumed');
    viewer.dropConnections();
    await waitUntil(() => viewer.connectionCount === 2 && session.attached, 5000, 're-attach');
    await waitUntil(() => viewer.ofType('exec.resumed').length === 2, 5000, 'replay');
    expect(JSON.stringify(viewer.received)).not.toContain(CANARY);
  });
});
