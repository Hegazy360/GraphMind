/**
 * An oversized event must degrade to a preview, never vanish.
 *
 * Before: `emit` of a 17 MB `node.finished` pushed a 17 MB frame into the
 * 8 MiB replay buffer, which evicted every older event to make room (they
 * were lost if the debugger was dark), and the frame itself was over the
 * server's 16 MiB WebSocket cap so it never arrived either. Nothing was
 * counted as lost and nothing was printed.
 *
 * Now the session applies the server's own storage shrink
 * (`serializePayload` from @graphmind-ai/schema) at emit, after redaction and
 * held time and before the ring buffer, so what it buffers and sends is
 * exactly what the server would store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  isTruncatedPayload,
  parseEnvelope,
  serializePayload,
} from '@graphmind-ai/schema';
import { createSession, type Session } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';

const MB = 1024 * 1024;
const SHRINK = /^\[graphmind\] an event of (\d+) bytes was shrunk to a preview \(the debugger stores at most 512 KB per payload\)$/;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function attachedSession(
  options: Parameters<typeof createSession>[0] = {},
): Promise<{ viewer: FakeViewer; session: Session; warnings: string[] }> {
  const viewer = await FakeViewer.start();
  cleanups.push(() => viewer.close());
  const warnings: string[] = [];
  const session = createSession({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    env: {},
    logger: (message) => warnings.push(message),
    ...options,
  });
  cleanups.push(() => session.dispose());
  expect(await session.ready()).toBe(true);
  return { viewer, session, warnings };
}

function shrinkWarnings(warnings: string[]): string[] {
  return warnings.filter((w) => SHRINK.test(w));
}

function nodeEvents(frames: ReceivedFrame[]): ReceivedFrame[] {
  return frames.filter((f) => f.type.startsWith('node.'));
}

describe('the exact defect: a 17 MB output while the debugger is dark', () => {
  it('no older event is evicted or lost, the big one arrives as a preview, one warning', async () => {
    const { viewer, session, warnings } = await attachedSession();
    viewer.dropConnections();
    await waitUntil(() => !session.attached, 2000, 'detach');

    session.emit('node.started', { nodeId: 'tool:a', kind: 'tool', name: 'a', instanceId: 'a1', input: { q: 1 } });
    session.emit('node.finished', { nodeId: 'tool:a', instanceId: 'a1', durationMs: 1, status: 'ok', output: 'small' });
    session.emit('node.started', { nodeId: 'tool:big', kind: 'tool', name: 'big', instanceId: 'b1', input: {} });
    session.emit('node.finished', {
      nodeId: 'tool:big',
      instanceId: 'b1',
      durationMs: 9,
      status: 'ok',
      output: { body: 'x'.repeat(17 * MB) },
    });
    session.emit('node.started', { nodeId: 'tool:c', kind: 'tool', name: 'c', instanceId: 'c1', input: { q: 3 } });

    const stats = session.stats();
    expect(stats.dropped).toBe(0);
    expect(stats.lost).toBe(0);
    expect(stats.buffered).toBeGreaterThanOrEqual(5);

    expect(await session.ready()).toBe(true);
    await waitUntil(() => nodeEvents(viewer.received).length >= 5, 5000, 'replay');
    const events = nodeEvents(viewer.received);
    expect(events.map((f) => f.type)).toEqual([
      'node.started',
      'node.finished',
      'node.started',
      'node.finished',
      'node.started',
    ]);
    const seqs = events.map((f) => f.seq);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);

    const big = events[3] as ReceivedFrame;
    expect(parseEnvelope(big).kind).toBe('ok');
    expect(big.payload['nodeId']).toBe('tool:big');
    expect(big.payload['status']).toBe('ok');
    expect(isTruncatedPayload(big.payload)).toBe(true);
    expect(isTruncatedPayload(big.payload['output'])).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(big.payload))).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(viewer.received.some((f) => f.type === 'graph.hint')).toBe(false); // no gap marker

    const shrunk = shrinkWarnings(warnings);
    expect(shrunk).toHaveLength(1);
    // N is the payload's real UTF-8 size, and the text quotes no content.
    expect(Number(SHRINK.exec(shrunk[0] as string)?.[1])).toBeGreaterThan(17 * MB);
    expect(warnings.join('\n')).not.toContain('xxxx');
    expect(stats.lost + session.stats().lost).toBe(0);
  }, 30_000);
});

describe('what is sent is exactly what the server would store', () => {
  it('node.finished: the frame payload equals serializePayload of the payload the session built', async () => {
    const { viewer, session } = await attachedSession();
    const payload = {
      nodeId: 'tool:t',
      instanceId: 'i',
      durationMs: 5,
      status: 'ok' as const,
      output: { rows: 'r'.repeat(600 * 1024), n: 3 },
    };
    session.emit('node.finished', payload);
    const frame = await viewer.waitForType('node.finished');
    // No node.started for this instance, so no heldMs is stamped: the
    // session's payload is the adapter's payload.
    expect(frame.payload).toEqual(serializePayload(payload).payload);
    expect(JSON.stringify(frame.payload)).toBe(serializePayload(payload).json);
    expect(frame.payload['fields']).toEqual(['output']);
    // Idempotent: the server re-applying it changes nothing.
    const again = serializePayload(frame.payload);
    expect(again.truncated).toBe(false);
    expect(again.json).toBe(JSON.stringify(frame.payload));
  });

  it('heldMs stamped by the session survives the shrink', async () => {
    const { viewer, session } = await attachedSession();
    session.emit('node.started', { nodeId: 'tool:h', kind: 'tool', name: 'h', instanceId: 'h1', input: {} });
    session.emit('node.finished', { nodeId: 'tool:h', instanceId: 'h1', durationMs: 5, status: 'ok', output: 'o'.repeat(700 * 1024) });
    const frame = await viewer.waitForType('node.finished');
    expect(isTruncatedPayload(frame.payload)).toBe(true);
    expect(frame.payload['heldMs']).toBe(0);
    expect(frame.payload['durationMs']).toBe(5);
  });

  it('node.error with a huge message stays a valid node.error', async () => {
    const { viewer, session, warnings } = await attachedSession();
    session.emit('node.error', {
      nodeId: 'llm:step',
      error: { name: 'APIError', message: 'm'.repeat(17 * MB) },
    });
    const frame = await viewer.waitForType('node.error');
    const parsed = parseEnvelope(frame);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok' || parsed.envelope.type !== 'node.error') throw new Error('invalid node.error');
    expect(parsed.envelope.payload.error.name).toBe('APIError');
    expect(parsed.envelope.payload.error.message.endsWith('…[graphmind: truncated]')).toBe(true);
    expect(shrinkWarnings(warnings)).toHaveLength(1);
  }, 30_000);

  it('a bare oversized token delta batch is shrunk too (deltas: [] keeps the array type)', async () => {
    const { viewer, session } = await attachedSession();
    session.emit('node.token', { nodeId: 'llm:step', deltas: [{ t: 'text', v: 'd'.repeat(600 * 1024) }] });
    const frame = await viewer.waitForType('node.token');
    expect(parseEnvelope(frame).kind).toBe('ok');
    expect(frame.payload['deltas']).toEqual([]);
  });
});

describe('the budget boundary is UTF-8 bytes of the payload JSON', () => {
  it('exactly MAX_PAYLOAD_BYTES is untouched; one byte more is shrunk', async () => {
    const { viewer, session, warnings } = await attachedSession();
    // {"nodes":[],"s":""} is 19 bytes of JSON around the string.
    expect(JSON.stringify({ nodes: [], s: '' })).toHaveLength(19);
    session.emit('graph.hint', { nodes: [], s: 'y'.repeat(MAX_PAYLOAD_BYTES - 19) } as never);
    session.emit('graph.hint', { nodes: [], s: 'z'.repeat(MAX_PAYLOAD_BYTES - 18) } as never);
    await waitUntil(() => viewer.ofType('graph.hint').length >= 2, 5000, 'hints');
    const [atLimit, overLimit] = viewer.ofType('graph.hint');
    expect(Buffer.byteLength(JSON.stringify(atLimit?.payload))).toBe(MAX_PAYLOAD_BYTES);
    expect(isTruncatedPayload(atLimit?.payload)).toBe(false);
    expect(isTruncatedPayload(overLimit?.payload)).toBe(true);
    expect(overLimit?.payload['bytes']).toBe(MAX_PAYLOAD_BYTES + 1);
    expect(shrinkWarnings(warnings)).toHaveLength(1);
  });

  it('multi-byte text under the limit in characters but over it in bytes is shrunk', async () => {
    const { viewer, session } = await attachedSession();
    // 262,141 x "é": ~262 K UTF-16 units (half the budget) but 524,282 bytes of string.
    session.emit('graph.hint', { nodes: [], s: 'é'.repeat(262_141) } as never);
    const frame = await viewer.waitForType('graph.hint');
    expect(isTruncatedPayload(frame.payload)).toBe(true);
  });

  it('three-byte text that is long in characters but within budget in bytes is untouched', async () => {
    const { viewer, session, warnings } = await attachedSession();
    // 170,000 x "中" = 510,000 bytes: above the cheap 1/3 pre-check, below the budget.
    const s = '中'.repeat(170_000);
    session.emit('graph.hint', { nodes: [], s } as never);
    const frame = await viewer.waitForType('graph.hint');
    expect(isTruncatedPayload(frame.payload)).toBe(false);
    expect(frame.payload['s']).toBe(s);
    expect(shrinkWarnings(warnings)).toHaveLength(0);
  });

  it('astral characters count four bytes each', async () => {
    const { viewer, session } = await attachedSession();
    // 131,070 x "😀" = 262,140 UTF-16 units, 524,280 bytes; + 19 bytes of JSON = 524,299 (over).
    // 131,067 x "😀" = 524,268 + 19 = 524,287 (under).
    session.emit('graph.hint', { nodes: [], s: '😀'.repeat(131_070) } as never);
    session.emit('graph.hint', { nodes: [], s: '😀'.repeat(131_067) } as never);
    await waitUntil(() => viewer.ofType('graph.hint').length >= 2, 5000, 'hints');
    const [over, under] = viewer.ofType('graph.hint');
    expect(isTruncatedPayload(over?.payload)).toBe(true);
    expect(isTruncatedPayload(under?.payload)).toBe(false);
  });
});

describe('warnings', () => {
  it('one per event type per interval, and never any payload content', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const secret = 'SECRET-CANARY-' + 'q'.repeat(600 * 1024);
    for (let i = 0; i < 5; i += 1) {
      session.emit('node.finished', { nodeId: `tool:${i}`, durationMs: 1, status: 'ok', output: secret });
    }
    session.emit('node.started', { nodeId: 'tool:s', kind: 'tool', name: 's', instanceId: 's', input: secret });
    await waitUntil(() => viewer.ofType('node.started').length >= 1, 5000, 'frames');
    expect(shrinkWarnings(warnings)).toHaveLength(2);
    expect(warnings.join('\n')).not.toContain('SECRET-CANARY');
    expect(viewer.ofType('node.finished')).toHaveLength(5);
  });
});

describe('under the budget nothing changes', () => {
  it('frames are byte-identical to the plain envelope serialization', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_757_000_000_000);
    const { viewer, session, warnings } = await attachedSession();
    const sentFrames: string[] = [];
    const runId = await session.run('realistic', async (ctx) => {
      const events: [string, Record<string, unknown>][] = [
        ['node.started', { nodeId: 'agent:weather', kind: 'agent', name: 'weather', instanceId: ctx.runId, input: { prompt: 'Weather in Paris? «é» 中文 😀' } }],
        ['node.started', { nodeId: 'llm:step', parentId: 'agent:weather', kind: 'llm', name: 'step', instanceId: '0', input: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'x'.repeat(170_000) }], max_tokens: 64 } }],
        ['node.token', { nodeId: 'llm:step', instanceId: '0', deltas: [{ t: 'text', v: 'Let me' }, { t: 'text', v: ' check.' }] }],
        ['node.finished', { nodeId: 'llm:step', instanceId: '0', durationMs: 412.37, status: 'ok', usage: { inputTokens: 12, outputTokens: 7 }, output: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'getWeather', input: { city: 'Paris' } }], stop_reason: 'tool_use' } }],
        ['node.started', { nodeId: 'tool:getWeather', parentId: 'agent:weather', kind: 'tool', name: 'getWeather', instanceId: 'toolu_1', input: { city: 'Paris' } }],
        ['node.error', { nodeId: 'tool:getWeather', instanceId: 'toolu_1', error: { name: 'TypeError', message: 'fetch failed', stack: 'at x (a.ts:1:1)' } }],
        ['graph.hint', { nodes: [{ id: 'tool:getWeather', kind: 'tool', name: 'getWeather' }] }],
        ['node.finished', { nodeId: 'agent:weather', instanceId: ctx.runId, durationMs: 1000, status: 'error', output: '中'.repeat(170_000) }],
      ];
      for (const [type, payload] of events) {
        const seq = session.stats().seq;
        session.emit(type as never, payload as never);
        await waitUntil(() => viewer.received.some((f) => f.seq === seq), 5000, `seq ${seq}`);
        const frame = viewer.received.find((f) => f.seq === seq) as ReceivedFrame;
        // The old emit path: JSON.stringify(createEnvelope(...)) with the
        // session's own heldMs stamp (the only thing it adds) appended.
        const expected = {
          ...payload,
          ...(frame.payload['heldMs'] === undefined || 'heldMs' in payload ? {} : { heldMs: frame.payload['heldMs'] }),
        };
        const expectedText = JSON.stringify({ gm: PROTOCOL_VERSION, seq, ts: 1_757_000_000_000, runId: ctx.runId, type, payload: expected });
        sentFrames.push(expectedText);
        expect(JSON.stringify(frame)).toBe(expectedText);
      }
      return ctx.runId;
    });
    expect(runId).toMatch(/^run/);
    expect(sentFrames).toHaveLength(8);
    expect(shrinkWarnings(warnings)).toHaveLength(0);
  });
});

describe('interplay', () => {
  it('redaction runs first: a hidden huge output becomes the placeholder and is never shrunk', async () => {
    const { viewer, session, warnings } = await attachedSession({ hideOutputs: true });
    session.emit('node.finished', { nodeId: 'tool:t', durationMs: 1, status: 'ok', output: 'h'.repeat(17 * MB) });
    const frame = await viewer.waitForType('node.finished');
    expect(frame.payload['output']).toBe('__REDACTED__');
    expect(isTruncatedPayload(frame.payload)).toBe(false);
    expect(shrinkWarnings(warnings)).toHaveLength(0);
  });

  it('a payload that cannot be serialized degrades to a marker instead of vanishing', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    session.emit('node.finished', { nodeId: 'tool:cyc', durationMs: 1, status: 'ok', output: cyclic });
    session.emit('node.finished', { nodeId: 'tool:big', durationMs: 1, status: 'ok', output: 10n as never });
    await waitUntil(() => viewer.ofType('node.finished').length >= 2, 5000, 'frames');
    const [first, second] = viewer.ofType('node.finished');
    expect(parseEnvelope(first).kind).toBe('ok');
    expect(first?.payload['nodeId']).toBe('tool:cyc');
    expect(first?.payload['fields']).toEqual(['output']);
    expect(second?.payload['fields']).toEqual(['output']);
    expect(warnings.filter((w) => w.includes('could not be serialized'))).toHaveLength(1);
    expect(session.stats().lost).toBe(0);
  });

  it('a cycle next to a 17 MB field: degraded AND held to the budget, as the server would store it', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    session.emit('node.finished', { nodeId: 'tool:both', durationMs: 1, status: 'ok', output: cyclic, big: 'b'.repeat(17 * MB) } as never);
    const frame = await viewer.waitForType('node.finished');
    expect(parseEnvelope(frame).kind).toBe('ok');
    expect(frame.payload['nodeId']).toBe('tool:both');
    expect(Buffer.byteLength(JSON.stringify(frame.payload))).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect((frame.payload['big'] as string).endsWith('…[graphmind: truncated]')).toBe(true);
    // The server's pass over what arrived is a no-op.
    expect(serializePayload(frame.payload).truncated).toBe(false);
    expect(warnings.filter((w) => w.includes('could not be serialized'))).toHaveLength(1);
    expect(shrinkWarnings(warnings)).toHaveLength(1);
  }, 30_000);

  it('a payload whose getter throws is dropped with a warning and never throws into the host', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const hostile = {
      nodeId: 'tool:x',
      durationMs: 1,
      status: 'ok',
      get output(): string {
        throw new Error('getter exploded');
      },
    };
    expect(() => session.emit('node.finished', hostile as never)).not.toThrow();
    session.emit('node.finished', { nodeId: 'tool:after', durationMs: 1, status: 'ok' });
    const frame = await viewer.waitForType('node.finished');
    expect(frame.payload['nodeId']).toBe('tool:after');
    expect(warnings.some((w) => w.includes('internal error in emit'))).toBe(true);
  });
});

describe('ring buffer belt and braces, reachable from emit with a small maxBufferBytes', () => {
  it('detached: an event larger than the whole buffer is not buffered, evicts nothing, and is counted as lost once', async () => {
    const { viewer, session, warnings } = await attachedSession({ maxBufferBytes: 64 * 1024 });
    viewer.dropConnections();
    await waitUntil(() => !session.attached, 2000, 'detach');

    session.emit('node.started', { nodeId: 'tool:a', kind: 'tool', name: 'a', instanceId: 'a', input: {} });
    const bigSeq = session.stats().seq;
    session.emit('node.finished', { nodeId: 'tool:a', instanceId: 'a', durationMs: 1, status: 'ok', output: 'x'.repeat(100 * 1024) });
    session.emit('node.started', { nodeId: 'tool:b', kind: 'tool', name: 'b', instanceId: 'b', input: {} });

    // run.started (implicit run) + the two node.started; the big one is not in the buffer.
    expect(session.stats()).toMatchObject({ buffered: 3, dropped: 0, lost: 1, pendingGaps: 1 });
    const oversize = warnings.filter((w) => w.includes('larger than the whole replay buffer'));
    expect(oversize).toHaveLength(1);
    expect(oversize[0]).not.toContain('xxxx');

    expect(await session.ready()).toBe(true);
    await waitUntil(() => nodeEvents(viewer.received).length >= 2, 5000, 'replay');
    await tick(50);
    const gap = viewer.received.find((f) => f.type === 'graph.hint')?.payload['gap'] as Record<string, unknown>;
    expect(gap).toMatchObject({ droppedCount: 1, fromSeq: bigSeq, toSeq: bigSeq });
    expect(nodeEvents(viewer.received).map((f) => f.payload['nodeId'])).toEqual(['tool:a', 'tool:b']);
  });

  it('attached: it is sent live, not lost, and the buffered events stay', async () => {
    const { viewer, session, warnings } = await attachedSession({ maxBufferBytes: 64 * 1024 });
    session.emit('node.started', { nodeId: 'tool:a', kind: 'tool', name: 'a', instanceId: 'a', input: {} });
    session.emit('node.finished', { nodeId: 'tool:a', instanceId: 'a', durationMs: 1, status: 'ok', output: 'x'.repeat(100 * 1024) });
    const frame = await viewer.waitForType('node.finished');
    expect(frame.payload['output']).toBe('x'.repeat(100 * 1024));
    expect(session.stats()).toMatchObject({ lost: 0, dropped: 0 });
    expect(session.stats().buffered).toBeGreaterThanOrEqual(2); // run.started + node.started
    expect(warnings.filter((w) => w.includes('larger than the whole replay buffer'))).toHaveLength(1);
  });
});

/**
 * The server shrinks the payload it PARSED from the frame's JSON; the client
 * holds a live object. They differ for every value JSON rewrites: a Buffer
 * (toJSON -> {type, data: [...]}), a typed array, a Date or URL, anything with
 * toJSON, a key whose value is undefined. Shrinking the live object walked a
 * 1 MB Buffer as a million object keys (~170 ms in the host's emit), could not
 * fit the result, and fell back to the whole-payload marker — which is not a
 * valid node.finished, so the server dropped the event at ingest: a tool that
 * returned `fs.readFile(...)` vanished, where before this workstream the server
 * had stored it as a valid preview.
 */
describe('live values are shrunk as the server sees them: their JSON', () => {
  it('a 1 MB Buffer tool result degrades to a VALID node.finished, exactly as the server would store it', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const payload = {
      nodeId: 'tool:readFile',
      instanceId: 'r1',
      durationMs: 1,
      status: 'ok' as const,
      output: Buffer.alloc(1024 * 1024, 65),
    };
    session.emit('node.finished', payload as never);
    const frame = await viewer.waitForType('node.finished');
    expect(parseEnvelope(frame).kind).toBe('ok');
    expect(frame.payload['nodeId']).toBe('tool:readFile');
    expect(frame.payload['output']).toMatchObject({ type: 'Buffer', data: [], __graphmindTruncated: true });
    expect(JSON.stringify(frame.payload)).toBe(serializePayload(JSON.parse(JSON.stringify(payload))).json);
    expect(shrinkWarnings(warnings)).toHaveLength(1);
  });

  it('toJSON values, Date, URL and undefined-valued keys: the frame is the shrink of the JSON', async () => {
    const { viewer, session } = await attachedSession();
    const payloads = [
      {
        nodeId: 'tool:a',
        durationMs: 1,
        status: 'ok' as const,
        skipped: undefined,
        output: { when: new Date(0), link: new URL('https://example.com/a'), body: 'x'.repeat(600_000) },
      },
      // CJK is sized in UTF-16 units while trimming, so every key is listed in
      // `fields` — including one that is absent from the JSON unless the
      // client shrinks the JSON.
      { nodeId: 'tool:b', durationMs: 1, status: 'ok' as const, skipped: undefined, output: '中'.repeat(200_000) },
      // A field whose toJSON is the big part.
      { nodeId: 'tool:c', durationMs: 1, status: 'ok' as const, output: { toJSON: () => 'q'.repeat(600_000) } },
    ];
    for (const payload of payloads) session.emit('node.finished', payload as never);
    await waitUntil(() => viewer.ofType('node.finished').length >= payloads.length, 5000, 'frames');
    viewer.ofType('node.finished').forEach((frame, i) => {
      const payload = payloads[i];
      expect(parseEnvelope(frame).kind).toBe('ok');
      expect(frame.payload['nodeId']).toBe(payload?.nodeId);
      expect(JSON.stringify(frame.payload)).toBe(serializePayload(JSON.parse(JSON.stringify(payload))).json);
    });
    const [dated] = viewer.ofType('node.finished');
    expect((dated?.payload['output'] as Record<string, unknown>)['when']).toBe('1970-01-01T00:00:00.000Z');
    expect((dated?.payload['output'] as Record<string, unknown>)['link']).toBe('https://example.com/a');
  });
});

/**
 * Shrink v2. Before it, trimming fields could fail to fit the budget (an
 * object keyed by id with thousands of small records; hundreds of 3 KB
 * fields; a typed array, which JSON writes as an object with one key per
 * element) and the whole payload became {__graphmindTruncated, bytes,
 * preview}: not a valid node.* event, so the server dropped it and the node
 * stayed "running". The session now passes the event type, the shrink caps
 * every object at 256 keys and, when trimming still cannot fit, keeps only
 * the type's required fields (the skeleton). Only an event that was not valid
 * to begin with can still be dropped, and the warning says exactly that.
 */
describe('shrink v2: every valid event stays a valid event', () => {
  it('6,000 records keyed by id arrive as a valid node.finished with the first 256 records', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const output: Record<string, unknown> = {};
    for (let i = 0; i < 6000; i += 1) output[`id${i}`] = { name: `CANARY record ${i}`, score: 0.5, desc: 'a short description of the record' };
    session.emit('node.finished', { nodeId: 'tool:list', durationMs: 1, status: 'ok', output });
    session.emit('node.finished', { nodeId: 'tool:after', durationMs: 1, status: 'ok', output: 'o'.repeat(600 * 1024) });
    await waitUntil(() => viewer.ofType('node.finished').length >= 2, 5000, 'frames');
    const [records, after] = viewer.ofType('node.finished');
    expect(parseEnvelope(records).kind).toBe('ok');
    expect(parseEnvelope(after).kind).toBe('ok');
    const kept = records?.payload['output'] as Record<string, unknown>;
    expect(kept['id0']).toEqual(output['id0']);
    expect(kept['id255']).toEqual(output['id255']);
    expect(kept['id256']).toBeUndefined();
    expect(kept['keysDropped']).toBe(6000 - 256);
    expect(Buffer.byteLength(JSON.stringify(records?.payload))).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(warnings.filter((w) => w.includes('could not be shrunk to a valid'))).toEqual([]);
    expect(shrinkWarnings(warnings)).toHaveLength(1); // one per event type per interval
    expect(warnings.join('\n')).not.toContain('CANARY');
  });

  it('300 fields of 3 KB arrive as the valid skeleton: required fields kept, the rest listed', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 300; i += 1) payload[`field${i}`] = `CANARY ${'m'.repeat(3000)}`;
    Object.assign(payload, { nodeId: 'tool:wide', instanceId: 'w1', durationMs: 7, status: 'ok' });
    session.emit('node.finished', payload as never);
    const frame = await viewer.waitForType('node.finished');
    expect(parseEnvelope(frame).kind).toBe('ok');
    expect(frame.payload).toMatchObject({ nodeId: 'tool:wide', instanceId: 'w1', durationMs: 7, status: 'ok', __graphmindTruncated: true });
    expect(frame.payload['fields']).toHaveLength(300); // instanceId (an optional string) is kept, not listed
    // The server's pass over what arrived is a no-op.
    expect(serializePayload(frame.payload, MAX_PAYLOAD_BYTES, 'node.finished').truncated).toBe(false);
    expect(shrinkWarnings(warnings)).toHaveLength(1);
    expect(warnings.join('\n')).not.toContain('CANARY');
  });

  it('a 2,000,000-element typed array result is a valid node.finished (keys 0..255 kept)', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const samples = new Float32Array(2_000_000).fill(0.5);
    session.emit('node.finished', { nodeId: 'tool:embed', instanceId: 'e1', durationMs: 3, status: 'ok', output: samples });
    const frame = await viewer.waitForType('node.finished', 20_000);
    expect(parseEnvelope(frame).kind).toBe('ok');
    const output = frame.payload['output'] as Record<string, unknown>;
    expect(output['0']).toBe(0.5);
    expect(output['255']).toBe(0.5);
    expect(output['256']).toBeUndefined();
    expect(output['keysDropped']).toBe(2_000_000 - 256);
    expect(shrinkWarnings(warnings)).toHaveLength(1);
    expect(session.stats().lost).toBe(0);
  }, 60_000);

  it('a cyclic REQUIRED error object still arrives as a valid node.error', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const error: Record<string, unknown> = { name: 'LoopError', message: 'went round' };
    error['cause'] = error;
    session.emit('node.error', { nodeId: 'llm:x', error } as never);
    const frame = await viewer.waitForType('node.error');
    expect(parseEnvelope(frame).kind).toBe('ok');
    expect(frame.payload['error']).toEqual({ name: 'LoopError', message: 'went round' });
    expect(warnings.filter((w) => w.includes('could not be serialized to JSON; it was sent'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('drop'))).toEqual([]);
  });

  it('an event that cannot be serialized AND cannot be made valid gets the honest warning, not "replaced by a marker"', async () => {
    const { session, warnings } = await attachedSession();
    // status must be a string; a BigInt cannot be serialized nor kept.
    session.emit('node.finished', { nodeId: 'tool:bad', durationMs: 1, status: 10n } as never);
    await tick(5);
    expect(warnings).toContain(
      '[graphmind] a node.finished event had a value that could not be serialized to JSON, and it could not be degraded to a valid event; the debugger will drop it',
    );
    expect(warnings.filter((w) => w.includes('replaced by a marker'))).toEqual([]);
  });

  it('an INVALID event over budget: warns that the debugger will drop it, never quoting content', async () => {
    const { viewer, session, warnings } = await attachedSession();
    const payload: Record<string, unknown> = { nodeId: 'tool:neg', durationMs: 1, status: 'not-a-status' };
    for (let i = 0; i < 300; i += 1) payload[`field${i}`] = `CANARY ${'m'.repeat(3000)}`;
    session.emit('node.finished', payload as never);
    session.emit('node.finished', { nodeId: 'tool:after', durationMs: 1, status: 'ok', output: 'o'.repeat(600 * 1024) });
    await waitUntil(() => viewer.ofType('node.finished').length >= 2, 5000, 'frames');
    const [whole, fine] = viewer.ofType('node.finished');
    expect(parseEnvelope(whole).kind).toBe('invalid');
    expect(parseEnvelope(fine).kind).toBe('ok');
    const dropped = warnings.filter((w) => w.includes('could not be shrunk to a valid'));
    expect(dropped).toEqual([
      `[graphmind] a node.finished event of ${Buffer.byteLength(JSON.stringify(payload))} bytes could not be shrunk to a valid event (the debugger stores at most 512 KB per payload, and this payload is not a valid node.finished event); the debugger will drop it`,
    ]);
    // The valid one still gets the ordinary warning, which is not rate-limited away by the drop.
    expect(shrinkWarnings(warnings)).toHaveLength(1);
    expect(warnings.join('\n')).not.toContain('CANARY');
  });
});
