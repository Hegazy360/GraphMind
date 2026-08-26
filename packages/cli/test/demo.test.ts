/**
 * The keyless demo experience: fixture integrity, and the replayer driven
 * through a REAL server by a fake viewer (pause genuinely holds, resume
 * actions steer onto the recorded branches, source is 'demo').
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnvelope } from '@graphmind/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_FIXTURE_NDJSON } from '../src/demo/fixture-data.js';
import { loadBundledFixture, parseDemoFixture } from '../src/demo/fixture.js';
import { startDemoReplay, type DemoReplay } from '../src/demo/replayer.js';
import type { UiServerMessage, WireEnvelope } from '../src/ui-protocol.js';
import { FakeUI, fetchJson, startTestServer, waitUntil, type TestServer } from './helpers.js';

const FIXTURE_PATH = join(import.meta.dirname, '..', 'src', 'demo', 'demo-run.ndjson');

type EventFrame = Extract<UiServerMessage, { type: 'event' }>;

function isEventOf(message: UiServerMessage, type: string): message is EventFrame {
  return message.type === 'event' && (message.envelope as WireEnvelope).type === type;
}

describe('demo fixture', () => {
  it('every line validates against @graphmind/schema and the shape is complete', () => {
    const lines = DEMO_FIXTURE_NDJSON.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(30);
    for (const line of lines) {
      expect(parseEnvelope(JSON.parse(line)).kind).toBe('ok');
    }
    const fixture = parseDemoFixture(DEMO_FIXTURE_NDJSON);
    expect(fixture.app).toBe('trip-planner');
    expect(fixture.base[0]?.type).toBe('run.started');
    expect(fixture.base.at(-1)?.type).toBe('exec.paused');
    expect(fixture.pause).toMatchObject({ nodeId: 'tool:checkBudget', point: 'error' });
    expect(fixture.inject.at(-1)?.type).toBe('run.finished');
    expect(fixture.cont.at(-1)?.type).toBe('run.finished');
    // The failing segment starts at the failing tool's node.started.
    const segment = fixture.base[fixture.pause.failingSegmentStart];
    expect(segment?.type).toBe('node.started');
    expect(segment?.payload['nodeId']).toBe('tool:checkBudget');
    // Relative timing is present.
    expect(fixture.base.some((e) => e.dt > 0)).toBe(true);
  });

  it('the importable copy matches the NDJSON file byte for byte', () => {
    expect(DEMO_FIXTURE_NDJSON).toBe(readFileSync(FIXTURE_PATH, 'utf8'));
  });
});

describe('demo replayer', () => {
  let ts: TestServer | undefined;
  let ui: FakeUI | undefined;
  let replay: DemoReplay | undefined;

  afterEach(async () => {
    replay?.stop();
    await ui?.close();
    await ts?.cleanup();
    ts = undefined;
    ui = undefined;
    replay = undefined;
  });

  async function startReplay(): Promise<{ pauseId: string; runId: string }> {
    ts = await startTestServer();
    ui = await FakeUI.connect(ts.port);
    ui.subscribe('*');
    const fixture = await loadBundledFixture();
    replay = startDemoReplay(
      { url: `ws://127.0.0.1:${ts.port}/ingest`, speed: 50, maxGapMs: 50 },
      fixture,
    );
    ui.subscribe(replay.runId); // legal before the run exists: empty replay, then tail
    const paused = await ui.next((m) => isEventOf(m, 'exec.paused'), 'exec.paused');
    const envelope = (paused as EventFrame).envelope as WireEnvelope;
    return {
      pauseId: (envelope.payload as { pauseId: string }).pauseId,
      runId: replay.runId,
    };
  }

  it('genuinely pauses at the planted bug and holds until a control resume', async () => {
    const { pauseId, runId } = await startReplay();
    expect(replay!.paused).toBe(true);

    // Hold: nothing further streams, the run stays running.
    await delay(250);
    expect(replay!.finished).toBe(false);
    const { body } = await fetchJson(ts!.port, '/api/runs');
    const run = body.runs.find((r: { id: string }) => r.id === runId);
    expect(run).toMatchObject({ status: 'running', source: 'demo', app: 'trip-planner' });

    // continue → the recorded error propagation: checkBudget finishes with
    // status error and the run still completes (the model apologizes).
    ui!.control('exec.resume', runId, { pauseId, action: 'continue' });
    await ui!.next((m) => isEventOf(m, 'run.finished'), 'run.finished');
    await expect(replay!.done).resolves.toBe('finished');

    const events = ts!.server.storage.listEvents(runId).events;
    const budgetFinish = events.find(
      (e) => e.type === 'node.finished' && e.nodeId === 'tool:checkBudget',
    );
    expect(budgetFinish?.payload).toMatchObject({ status: 'error' });
    const text = events
      .filter((e) => e.type === 'node.token')
      .flatMap((e) => ((e.payload as { deltas: { v: string }[] }).deltas ?? []).map((d) => d.v))
      .join('');
    expect(text).toContain('convertCurrency');
  });

  it('inject produces the recorded fixed-path branch carrying the injected output', async () => {
    const { pauseId, runId } = await startReplay();
    const injected = { ok: true, totalUsd: 2693.4, note: 'FIXED_BY_TEST' };
    ui!.control('exec.resume', runId, { pauseId, action: 'inject', output: injected });
    await ui!.next((m) => isEventOf(m, 'run.finished'), 'run.finished');
    await expect(replay!.done).resolves.toBe('finished');

    const events = ts!.server.storage.listEvents(runId).events;
    const budgetFinish = events.find(
      (e) => e.type === 'node.finished' && e.nodeId === 'tool:checkBudget',
    );
    expect(budgetFinish?.payload).toMatchObject({
      status: 'ok',
      injected: true,
      output: injected,
    });
    const runRow = ts!.server.storage.getRun(runId);
    expect(runRow?.status).toBe('ok');
    const text = events
      .filter((e) => e.type === 'node.token')
      .flatMap((e) => ((e.payload as { deltas: { v: string }[] }).deltas ?? []).map((d) => d.v))
      .join('');
    expect(text).toContain('fits the budget');
  });

  it('retry replays the failing segment and pauses again; abort ends the run', async () => {
    const first = await startReplay();
    ui!.control('exec.resume', first.runId, { pauseId: first.pauseId, action: 'retry' });

    const paused = await ui!.next(
      (m) =>
        isEventOf(m, 'exec.paused') &&
        ((m as EventFrame).envelope as WireEnvelope & { payload: { pauseId: string } }).payload
          .pauseId !== first.pauseId,
      'second exec.paused',
    );
    const secondPauseId = ((paused as EventFrame).envelope.payload as { pauseId: string }).pauseId;

    const events = ts!.server.storage.listEvents(first.runId).events;
    const starts = events.filter(
      (e) => e.type === 'node.started' && e.nodeId === 'tool:checkBudget',
    );
    expect(starts.length).toBe(2);
    const instanceIds = starts.map((e) => (e.payload as { instanceId: string }).instanceId);
    expect(new Set(instanceIds).size).toBe(2);

    ui!.control('exec.resume', first.runId, { pauseId: secondPauseId, action: 'abort' });
    await ui!.next((m) => isEventOf(m, 'run.finished'), 'run.finished');
    await expect(replay!.done).resolves.toBe('finished');
    expect(ts!.server.storage.getRun(first.runId)?.status).toBe('aborted');
  });

  it('honors a cleared error breakpoint: no pause, error propagates', async () => {
    ts = await startTestServer();
    ui = await FakeUI.connect(ts.port);
    ui.subscribe('*');
    ui.control('breakpoint.clear', '*', { matcher: { point: 'error' } });
    await ui.next((m) => m.type === 'state' && m.breakpoints.length === 0, 'cleared state');

    const fixture = await loadBundledFixture();
    replay = startDemoReplay(
      { url: `ws://127.0.0.1:${ts.port}/ingest`, speed: 50, maxGapMs: 50 },
      fixture,
    );
    await expect(replay.done).resolves.toBe('finished');
    const events = ts.server.storage.listEvents(replay.runId).events;
    expect(events.some((e) => e.type === 'exec.paused')).toBe(false);
    expect(events.some((e) => e.type === 'exec.resumed')).toBe(false);
    expect(ts.server.storage.getRun(replay.runId)?.status).toBe('ok');
  });
});

describe('POST /api/demo/start', () => {
  it('kicks off the in-process replayer and registers a demo run', async () => {
    const ts = await startTestServer();
    try {
      const response = await fetch(`http://127.0.0.1:${ts.port}/api/demo/start`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; runId: string };
      expect(body.ok).toBe(true);
      expect(body.runId).toMatch(/^demo-/);

      await waitUntil(async () => {
        const { body: runs } = await fetchJson(ts.port, '/api/runs');
        return runs.runs.some(
          (r: { id: string; source: string }) => r.id === body.runId && r.source === 'demo',
        );
      }, 'demo run registered');

      const again = await fetch(`http://127.0.0.1:${ts.port}/api/demo/start`, { method: 'POST' });
      const secondBody = (await again.json()) as { runId: string; alreadyRunning?: boolean };
      expect(secondBody.alreadyRunning).toBe(true);
      expect(secondBody.runId).toBe(body.runId);
    } finally {
      await ts.cleanup(); // also stops the still-paused replay
    }
  });
});
