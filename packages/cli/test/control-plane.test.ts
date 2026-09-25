/**
 * The control plane against a real server (contract C3): the pause registry's
 * lifecycle, first-writer-wins across viewer sockets and the HTTP endpoint,
 * the principal stamped on `exec.resumed`, credentials and levels, the edit
 * gates, and a real @graphmind-ai/client session receiving an edited input
 * through every surface.
 */
import { connect, createServer, type Server, type Socket } from 'node:net';
import { createSession, mergeToolInput, type GateDecision, type Session } from '@graphmind-ai/client';
import { TRUNCATION_SUFFIX, type MessagePayloadMap } from '@graphmind-ai/schema';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ControlLevel } from '../src/control-auth.js';
import type { ServerOptions } from '../src/server.js';
import type { UiServerMessage } from '../src/ui-protocol.js';
import { ALL_CAPABILITIES, getJson, heldApp, postResume, sleep } from './control-helpers.js';
import { FakeApp, FakeUI, startTestServer, waitUntil, type TestServer } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(options: ServerOptions = {}): Promise<TestServer> {
  const ts = await startTestServer(options);
  cleanups.push(() => ts.cleanup());
  return ts;
}

async function ui(ts: TestServer, token?: string): Promise<FakeUI> {
  const conn = await FakeUI.connect(ts.port, token === undefined ? {} : { token });
  cleanups.push(() => conn.close());
  return conn;
}

async function pauses(ts: TestServer, runId?: string): Promise<{ pauseId: string; state: string; runId: string }[]> {
  const result = await getJson(ts.port, `/api/pauses${runId === undefined ? '' : `?runId=${runId}`}`);
  return result.body.pauses;
}

async function waitForPause(ts: TestServer, pauseId: string, state = 'open', runId?: string): Promise<void> {
  await waitUntil(async () => (await pauses(ts, runId)).some((p) => p.pauseId === pauseId && p.state === state), `${pauseId} ${state}`);
}

async function storedResumed(ts: TestServer, runId: string): Promise<Record<string, unknown>[]> {
  const page = ts.server.storage.listEvents(runId);
  return page.events.filter((e) => e.type === 'exec.resumed').map((e) => e.payload as Record<string, unknown>);
}

function errorFrame(conn: FakeUI, label = 'ui error'): Promise<Extract<UiServerMessage, { type: 'error' }>> {
  return conn.next((m) => m.type === 'error', label) as Promise<Extract<UiServerMessage, { type: 'error' }>>;
}

describe('registry lifecycle', () => {
  it('opens on exec.paused with every C3 field, and closes on exec.resumed', async () => {
    const ts = await boot();
    const held = await heldApp(ts.port, { editable: true });
    await waitForPause(ts, 'p1');
    const [pause] = await pauses(ts);
    expect(pause).toMatchObject({
      runId: 'run-held',
      pauseId: 'p1',
      nodeId: 'tool:search',
      point: 'before',
      reason: 'breakpoint',
      editable: true,
      state: 'open',
      app: 'held-app',
    });
    expect(typeof (pause as unknown as { since: number }).since).toBe('number');
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'continue' });
    await waitUntil(async () => (await pauses(ts)).length === 0, 'closed');
    await held.app.close();
  });

  it('closes on run.finished', async () => {
    const ts = await boot();
    const held = await heldApp(ts.port);
    await waitForPause(ts, 'p1');
    held.app.send('run.finished', held.runId, { status: 'ok' });
    await waitUntil(async () => (await pauses(ts)).length === 0, 'closed by run.finished');
    await held.app.close();
  });

  it('closes on owner disconnect (the client released its gates), and a resume then gets no-such-pause', async () => {
    const ts = await boot();
    const held = await heldApp(ts.port);
    await waitForPause(ts, 'p1');
    await held.app.close();
    await waitUntil(async () => (await pauses(ts)).length === 0, 'closed by disconnect');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    viewer.control('exec.resume', held.runId, { pauseId: 'p1', action: 'continue' });
    const err = await errorFrame(viewer);
    expect(err.code).toBe('no-such-pause');
  });

  it('a reconnect that replays its buffer (same seq) neither duplicates nor reopens a pause', async () => {
    const ts = await boot();
    const app = await FakeApp.connect(ts.port, { app: 'replayer', capabilities: ALL_CAPABILITIES });
    const token = app.ack?.sessionToken as string;
    app.send('run.started', 'run-r', { app: 'replayer', sdk: { name: 't', version: '0' } }, 0);
    app.send('exec.paused', 'run-r', { pauseId: 'p1', nodeId: 'tool:x', point: 'before' }, 1);
    app.send('exec.resumed', 'run-r', { pauseId: 'p1', action: 'continue' }, 2);
    app.send('exec.paused', 'run-r', { pauseId: 'p2', nodeId: 'tool:x', point: 'before' }, 3);
    await waitForPause(ts, 'p2');
    await app.close();
    // The same client comes back with its token and replays everything.
    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/ingest`);
    await new Promise((resolve) => ws.once('open', resolve));
    const send = (type: string, seq: number, payload: unknown): void => {
      ws.send(JSON.stringify({ gm: 1, seq, ts: Date.now(), runId: type === 'hello' ? '*' : 'run-r', type, payload }));
    };
    send('hello', 100, { versions: { protocol: 1, client: 't' }, capabilities: ALL_CAPABILITIES, resumeToken: token });
    await sleep(100);
    send('exec.paused', 1, { pauseId: 'p1', nodeId: 'tool:x', point: 'before' });
    send('exec.paused', 3, { pauseId: 'p2', nodeId: 'tool:x', point: 'before' });
    await sleep(200);
    const listed = await pauses(ts);
    // p2 was closed by the disconnect and p1 by its resume: the replays are
    // duplicates (same seq) and change nothing.
    expect(listed).toEqual([]);
    expect(ts.server.hub.registry.isKnownClosed('run-r', 'p1')).toBe(true);
    ws.close();
  });

  it('keys on (runId, pauseId): two apps both holding "p1" are independent', async () => {
    const ts = await boot();
    const a = await heldApp(ts.port, { runId: 'run-a', answer: 'echo' });
    const b = await heldApp(ts.port, { runId: 'run-b', answer: 'echo' });
    await waitUntil(async () => (await pauses(ts)).length === 2, 'two pauses');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    viewer.control('exec.resume', 'run-a', { pauseId: 'p1', action: 'continue' });
    await waitUntil(async () => (await pauses(ts)).length === 1, 'one left');
    expect((await pauses(ts))[0]).toMatchObject({ runId: 'run-b', pauseId: 'p1', state: 'open' });
    expect(a.resumes).toHaveLength(1);
    expect(b.resumes).toHaveLength(0);
    await a.app.close();
    await b.app.close();
  });

  it('only frames that pass the run claim update it: a peer cannot open or close pauses in another run', async () => {
    const ts = await boot();
    const victim = await heldApp(ts.port, { runId: 'victim-run' });
    await waitForPause(ts, 'p1');
    const attacker = await FakeApp.connect(ts.port, { app: 'evil', capabilities: ALL_CAPABILITIES });
    attacker.send('exec.resumed', 'victim-run', { pauseId: 'p1', action: 'continue' });
    attacker.send('exec.paused', 'victim-run', { pauseId: 'evil-p', nodeId: 'tool:x', point: 'before' });
    attacker.send('run.finished', 'victim-run', { status: 'error' });
    await sleep(200);
    const listed = await pauses(ts);
    expect(listed.map((p) => p.pauseId)).toEqual(['p1']);
    await attacker.close();
    await victim.app.close();
  });

  it('a peer that writes 5,000 fresh run ids cannot push out a live run\'s claim and then take the run and its pause', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const victim = await heldApp(ts.port, { runId: 'victim-run' });
    await waitForPause(ts, 'p1');
    const attacker = await FakeApp.connect(ts.port, { app: 'evil', capabilities: ALL_CAPABILITIES });
    for (let i = 0; i < 5_001; i += 1) attacker.send('run.started', `flood-${i}`, { app: 'evil', sdk: { name: 'x', version: '0' } });
    await waitUntil(() => ts.server.storage.getRun('flood-5000') !== undefined, 'the flood stored', 20_000);
    // Now the attacker writes to the victim's run as if it were its own.
    attacker.send('exec.paused', 'victim-run', { pauseId: 'p1', nodeId: 'tool:x', point: 'before' });
    attacker.send('node.started', 'victim-run', { nodeId: 'tool:evil', kind: 'tool', name: 'evil', instanceId: 'e1' });
    await sleep(300);
    expect(ts.server.storage.listEvents('victim-run').events.some((e) => e.type === 'node.started' && (e.payload as { nodeId?: string }).nodeId === 'tool:evil')).toBe(false);
    // The victim still owns its run: its frames are stored, and a resume reaches IT.
    victim.app.send('node.started', 'victim-run', { nodeId: 'tool:later', kind: 'tool', name: 'later', instanceId: 'l1' });
    await waitUntil(
      () => ts.server.storage.listEvents('victim-run').events.some((e) => (e.payload as { nodeId?: string }).nodeId === 'tool:later'),
      'the victim\'s later frame stored',
    );
    const answer = await postResume(ts.port, 'victim-run', 'p1', { action: 'continue', timeoutMs: 5_000 }, ts.server.tokens.agent);
    expect(answer.body).toMatchObject({ outcome: 'resumed' });
    expect(victim.resumes.map((r) => r.pauseId)).toEqual(['p1']);
    await attacker.close();
    await victim.app.close();
  }, 30_000);

  it('caps open pauses per app connection at 1,000; a resume for an untracked pause is still forwarded', async () => {
    const ts = await boot();
    const held = await heldApp(ts.port, { answer: 'ignore' });
    for (let i = 2; i <= 1_001; i += 1) held.hold(`p${i}`);
    await waitUntil(async () => (await pauses(ts)).length === 1_000, '1000 pauses', 10_000);
    await sleep(100);
    expect(ts.server.hub.registry.get('run-held', 'p1001')).toBeUndefined();
    const viewer = await ui(ts, ts.server.tokens.viewer);
    viewer.control('exec.resume', held.runId, { pauseId: 'p1001', action: 'continue' });
    await waitUntil(() => held.resumes.some((r) => r.pauseId === 'p1001'), 'forwarded best-effort');
    await held.app.close();
  }, 30_000);
});

describe('first writer wins', () => {
  it('two viewer sockets: the first resume is forwarded, the second gets pause-taken', async () => {
    const ts = await boot();
    // A 0.5 client: no edit-input, never echoes requestId.
    const held = await heldApp(ts.port, { answer: 'ignore', capabilities: ['pause', 'inject', 'retry', 'abort', 'run-claim'] });
    await waitForPause(ts, 'p1');
    const one = await ui(ts, ts.server.tokens.viewer);
    const two = await ui(ts);
    one.control('exec.resume', held.runId, { pauseId: 'p1', action: 'continue' });
    await waitForPause(ts, 'p1', 'resolving');
    two.control('exec.resume', held.runId, { pauseId: 'p1', action: 'abort' });
    const err = await errorFrame(two);
    expect(err).toMatchObject({ code: 'pause-taken', runId: held.runId, pauseId: 'p1' });
    expect(held.resumes.map((r) => r.action)).toEqual(['continue']);
    // The app answers the winner (a legacy client, no requestId echo).
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'continue' });
    const result = await one.next((m) => m.type === 'resume.result', 'resume.result');
    expect(result).toMatchObject({ outcome: 'resumed', pauseId: 'p1' });
    await waitUntil(async () => (await storedResumed(ts, held.runId)).length === 1, 'stored');
    expect((await storedResumed(ts, held.runId))[0]).toMatchObject({ principal: 'viewer' });
    await held.app.close();
  });

  it('viewer vs HTTP: the HTTP request wins, the viewer is told, the store says "agent"', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' });
    await waitForPause(ts, 'p1');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    const http = postResume(ts.port, held.runId, 'p1', { action: 'continue', operator: 'claude' }, ts.server.tokens.agent);
    await waitUntil(() => held.resumes.length === 1, 'forwarded');
    viewer.control('exec.resume', held.runId, { pauseId: 'p1', action: 'abort' });
    expect((await errorFrame(viewer)).code).toBe('pause-taken');
    const forwarded = held.resumes[0] as MessagePayloadMap['exec.resume'];
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'continue', requestId: forwarded.requestId as string });
    const answer = await http;
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: 'resumed', principal: 'agent', requestId: forwarded.requestId });
    const [stored] = await storedResumed(ts, held.runId);
    expect(stored).toMatchObject({ principal: 'agent', operator: 'claude', requestId: forwarded.requestId });
    await held.app.close();
  });

  it('HTTP vs HTTP: the second is 409 taken; a pause the hub knows is closed is 404 no-such-pause', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' });
    await waitForPause(ts, 'p1');
    const first = postResume(ts.port, held.runId, 'p1', { action: 'continue', timeoutMs: 5_000 }, ts.server.tokens.agent);
    await waitUntil(() => held.resumes.length === 1, 'forwarded');
    const second = await postResume(ts.port, held.runId, 'p1', { action: 'continue' }, ts.server.tokens.agent);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ outcome: 'taken', code: 'pause-taken' });
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'continue', requestId: held.resumes[0]?.requestId as string });
    expect((await first).body.outcome).toBe('resumed');
    const late = await postResume(ts.port, held.runId, 'p1', { action: 'continue' }, ts.server.tokens.agent);
    expect(late.status).toBe(404);
    expect(late.body).toMatchObject({ outcome: 'no-such-pause', code: 'no-such-pause' });
    expect(held.resumes).toHaveLength(1);
    await held.app.close();
  });

  it('an unknown pause (never seen by the hub) is forwarded best-effort; an unowned run is no-such-pause', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitForPause(ts, 'p1');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    viewer.control('exec.resume', held.runId, { pauseId: 'mystery', action: 'continue' });
    await waitUntil(() => held.resumes.some((r) => r.pauseId === 'mystery'), 'forwarded');
    const unowned = await postResume(ts.port, 'no-such-run', 'p1', { action: 'continue' }, ts.server.tokens.agent);
    expect(unowned.status).toBe(404);
    expect(unowned.body).toMatchObject({ outcome: 'no-such-pause', code: 'no-owner' });
    await held.app.close();
  });

  it('a resolving pause the app never answers (an old client, an unknown id) reopens after the resolving timeout', async () => {
    const ts = await boot({ resolvingTimeoutMs: 300, allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' });
    await waitForPause(ts, 'p1');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    viewer.control('exec.resume', held.runId, { pauseId: 'p1', action: 'continue' });
    await waitForPause(ts, 'p1', 'resolving');
    await waitForPause(ts, 'p1', 'open');
    // Reopened: the next resume is forwarded. The first request is answered
    // by what the app actually did — it released the gate for the second one.
    held.setAnswer('echo');
    const second = await postResume(ts.port, held.runId, 'p1', { action: 'continue' }, ts.server.tokens.agent);
    expect(second.body.outcome).toBe('resumed');
    expect(held.resumes).toHaveLength(2);
    const lost = await viewer.next((m) => m.type === 'resume.result', 'first result');
    expect(lost).toMatchObject({ outcome: 'taken', code: 'superseded' });
    await held.app.close();
  });

  it('exec.refused reopens the pause and answers the resumer as refused (422)', async () => {
    const ts = await boot({ allowControl: 'edit' });
    const held = await heldApp(ts.port, { answer: 'refuse', editable: true });
    await waitForPause(ts, 'p1');
    const answer = await postResume(ts.port, held.runId, 'p1', { action: 'continue', input: { query: 5 } }, ts.server.tokens.agent);
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ outcome: 'refused', code: 'schema', message: 'expected "query" to be a string' });
    expect((await pauses(ts))[0]).toMatchObject({ pauseId: 'p1', state: 'open' });
    held.setAnswer('echo');
    const retry = await postResume(ts.port, held.runId, 'p1', { action: 'continue', input: { query: 'porto' } }, ts.server.tokens.agent);
    expect(retry.body.outcome).toBe('resumed');
    await held.app.close();
  });

  it('relays an app\'s refusal message without control or bidi characters', async () => {
    const ts = await boot({ allowControl: 'edit' });
    const held = await heldApp(ts.port, { answer: 'ignore', editable: true });
    await waitForPause(ts, 'p1');
    const pending = postResume(ts.port, held.runId, 'p1', { action: 'continue', input: { query: 'x' } }, ts.server.tokens.agent);
    await waitUntil(() => held.resumes.length === 1, 'forwarded');
    held.app.send('exec.refused', held.runId, {
      pauseId: 'p1',
      code: 'schema',
      message: '\u001b[2Jbad\u202E arg\u0007',
      requestId: held.resumes[0]?.requestId as string,
    });
    const answer = await pending;
    expect(answer.body).toMatchObject({ outcome: 'refused', code: 'schema', message: '[2Jbad arg' }); // ESC, RLO, BEL gone
    await held.app.close();
  });

  it('a resumer-supplied requestId with control, bidi or odd characters is replaced, never forwarded', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitForPause(ts, 'p1');
    const answer = await postResume(ts.port, held.runId, 'p1', { action: 'continue', requestId: 'id\u202E\u0007<b>' }, ts.server.tokens.agent);
    expect(answer.body.outcome).toBe('resumed');
    expect(held.resumes[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer.body.requestId).toBe(held.resumes[0]?.requestId);
    await held.app.close();
  });

  it('requestId round trip: the resumer\'s id reaches the app and comes back; the hub mints one when absent', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitForPause(ts, 'p1');
    const answer = await postResume(ts.port, held.runId, 'p1', { action: 'continue', requestId: 'agent-req-7' }, ts.server.tokens.agent);
    expect(answer.body).toMatchObject({ outcome: 'resumed', requestId: 'agent-req-7' });
    expect(held.resumes[0]?.requestId).toBe('agent-req-7');
    expect((await storedResumed(ts, held.runId))[0]).toMatchObject({ requestId: 'agent-req-7' });

    held.hold('p2');
    await waitForPause(ts, 'p2');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    viewer.control('exec.resume', held.runId, { pauseId: 'p2', action: 'continue' });
    const result = await viewer.next((m) => m.type === 'resume.result', 'resume.result');
    const minted = held.resumes[1]?.requestId;
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    expect(result).toMatchObject({ outcome: 'resumed', requestId: minted });
    await held.app.close();
  });

  it('a 0.6 client that releases a resolving gate on its own (no requestId echo) is not attributed to the resumer', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' }); // announces edit-input: echoes requestIds
    await waitForPause(ts, 'p1');
    const pending = postResume(ts.port, held.runId, 'p1', { action: 'continue', timeoutMs: 5_000 }, ts.server.tokens.agent);
    await waitUntil(() => held.resumes.length === 1, 'forwarded');
    // e.g. its pause timeout fired while the resume was in flight
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'continue' });
    const answer = await pending;
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ outcome: 'taken', code: 'superseded' });
    await waitUntil(async () => (await storedResumed(ts, held.runId)).length === 1, 'stored');
    expect((await storedResumed(ts, held.runId))[0]).not.toHaveProperty('principal');
    await held.app.close();
  });

  it('forwards only the fields it understands (no inputPatch, no stray output)', async () => {
    const ts = await boot();
    const held = await heldApp(ts.port, { answer: 'ignore' });
    await waitForPause(ts, 'p1');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    viewer.control('exec.resume', held.runId, {
      pauseId: 'p1',
      action: 'continue',
      output: 'stray',
      inputPatch: [{ op: 'test', path: '/secret', value: 'x' }],
    } as never);
    await waitUntil(() => held.resumes.length === 1, 'forwarded');
    expect(Object.keys(held.resumes[0] as object).sort()).toEqual(['action', 'pauseId', 'requestId']);
    await held.app.close();
  });
});

describe('late answers: the app\'s real answer decides every waiting resume', () => {
  it('a 0.6 app applies the resume it read first after the pause reopened: THAT resumer is told resumed, the other superseded', async () => {
    const ts = await boot({ resolvingTimeoutMs: 300, allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' }); // announces edit-input: echoes requestIds
    await waitForPause(ts, 'p1');
    const r1 = postResume(ts.port, held.runId, 'p1', { action: 'abort', requestId: 'agent-abort-1', timeoutMs: 10_000 }, ts.server.tokens.agent);
    await waitUntil(() => held.resumes.length === 1, 'R1 forwarded');
    await waitForPause(ts, 'p1', 'resolving');
    await waitForPause(ts, 'p1', 'open'); // the app is slow: reopened
    const r2 = postResume(ts.port, held.runId, 'p1', { action: 'continue', requestId: 'viewer-continue-1', timeoutMs: 10_000 }, ts.server.tokens.viewer);
    await waitUntil(() => held.resumes.length === 2, 'R2 forwarded');
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'abort', requestId: 'agent-abort-1' });
    const [a1, a2] = await Promise.all([r1, r2]);
    await waitUntil(async () => (await storedResumed(ts, held.runId)).length === 1, 'stored');
    expect((await storedResumed(ts, held.runId))[0]).toMatchObject({ action: 'abort', requestId: 'agent-abort-1', principal: 'agent' });
    expect({ status: a1.status, body: a1.body }).toMatchObject({ status: 200, body: { outcome: 'resumed', requestId: 'agent-abort-1', principal: 'agent' } });
    expect({ status: a2.status, body: a2.body }).toMatchObject({ status: 409, body: { outcome: 'taken', code: 'superseded', requestId: 'viewer-continue-1' } });
    await held.app.close();
  });

  it('an old client (no requestId echo) answering late: credited by the action it applied, not to whoever holds the slot', async () => {
    const ts = await boot({ resolvingTimeoutMs: 300, allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore', capabilities: ['pause', 'step', 'inject', 'retry', 'abort', 'run-claim'] });
    await waitForPause(ts, 'p1');
    const agentAnswer = postResume(ts.port, held.runId, 'p1', { action: 'abort', timeoutMs: 10_000 }, ts.server.tokens.agent);
    await waitUntil(() => held.resumes.length === 1, 'R1 forwarded');
    await waitForPause(ts, 'p1', 'resolving');
    await waitForPause(ts, 'p1', 'open');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    viewer.control('exec.resume', held.runId, { pauseId: 'p1', action: 'continue' });
    await waitUntil(() => held.resumes.length === 2, 'R2 forwarded');
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'abort' });
    const viewerResult = await viewer.next((m) => m.type === 'resume.result', 'viewer resume.result');
    const agent = await agentAnswer;
    await waitUntil(async () => (await storedResumed(ts, held.runId)).length === 1, 'stored');
    // "aborted by agent" — the abort that ran was the agent's.
    expect((await storedResumed(ts, held.runId))[0]).toMatchObject({ action: 'abort', principal: 'agent' });
    expect(viewerResult).toMatchObject({ outcome: 'taken', code: 'superseded' });
    expect(agent.body).toMatchObject({ outcome: 'resumed', principal: 'agent' });
    await held.app.close();
  });

  it('a retry right after the caller\'s own short timeout is "still-resolving" (202, not taken), and the pause reopens on its own', async () => {
    const ts = await boot({ resolvingTimeoutMs: 3_000, allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' });
    await waitForPause(ts, 'p1');
    const first = await postResume(ts.port, held.runId, 'p1', { action: 'continue', requestId: 'req-first', timeoutMs: 1_000 }, ts.server.tokens.agent);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ outcome: 'timeout', code: 'no-answer' });
    expect((await pauses(ts))[0]?.state).toBe('resolving');
    const retry = await postResume(ts.port, held.runId, 'p1', { action: 'continue', requestId: 'req-retry', timeoutMs: 1_000 }, ts.server.tokens.agent);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ outcome: 'timeout', code: 'still-resolving' });
    expect(held.resumes).toHaveLength(1);
    // It reopens on its own; then, while a caller IS waiting, another resume is taken.
    await waitForPause(ts, 'p1', 'open');
    const waiting = postResume(ts.port, held.runId, 'p1', { action: 'continue', timeoutMs: 5_000 }, ts.server.tokens.agent);
    await waitUntil(() => held.resumes.length === 2, 'forwarded after the reopen');
    const taken = await postResume(ts.port, held.runId, 'p1', { action: 'abort' }, ts.server.tokens.agent);
    expect(taken).toMatchObject({ status: 409, body: { outcome: 'taken', code: 'pause-taken' } });
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'continue', requestId: held.resumes[1]?.requestId });
    expect((await waiting).body).toMatchObject({ outcome: 'resumed' });
    await held.app.close();
  });

  it('a flood of tokenless resumes for made-up pause ids cannot turn a pending edit into a false timeout or strip its principal', async () => {
    const ts = await boot({ allowControl: 'edit' });
    ts.server.hub.state.set({ kind: 'tool', point: 'before' });
    const session = createSession({ url: `ws://127.0.0.1:${ts.port}/ingest`, appName: 'real-agent', enabled: true, env: {}, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());
    expect(await session.ready({ timeoutMs: 5_000 })).toBe(true);
    const live = { query: 'lisbon', limit: 5 };
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let validating = false;
    let runId = '';
    let resolveDecision!: (d: GateDecision) => void;
    const decision = new Promise<GateDecision>((resolve) => {
      resolveDecision = resolve;
    });
    void session.run('edit-me', async (ctx) => {
      runId = ctx.runId;
      session.emit('node.started', { nodeId: 'tool:search', kind: 'tool', name: 'search', instanceId: 's-1', input: live });
      resolveDecision(
        await session.gate(
          'before',
          { nodeId: 'tool:search', kind: 'tool', name: 'search' },
          {
            editable: true,
            validateInput: async (proposed) => {
              validating = true;
              await validationGate;
              return mergeToolInput(live, proposed);
            },
          },
        ),
      );
    });
    await waitUntil(() => runId !== '', 'run started');
    await waitUntil(async () => (await pauses(ts, runId)).length === 1, 'held');
    const pauseId = (await pauses(ts, runId))[0]?.pauseId as string;
    let answeredEarly: unknown;
    const pending = postResume(ts.port, runId, pauseId, { action: 'continue', input: { query: 'porto' }, operator: 'claude-code' }, ts.server.tokens.agent).then(
      (r) => {
        answeredEarly ??= r.body;
        return r;
      },
    );
    await waitUntil(() => validating, 'the app is validating the edit');
    const anon = await ui(ts);
    for (let i = 0; i < 1_001; i += 1) anon.control('exec.resume', runId, { pauseId: `ghost-${i}`, action: 'continue' });
    // Frames on one socket are handled in order; an anonymous edit is refused at once.
    anon.control('exec.resume', runId, { pauseId: 'sentinel', action: 'continue', input: { query: 'x' } });
    await anon.next((m) => m.type === 'error' && m.code === 'edit-refused', 'sentinel refusal');
    await sleep(200);
    expect(answeredEarly, 'the agent was told something before the app answered').toBeUndefined();
    releaseValidation();
    expect(await decision).toMatchObject({ action: 'continue', input: { query: 'porto', limit: 5 } });
    const answer = await pending;
    await waitUntil(async () => (await storedResumed(ts, runId)).length === 1, 'stored');
    expect({ status: answer.status, outcome: answer.body.outcome }).toEqual({ status: 200, outcome: 'resumed' });
    expect((await storedResumed(ts, runId))[0]).toMatchObject({ principal: 'agent', operator: 'claude-code', edited: { after: { query: 'porto', limit: 5 } } });
  }, 30_000);
});

describe('principal and operator', () => {
  it('stamps viewer / anonymous / agent from the credential that won', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitForPause(ts, 'p1');
    (await ui(ts, ts.server.tokens.viewer)).control('exec.resume', held.runId, { pauseId: 'p1', action: 'continue' });
    await waitUntil(async () => (await storedResumed(ts, held.runId)).length === 1, 'first');
    held.hold('p2');
    await waitForPause(ts, 'p2');
    (await ui(ts)).control('exec.resume', held.runId, { pauseId: 'p2', action: 'continue' });
    await waitUntil(async () => (await storedResumed(ts, held.runId)).length === 2, 'second');
    held.hold('p3');
    await waitForPause(ts, 'p3');
    await postResume(ts.port, held.runId, 'p3', { action: 'continue' }, ts.server.tokens.agent);
    const stored = await storedResumed(ts, held.runId);
    expect(stored.map((s) => s['principal'])).toEqual(['viewer', 'anonymous', 'agent']);
    await held.app.close();
  });

  it('strips principal/operator an app writes itself, on every exec.* event (the audit trail is the hub\'s)', async () => {
    const ts = await boot();
    const app = await FakeApp.connect(ts.port, { app: 'forger', capabilities: ALL_CAPABILITIES });
    app.send('run.started', 'run-f', { app: 'forger', sdk: { name: 't', version: '0' } });
    app.send('exec.paused', 'run-f', { pauseId: 'p1', nodeId: 'tool:x', point: 'before', principal: 'viewer', operator: 'admin' } as never);
    app.send('exec.resumed', 'run-f', { pauseId: 'p1', action: 'continue', principal: 'viewer', operator: 'the human' } as never);
    const viewer = await ui(ts);
    viewer.subscribe('run-f');
    await waitUntil(() => ts.server.storage.listEvents('run-f').events.length === 3, 'stored');
    for (const event of ts.server.storage.listEvents('run-f').events) {
      expect(event.payload, event.type).not.toHaveProperty('principal');
      expect(event.payload, event.type).not.toHaveProperty('operator');
    }
    // What viewers were sent live is the same stripped payload.
    const live = viewer.received.peekAll().filter((m) => m.type === 'event');
    for (const frame of live) {
      if (frame.type !== 'event') continue;
      expect(frame.envelope.payload).not.toHaveProperty('principal');
    }
    await app.close();
  });

  it('an app cannot get a principal stamped by echoing another pause\'s requestId', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' });
    held.hold('p2');
    await waitForPause(ts, 'p2');
    const pending = postResume(ts.port, held.runId, 'p1', { action: 'continue', requestId: 'for-p1', timeoutMs: 2_000 }, ts.server.tokens.agent);
    await waitUntil(() => held.resumes.length === 1, 'forwarded');
    // The app closes p2 (which nobody resumed) citing p1's request.
    held.app.send('exec.resumed', held.runId, { pauseId: 'p2', action: 'continue', requestId: 'for-p1' });
    await waitUntil(async () => (await storedResumed(ts, held.runId)).length === 1, 'stored');
    expect((await storedResumed(ts, held.runId))[0]).not.toHaveProperty('principal');
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'continue', requestId: 'for-p1' });
    expect((await pending).body.outcome).toBe('resumed');
    await held.app.close();
  });

  it('sanitizes the operator label (bidi, control, length) before storing it', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitForPause(ts, 'p1');
    const hostile = `\u202Eevil\u2066 bot\u0007\n${'x'.repeat(200)}`;
    await postResume(ts.port, held.runId, 'p1', { action: 'continue', operator: hostile }, ts.server.tokens.agent);
    const [stored] = await storedResumed(ts, held.runId);
    const operator = stored?.['operator'] as string;
    expect(operator.startsWith('evil botx')).toBe(true);
    expect([...operator]).toHaveLength(64);
    expect(operator).not.toMatch(/[\u0000-\u001F\u202A-\u202E\u2066-\u2069]/u);
    await held.app.close();
  });
});

describe('credentials on the viewer socket', () => {
  it('announces who the socket is and what the hub implements on welcome', async () => {
    const ts = await boot({ allowControl: 'inject' });
    const viewer = await ui(ts, ts.server.tokens.viewer);
    expect(viewer.welcome?.control).toEqual({
      principal: 'viewer',
      agentLevel: 'inject',
      editInput: true,
      hubCapabilities: ['pause-registry', 'edit-input'],
    });
    const anonymous = await ui(ts);
    expect(anonymous.welcome?.control?.principal).toBe('anonymous');
    const agent = await FakeUI.connect(ts.port, { headers: { authorization: `Bearer ${ts.server.tokens.agent}` } });
    cleanups.push(() => agent.close());
    expect(agent.welcome?.control?.principal).toBe('agent');
  });

  it('selects graphmind.v1 and never echoes the token subprotocol', async () => {
    const ts = await boot();
    const viewer = await ui(ts, ts.server.tokens.viewer);
    expect(viewer.ws.protocol).toBe('graphmind.v1');
  });

  it('refuses a wrong token at the upgrade (401), never downgrading it to anonymous', async () => {
    const ts = await boot();
    await expect(FakeUI.connect(ts.port, { token: 'gmv_wrong' })).rejects.toThrow(/401/);
    await expect(FakeUI.connect(ts.port, { headers: { authorization: 'Bearer nope' } })).rejects.toThrow(/401/);
    await expect(
      FakeUI.connect(ts.port, { protocols: ['graphmind.v1', `gm.auth.${ts.server.tokens.viewer}`, `gm.auth.${ts.server.tokens.agent}`] }),
    ).rejects.toThrow(/401/);
  });

  it('never reads ?token= or a cookie: those sockets are anonymous and cannot edit', async () => {
    const ts = await boot();
    const held = await heldApp(ts.port, { editable: true, answer: 'ignore' });
    await waitForPause(ts, 'p1');
    for (const [url, headers] of [
      [`ws://127.0.0.1:${ts.port}/ws/ui?token=${ts.server.tokens.viewer}`, {}],
      [`ws://127.0.0.1:${ts.port}/ws/ui`, { cookie: `token=${ts.server.tokens.viewer}; gm_token=${ts.server.tokens.viewer}` }],
    ] as const) {
      const ws = new WebSocket(url, { headers });
      const frames: UiServerMessage[] = [];
      ws.on('message', (data) => frames.push(JSON.parse(String(data)) as UiServerMessage));
      await new Promise((resolve) => ws.once('open', resolve));
      await waitUntil(() => frames.some((f) => f.type === 'welcome'), 'welcome');
      const welcome = frames.find((f) => f.type === 'welcome');
      expect(welcome?.type === 'welcome' && welcome.control?.principal).toBe('anonymous');
      ws.send(JSON.stringify({
        type: 'control',
        envelope: { gm: 1, seq: 0, ts: Date.now(), runId: held.runId, type: 'exec.resume', payload: { pauseId: 'p1', action: 'continue', input: { query: 'x' } } },
      }));
      await waitUntil(() => frames.some((f) => f.type === 'error'), 'refusal');
      expect(frames.find((f) => f.type === 'error')).toMatchObject({ code: 'edit-refused' });
      ws.close();
    }
    expect(held.resumes).toEqual([]);
    await held.app.close();
  });
});

describe('what a credential may do', () => {
  it('tokenless viewer sockets keep only continue/retry/abort (0.5, deprecated): never edits, injects, breakpoints or mode; one deprecation note', async () => {
    const logs: string[] = [];
    const ts = await boot({ log: (line) => logs.push(line) });
    const held = await heldApp(ts.port, { editable: true, answer: 'echo' });
    await waitForPause(ts, 'p1');
    const anon = await ui(ts);
    await ui(ts); // a second tokenless socket: still one note
    anon.control('exec.resume', held.runId, { pauseId: 'p1', action: 'continue', input: { query: 'x' }, requestId: 'edit-1' });
    // The refusal names the request it answers, so the viewer's editor can show it at once.
    expect(await errorFrame(anon)).toMatchObject({ code: 'edit-refused', pauseId: 'p1', requestId: 'edit-1' });
    anon.control('exec.resume', held.runId, { pauseId: 'p1', action: 'inject', output: { ok: true } });
    expect(await errorFrame(anon)).toMatchObject({ code: 'forbidden', pauseId: 'p1' });
    expect(held.resumes).toEqual([]);
    const armed = structuredClone(ts.server.hub.state.breakpoints);
    anon.control('breakpoint.set', '*', { matcher: { kind: 'tool' } });
    expect((await errorFrame(anon)).code).toBe('forbidden');
    // ...followed by the real state, so an optimistic viewer puts its toggle back.
    expect(await anon.next((m) => m.type === 'state', 'state')).toMatchObject({ breakpoints: armed, mode: 'run' });
    anon.control('mode.set', '*', { mode: 'step' });
    expect((await errorFrame(anon)).code).toBe('forbidden');
    expect(ts.server.hub.state.mode).toBe('run');
    expect(ts.server.hub.state.breakpoints).toEqual(armed);
    anon.control('exec.resume', held.runId, { pauseId: 'p1', action: 'continue' });
    await waitUntil(() => held.resumes.length === 1, 'continue forwarded');
    expect(held.resumes[0]).toMatchObject({ action: 'continue' });
    expect(logs.filter((line) => line.includes('Tokenless viewer sockets are deprecated'))).toHaveLength(1);
    await held.app.close();
  });

  it('levels matrix over HTTP: off / resume / inject / edit x action x input', async () => {
    const actions = ['continue', 'retry', 'inject', 'abort'] as const;
    const rank = ['off', 'resume', 'inject', 'edit'];
    for (const level of rank as ControlLevel[]) {
      const ts = await boot({ allowControl: level });
      const held = await heldApp(ts.port, { answer: 'echo', editable: true, pauseId: 'q0' });
      await waitForPause(ts, 'q0');
      let n = 0;
      for (const action of actions) {
        for (const withInput of [false, true]) {
          n += 1;
          const pauseId = `q${n}`;
          held.hold(pauseId, { editable: true, point: action === 'retry' ? 'after' : 'before' });
          await waitForPause(ts, pauseId);
          const before = held.resumes.length;
          const body: Record<string, unknown> = { action };
          if (action === 'inject') body['output'] = { ok: true };
          if (withInput) body['input'] = { query: 'edited' };
          const answer = await postResume(ts.port, held.runId, pauseId, body, ts.server.tokens.agent);
          const allowed = withInput
            ? level === 'edit'
            : action === 'inject'
              ? rank.indexOf(level) >= 2
              : rank.indexOf(level) >= 1;
          const label = `${level} ${action}${withInput ? '+input' : ''}`;
          if (allowed) {
            expect(held.resumes.length, label).toBe(before + 1);
            expect(answer.body.outcome, label).toBe('resumed');
          } else {
            expect(held.resumes.length, label).toBe(before);
            expect(answer.status, label).toBe(403);
            expect(answer.body, label).toMatchObject({ outcome: 'refused', code: 'forbidden' });
          }
        }
      }
      await held.app.close();
    }
  }, 60_000);

  it('the agent token at level off cannot touch breakpoints or step mode over a socket either', async () => {
    const ts = await boot();
    const agent = await FakeUI.connect(ts.port, { headers: { authorization: `Bearer ${ts.server.tokens.agent}` } });
    cleanups.push(() => agent.close());
    agent.control('breakpoint.set', '*', { matcher: { kind: 'tool' } });
    expect((await errorFrame(agent)).code).toBe('forbidden');
    agent.control('mode.set', '*', { mode: 'step' });
    expect((await errorFrame(agent)).code).toBe('forbidden');
    expect(ts.server.hub.state.mode).toBe('run');
    expect(ts.server.hub.state.breakpoints).toEqual([{ point: 'error' }]);
  });

  it('--no-edit-input: hubCapabilities drops edit-input, every edit is refused, plain resumes still work', async () => {
    const ts = await boot({ editInput: false, allowControl: 'edit' });
    const held = await heldApp(ts.port, { editable: true, answer: 'echo' });
    expect(held.app.ack?.hubCapabilities).toEqual(['pause-registry']);
    await waitForPause(ts, 'p1');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    expect(viewer.welcome?.control?.editInput).toBe(false);
    viewer.control('exec.resume', held.runId, { pauseId: 'p1', action: 'continue', input: { query: 'x' } });
    const err = await errorFrame(viewer);
    expect(err.code).toBe('edit-refused');
    expect(err.message).toContain('--no-edit-input');
    const http = await postResume(ts.port, held.runId, 'p1', { action: 'continue', input: { query: 'x' } }, ts.server.tokens.agent);
    expect(http.status).toBe(403);
    expect(held.resumes).toEqual([]);
    const plain = await postResume(ts.port, held.runId, 'p1', { action: 'continue' }, ts.server.tokens.agent);
    expect(plain.body.outcome).toBe('resumed');
    await held.app.close();
  });

  it('hello.ack lists pause-registry and edit-input by default (so a 0.6 client offers editable pauses)', async () => {
    const ts = await boot();
    const app = await FakeApp.connect(ts.port, { capabilities: ALL_CAPABILITIES });
    expect(app.ack?.hubCapabilities).toEqual(['pause-registry', 'edit-input']);
    // Still an echo of the app's own list, as in 0.5.
    expect(app.ack?.capabilities).toEqual(ALL_CAPABILITIES);
    await app.close();
  });

  it('an edit needs an owner that announced edit-input and an editable pause (422 not-editable: the credential is fine)', async () => {
    const ts = await boot({ allowControl: 'edit' });
    const old = await heldApp(ts.port, { runId: 'run-old', capabilities: ['pause', 'inject'], editable: true });
    const plain = await heldApp(ts.port, { runId: 'run-plain', editable: false });
    await waitUntil(async () => (await pauses(ts)).length === 2, 'two pauses');
    const a = await postResume(ts.port, 'run-old', 'p1', { action: 'continue', input: { q: 1 } }, ts.server.tokens.agent);
    expect(a.status).toBe(422);
    expect(a.body).toMatchObject({ outcome: 'refused', code: 'not-editable' });
    expect(a.body.message).toContain('edit-input');
    const b = await postResume(ts.port, 'run-plain', 'p1', { action: 'continue', input: { q: 1 } }, ts.server.tokens.agent);
    expect(b.status).toBe(422);
    expect(b.body).toMatchObject({ outcome: 'refused', code: 'not-editable' });
    expect(b.body.message).toContain('not editable');
    expect(old.resumes).toEqual([]);
    expect(plain.resumes).toEqual([]);
    await old.app.close();
    await plain.app.close();
  });

  it('refuses placeholder and truncated inputs and inject outputs, before anything reaches the app', async () => {
    const ts = await boot({ allowControl: 'edit' });
    const held = await heldApp(ts.port, { editable: true, answer: 'echo' });
    await waitForPause(ts, 'p1');
    const cases: [Record<string, unknown>, string][] = [
      [{ action: 'continue', input: { query: '__REDACTED__' } }, 'placeholder'],
      [{ action: 'continue', input: { query: { __graphmindTruncated: true, bytes: 1, preview: 'x' } } }, 'truncated'],
      [{ action: 'continue', input: { query: `abc${TRUNCATION_SUFFIX}` } }, 'truncated'],
      [{ action: 'continue', input: { __graphmind: 'truncated', preview: '...' } }, 'truncated'],
      [{ action: 'inject', output: { rows: '__REDACTED__' } }, 'placeholder'],
      [{ action: 'inject', output: `partial${TRUNCATION_SUFFIX}` }, 'truncated'],
    ];
    for (const [body, code] of cases) {
      const answer = await postResume(ts.port, held.runId, 'p1', body, ts.server.tokens.viewer);
      expect(answer.body, JSON.stringify(body)).toMatchObject({ outcome: 'refused', code });
      expect(answer.status).toBe(422);
    }
    expect(held.resumes).toEqual([]);
    expect((await pauses(ts))[0]?.state).toBe('open');
    await held.app.close();
  });
});

describe('a real @graphmind-ai/client session holding an editable gate', () => {
  interface Agent {
    session: Session;
    runId: string;
    decision: Promise<GateDecision>;
    validated: unknown[];
  }

  async function realAgent(ts: TestServer, live: Record<string, unknown> = { query: 'lisbon', limit: 5 }): Promise<Agent> {
    const session = createSession({
      url: `ws://127.0.0.1:${ts.port}/ingest`,
      appName: 'real-agent',
      enabled: true,
      env: {},
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => session.dispose());
    expect(await session.ready({ timeoutMs: 5_000 })).toBe(true);
    const validated: unknown[] = [];
    let runId = '';
    let resolveDecision!: (d: GateDecision) => void;
    const decision = new Promise<GateDecision>((resolve) => {
      resolveDecision = resolve;
    });
    void session.run('edit-me', async (ctx) => {
      runId = ctx.runId;
      session.emit('node.started', { nodeId: 'tool:search', kind: 'tool', name: 'search', instanceId: 's-1', input: live });
      const result = await session.gate(
        'before',
        { nodeId: 'tool:search', kind: 'tool', name: 'search' },
        {
          editable: true,
          validateInput: (proposed) => {
            validated.push(proposed);
            const merged = mergeToolInput(live, proposed);
            if (!merged.ok) return merged;
            const value = merged.value as Record<string, unknown>;
            if (typeof value['query'] !== 'string') return { ok: false, code: 'schema', message: 'query must be a string' };
            return merged;
          },
        },
      );
      resolveDecision(result);
    });
    await waitUntil(() => runId !== '', 'run started');
    return { session, runId, decision, validated };
  }

  it('offers the pause as editable; a refused edit reopens the registry entry; an accepted one runs with the merged input', async () => {
    const ts = await boot({ allowControl: 'edit' });
    // Break before every tool call.
    ts.server.hub.state.set({ kind: 'tool', point: 'before' });
    const agent = await realAgent(ts);
    await waitUntil(async () => (await pauses(ts, agent.runId)).length === 1, 'held');
    const [pause] = (await pauses(ts, agent.runId)) as unknown as { pauseId: string; editable?: boolean }[];
    expect(pause?.editable).toBe(true);
    const pauseId = pause?.pauseId as string;

    // The app's validator refuses: exec.refused, the gate is still held, the
    // registry entry is open again.
    const refused = await postResume(ts.port, agent.runId, pauseId, { action: 'continue', input: { query: 42 } }, ts.server.tokens.agent);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ outcome: 'refused', code: 'schema' });
    expect((await pauses(ts, agent.runId))[0]).toMatchObject({ pauseId, state: 'open' });

    // A shape the client refuses on its own (retry at a before gate).
    const shape = await postResume(ts.port, agent.runId, pauseId, { action: 'retry', input: { query: 'x' } }, ts.server.tokens.agent);
    expect(shape.body).toMatchObject({ outcome: 'refused', code: 'shape' });

    // Accepted: runs with the merged input; the stored event says who and what.
    const ok = await postResume(
      ts.port,
      agent.runId,
      pauseId,
      { action: 'continue', input: { query: 'porto' }, operator: 'claude-code' },
      ts.server.tokens.agent,
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ outcome: 'resumed', principal: 'agent' });
    const decision = await agent.decision;
    expect(decision).toMatchObject({ action: 'continue', input: { query: 'porto', limit: 5 } });
    await waitUntil(async () => (await storedResumed(ts, agent.runId)).length === 1, 'stored resumed');
    const [stored] = await storedResumed(ts, agent.runId);
    expect(stored).toMatchObject({
      pauseId,
      action: 'continue',
      principal: 'agent',
      operator: 'claude-code',
      requestId: ok.body.requestId,
      edited: { after: { query: 'porto', limit: 5 } },
    });
    const refusals = ts.server.storage.listEvents(agent.runId).events.filter((e) => e.type === 'exec.refused');
    expect(refusals.map((e) => (e.payload as { code: string }).code)).toEqual(['schema', 'shape']);
    expect(await pauses(ts, agent.runId)).toEqual([]);
  });

  it('the viewer token edits over the socket; an anonymous socket cannot', async () => {
    const ts = await boot();
    ts.server.hub.state.set({ kind: 'tool', point: 'before' });
    const agent = await realAgent(ts);
    await waitUntil(async () => (await pauses(ts, agent.runId)).length === 1, 'held');
    const pauseId = (await pauses(ts, agent.runId))[0]?.pauseId as string;
    const anon = await ui(ts);
    anon.control('exec.resume', agent.runId, { pauseId, action: 'continue', input: { query: 'anon' } });
    expect((await errorFrame(anon)).code).toBe('edit-refused');
    const viewer = await ui(ts, ts.server.tokens.viewer);
    viewer.control('exec.resume', agent.runId, { pauseId, action: 'continue', input: { query: 'viewer' } });
    const result = await viewer.next((m) => m.type === 'resume.result', 'resume.result');
    expect(result).toMatchObject({ outcome: 'resumed' });
    expect(await agent.decision).toMatchObject({ input: { query: 'viewer', limit: 5 } });
    expect((await storedResumed(ts, agent.runId))[0]).toMatchObject({ principal: 'viewer' });
    expect(agent.validated).toEqual([{ query: 'viewer' }]);
  });

  it('a client whose edit-input is switched off never offers editable pauses', async () => {
    const ts = await boot({ allowControl: 'edit' });
    ts.server.hub.state.set({ kind: 'tool', point: 'before' });
    const session = createSession({
      url: `ws://127.0.0.1:${ts.port}/ingest`,
      appName: 'no-edit',
      enabled: true,
      env: { GRAPHMIND_DISABLE_EDIT_INPUT: '1' },
      retryIntervalMs: 60_000,
    });
    cleanups.push(() => session.dispose());
    await session.ready({ timeoutMs: 5_000 });
    let runId = '';
    void session.run('x', async (ctx) => {
      runId = ctx.runId;
      await session.gate('before', { nodeId: 'tool:t', kind: 'tool', name: 't' }, { editable: true });
    });
    await waitUntil(async () => runId !== '' && (await pauses(ts, runId)).length === 1, 'held');
    const [pause] = (await pauses(ts, runId)) as unknown as { pauseId: string; editable?: boolean }[];
    expect(pause?.editable).toBeUndefined();
    const answer = await postResume(ts.port, runId, pause?.pauseId as string, { action: 'continue', input: { a: 1 } }, ts.server.tokens.agent);
    // The credential is fine; this pause cannot take an edit.
    expect(answer.body).toMatchObject({ outcome: 'refused', code: 'not-editable' });
  });
});

describe('echo detection: a 0.6 client with GRAPHMIND_DISABLE_EDIT_INPUT still echoes requestId', () => {
  /** TCP proxy app <-> server whose server -> app direction can be held. */
  async function holdingProxy(targetPort: number): Promise<{ port: number; hold(): void; release(): void }> {
    let holding = false;
    const held: { to: Socket; chunk: Buffer | string }[] = [];
    const sockets = new Set<Socket>();
    const server: Server = createServer((app) => {
      const upstream = connect(targetPort, '127.0.0.1');
      sockets.add(app);
      sockets.add(upstream);
      app.on('data', (chunk) => upstream.write(chunk));
      upstream.on('data', (chunk) => {
        if (holding) held.push({ to: app, chunk });
        else app.write(chunk);
      });
      const end = (): void => {
        app.destroy();
        upstream.destroy();
      };
      for (const socket of [app, upstream]) {
        socket.on('close', end);
        socket.on('error', end);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    );
    return {
      port: typeof address === 'object' && address !== null ? address.port : 0,
      hold() {
        holding = true;
      },
      release() {
        holding = false;
        for (const { to, chunk } of held.splice(0)) if (!to.destroyed) to.write(chunk);
      },
    };
  }

  async function appHoldingATool(
    port: number,
    env: Record<string, string>,
    pauseTimeoutMs?: number,
  ): Promise<{ runId: string; decision: Promise<GateDecision> }> {
    const session = createSession({
      url: `ws://127.0.0.1:${port}/ingest`,
      appName: 'echo-app',
      enabled: true,
      env,
      retryIntervalMs: 60_000,
      ...(pauseTimeoutMs === undefined ? {} : { pauseTimeoutMs }),
    });
    cleanups.push(() => session.dispose());
    expect(await session.ready({ timeoutMs: 5_000 })).toBe(true);
    let runId = '';
    let resolveDecision!: (d: GateDecision) => void;
    const decision = new Promise<GateDecision>((resolve) => {
      resolveDecision = resolve;
    });
    void session.run('echo', async (ctx) => {
      runId = ctx.runId;
      session.emit('node.started', { nodeId: 'tool:shell', kind: 'tool', name: 'shell', instanceId: 'i-1', input: { cmd: 'rm -rf build' } });
      resolveDecision(await session.gate('before', { nodeId: 'tool:shell', kind: 'tool', name: 'shell' }));
    });
    await waitUntil(() => runId !== '', 'run started');
    return { runId, decision };
  }

  /** The agent's abort is forwarded (the pause is `resolving`), but the app's pause timeout releases the gate first. */
  async function abortRacingPauseTimeout(env: Record<string, string>) {
    const ts = await boot({ allowControl: 'resume' });
    ts.server.hub.state.set({ kind: 'tool', point: 'before' });
    const proxy = await holdingProxy(ts.port);
    const run = await appHoldingATool(proxy.port, env, 1_500);
    await waitUntil(async () => (await pauses(ts, run.runId)).length === 1, 'held');
    const pauseId = (await pauses(ts, run.runId))[0]?.pauseId as string;
    proxy.hold(); // the forwarded abort sits in the proxy: "in flight"
    const answer = postResume(
      ts.port,
      run.runId,
      pauseId,
      { action: 'abort', requestId: 'agent-abort-R', timeoutMs: 8_000 },
      ts.server.tokens.agent,
    );
    await waitUntil(async () => (await pauses(ts, run.runId))[0]?.state === 'resolving', 'abort forwarded');
    const decision = await run.decision; // the app's pause timeout fired
    const result = await answer;
    proxy.release(); // the abort now reaches an app whose gate is gone: ignored
    await waitUntil(async () => (await storedResumed(ts, run.runId)).length === 1, 'stored exec.resumed');
    return { decision, result, stored: await storedResumed(ts, run.runId) };
  }

  it('the kill switch drops edit-input from hello, but the client still says it echoes (request-id) and does', async () => {
    const ts = await boot({ allowControl: 'resume' });
    ts.server.hub.state.set({ kind: 'tool', point: 'before' });
    const run = await appHoldingATool(ts.port, { GRAPHMIND_DISABLE_EDIT_INPUT: '1' });
    await waitUntil(async () => (await pauses(ts, run.runId)).length === 1, 'held');
    const pauseId = (await pauses(ts, run.runId))[0]?.pauseId as string;
    const edit = await postResume(ts.port, run.runId, pauseId, { action: 'continue', input: { cmd: 'ls' } }, ts.server.tokens.viewer);
    expect(edit.body).toMatchObject({ outcome: 'refused', code: 'not-editable' });
    const ok = await postResume(ts.port, run.runId, pauseId, { action: 'continue', requestId: 'agent-req-1' }, ts.server.tokens.agent);
    expect(ok.body).toMatchObject({ outcome: 'resumed', requestId: 'agent-req-1' });
    await waitUntil(async () => (await storedResumed(ts, run.runId)).length === 1, 'stored');
    expect((await storedResumed(ts, run.runId))[0]).toMatchObject({ requestId: 'agent-req-1' });
  });

  for (const [label, env] of [
    ['edits on', {}],
    ['GRAPHMIND_DISABLE_EDIT_INPUT', { GRAPHMIND_DISABLE_EDIT_INPUT: '1' }],
  ] as const) {
    it(`${label}: a pause-timeout release racing an agent abort is not credited to the agent`, async () => {
      const { decision, result, stored } = await abortRacingPauseTimeout(env);
      expect(decision.action).toBe('continue'); // the run continued: the abort was never applied
      expect(stored[0]).toMatchObject({ action: 'continue' });
      expect({
        status: result.status,
        outcome: result.body.outcome,
        code: result.body.code,
        answeredPrincipal: result.body.principal,
        storedPrincipal: stored[0]?.['principal'],
      }).toEqual({ status: 409, outcome: 'taken', code: 'superseded', answeredPrincipal: undefined, storedPrincipal: undefined });
    });
  }
});

