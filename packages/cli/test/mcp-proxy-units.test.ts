/**
 * Unit-level guarantees of the mcp-proxy plumbing: framing, JSON-RPC
 * classification, the protocol -> graph mapping, the serialized writer, and
 * the relay's ordering/fail-open rules.
 */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LineFramer } from '../src/mcp-proxy/framing.js';
import {
  GRAPHMIND_ABORTED_CODE,
  classify,
  encodeFrame,
  errorResponse,
  idKey,
  injectedResponse,
  isErrorResult,
  parseFrame,
} from '../src/mcp-proxy/jsonrpc.js';
import { commandLabel, mapMethod, otherSide } from '../src/mcp-proxy/mapping.js';
import { FrameRelay, FORWARD, type FrameAction } from '../src/mcp-proxy/relay.js';
import { FrameWriter } from '../src/mcp-proxy/writer.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('LineFramer', () => {
  it('splits on newlines and returns the exact bytes between them', () => {
    const framer = new LineFramer(1024);
    const { frames } = framer.append(buf('{"a":1}\n{"b":2}\n'));
    expect(frames.map((f) => f.toString())).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a frame split across arbitrary chunk boundaries', () => {
    const framer = new LineFramer(1024);
    expect(framer.append(buf('{"hel')).frames).toEqual([]);
    expect(framer.append(buf('lo":')).frames).toEqual([]);
    const { frames } = framer.append(buf('"world"}\n'));
    expect(frames.map((f) => f.toString())).toEqual(['{"hello":"world"}']);
  });

  it('keeps a trailing \\r inside the frame instead of stripping it', () => {
    const framer = new LineFramer(1024);
    const { frames } = framer.append(buf('{"a":1}\r\n'));
    expect(frames[0]?.toString()).toBe('{"a":1}\r');
  });

  it('preserves empty frames and does not lose the incomplete tail', () => {
    const framer = new LineFramer(1024);
    const { frames } = framer.append(buf('\n\nx'));
    expect(frames.map((f) => f.toString())).toEqual(['', '']);
    expect(framer.pendingBytes).toBe(1);
    expect(framer.takePending().toString()).toBe('x');
    expect(framer.pendingBytes).toBe(0);
  });

  it('reports overflow instead of throwing, and keeps the bytes', () => {
    const framer = new LineFramer(8);
    const result = framer.append(buf('0123456789'));
    expect(result.overflowed).toBe(true);
    expect(result.frames).toEqual([]);
    expect(framer.takePending().toString()).toBe('0123456789');
  });

  it('survives a multi-megabyte frame arriving in small chunks', () => {
    const framer = new LineFramer(32 * 1024 * 1024);
    const payload = 'y'.repeat(3 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 65536) {
      expect(framer.append(buf(payload.slice(i, i + 65536))).frames).toEqual([]);
    }
    const { frames } = framer.append(buf('\n'));
    expect(frames[0]?.length).toBe(payload.length);
  });
});

describe('JSON-RPC classification', () => {
  it('separates requests, notifications and responses', () => {
    expect(classify({ jsonrpc: '2.0', id: 1, method: 'ping' })).toMatchObject({ kind: 'request' });
    expect(classify({ jsonrpc: '2.0', method: 'notifications/initialized' })).toMatchObject({
      kind: 'notification',
    });
    expect(classify({ jsonrpc: '2.0', id: 1, result: {} })).toMatchObject({ kind: 'response' });
    expect(classify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toMatchObject({
      kind: 'response',
    });
  });

  it('treats an id-less error response as unpairable rather than guessing', () => {
    expect(classify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'x' } })).toEqual({
      kind: 'other',
    });
  });

  it('classifies batches element by element', () => {
    const result = classify([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/x' },
    ]);
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error('expected a batch');
    expect(result.items.map((i) => i.kind)).toEqual(['request', 'notification']);
  });

  it('keeps numeric and string ids distinct', () => {
    expect(idKey(1)).not.toBe(idKey('1'));
  });

  it('returns undefined for non-JSON rather than throwing', () => {
    expect(parseFrame(buf('not json'))).toBeUndefined();
    expect(parseFrame(buf('   '))).toBeUndefined();
  });

  it('detects an MCP tool result that failed in-band', () => {
    expect(isErrorResult({ isError: true, content: [] })).toBe(true);
    expect(isErrorResult({ content: [] })).toBe(false);
    expect(isErrorResult(null)).toBe(false);
  });

  it('injects into `result` by default and replaces the whole frame on demand', () => {
    expect(JSON.parse(injectedResponse(7, { ok: 1 }).toString())).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { ok: 1 },
    });
    expect(
      JSON.parse(injectedResponse(7, { jsonrpc: '2.0', error: { code: -1, message: 'no' } }).toString()),
    ).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -1, message: 'no' } });
  });

  it('never emits a response with neither result nor error', () => {
    // "inject" with no value is a real click in the viewer; `JSON.stringify`
    // would drop an `undefined` result and produce a frame clients reject.
    const frame = JSON.parse(injectedResponse(1, undefined).toString()) as Record<string, unknown>;
    expect('result' in frame).toBe(true);
    expect(frame['result']).toBeNull();
  });

  it('reports frames it cannot serialize instead of writing garbage', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(encodeFrame(cyclic)).toBeUndefined();
    expect(encodeFrame(undefined)).toBeUndefined();
    expect(encodeFrame({ n: 1n as unknown as number })).toBeUndefined();
  });

  it('uses an implementation-defined error code that MCP has not claimed', () => {
    const frame = JSON.parse(errorResponse(1, GRAPHMIND_ABORTED_CODE, 'nope').toString()) as {
      error: { code: number };
    };
    expect(frame.error.code).toBe(-32099);
    expect([-32000, -32001, -32042]).not.toContain(frame.error.code);
  });
});

describe('protocol -> graph mapping', () => {
  it('gives tools, resources and prompts their own kinds, keyed by identity', () => {
    expect(mapMethod('tools/call', { name: 'search' })).toEqual({
      nodeId: 'tool:search',
      kind: 'tool',
      name: 'search',
    });
    expect(mapMethod('resources/read', { uri: 'file:///a' })).toEqual({
      nodeId: 'resource:file:///a',
      kind: 'resource',
      name: 'file:///a',
    });
    expect(mapMethod('prompts/get', { name: 'summarize' })).toEqual({
      nodeId: 'prompt:summarize',
      kind: 'prompt',
      name: 'summarize',
    });
  });

  it('maps server-initiated sampling onto an llm node', () => {
    expect(mapMethod('sampling/createMessage', {})).toMatchObject({
      nodeId: 'llm:sampling',
      kind: 'llm',
    });
  });

  it('keeps protocol chatter visible as custom nodes named after the method', () => {
    expect(mapMethod('initialize', {})).toEqual({
      nodeId: 'mcp:initialize',
      kind: 'custom',
      name: 'initialize',
    });
    expect(mapMethod('notifications/progress', {})).toMatchObject({ kind: 'custom' });
  });

  it('degrades gracefully when the params are missing or malformed', () => {
    expect(mapMethod('tools/call', undefined).nodeId).toBe('tool:unknown');
    expect(mapMethod('tools/call', { name: 42 }).nodeId).toBe('tool:unknown');
  });

  it('trims long command labels but keeps them recognisable', () => {
    expect(commandLabel('node', ['server.js'])).toBe('node server.js');
    // An MCP client launches an absolute interpreter path; the run is "node".
    expect(commandLabel('/usr/local/bin/node', ['server.js'])).toBe('node server.js');
    // ...and so are the arguments, because an MCP client config is written in
    // absolute paths. This is a real invocation from the mcp-server sample.
    expect(
      commandLabel('node', [
        '/Users/x/graphmind-samples/mcp-server/node_modules/tsx/dist/cli.mjs',
        '/Users/x/graphmind-samples/mcp-server/src/server.ts',
      ]),
    ).toBe('node cli.mjs server.ts');
    // A flag keeps its value: it may be the only thing telling two runs apart.
    expect(commandLabel('server', ['--config=/etc/a/b.toml'])).toBe(
      'server --config=/etc/a/b.toml',
    );
    const long = commandLabel('node', [`/very/long/path/${'x'.repeat(200)}-my-server.js`]);
    expect(long.length).toBe(64);
    // Trimmed from the left, so the part that identifies the server survives.
    expect(long.endsWith('my-server.js')).toBe(true);
    expect(long.startsWith('…')).toBe(true);
  });

  it('knows which way an answer travels', () => {
    expect(otherSide('client-to-server')).toBe('server-to-client');
    expect(otherSide('server-to-client')).toBe('client-to-server');
  });
});

describe('FrameWriter', () => {
  it('adds exactly one newline per frame and keeps call order', async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const writer = new FrameWriter(sink);
    void writer.writeFrame(buf('{"a":1}'));
    void writer.writeFrame(buf('{"b":2}'));
    await writer.writeRaw(buf('tail'));
    expect(Buffer.concat(chunks).toString()).toBe('{"a":1}\n{"b":2}\ntail');
  });

  it('does not drop frames queued just before end()', async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const writer = new FrameWriter(sink);
    void writer.writeFrame(buf('one'));
    void writer.writeFrame(buf('two'));
    await writer.end();
    expect(Buffer.concat(chunks).toString()).toBe('one\ntwo\n');
  });

  it('swallows write errors (EPIPE) instead of crashing the process', async () => {
    const broken = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('EPIPE'));
      },
    });
    const writer = new FrameWriter(broken);
    await expect(writer.writeFrame(buf('{"a":1}'))).resolves.toBeUndefined();
    await expect(writer.writeFrame(buf('{"b":2}'))).resolves.toBeUndefined();
  });
});

describe('FrameRelay', () => {
  function rig(intercept: (raw: Buffer) => Promise<FrameAction>, maxFrameBytes = 1024) {
    const source = new PassThrough();
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const degrades: number[] = [];
    const errors: unknown[] = [];
    const relay = new FrameRelay({
      source,
      sink: new FrameWriter(sink),
      intercept,
      maxFrameBytes,
      onDegrade: (n) => degrades.push(n),
      onInterceptError: (e) => errors.push(e),
    });
    return {
      source,
      relay,
      degrades,
      errors,
      out: () => Buffer.concat(chunks).toString(),
    };
  }

  it('relays frames verbatim when nothing intercepts them', async () => {
    const r = rig(async () => FORWARD);
    r.source.write('{"jsonrpc":"2.0" , "id":1,"result":{"z":1,"ratio":1.50}}\n');
    r.source.end();
    await r.relay.whenFinished();
    expect(r.out()).toBe('{"jsonrpc":"2.0" , "id":1,"result":{"z":1,"ratio":1.50}}\n');
  });

  it('holds the frames behind a held one instead of letting them overtake', async () => {
    let release: (() => void) | undefined;
    const seen: string[] = [];
    const r = rig(async (raw) => {
      seen.push(raw.toString());
      if (raw.toString() === 'A') await new Promise<void>((res) => (release = res));
      return FORWARD;
    });
    r.source.write('A\nB\nC\n');
    await tick(20);
    expect(seen).toEqual(['A']);
    expect(r.out()).toBe('');
    release?.();
    await tick(20);
    expect(seen).toEqual(['A', 'B', 'C']);
    expect(r.out()).toBe('A\nB\nC\n');
  });

  it('forwards the original frame when the interceptor throws', async () => {
    const r = rig(async () => {
      throw new Error('observer bug');
    });
    r.source.write('{"a":1}\n');
    await tick(20);
    expect(r.out()).toBe('{"a":1}\n');
    expect(r.errors).toHaveLength(1);
  });

  it('degrades to a raw byte pipe on an oversized frame, losing no bytes', async () => {
    const r = rig(async () => FORWARD, 16);
    r.source.write('short\n');
    r.source.write('x'.repeat(40));
    await tick(20);
    r.source.write('yyy\nmore\n');
    r.source.end();
    await r.relay.whenFinished();
    expect(r.relay.isDegraded).toBe(true);
    expect(r.degrades).toHaveLength(1);
    expect(r.out()).toBe(`short\n${'x'.repeat(40)}yyy\nmore\n`);
  });

  it('relays a trailing fragment that never got its newline', async () => {
    const r = rig(async () => FORWARD);
    r.source.write('{"a":1}\n{"b":2');
    r.source.end();
    await r.relay.whenFinished();
    expect(r.out()).toBe('{"a":1}\n{"b":2');
  });

  it('applies replace and drop actions', async () => {
    const r = rig(async (raw) => {
      if (raw.toString() === 'replace-me') return { kind: 'replace', raw: buf('REPLACED') };
      if (raw.toString() === 'drop-me') return { kind: 'drop' };
      return FORWARD;
    });
    r.source.write('keep\nreplace-me\ndrop-me\nkeep2\n');
    r.source.end();
    await r.relay.whenFinished();
    expect(r.out()).toBe('keep\nREPLACED\nkeep2\n');
  });
});
