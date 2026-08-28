/**
 * `graphmind mcp-proxy`, attacked from both ends.
 *
 * This is the only place in GraphMind where *both* peers are untrusted: the
 * proxy sits between somebody's coding agent and somebody else's MCP server,
 * parsing JSON-RPC it did not write, cannot validate, and must not reject. Its
 * own doc comment orders its contract, and the order is the right one:
 *
 *   1. relay the conversation byte-for-byte;
 *   2. never break the session — not when GraphMind is down, not when the
 *      socket dies mid-hold, not when a payload is too big to frame;
 *   3. stdout carries the protocol and nothing else.
 *
 * A debugger that corrupts one byte of somebody's tool call is worse than no
 * debugger, so #1 is tested the only way it can be: send bytes no well-behaved
 * peer would, echo them back through a byte-faithful fixture server, and
 * compare. Anything the proxy normalises — a `\r` before the newline, a
 * re-encoded JSON number, a dropped empty frame — shows up as a diff.
 *
 * The proxy is a sibling's package (`packages/cli/src/mcp-proxy/`) and is only
 * read here, never edited. Everything below drives the shipped `dist/cli.js`
 * as a child process, exactly as an `mcpServers` config would.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { hostileText } from '../src/fuzz.js';
import { ProxyPeer } from '../src/proxy-peer.js';
import { RawViewer, WireServer, sleep, type WireFrame } from '../src/wire.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Frames a hostile MCP client might send. One line each — `\n` frames. */
function hostileFrames(): string[] {
  const jsonRpc = [
    // legal JSON-RPC that the proxy must relay but cannot correlate
    '{"jsonrpc":"2.0","id":null,"error":{"code":-1,"message":"unpairable"}}',
    '{"jsonrpc":"2.0","id":1.5,"method":"tools/call"}',
    '{"jsonrpc":"2.0","id":true,"method":"tools/call"}',
    '{"jsonrpc":"2.0","id":{"nested":"id"},"method":"tools/call"}',
    '{"jsonrpc":"2.0","id":[1,2],"method":"tools/call"}',
    // a batch (dropped in MCP 2025-06-18; older peers still emit them)
    '[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]',
    '[]',
    '[[[[[1]]]]]',
    // id collisions and type confusion between "1" and 1
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}',
    '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{}}',
    '{"jsonrpc":"2.0","id":1,"result":{"first":true}}',
    '{"jsonrpc":"2.0","id":1,"result":{"second":true}}',
    // a response for an id nobody asked about
    '{"jsonrpc":"2.0","id":999999,"result":{"unsolicited":true}}',
    // both result and error
    '{"jsonrpc":"2.0","id":2,"result":1,"error":{"code":1,"message":"both"}}',
    // prototype pollution through params and through a tool result
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"__proto__":{"pwned":true}}}',
    '{"jsonrpc":"2.0","id":4,"result":{"content":[],"__proto__":{"pwned":true}}}',
    '{"jsonrpc":"2.0","id":5,"method":"__proto__","params":null}',
    '{"jsonrpc":"2.0","id":6,"method":"constructor","params":{}}',
    // wrong version, missing version, method of the wrong type
    '{"jsonrpc":"1.0","id":7,"method":"tools/call"}',
    '{"id":8,"method":"tools/call"}',
    '{"jsonrpc":"2.0","id":9,"method":42}',
    // in-band tool failure (the error gate has to look for this, not -32xxx)
    '{"jsonrpc":"2.0","id":10,"result":{"isError":true,"content":[{"type":"text","text":"x"}]}}',
    // unicode that must survive re-encoding
    '{"jsonrpc":"2.0","id":11,"result":{"s":"\\ud800"}}',
    '{"jsonrpc":"2.0","id":12,"result":{"s":"\\u2028\\u2029\\u202e"}}',
    '{"jsonrpc":"2.0","id":13,"result":{"s":"\\u0000"}}',
    // numbers JSON allows and JS cannot round-trip
    '{"jsonrpc":"2.0","id":14,"result":{"n":9007199254740993}}',
    '{"jsonrpc":"2.0","id":15,"result":{"n":1e999}}',
    '{"jsonrpc":"2.0","id":16,"result":{"n":-0}}',
    // whitespace and framing edge cases
    '   {"jsonrpc":"2.0","id":17,"method":"spaced"}   ',
    '',
    ' ',
  ];
  // Plus the general corpus, minus anything containing a newline (which would
  // be two frames) or large enough to make the comparison unreadable.
  const general = hostileText().filter(
    (text) => !text.includes('\n') && text.length > 0 && text.length < 4_096,
  );
  return [...jsonRpc, ...general];
}

describe('the proxy is byte-faithful under hostile input', () => {
  it('relays every hostile frame back byte-for-byte, with GraphMind attached', async () => {
    // Pause-on-error off. With the shipped default armed, a correlated error
    // response is *supposed* to stop this direction of the conversation —
    // that is what a breakpoint is, and it is pinned in its own block below.
    // Here the question is byte-faithfulness, so nothing is armed.
    const server = await WireServer.boot({ pauseOnError: 'off' });
    cleanups.push(() => server.close());
    const peer = await ProxyPeer.start({ port: server.port });
    cleanups.push(() => peer.close());

    const frames = hostileFrames();
    expect(frames.length).toBeGreaterThan(60);
    const sent = Buffer.from(frames.map((frame) => `${frame}\n`).join(''), 'utf8');
    peer.write(sent);

    await peer.waitForBytes(sent.length, 60_000);
    // The strongest statement available: the bytes the client got back are the
    // bytes it sent. Not "equivalent JSON" — the same bytes.
    expect(peer.stdout().equals(sent)).toBe(true);
    expect(peer.alive).toBe(true);
    expect(await server.alive()).toBe(true);
  }, 120_000);

  it('preserves a `\\r` before the newline, an empty frame and a NUL byte', async () => {
    // Each of these is a thing a naive framer silently normalises. The SDK's
    // own ReadBuffer strips the `\r`; the proxy must not, or the server sees
    // different bytes than the client sent.
    const peer = await ProxyPeer.start();
    cleanups.push(() => peer.close());
    const sent = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"crlf"}\r\n', 'utf8'),
      Buffer.from('\n', 'utf8'),
      Buffer.from('{"jsonrpc":"2.0","id":2,"method":"nul"}', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('\n', 'utf8'),
    ]);
    peer.write(sent);
    await peer.waitForBytes(sent.length, 30_000);
    expect(peer.stdout().equals(sent)).toBe(true);
  }, 60_000);

  it('relays a frame split across many small writes', async () => {
    // Framing state is the classic place to lose bytes. One frame, one byte
    // per write, is the worst case.
    const peer = await ProxyPeer.start();
    cleanups.push(() => peer.close());
    const frame = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"a":"bcdefghij"}}';
    for (const char of frame) peer.write(char);
    peer.write('\n');
    const expected = Buffer.from(`${frame}\n`, 'utf8');
    await peer.waitForBytes(expected.length, 30_000);
    expect(peer.stdout().equals(expected)).toBe(true);
  }, 60_000);

  it('relays a multi-megabyte frame unchanged', async () => {
    const peer = await ProxyPeer.start();
    cleanups.push(() => peer.close());
    const frame = `{"jsonrpc":"2.0","id":1,"result":{"big":"${'A'.repeat(4 * 1024 * 1024)}"}}`;
    const expected = Buffer.from(`${frame}\n`, 'utf8');
    peer.write(expected);
    await peer.waitForBytes(expected.length, 60_000);
    expect(peer.stdout().equals(expected)).toBe(true);
    expect(peer.alive).toBe(true);
  }, 120_000);

  it('degrades to a raw byte pipe past --max-frame-bytes, losing nothing', async () => {
    // The documented failure mode: "stop observing, keep relaying". A frame
    // over the ceiling must still arrive, in full, unmodified.
    const peer = await ProxyPeer.start({ maxFrameBytes: 1024 });
    cleanups.push(() => peer.close());
    const frame = `{"jsonrpc":"2.0","id":1,"result":{"big":"${'B'.repeat(64 * 1024)}"}}`;
    const expected = Buffer.from(`${frame}\n`, 'utf8');
    peer.write(expected);
    await peer.waitForBytes(expected.length, 30_000);
    expect(peer.stdout().equals(expected)).toBe(true);
    expect(peer.alive).toBe(true);
  }, 60_000);
});

describe('the proxy never breaks the session', () => {
  it('relays perfectly with no GraphMind running at all (fail-open)', async () => {
    // `--port 1` — nothing is listening. The pipe must not notice.
    const peer = await ProxyPeer.start();
    cleanups.push(() => peer.close());
    const frames = hostileFrames().slice(0, 40);
    const sent = Buffer.from(frames.map((frame) => `${frame}\n`).join(''), 'utf8');
    peer.write(sent);
    await peer.waitForBytes(sent.length, 60_000);
    expect(peer.stdout().equals(sent)).toBe(true);
    expect(peer.alive).toBe(true);
  }, 120_000);

  it('keeps relaying after the GraphMind server disappears mid-conversation', async () => {
    const server = await WireServer.boot({ pauseOnError: 'off' });
    const peer = await ProxyPeer.start({ port: server.port });
    cleanups.push(() => peer.close());

    const first = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"before"}\n', 'utf8');
    peer.write(first);
    await peer.waitForBytes(first.length, 30_000);

    await server.close();
    await sleep(300);

    const second = Buffer.from('{"jsonrpc":"2.0","id":2,"method":"after"}\n', 'utf8');
    peer.write(second);
    await peer.waitForBytes(first.length + second.length, 30_000);
    expect(peer.stdout().equals(Buffer.concat([first, second]))).toBe(true);
    expect(peer.alive).toBe(true);
  }, 120_000);

  it('puts nothing but protocol bytes on stdout, whatever it is told', async () => {
    // The contract that makes the proxy usable at all: a single stray
    // diagnostic line on stdout corrupts the client's JSON-RPC stream.
    const server = await WireServer.boot({ pauseOnError: 'off' });
    cleanups.push(() => server.close());
    const peer = await ProxyPeer.start({ port: server.port });
    cleanups.push(() => peer.close());

    const frames = ['not json at all', '{', '"a string"', '{"jsonrpc":"2.0","id":1,"method":"m"}'];
    const sent = Buffer.from(frames.map((frame) => `${frame}\n`).join(''), 'utf8');
    peer.write(sent);
    await peer.waitForBytes(sent.length, 30_000);
    await sleep(500);
    // Exactly the echo, nothing appended.
    expect(peer.stdout().equals(sent)).toBe(true);
    // ...and the human-facing words really did go somewhere: stderr.
    expect(peer.stderr.join('')).toContain('mcp-proxy');
  }, 60_000);
});

describe('what the proxy reports to GraphMind', () => {
  it('is always a valid envelope, however hostile the conversation', async () => {
    const server = await WireServer.boot({ pauseOnError: 'off' });
    cleanups.push(() => server.close());
    const peer = await ProxyPeer.start({ port: server.port });
    cleanups.push(() => peer.close());

    const frames = hostileFrames();
    const sent = Buffer.from(frames.map((frame) => `${frame}\n`).join(''), 'utf8');
    peer.write(sent);
    await peer.waitForBytes(sent.length, 60_000);
    await sleep(1_500); // let the reporter's envelopes land

    const runs = await server.runs();
    expect(runs.length).toBeGreaterThan(0);
    const events: WireFrame[] = [];
    for (const run of runs) events.push(...(await server.events(run.id)));
    expect(events.length).toBeGreaterThan(0);
    const bad = events.filter((event) => parseEnvelope(event).kind === 'invalid');
    expect(
      bad.map((event) => ({ type: event.type, seq: event.seq, runId: event.runId })),
    ).toEqual([]);
    expect(await server.alive()).toBe(true);
  }, 120_000);
});

describe('the error gate stops the conversation, on purpose', () => {
  /**
   * Pause-on-error is armed by default (decisions.md #8), and in the proxy
   * that means something stronger than in an in-process adapter: `relay.ts`
   * pauses the source stream for the whole drain, so a held gate stops *this
   * direction of the conversation*. A correlated JSON-RPC error response is
   * therefore where the MCP client's request appears to hang.
   *
   * That is what a breakpoint is for, and the proxy handles it about as well
   * as it can be handled — it says so on stderr, names the URL to resume it
   * at, and warns that the client is waiting. Pinned here because the
   * consequence is unusually large: `graphmind mcp-proxy` is meant to be
   * dropped into an `mcpServers` config and forgotten, so a developer with
   * `graphmind serve` running and the viewer tab closed will see their agent
   * hang on the first failing tool call with no UI open to explain it.
   *
   * The other half — that the hold is a pause and not a deadlock — is the
   * second assertion: a viewer resuming releases it and the exact bytes
   * arrive.
   */
  it('holds a correlated error response, says so, and releases on resume', async () => {
    const server = await WireServer.boot(); // shipped default: error gate armed
    cleanups.push(() => server.close());
    const viewer = await RawViewer.connect(server);
    cleanups.push(async () => viewer.close());
    viewer.subscribe('*');
    const peer = await ProxyPeer.start({ port: server.port });
    cleanups.push(() => peer.close());

    // A request the proxy can correlate, then its error response.
    const request = Buffer.from('{"jsonrpc":"2.0","id":7,"method":"tools/call"}\n', 'utf8');
    peer.write(request);
    await peer.waitForBytes(request.length, 30_000);

    const failure = Buffer.from(
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"the tool failed"}}\n',
      'utf8',
    );
    peer.write(failure);

    // It must NOT be relayed while the gate is held.
    await sleep(1_500);
    expect(peer.stdout().length).toBe(request.length);
    expect(peer.stderr.join('')).toContain('error gate');
    expect(peer.stderr.join('')).toContain(String(server.port));

    // Release every hold until the bytes arrive. Two are expected: this
    // frame gates on the way to the server, and the echo of it gates again on
    // the way back — the gate is per direction, which is the correct
    // behaviour and worth being explicit about.
    const wanted = request.length + failure.length;
    const resumed = new Set<string>();
    const deadline = Date.now() + 30_000;
    while (peer.stdout().length < wanted && Date.now() < deadline) {
      for (const run of await server.runs()) {
        for (const event of await server.events(run.id)) {
          if (event.type !== 'exec.paused') continue;
          const pauseId = String((event.payload as { pauseId?: string }).pauseId);
          if (resumed.has(pauseId)) continue;
          resumed.add(pauseId);
          viewer.control(run.id, 'exec.resume', { pauseId, action: 'continue' });
        }
      }
      await sleep(100);
    }
    expect(resumed.size).toBeGreaterThan(0);
    expect(viewer.errors()).toEqual([]);

    // ...and the held bytes arrive, unmodified.
    expect(peer.stdout().equals(Buffer.concat([request, failure]))).toBe(true);
    expect(peer.alive).toBe(true);
  }, 120_000);
});
