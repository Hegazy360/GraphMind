/**
 * A sanitised export must not carry `exec.paused.loop.fingerprint`: it is an
 * unsalted digest of the node's WHOLE input, so once a secret has been removed
 * from that input the digest plus the rest of the export gives the secret
 * back to anyone with a dictionary (the W5 verifier recovered `hunter2` from
 * five guesses). `--no-redact-secrets` exports everything as recorded anyway.
 */
import { describe, expect, it } from 'vitest';
import { fingerprintCall } from '@graphmind-ai/client';
import { REDACTED, redactStoredEvents } from '../src/redact-secrets.js';
import type { StoredEvent } from '../src/storage.js';

const INPUT = { user: 'alice', password: 'hunter2' };
const NODE = 'tool:login';

function run(): StoredEvent[] {
  const fingerprint = fingerprintCall(NODE, INPUT);
  const base = { gm: 1, runId: 'run_1', ts: 1 };
  return [
    { ...base, seq: 1, type: 'node.started', payload: { nodeId: NODE, kind: 'tool', name: 'login', instanceId: 'i1', input: INPUT } },
    { ...base, seq: 2, type: 'node.started', payload: { nodeId: NODE, kind: 'tool', name: 'login', instanceId: 'i2', input: INPUT } },
    { ...base, seq: 3, type: 'node.started', payload: { nodeId: NODE, kind: 'tool', name: 'login', instanceId: 'i3', input: INPUT } },
    {
      ...base,
      seq: 4,
      type: 'exec.paused',
      payload: { pauseId: 'p1', nodeId: NODE, point: 'before', reason: 'loop', loop: { repeats: 3, firstSeq: 1, lastSeq: 3, fingerprint } },
    },
  ] as unknown as StoredEvent[];
}

describe('graphmind record drops the loop fingerprint', () => {
  it('the exported fingerprint is the placeholder, and a dictionary attack against the export finds nothing', () => {
    const { events } = redactStoredEvents(run());
    const text = JSON.stringify(events);
    expect(text).not.toContain('hunter2');
    const paused = events.find((e) => e.type === 'exec.paused')!;
    const loop = (paused.payload as { loop: Record<string, unknown> }).loop;
    expect(loop['fingerprint']).toBe(REDACTED);
    // What survives is what the viewer uses.
    expect(loop).toMatchObject({ repeats: 3, firstSeq: 1, lastSeq: 3 });

    // The attack: rebuild the input from the export with each guess and hash it.
    const exported = (events[0]!.payload as { input: Record<string, unknown> }).input;
    const recovered = ['password', '123456', 'letmein', 'hunter2', 'qwerty'].find(
      (guess) => fingerprintCall(NODE, { ...exported, password: guess }) === loop['fingerprint'],
    );
    expect(recovered).toBeUndefined();
  });

  it('the original digest really was attackable (the test is not vacuous)', () => {
    const original = run().find((e) => e.type === 'exec.paused')!;
    const fp = (original.payload as { loop: { fingerprint: string } }).loop.fingerprint;
    const recovered = ['password', '123456', 'letmein', 'hunter2', 'qwerty'].find(
      (guess) => fingerprintCall(NODE, { user: 'alice', password: guess }) === fp,
    );
    expect(recovered).toBe('hunter2');
  });

  it('the fingerprint is not counted as a redacted secret, and a second pass changes nothing', () => {
    const first = redactStoredEvents(run());
    expect(first.count).toBe(3); // the three `password` values
    const second = redactStoredEvents(first.events);
    expect(second.count).toBe(0);
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
  });

  it('events without a loop, or with a malformed one, pass through untouched', () => {
    const base = { gm: 1, runId: 'r', ts: 1, type: 'exec.paused' };
    for (const payload of [{ pauseId: 'p', nodeId: 'n', point: 'error' }, { pauseId: 'p', loop: null }, { pauseId: 'p', loop: ['x'] }, null]) {
      const event = { ...base, seq: 9, payload } as unknown as StoredEvent;
      expect(redactStoredEvents([event]).events[0]).toBe(event);
    }
  });
});
