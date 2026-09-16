/**
 * An oversized event must degrade to a preview, never vanish.
 *
 * The defect this guards: a real TS client emitting `node.finished` with a
 * 17 MB output lost it silently. The frame was bigger than the server's
 * WebSocket `maxPayload` (MAX_FRAME_BYTES, 16 MiB), so it never arrived; the
 * client's 8 MiB replay buffer had also evicted the older events to make room
 * for it. The stored run was missing that seq, the node card stayed "running"
 * forever, `stats().lost` stayed 0 and nothing was printed.
 *
 * The fix shrinks the payload in the client (same algorithm, same budget as
 * the server's storage, now shared from @graphmind-ai/schema), so what the
 * client buffers and sends is exactly what the server would have stored.
 *
 * Everything here is real: `startServer` on a temp DB, a real
 * `@graphmind-ai/client` session over a real WebSocket, raw SQLite rows.
 */
import { DatabaseSync } from 'node:sqlite';
import { createSession, type Session } from '@graphmind-ai/client';
import { MAX_PAYLOAD_BYTES as SCHEMA_MAX_PAYLOAD_BYTES, parseEnvelope, serializePayload as schemaSerializePayload } from '@graphmind-ai/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES, isTruncatedPayload, serializePayload } from '../src/storage.js';
import { FakeApp, fetchJson, startTestServer, waitUntil, type TestServer } from './helpers.js';
import type { WireEnvelope } from '../src/ui-protocol.js';

const MB = 1024 * 1024;
const SHRINK_WARNING = /an event of \d+ bytes was shrunk to a preview \(the debugger stores at most 512 KB per payload\)/;

let ts: TestServer | undefined;
let session: Session | undefined;

afterEach(async () => {
  await session?.dispose();
  session = undefined;
  await ts?.cleanup();
  ts = undefined;
});

/** A WebSocket that records every text frame the client actually sent. */
function recordingWebSocket(sent: string[]): typeof WebSocket {
  const Base = globalThis.WebSocket;
  return class RecordingWebSocket extends Base {
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data === 'string') sent.push(data);
      super.send(data);
    }
  };
}

async function boot(sent: string[] = []): Promise<{ ts: TestServer; session: Session; warnings: string[] }> {
  ts = await startTestServer();
  const warnings: string[] = [];
  session = createSession({
    url: `ws://127.0.0.1:${ts.port}/ingest`,
    appName: 'oversize-app',
    logger: (message) => warnings.push(message),
    webSocket: recordingWebSocket(sent) as never,
    env: {},
  });
  expect(await session.ready({ timeoutMs: 5000 })).toBe(true);
  return { ts, session, warnings };
}

async function runStatus(port: number, runId: string): Promise<string | undefined> {
  const runs = await fetchJson(port, '/api/runs');
  return (runs.body.runs as { id: string; status: string }[]).find((r) => r.id === runId)?.status;
}

async function storedEvents(port: number, runId: string): Promise<WireEnvelope[]> {
  const res = await fetchJson(port, `/api/runs/${runId}/events`);
  expect(res.status).toBe(200);
  return res.body.events as WireEnvelope[];
}

function rawStoredPayloads(dbPath: string, runId: string): Map<number, string> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT seq, payload_json AS payload FROM events WHERE run_id = ? ORDER BY seq')
      .all(runId) as { seq: number; payload: string }[];
    return new Map(rows.map((row) => [Number(row.seq), String(row.payload)]));
  } finally {
    db.close();
  }
}

/** The payload text the server stores for an in-budget frame: its parsed payload, serialized. */
function serverSerialization(frame: WireEnvelope): string {
  const parsed = parseEnvelope(frame);
  if (parsed.kind !== 'ok') throw new Error(`frame did not parse: ${parsed.kind}`);
  return JSON.stringify(parsed.envelope.payload);
}

describe('shared contract', () => {
  it('the CLI re-exports the schema package shrink, not a copy', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(SCHEMA_MAX_PAYLOAD_BYTES);
    expect(serializePayload).toBe(schemaSerializePayload);
    // The repro below is only meaningful while a 17 MB frame is over the cap.
    expect(17 * MB).toBeGreaterThan(MAX_FRAME_BYTES);
  });
});

describe('an oversized event through a real client and a real server', () => {
  it('a 17 MB node.finished output is stored as a preview, with its seq, and nothing is lost', async () => {
    const { ts, session, warnings } = await boot();
    const huge = 'x'.repeat(17 * MB);

    const runId = await session.run('oversize', async (ctx) => {
      session.emit('node.started', { nodeId: 'tool:before', kind: 'tool', name: 'before', instanceId: 'b1', input: { q: 1 } });
      session.emit('node.finished', { nodeId: 'tool:before', instanceId: 'b1', durationMs: 1, status: 'ok', output: { ok: true } });
      session.emit('node.started', { nodeId: 'tool:scrape', kind: 'tool', name: 'scrape', instanceId: 's1', input: { url: 'u' } });
      session.emit('node.finished', {
        nodeId: 'tool:scrape',
        instanceId: 's1',
        durationMs: 12,
        status: 'ok',
        output: { body: huge, contentType: 'text/html' },
      });
      session.emit('node.started', { nodeId: 'tool:after', kind: 'tool', name: 'after', instanceId: 'a1', input: { q: 2 } });
      session.emit('node.finished', { nodeId: 'tool:after', instanceId: 'a1', durationMs: 2, status: 'ok', output: { ok: 2 } });
      return ctx.runId;
    });

    await waitUntil(async () => (await runStatus(ts.port, runId)) === 'ok', 'run finished', 10_000);
    const stats = session.stats();
    expect(stats.lost).toBe(0);
    expect(stats.dropped).toBe(0);

    const events = await storedEvents(ts.port, runId);
    // run.started, 6 node events, run.finished — contiguous, nothing missing.
    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      'node.started',
      'node.finished',
      'node.started',
      'node.finished',
      'node.started',
      'node.finished',
      'run.finished',
    ]);
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);

    const big = events[4] as WireEnvelope;
    expect(parseEnvelope(big).kind).toBe('ok');
    const payload = big.payload as Record<string, unknown>;
    expect(payload['nodeId']).toBe('tool:scrape');
    expect(payload['status']).toBe('ok');
    expect(payload['durationMs']).toBe(12);
    expect(isTruncatedPayload(payload)).toBe(true);
    const output = payload['output'] as Record<string, unknown>;
    expect(isTruncatedPayload(output)).toBe(true);
    expect(typeof output['preview']).toBe('string');
    expect((output['preview'] as string).length).toBeGreaterThan(0);
    expect(output['contentType']).toBe('text/html');
    expect((output['body'] as string).endsWith('…[graphmind: truncated]')).toBe(true);

    // Neighbours intact.
    expect((events[2]?.payload as Record<string, unknown>)['output']).toEqual({ ok: true });
    expect((events[6]?.payload as Record<string, unknown>)['output']).toEqual({ ok: 2 });

    // Exactly one warning, and it never quotes the payload.
    const shrinkWarnings = warnings.filter((w) => SHRINK_WARNING.test(w));
    expect(shrinkWarnings).toHaveLength(1);
    expect(warnings.every((w) => !w.includes('xxxxxxxx'))).toBe(true);
  }, 60_000);

  it('a 17 MB node.error message stays a valid node.error (type preserved)', async () => {
    const { ts, session, warnings } = await boot();
    const hugeMessage = 'provider said: ' + 'e'.repeat(17 * MB);

    const runId = await session.run('oversize-error', async (ctx) => {
      session.emit('node.started', { nodeId: 'llm:step', kind: 'llm', name: 'step', instanceId: 'l1', input: { m: 1 } });
      session.emit('node.error', {
        nodeId: 'llm:step',
        instanceId: 'l1',
        error: { name: 'APIError', message: hugeMessage, stack: 'at call (x.ts:1:1)' },
      });
      session.emit('node.started', { nodeId: 'llm:step', kind: 'llm', name: 'step', instanceId: 'l2', input: { m: 2 } });
      session.emit('node.finished', { nodeId: 'llm:step', instanceId: 'l2', durationMs: 3, status: 'ok', output: 'fine' });
      return ctx.runId;
    });

    await waitUntil(async () => (await runStatus(ts.port, runId)) === 'ok', 'run finished', 10_000);
    expect(session.stats().lost).toBe(0);
    expect(session.stats().dropped).toBe(0);

    const events = await storedEvents(ts.port, runId);
    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      'node.started',
      'node.error',
      'node.started',
      'node.finished',
      'run.finished',
    ]);
    const errorEvent = events[2] as WireEnvelope;
    const parsed = parseEnvelope(errorEvent);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok' || parsed.envelope.type !== 'node.error') throw new Error('not a valid node.error');
    const error = parsed.envelope.payload.error;
    expect(typeof error.name).toBe('string');
    expect(typeof error.message).toBe('string');
    expect(error.message.startsWith('provider said: eee')).toBe(true);
    expect(error.message.endsWith('…[graphmind: truncated]')).toBe(true);
    expect(isTruncatedPayload(errorEvent.payload)).toBe(true);
    expect(events[4]?.payload).toMatchObject({ output: 'fine', status: 'ok' });

    expect(warnings.filter((w) => SHRINK_WARNING.test(w))).toHaveLength(1);
    expect(warnings.every((w) => !w.includes('eeeeeeee'))).toBe(true);
  }, 60_000);

  it('a 600 KB payload is shrunk in the client and the server stores the identical JSON text', async () => {
    const sent: string[] = [];
    const { ts, session, warnings } = await boot(sent);
    const runId = await session.run('six-hundred', async (ctx) => {
      session.emit('node.started', { nodeId: 'tool:t', kind: 'tool', name: 't', instanceId: 'i', input: {} });
      session.emit('node.finished', {
        nodeId: 'tool:t',
        instanceId: 'i',
        durationMs: 5,
        status: 'ok',
        output: { rows: 'r'.repeat(600 * 1024), n: 3 },
      });
      return ctx.runId;
    });

    await waitUntil(async () => (await runStatus(ts.port, runId)) === 'ok', 'run finished', 10_000);

    const frame = sent
      .map((text) => JSON.parse(text) as WireEnvelope)
      .find((env) => env.runId === runId && env.type === 'node.finished');
    if (frame === undefined) throw new Error('client never sent node.finished');
    const sentPayloadJson = JSON.stringify(frame.payload);
    expect(isTruncatedPayload(frame.payload)).toBe(true);
    expect(Buffer.byteLength(sentPayloadJson)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);

    const raw = rawStoredPayloads(ts.dbPath, runId);
    const storedJson = raw.get(frame.seq);
    // Identical text: the server did not shrink again, nor re-mark it. The
    // server re-serializes the payload its schema parser returned, which
    // lists known fields first, so the text is compared against that
    // serialization of what the client sent (same bytes, same values).
    expect(storedJson).toBe(serverSerialization(frame));
    expect(Buffer.byteLength(storedJson as string)).toBe(Buffer.byteLength(sentPayloadJson));
    expect(JSON.parse(storedJson as string)).toEqual(frame.payload);
    const stored = JSON.parse(storedJson as string) as Record<string, unknown>;
    expect(stored['fields']).toEqual(['output']);
    expect(warnings.filter((w) => SHRINK_WARNING.test(w))).toHaveLength(1);
  }, 30_000);

  it('a payload under 512 KB is sent and stored untouched, without a warning', async () => {
    const sent: string[] = [];
    const { ts, session, warnings } = await boot(sent);
    const output = { rows: 'r'.repeat(400 * 1024), nested: { a: [1, 2, 3], s: 'é😀' } };
    const runId = await session.run('under', async (ctx) => {
      session.emit('node.started', { nodeId: 'tool:t', kind: 'tool', name: 't', instanceId: 'i', input: {} });
      session.emit('node.finished', { nodeId: 'tool:t', instanceId: 'i', durationMs: 5, status: 'ok', output });
      return ctx.runId;
    });
    await waitUntil(async () => (await runStatus(ts.port, runId)) === 'ok', 'run finished', 10_000);
    const frame = sent
      .map((text) => JSON.parse(text) as WireEnvelope)
      .find((env) => env.runId === runId && env.type === 'node.finished');
    expect((frame?.payload as Record<string, unknown>)['output']).toEqual(output);
    expect(isTruncatedPayload(frame?.payload)).toBe(false);
    const storedJson = rawStoredPayloads(ts.dbPath, runId).get(frame?.seq as number);
    expect(storedJson).toBe(serverSerialization(frame as WireEnvelope));
    expect(JSON.parse(storedJson as string)).toEqual(frame?.payload);
    expect(warnings.filter((w) => SHRINK_WARNING.test(w))).toHaveLength(0);
  }, 30_000);

  it('a tool that returns a 1 MB Buffer is stored as a valid node.finished with its seq (not dropped at ingest)', async () => {
    // Shrinking the live Buffer (rather than its JSON, which is what the
    // server parses) fell back to the whole-payload marker: not a valid
    // node.finished, so ingest dropped it and the seq never reached storage.
    const sent: string[] = [];
    const { ts, session } = await boot(sent);
    const runId = await session.run('buffer-result', async (ctx) => {
      session.emit('node.started', { nodeId: 'tool:readFile', kind: 'tool', name: 'readFile', instanceId: 'r', input: { path: 'a.png' } });
      session.emit('node.finished', {
        nodeId: 'tool:readFile',
        instanceId: 'r',
        durationMs: 2,
        status: 'ok',
        output: Buffer.alloc(1024 * 1024, 65),
      });
      return ctx.runId;
    });
    await waitUntil(async () => (await runStatus(ts.port, runId)) === 'ok', 'run finished', 10_000);
    const events = await storedEvents(ts.port, runId);
    expect(events.map((e) => e.type)).toEqual(['run.started', 'node.started', 'node.finished', 'run.finished']);
    const finished = events[2] as WireEnvelope;
    expect(parseEnvelope(finished).kind).toBe('ok');
    const payload = finished.payload as Record<string, unknown>;
    expect(payload['nodeId']).toBe('tool:readFile');
    expect(payload['fields']).toEqual(['output']);
    expect(payload['output']).toMatchObject({ type: 'Buffer', data: [], __graphmindTruncated: true });
    // What the client sent is what was stored (no second shrink on the server).
    const frame = sent.map((t) => JSON.parse(t) as WireEnvelope).find((e) => e.runId === runId && e.type === 'node.finished');
    expect(rawStoredPayloads(ts.dbPath, runId).get(finished.seq)).toBe(serverSerialization(frame as WireEnvelope));
  }, 30_000);
});

/**
 * Shrink v2 on the SERVER path (defects 1 and 2). A raw app bypasses the
 * client's own shrink and sends frames under the 16 MiB cap whose payloads the
 * field trim alone could not fit: before v2 the hub stored the whole-payload
 * marker, which is not a valid node.* event — the node stayed "running" on
 * reload and the viewer dropped the envelope. The hub and SQLite storage now
 * pass the event type, so the payload is shrunk to a valid event.
 */
describe('shrink v2 through the real server: the stored event is valid, with its seq', () => {
  let app: FakeApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function records(count: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) out[`id${i}`] = { name: `record ${i}`, score: 0.5, desc: 'a short description of the record' };
    return out;
  }

  it('keyed records, 300 medium fields, a 1.2M-key typed array and a crowded node.error all store valid', async () => {
    ts = await startTestServer();
    app = await FakeApp.connect(ts.port, { app: 'raw-oversize' });
    const runId = 'run-shrink-v2';
    app.send('run.started', runId, { app: 'raw-oversize', sdk: { name: 'raw', version: '0' } });

    app.send('node.started', runId, { nodeId: 'tool:list', kind: 'tool', name: 'list', instanceId: 'l1' });
    const keyedSeq = app.send('node.finished', runId, { nodeId: 'tool:list', instanceId: 'l1', durationMs: 1, status: 'ok', output: records(8000) });

    app.send('node.started', runId, { nodeId: 'tool:wide', kind: 'tool', name: 'wide', instanceId: 'w1' });
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 300; i += 1) wide[`field${i}`] = 'm'.repeat(3000);
    const wideSeq = app.send('node.finished', runId, { ...wide, nodeId: 'tool:wide', instanceId: 'w1', durationMs: 2, status: 'ok' } as never);

    app.send('node.started', runId, { nodeId: 'tool:bytes', kind: 'tool', name: 'bytes', instanceId: 'b1' });
    // A 1.2 MB Uint8Array as JSON writes it: {"0":7,"1":7,...} — a 13.6 MB frame, under the 16 MiB cap.
    const typedSeq = app.seq++;
    const keys = Array.from({ length: 1_200_000 }, (_, i) => `"${i}":7`).join(',');
    const typedFrame = `{"gm":1,"seq":${typedSeq},"ts":${Date.now()},"runId":"${runId}","type":"node.finished","payload":{"nodeId":"tool:bytes","instanceId":"b1","durationMs":3,"status":"ok","output":{${keys}}}}`;
    expect(typedFrame.length).toBeLessThan(MAX_FRAME_BYTES);
    app.sendRaw(typedFrame);

    app.send('node.started', runId, { nodeId: 'llm:step', kind: 'llm', name: 'step', instanceId: 's1' });
    const crowded: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i += 1) crowded[`k${i}`] = 'filler';
    const errorSeq = app.send('node.error', runId, {
      nodeId: 'llm:step',
      instanceId: 's1',
      error: { ...crowded, name: 'APIError', message: `provider said: ${'e'.repeat(MB)}` },
    } as never);
    app.send('run.finished', runId, { status: 'ok' });

    await waitUntil(async () => (await runStatus(ts!.port, runId)) === 'ok', 'run finished', 30_000);
    const events = await storedEvents(ts.port, runId);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => (seqs[0] as number) + i));
    for (const seq of [keyedSeq, wideSeq, typedSeq, errorSeq]) expect(seqs, `seq ${seq} stored`).toContain(seq);
    for (const event of events) expect(parseEnvelope(event).kind, `${event.type} #${event.seq}`).toBe('ok');

    const bySeq = new Map(events.map((e) => [e.seq, e.payload as Record<string, unknown>]));
    const raw = rawStoredPayloads(ts.dbPath, runId);
    for (const seq of [keyedSeq, wideSeq, typedSeq, errorSeq]) {
      const stored = raw.get(seq) as string;
      expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      expect(isTruncatedPayload(JSON.parse(stored))).toBe(true);
    }

    expect(bySeq.get(keyedSeq)).toMatchObject({ nodeId: 'tool:list', instanceId: 'l1', status: 'ok' });
    expect((bySeq.get(keyedSeq)?.['output'] as Record<string, unknown>)['keysDropped']).toBe(8000 - 256);

    expect(bySeq.get(wideSeq)).toMatchObject({ nodeId: 'tool:wide', instanceId: 'w1', durationMs: 2, status: 'ok' });
    expect(bySeq.get(wideSeq)?.['fields']).toHaveLength(300);

    const typedOutput = bySeq.get(typedSeq)?.['output'] as Record<string, unknown>;
    expect(bySeq.get(typedSeq)).toMatchObject({ nodeId: 'tool:bytes', instanceId: 'b1', status: 'ok' });
    expect(typedOutput['255']).toBe(7);
    expect(typedOutput['keysDropped']).toBe(1_200_000 - 256);

    const error = bySeq.get(errorSeq)?.['error'] as Record<string, unknown>;
    expect(bySeq.get(errorSeq)).toMatchObject({ nodeId: 'llm:step', instanceId: 's1' });
    expect(error['name']).toBe('APIError');
    expect((error['message'] as string).startsWith('provider said: eee')).toBe(true);
    expect((error['message'] as string).endsWith('…[graphmind: truncated]')).toBe(true);

    // Every node the run started is finished (none left "running" on reload).
    const started = events.filter((e) => e.type === 'node.started').map((e) => (e.payload as { instanceId: string }).instanceId);
    const ended = events
      .filter((e) => e.type === 'node.finished' || e.type === 'node.error')
      .map((e) => (e.payload as { instanceId: string }).instanceId);
    expect(ended.sort()).toEqual(started.sort());
  }, 60_000);

  it('through a real client: a 2,000,000-element Float32Array result and 300 medium fields are stored valid', async () => {
    const { ts, session, warnings } = await boot();
    const runId = await session.run('client-shrink-v2', async (ctx) => {
      session.emit('node.started', { nodeId: 'tool:embed', kind: 'tool', name: 'embed', instanceId: 'e1', input: {} });
      session.emit('node.finished', { nodeId: 'tool:embed', instanceId: 'e1', durationMs: 4, status: 'ok', output: new Float32Array(2_000_000).fill(0.25) as never });
      session.emit('node.started', { nodeId: 'tool:wide', kind: 'tool', name: 'wide', instanceId: 'w1', input: {} });
      const wide: Record<string, unknown> = { nodeId: 'tool:wide', instanceId: 'w1', durationMs: 5, status: 'ok' };
      for (let i = 0; i < 300; i += 1) wide[`field${i}`] = 'CANARY'.repeat(500);
      session.emit('node.finished', wide as never);
      return ctx.runId;
    });
    await waitUntil(async () => (await runStatus(ts.port, runId)) === 'ok', 'run finished', 30_000);
    expect(session.stats().lost).toBe(0);
    const events = await storedEvents(ts.port, runId);
    expect(events.map((e) => e.type)).toEqual(['run.started', 'node.started', 'node.finished', 'node.started', 'node.finished', 'run.finished']);
    for (const event of events) expect(parseEnvelope(event).kind, event.type).toBe('ok');
    expect((events[2]?.payload as Record<string, unknown>)['output']).toMatchObject({ '0': 0.25, '255': 0.25, keysDropped: 2_000_000 - 256 });
    expect(events[4]?.payload).toMatchObject({ nodeId: 'tool:wide', instanceId: 'w1', durationMs: 5, status: 'ok', __graphmindTruncated: true });
    expect(warnings.filter((w) => w.includes('drop'))).toEqual([]);
    expect(warnings.join('\n')).not.toContain('CANARY');
  }, 60_000);
});
