/**
 * The pause registry across runs (Phase 7, contract C3; refute-security.md
 * S10): pause ids are per-process counters, so two apps both hold "p1". The
 * registry is keyed by (runId, pauseId) and updated only by frames that
 * passed the run claim, so one peer can neither close, reopen, fabricate nor
 * receive another run's pause — and first-writer-wins in one run never blocks
 * a resume in another.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';
import { startServer, type GraphMindServer } from 'graphmind-ai';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

async function boot(): Promise<GraphMindServer> {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-registry-iso-'));
  const server = await startServer({
    port: 0,
    dbPath: join(dir, 'graphmind.db'),
    log: () => {},
    allowControl: 'resume',
    env: { GRAPHMIND_RETENTION: 'off', GRAPHMIND_TELEMETRY: '0' },
  });
  cleanups.push(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return server;
}

class Peer {
  readonly resumes: { pauseId?: string; requestId?: string }[] = [];
  private seq = 0;
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { type?: string; payload?: { pauseId?: string; requestId?: string } };
      if (frame.type === 'exec.resume' && frame.payload !== undefined) this.resumes.push(frame.payload);
    });
  }
  static async connect(server: GraphMindServer, app: string): Promise<Peer> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ingest`);
    await new Promise((resolve) => ws.once('open', resolve));
    cleanups.push(() => ws.close());
    const peer = new Peer(ws);
    peer.send('hello', '*', { versions: { protocol: PROTOCOL_VERSION, client: 'x' }, capabilities: ['pause', 'run-claim'], app });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return peer;
  }
  send(type: string, runId: string, payload: unknown): void {
    this.ws.send(JSON.stringify({ gm: PROTOCOL_VERSION, seq: this.seq++, ts: Date.now(), runId, type, payload }));
  }
  hold(runId: string, pauseId = 'p1'): void {
    this.send('run.started', runId, { app: 'x', sdk: { name: 'x', version: '0' } });
    this.send('exec.paused', runId, { pauseId, nodeId: 'tool:x', point: 'before' });
  }
}

async function resume(server: GraphMindServer, runId: string, pauseId: string, timeoutMs = 1_000) {
  const response = await fetch(`${server.url}/api/runs/${runId}/pauses/${pauseId}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.tokens.agent}` },
    body: JSON.stringify({ action: 'continue', timeoutMs }),
  });
  return (await response.json()) as { outcome: string; code?: string };
}

describe('S10: pauses are isolated per run', () => {
  it('two runs both holding "p1": each resume reaches only its own app, and closing one leaves the other held', async () => {
    const server = await boot();
    const alice = await Peer.connect(server, 'alice');
    const bob = await Peer.connect(server, 'bob');
    alice.hold('run-alice');
    bob.hold('run-bob');
    await until(() => server.hub.listPauses().length === 2);
    // Alice's app never answers: her pause stays resolving (first writer wins)...
    const pending = resume(server, 'run-alice', 'p1', 2_000);
    await until(() => alice.resumes.length === 1);
    // ...which must not block Bob's pause of the same id.
    const forBob = resume(server, 'run-bob', 'p1');
    await until(() => bob.resumes.length === 1);
    bob.send('exec.resumed', 'run-bob', { pauseId: 'p1', action: 'continue', requestId: bob.resumes[0]?.requestId });
    expect((await forBob).outcome).toBe('resumed');
    expect(alice.resumes).toHaveLength(1);
    expect(bob.resumes).toHaveLength(1);
    expect(server.hub.listPauses().map((p) => [p.runId, p.state])).toEqual([['run-alice', 'resolving']]);
    expect((await pending).outcome).toBe('timeout');
  });

  it('a peer cannot close, fabricate or re-open a pause in a run it does not own', async () => {
    const server = await boot();
    const victim = await Peer.connect(server, 'victim');
    victim.hold('victim-run');
    await until(() => server.hub.listPauses().length === 1);
    const attacker = await Peer.connect(server, 'attacker');
    attacker.send('exec.resumed', 'victim-run', { pauseId: 'p1', action: 'continue' });
    attacker.send('exec.paused', 'victim-run', { pauseId: 'fake', nodeId: 'tool:x', point: 'before' });
    attacker.send('exec.refused', 'victim-run', { pauseId: 'p1', code: 'schema' });
    attacker.send('run.finished', 'victim-run', { status: 'error' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.hub.listPauses().map((p) => [p.runId, p.pauseId, p.state])).toEqual([['victim-run', 'p1', 'open']]);
    // The victim's pause is still resumable, and only the victim receives it.
    const answer = resume(server, 'victim-run', 'p1');
    await until(() => victim.resumes.length === 1);
    victim.send('exec.resumed', 'victim-run', { pauseId: 'p1', action: 'continue', requestId: victim.resumes[0]?.requestId });
    expect((await answer).outcome).toBe('resumed');
    expect(attacker.resumes).toEqual([]);
  });

  it('a flood of pauses from one connection is capped and cannot crowd out another app', async () => {
    const server = await boot();
    const flooder = await Peer.connect(server, 'flooder');
    flooder.send('run.started', 'flood', { app: 'x', sdk: { name: 'x', version: '0' } });
    for (let i = 0; i < 1_500; i += 1) flooder.send('exec.paused', 'flood', { pauseId: `f${i}`, nodeId: 'tool:x', point: 'before' });
    await until(() => server.hub.listPauses('flood').length === 1_000, 15_000);
    const honest = await Peer.connect(server, 'honest');
    honest.hold('honest-run');
    await until(() => server.hub.listPauses('honest-run').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.hub.listPauses('flood')).toHaveLength(1_000);
  }, 30_000);
});
