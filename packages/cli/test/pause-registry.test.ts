/**
 * The pause registry on its own (contract C3), plus the one hub path that
 * needs a socket double: a resume whose send never left must not leave the
 * pause `resolving`.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope, serializeEnvelope, type ResumeAction } from '@graphmind-ai/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { Hub } from '../src/hub.js';
import { PauseRegistry, type PauseInfo, type ResumeOutcome } from '../src/pause-registry.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

afterEach(() => {
  vi.useRealTimers();
});

const info = (pauseId: string, runId = 'r1'): Omit<PauseInfo, 'state'> => ({
  runId,
  pauseId,
  nodeId: 'tool:x',
  point: 'before',
  since: 1,
});

function begin(
  registry: PauseRegistry<string>,
  pauseId: string,
  extra: { runId?: string; requestId?: string; owner?: string; principal?: 'viewer' | 'agent' | 'anonymous'; action?: ResumeAction } = {},
) {
  return registry.begin({
    runId: extra.runId ?? 'r1',
    pauseId,
    principal: extra.principal ?? 'viewer',
    operator: undefined,
    requestId: extra.requestId,
    owner: extra.owner ?? 'app',
    ...(extra.action === undefined ? {} : { action: extra.action }),
  });
}

describe('PauseRegistry lifecycle', () => {
  it('opens, lists oldest first, and closes on resumed / run finished / owner gone', () => {
    const registry = new PauseRegistry<string>();
    registry.open('app', { ...info('p2'), since: 20 });
    registry.open('app', { ...info('p1'), since: 10 });
    registry.open('other', { ...info('q1', 'r2'), since: 30 });
    expect(registry.list().map((p) => p.pauseId)).toEqual(['p1', 'p2', 'q1']);
    expect(registry.list('r2').map((p) => p.pauseId)).toEqual(['q1']);
    expect(registry.get('r1', 'p1')?.state).toBe('open');

    registry.resumed('r1', 'p1', undefined);
    expect(registry.get('r1', 'p1')).toBeUndefined();
    expect(registry.isKnownClosed('r1', 'p1')).toBe(true);

    registry.closeRun('r1');
    expect(registry.get('r1', 'p2')).toBeUndefined();
    expect(registry.isKnownClosed('r1', 'p2')).toBe(true);

    registry.closeOwner('other');
    expect(registry.list()).toEqual([]);
    expect(registry.countFor('app')).toBe(0);
    expect(registry.countFor('other')).toBe(0);
  });

  it('keys on (runId, pauseId): the same pause id in two runs is two entries', () => {
    const registry = new PauseRegistry<string>();
    registry.open('a', info('p1', 'run-a'));
    registry.open('b', info('p1', 'run-b'));
    registry.resumed('run-a', 'p1', undefined);
    expect(registry.get('run-b', 'p1')?.state).toBe('open');
    expect(registry.isKnownClosed('run-b', 'p1')).toBe(false);
  });

  it('caps open entries per owner', () => {
    const registry = new PauseRegistry<string>({ maxPerOwner: 3 });
    for (const id of ['p1', 'p2', 'p3']) expect(registry.open('app', info(id))).toBe(true);
    expect(registry.open('app', info('p4'))).toBe(false);
    expect(registry.open('other', info('q1', 'r2'))).toBe(true);
    registry.resumed('r1', 'p1', undefined);
    expect(registry.open('app', info('p4'))).toBe(true);
    expect(registry.countFor('app')).toBe(3);
  });

  it('a re-open of the same key replaces the entry without double-counting', () => {
    const registry = new PauseRegistry<string>({ maxPerOwner: 2 });
    registry.open('app', info('p1'));
    registry.open('app', info('p1'));
    expect(registry.countFor('app')).toBe(1);
    expect(registry.list()).toHaveLength(1);
  });
});

describe('first writer wins', () => {
  it('claims an open pause once; a second resume is taken; a closed one is closed; an unknown one is forwarded', () => {
    const registry = new PauseRegistry<string>();
    registry.open('app', info('p1'));
    const first = begin(registry, 'p1', { requestId: 'req-1' });
    expect(first).toEqual({ kind: 'claimed', requestId: 'req-1' });
    expect(registry.get('r1', 'p1')?.state).toBe('resolving');
    expect(begin(registry, 'p1')).toEqual({ kind: 'taken' });
    registry.resumed('r1', 'p1', 'req-1');
    expect(begin(registry, 'p1')).toEqual({ kind: 'closed' });
    const unknown = begin(registry, 'never-seen');
    expect(unknown.kind).toBe('unknown');
  });

  it('mints a requestId when none (or an unusable or duplicate one) is given', () => {
    const registry = new PauseRegistry<string>();
    registry.open('app', info('p1'));
    registry.open('app', info('p2'));
    const minted = begin(registry, 'p1', { requestId: 'bad id with spaces' });
    expect(minted.kind === 'claimed' && minted.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const dup = begin(registry, 'p2', { requestId: minted.kind === 'claimed' ? minted.requestId : '' });
    expect(dup.kind === 'claimed' && dup.requestId).not.toBe(minted.kind === 'claimed' ? minted.requestId : '');
  });

  it('exec.refused reopens a resolving entry and answers the request as refused', () => {
    const registry = new PauseRegistry<string>();
    registry.open('app', info('p1'));
    const claim = begin(registry, 'p1', { requestId: 'r-1' });
    const outcomes: ResumeOutcome[] = [];
    registry.whenAnswered('r-1', (o) => outcomes.push(o));
    expect(claim.kind).toBe('claimed');
    registry.refused('r1', 'p1', 'r-1', 'schema', 'bad arg');
    expect(registry.get('r1', 'p1')?.state).toBe('open');
    expect(outcomes).toEqual([
      { outcome: 'refused', runId: 'r1', pauseId: 'p1', requestId: 'r-1', code: 'schema', message: 'bad arg' },
    ]);
    // Reopened: the next resume claims it again.
    expect(begin(registry, 'p1').kind).toBe('claimed');
  });

  it('a resolving entry reopens after the resolving timeout; the slow request stays pending when another claims it', () => {
    vi.useFakeTimers();
    const registry = new PauseRegistry<string>({ resolvingTimeoutMs: 5_000 });
    registry.open('app', info('p1'));
    begin(registry, 'p1', { requestId: 'slow' });
    const outcomes: ResumeOutcome[] = [];
    registry.whenAnswered('slow', (o) => outcomes.push(o), 60_000);
    vi.advanceTimersByTime(4_999);
    expect(registry.get('r1', 'p1')?.state).toBe('resolving');
    vi.advanceTimersByTime(1);
    expect(registry.get('r1', 'p1')?.state).toBe('open');
    expect(begin(registry, 'p1', { requestId: 'fast' }).kind).toBe('claimed');
    // Nobody has answered yet: the app's real answer decides who won.
    expect(outcomes).toEqual([]);
  });

  it('a late answer echoing the slow request credits IT (resumed), and the one that claimed the reopened pause is superseded', () => {
    vi.useFakeTimers();
    const registry = new PauseRegistry<string>({ resolvingTimeoutMs: 5_000 });
    registry.open('app', info('p1'));
    begin(registry, 'p1', { requestId: 'agent-abort', principal: 'agent', action: 'abort' });
    vi.advanceTimersByTime(5_001);
    begin(registry, 'p1', { requestId: 'viewer-continue', principal: 'viewer', action: 'continue' });
    const outcomes: ResumeOutcome[] = [];
    registry.whenAnswered('agent-abort', (o) => outcomes.push(o), 60_000);
    registry.whenAnswered('viewer-continue', (o) => outcomes.push(o), 60_000);
    expect(registry.attribution('r1', 'p1', 'agent-abort', true)).toMatchObject({ principal: 'agent' });
    registry.resumed('r1', 'p1', 'agent-abort', true);
    expect(outcomes.map((o) => [o.requestId, o.outcome, o.code ?? null, o.principal ?? null])).toEqual([
      ['agent-abort', 'resumed', null, 'agent'],
      ['viewer-continue', 'taken', 'superseded', null],
    ]);
  });

  it('a late exec.refused for the slow request reopens the pause (the gate is held) and answers only that request', () => {
    vi.useFakeTimers();
    const registry = new PauseRegistry<string>({ resolvingTimeoutMs: 5_000 });
    registry.open('app', info('p1'));
    begin(registry, 'p1', { requestId: 'agent-edit', principal: 'agent', action: 'continue' });
    vi.advanceTimersByTime(5_001);
    begin(registry, 'p1', { requestId: 'viewer-continue', action: 'continue' });
    expect(registry.get('r1', 'p1')?.state).toBe('resolving');
    const outcomes: ResumeOutcome[] = [];
    registry.whenAnswered('agent-edit', (o) => outcomes.push(o), 60_000);
    registry.whenAnswered('viewer-continue', (o) => outcomes.push(o), 60_000);
    registry.refused('r1', 'p1', 'agent-edit', 'schema', 'nope');
    expect(registry.get('r1', 'p1')?.state).toBe('open');
    expect(outcomes.map((o) => [o.requestId, o.outcome, o.code])).toEqual([['agent-edit', 'refused', 'schema']]);
  });

  it('an old client (no echo) answering late is credited by the action it applied, never to a request that asked for another', () => {
    vi.useFakeTimers();
    const registry = new PauseRegistry<string>({ resolvingTimeoutMs: 5_000 });
    registry.open('app', info('p1'));
    begin(registry, 'p1', { requestId: 'r1-abort', principal: 'agent', action: 'abort' });
    vi.advanceTimersByTime(5_001);
    begin(registry, 'p1', { requestId: 'r2-continue', principal: 'viewer', action: 'continue' });
    const outcomes: ResumeOutcome[] = [];
    registry.whenAnswered('r1-abort', (o) => outcomes.push(o), 60_000);
    registry.whenAnswered('r2-continue', (o) => outcomes.push(o), 60_000);
    // The app applied the abort it read first and answered without a requestId.
    expect(registry.attribution('r1', 'p1', undefined, false, 'abort')).toMatchObject({ principal: 'agent', requestId: 'r1-abort' });
    registry.resumed('r1', 'p1', undefined, false, 'abort');
    expect(outcomes.map((o) => [o.requestId, o.outcome, o.code ?? null])).toEqual([
      ['r1-abort', 'resumed', null],
      ['r2-continue', 'taken', 'superseded'],
    ]);

    // No request asked for what the app did: credited to nobody.
    registry.open('app', info('p2'));
    begin(registry, 'p2', { requestId: 'r3-continue', action: 'continue' });
    expect(registry.attribution('r1', 'p2', undefined, false, 'abort')).toBeUndefined();
    const late: ResumeOutcome[] = [];
    registry.whenAnswered('r3-continue', (o) => late.push(o));
    registry.resumed('r1', 'p2', undefined, false, 'abort');
    expect(late).toMatchObject([{ outcome: 'taken', code: 'superseded' }]);
  });

  it('resumes to pauses it never saw cannot evict a pending request for a pause it holds', () => {
    const registry = new PauseRegistry<string>();
    registry.open('app', info('p1'));
    expect(begin(registry, 'p1', { requestId: 'agent-edit', principal: 'agent' })).toEqual({ kind: 'claimed', requestId: 'agent-edit' });
    const outcomes: ResumeOutcome[] = [];
    registry.whenAnswered('agent-edit', (o) => outcomes.push(o), 60_000);
    for (let i = 0; i < 1_001; i += 1) {
      registry.begin({ runId: 'r1', pauseId: `ghost-${i}`, principal: 'anonymous', operator: undefined, requestId: undefined, owner: 'app' });
    }
    expect(outcomes).toEqual([]);
    expect(registry.attribution('r1', 'p1', 'agent-edit', true)).toMatchObject({ principal: 'agent' });
    registry.dispose();
  });

  it('knows when the request a pause is resolving on was already answered timeout (its caller gave up)', () => {
    vi.useFakeTimers();
    const registry = new PauseRegistry<string>({ resolvingTimeoutMs: 5_000 });
    registry.open('app', info('p1'));
    registry.begin({ runId: 'r1', pauseId: 'p1', principal: 'agent', operator: undefined, requestId: 'short', owner: 'app', deadlineMs: 1_000 });
    expect(registry.resolvingUnanswered('r1', 'p1')).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(registry.get('r1', 'p1')?.state).toBe('resolving');
    expect(registry.resolvingUnanswered('r1', 'p1')).toBe(false);
    vi.advanceTimersByTime(4_000);
    expect(registry.get('r1', 'p1')?.state).toBe('open');
  });

  it('attributes an answer by echoed requestId, or (legacy client) to the request resolving that pause', () => {
    const registry = new PauseRegistry<string>();
    registry.open('app', info('p1'));
    registry.open('app', info('p2'));
    registry.begin({ runId: 'r1', pauseId: 'p1', principal: 'agent', operator: 'bot', requestId: 'a-1', owner: 'app' });
    registry.begin({ runId: 'r1', pauseId: 'p2', principal: 'viewer', operator: undefined, requestId: 'v-1', owner: 'app' });
    expect(registry.attribution('r1', 'p1', 'a-1')).toEqual({ principal: 'agent', operator: 'bot', requestId: 'a-1' });
    expect(registry.attribution('r1', 'p2', undefined)).toEqual({ principal: 'viewer', requestId: 'v-1' });
    // An echoed id only counts for the pause it was issued for.
    expect(registry.attribution('r1', 'p2', 'a-1')).toBeUndefined();
    expect(registry.attribution('other-run', 'p1', 'a-1')).toBeUndefined();
  });

  it('owner disconnect and run finish answer every waiter', () => {
    const registry = new PauseRegistry<string>();
    registry.open('app', info('p1'));
    registry.open('app', info('p2', 'r2'));
    begin(registry, 'p1', { requestId: 'x1' });
    begin(registry, 'p2', { runId: 'r2', requestId: 'x2' });
    const outcomes: ResumeOutcome[] = [];
    registry.whenAnswered('x1', (o) => outcomes.push(o));
    registry.whenAnswered('x2', (o) => outcomes.push(o));
    registry.closeRun('r2');
    registry.closeOwner('app');
    expect(outcomes.map((o) => [o.requestId, o.outcome, o.code])).toEqual([
      ['x2', 'no-such-pause', 'run-finished'],
      ['x1', 'timeout', 'app-disconnected'],
    ]);
  });

  it('a request nobody answers settles as timeout at its deadline; dispose answers the rest', () => {
    vi.useFakeTimers();
    const registry = new PauseRegistry<string>({ resolvingTimeoutMs: 60_000 });
    registry.open('app', info('p1'));
    registry.open('app', info('p2'));
    registry.begin({ runId: 'r1', pauseId: 'p1', principal: 'viewer', operator: undefined, requestId: 'd1', owner: 'app', deadlineMs: 2_000 });
    registry.begin({ runId: 'r1', pauseId: 'p2', principal: 'viewer', operator: undefined, requestId: 'd2', owner: 'app', deadlineMs: 50_000 });
    const outcomes: ResumeOutcome[] = [];
    registry.whenAnswered('d1', (o) => outcomes.push(o));
    registry.whenAnswered('d2', (o) => outcomes.push(o));
    vi.advanceTimersByTime(2_000);
    expect(outcomes.map((o) => [o.requestId, o.outcome, o.code])).toEqual([['d1', 'timeout', 'no-answer']]);
    registry.dispose();
    expect(outcomes.map((o) => [o.requestId, o.code])).toEqual([
      ['d1', 'no-answer'],
      ['d2', 'server-closing'],
    ]);
  });

  it('whenAnswered on an already-settled request answers at once', () => {
    const registry = new PauseRegistry<string>();
    registry.open('app', info('p1'));
    begin(registry, 'p1', { requestId: 'done' });
    registry.resumed('r1', 'p1', 'done');
    const seen: string[] = [];
    registry.whenAnswered('done', (o) => seen.push(o.outcome));
    expect(seen).toEqual(['resumed']);
  });
});

/** Just enough of a `ws` WebSocket for the hub. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: string[] = [];
  failNextSend: Error | undefined;
  send(data: string, cb?: (error?: Error) => void): void {
    this.sent.push(data);
    const failure = this.failNextSend;
    this.failNextSend = undefined;
    if (cb !== undefined) queueMicrotask(() => cb(failure));
  }
  ping(): void {}
  terminate(): void {}
  close(): void {}
}

describe('hub: a resume that never reached the app does not wedge the pause', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'graphmind-hub-send-'));
    const storage = new SqliteStorage(join(dir, 'g.db'));
    const hub = new Hub(storage, () => {});
    const socket = new FakeSocket();
    hub.addIngestSocket(socket as unknown as WebSocket);
    let seq = 0;
    const frame = (type: string, runId: string, payload: unknown): void => {
      socket.emit('message', Buffer.from(serializeEnvelope(createEnvelope({ type: type as 'hello', runId, seq: seq++, payload: payload as never }))), false);
    };
    frame('hello', '*', { versions: { protocol: 1, client: 't' }, capabilities: ['pause', 'edit-input'] });
    frame('run.started', 'r1', { app: 'a', sdk: { name: 't', version: '0' } });
    frame('exec.paused', 'r1', { pauseId: 'p1', nodeId: 'tool:x', point: 'before' });
    return { hub, socket, storage };
  }

  it('hello.ack carries hubCapabilities (pause-registry, edit-input)', () => {
    const { socket, storage } = setup();
    const ack = JSON.parse(socket.sent[0] as string) as { type: string; payload: { hubCapabilities?: string[] } };
    expect(ack.type).toBe('hello.ack');
    expect(ack.payload.hubCapabilities).toEqual(['pause-registry', 'edit-input']);
    storage.close();
  });

  it('a closing socket: the send is refused, the pause stays open, the resumer hears why', () => {
    const { hub, socket, storage } = setup();
    socket.readyState = 2; // CLOSING: `ws` would silently drop the frame
    const start = hub.requestResume('r1', { pauseId: 'p1', action: 'continue' }, 'viewer');
    expect(start.kind).toBe('answered');
    // The same answer a disconnect a moment later gives (closeOwner), as
    // documented: timeout / app-disconnected (202, CLI exit 2) — never a
    // timing-dependent 404.
    expect(start.kind === 'answered' && start.outcome).toMatchObject({ outcome: 'timeout', code: 'app-disconnected' });
    expect(hub.registry.get('r1', 'p1')?.state).toBe('open');
    storage.close();
  });

  it('a send that fails after leaving: the pause reopens and the request is answered', async () => {
    const { hub, socket, storage } = setup();
    socket.failNextSend = new Error('EPIPE');
    const start = hub.requestResume('r1', { pauseId: 'p1', action: 'continue' }, 'viewer');
    expect(start.kind).toBe('forwarded');
    expect(hub.registry.get('r1', 'p1')?.state).toBe('resolving');
    const outcome = await new Promise<ResumeOutcome>((resolve) => {
      hub.registry.whenAnswered(start.kind === 'forwarded' ? start.requestId : '', resolve);
    });
    expect(outcome).toMatchObject({ outcome: 'timeout', code: 'send-failed' });
    expect(hub.registry.get('r1', 'p1')?.state).toBe('open');
    storage.close();
  });
});
