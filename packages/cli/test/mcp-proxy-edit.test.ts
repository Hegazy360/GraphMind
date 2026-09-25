/**
 * `graphmind mcp-proxy`: edited tool arguments (0.6.0, contract C2 / W2).
 *
 *  - continue + input at a tools/call `before` gate rewrites ONLY that
 *    frame: its `params.arguments` value is replaced by the merged edit in
 *    the frame's own bytes (id, name, `_meta`, spacing and key order kept),
 *    and it is relayed in place of the original;
 *  - retry + input at `after` / `error` sends the rewritten request down the
 *    retry path (and a later plain retry re-sends what last ran);
 *  - an edit is checked against the tool's `inputSchema` from the server's
 *    last `tools/list` (JSON-schema-lite), refused with the gate still held;
 *  - every other frame stays byte-for-byte;
 *  - the tool's JSON-RPC result reaches the after-gate detectors;
 *  - nothing changes under a 0.5 debugger, with edits disabled, or detached.
 *
 * The server (fixtures/mcp-proxy/args-server.mjs) quotes the exact request
 * line it received, so every assertion about "what reached the server" is
 * about bytes, not about what the proxy meant to send.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AfterGateContext, GateDetector, Session, SessionOptions } from '@graphmind-ai/client';
import { FakeViewer, ProxyRig, tick, waitUntil, type ReceivedFrame } from './mcp-proxy-harness.js';

let viewer: FakeViewer | undefined;
let rig: ProxyRig | undefined;

afterEach(async () => {
  if (rig !== undefined) {
    rig.endClient();
    await Promise.race([rig.handle.done, tick(3000)]);
    rig.handle.stop('SIGKILL');
    rig = undefined;
  }
  if (viewer !== undefined) {
    await viewer.close();
    viewer = undefined;
  }
});

const EDIT_HUB = ['edit-input'];

async function attach(
  options: {
    breakpoints?: Parameters<FakeViewer['setBreakpoint']>[0][];
    hubCapabilities?: string[] | undefined;
    sessionOptions?: SessionOptions;
  } = {},
): Promise<{ viewer: FakeViewer; rig: ProxyRig }> {
  viewer = await FakeViewer.start({
    breakpoints: options.breakpoints ?? [],
    hubCapabilities: 'hubCapabilities' in options ? options.hubCapabilities : EDIT_HUB,
  });
  rig = new ProxyRig({
    server: 'args-server.mjs',
    viewerUrl: viewer.url,
    waitForAttach: true,
    sessionOptions: { env: {}, ...options.sessionOptions },
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { viewer, rig };
}

function detectorsOf(session: Session): GateDetector[] {
  return (session as unknown as { detectors: GateDetector[] }).detectors;
}

function pausedAt(v: FakeViewer, nodeId: string, point: string, n = 1): Promise<ReceivedFrame> {
  const match = (f: ReceivedFrame): boolean =>
    f.type === 'exec.paused' && f.payload['nodeId'] === nodeId && f.payload['point'] === point;
  return waitUntil(() => v.received.filter(match).length >= n, `${nodeId} ${point} #${n}`).then(
    () => v.received.filter(match)[n - 1] as ReceivedFrame,
  );
}

const pauseIdOf = (frame: ReceivedFrame): string => frame.payload['pauseId'] as string;

async function refusal(v: FakeViewer, pauseId: string, n = 1): Promise<ReceivedFrame> {
  const match = (f: ReceivedFrame): boolean => f.type === 'exec.refused' && f.payload['pauseId'] === pauseId;
  await waitUntil(() => v.received.filter(match).length >= n, `refusal #${n}`);
  return v.received.filter(match)[n - 1] as ReceivedFrame;
}

/** The request line the server says it received (quoted in the tool result's text). */
function receivedLine(response: Record<string, unknown>): string {
  const result = response['result'] as { content: { text: string }[] };
  return result.content[0]?.text ?? '';
}

/** The server's answer bytes for a tool result quoting `line` (args-server's exact format). */
function answerBytes(id: number, line: string, extra = ''): string {
  return `{"jsonrpc":"2.0" , "id":${JSON.stringify(id)},"result":{"content":[{"type":"text","text":${JSON.stringify(line)}}],"ratio":1.50${extra}}}`;
}

/** Ask for tools/list so the proxy knows the schemas. */
async function listTools(r: ProxyRig, id = 900): Promise<void> {
  r.request(id, 'tools/list');
  await r.response(id);
}

describe('continue + input at the before gate', () => {
  it('rewrites params.arguments of the held frame only: id, name, _meta and key order kept; the answer is relayed untouched', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', name: 'echoArgs' }] });
    const sent = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"caf\\u00e9","times":2},"_meta":{"progressToken":"p-1"}}}';
    r.sendRaw(`${sent}\n`);
    const paused = await pausedAt(v, 'tool:echoArgs', 'before');
    expect(paused.payload['editable']).toBe(true);
    v.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { arguments: { times: 5 } }, requestId: 'req-1' });

    const response = await r.response(1);
    const reached = receivedLine(response);
    expect(reached).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"café","times":5},"_meta":{"progressToken":"p-1"}}}',
    );
    // The server's answer reached the client byte for byte.
    expect(r.out.toString('utf8')).toContain(`${answerBytes(1, reached)}\n`);

    // The trail has the recorded input's shape (the request's params), so the
    // viewer's before/after lines up with node.started.input.
    const resumed = await v.waitFor((f) => f.type === 'exec.resumed' && f.payload['pauseId'] === pauseIdOf(paused));
    expect(resumed.payload['edited']).toEqual({
      after: { name: 'echoArgs', arguments: { text: 'café', times: 5 }, _meta: { progressToken: 'p-1' } },
    });
    expect(resumed.payload['requestId']).toBe('req-1');
    const started = v.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:echoArgs');
    expect(started?.payload['input']).toEqual({
      name: 'echoArgs',
      arguments: { text: 'café', times: 2 },
      _meta: { progressToken: 'p-1' },
    });
    const finished = await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:echoArgs');
    expect(finished.payload['status']).toBe('ok');
  });

  it('only the arguments are rewritten: an id above 2^53 and _meta numbers reach the server as the client wrote them', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', name: 'echoArgs' }] });
    const sent =
      '{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"a"},"_meta":{"progressToken":1e400}}}';
    r.sendRaw(`${sent}\n`);
    const paused = await pausedAt(v, 'tool:echoArgs', 'before');
    v.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { arguments: { text: 'b' } } });
    // (A JS client cannot tell 9007199254740993 from ...992: both are the same number.)
    const reached = receivedLine(await r.response(9007199254740993));
    expect(reached).toBe(
      '{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"b"},"_meta":{"progressToken":1e400}}}',
    );
  });

  it('the recorded input sent back whole (as a viewer pre-fills it) works; name and _meta are locked', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', name: 'echoArgs' }] });
    r.request(1, 'tools/call', { name: 'echoArgs', arguments: { text: 'a', times: 1 }, _meta: { progressToken: 7 } });
    const pauseId = pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'before'));

    v.resumeWith({ pauseId, action: 'continue', input: { name: 'rm_rf', arguments: { text: 'b' } } });
    const renamed = await refusal(v, pauseId, 1);
    expect(renamed.payload['code']).toBe('shape');
    expect(String(renamed.payload['message'])).toContain('"name" must stay as the client sent it');
    v.resumeWith({ pauseId, action: 'continue', input: { arguments: { text: 'b' }, _meta: { progressToken: 8 } } });
    expect(String((await refusal(v, pauseId, 2)).payload['message'])).toContain('"_meta"');
    v.resumeWith({ pauseId, action: 'continue', input: { arguments: { text: 'b' }, task: { ttl: 1 } } });
    expect(String((await refusal(v, pauseId, 3)).payload['message'])).toContain('"task"');
    v.resumeWith({ pauseId, action: 'continue', input: { arguments: 'not an object' } });
    expect((await refusal(v, pauseId, 4)).payload['code']).toBe('shape');

    v.resumeWith({
      pauseId,
      action: 'continue',
      input: { _meta: { progressToken: 7 }, name: 'echoArgs', arguments: { text: 'whole', times: 1 } },
    });
    expect(receivedLine(await r.response(1))).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"whole","times":1},"_meta":{"progressToken":7}}}',
    );
  });

  // Integration defect (tool gates x W0 fixes): under a HIDE switch the proxy
  // merged the edit onto the hidden live arguments and compared `_meta` with
  // the hidden live value — both answers leak a hidden value per edit.
  it('under GRAPHMIND_HIDE_TOOL_ARGS an edit replaces the arguments wholesale and may not name any other key', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'tool', name: 'echoArgs' }],
      sessionOptions: { env: { GRAPHMIND_HIDE_TOOL_ARGS: '1' } },
    });
    r.request(1, 'tools/call', { name: 'echoArgs', arguments: { text: 'a', times: 3 }, _meta: { progressToken: 7 } });
    const paused = await pausedAt(v, 'tool:echoArgs', 'before');
    expect(paused.payload['editable']).toBe(true);
    const pauseId = pauseIdOf(paused);

    // Naming `_meta` (equal or not to the hidden live value) is refused without a comparison.
    v.resumeWith({ pauseId, action: 'continue', input: { arguments: { text: 'b' }, _meta: { progressToken: 7 } } });
    const refused = await refusal(v, pauseId, 1);
    expect(refused.payload['code']).toBe('shape');
    expect(refused.payload['message']).toBeUndefined(); // a covering HIDE switch drops the message
    v.resumeWith({ pauseId, action: 'continue', input: { name: 'echoArgs', arguments: { text: 'b' } } });
    expect((await refusal(v, pauseId, 2)).payload['code']).toBe('shape');

    // Only arguments: a full replacement — `times` is NOT carried over from the hidden live call.
    v.resumeWith({ pauseId, action: 'continue', input: { arguments: { text: 'b' } } });
    const line = JSON.parse(receivedLine(await r.response(1))) as { params: Record<string, unknown> };
    expect(line.params['arguments']).toEqual({ text: 'b' });
    expect(line.params['_meta']).toEqual({ progressToken: 7 });
    const resumed = v.received.find((f) => f.type === 'exec.resumed' && f.payload['pauseId'] === pauseId);
    expect((resumed?.payload['edited'] as { after: unknown }).after).toBe('__REDACTED__');
  });

  it('every other frame stays byte-for-byte, before and after an edited one', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', name: 'echoArgs' }] });
    const odd = (id: number, text: string): string =>
      `{"jsonrpc":"2.0",  "id":${id},"method":"tools/call","params":{"arguments":{"times":1.50,"text":"${text}"},"name":"echoArgs"}}`;

    r.sendRaw(`${odd(1, 'first')}\n`);
    v.resume(pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'before', 1)), 'continue');
    expect(receivedLine(await r.response(1))).toBe(odd(1, 'first'));

    r.sendRaw(`${odd(2, 'second')}\n`);
    v.resumeWith({ pauseId: pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'before', 2)), action: 'continue', input: { arguments: { text: 'EDITED' } } });
    // Only the arguments value is re-encoded; the rest keeps the client's bytes.
    expect(receivedLine(await r.response(2))).toBe(
      '{"jsonrpc":"2.0",  "id":2,"method":"tools/call","params":{"arguments":{"times":1.5,"text":"EDITED"},"name":"echoArgs"}}',
    );

    r.sendRaw(`${odd(3, 'third')}\n`);
    v.resume(pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'before', 3)), 'continue');
    expect(receivedLine(await r.response(3))).toBe(odd(3, 'third'));
  });

  it('refuses an edit the listed inputSchema forbids (code schema, no value quoted); the gate stays held; a valid edit then runs', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', name: 'echoArgs' }] });
    await listTools(r);
    r.callTool(1, 'echoArgs', { text: 'hi' });
    const pauseId = pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'before'));

    const cases: [unknown, RegExp][] = [
      [{ times: 0 }, /field "times" must be at least 1/],
      [{ text: 7777 }, /field "text" must be string, got integer/],
      [{ secret: 'SECRET-VALUE' }, /field "secret" is not a parameter of this tool/],
    ];
    for (const [index, [args, message]] of cases.entries()) {
      v.resumeWith({ pauseId, action: 'continue', input: { arguments: args } });
      const refused = await refusal(v, pauseId, index + 1);
      expect(refused.payload['code']).toBe('schema');
      expect(String(refused.payload['message'])).toMatch(message);
      expect(JSON.stringify(refused.payload)).not.toMatch(/SECRET-VALUE|7777/);
    }
    // Still held: the server has seen nothing.
    await tick(100);
    expect(r.out.toString('utf8')).not.toContain('"id":1,');

    v.resumeWith({ pauseId, action: 'continue', input: { arguments: { times: 3 } } });
    expect(JSON.parse(receivedLine(await r.response(1)))).toMatchObject({
      params: { name: 'echoArgs', arguments: { text: 'hi', times: 3 } },
    });
  });

  it('with no tools/list seen (or a tool listed without a schema), the merged edit is relayed and the server judges', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool' }] });
    r.callTool(1, 'echoArgs', { text: 'hi' });
    v.resumeWith({ pauseId: pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'before')), action: 'continue', input: { arguments: { anything: true } } });
    expect(JSON.parse(receivedLine(await r.response(1)))).toMatchObject({
      params: { arguments: { text: 'hi', anything: true } },
    });

    await listTools(r);
    r.callTool(2, 'loose', { a: 1 });
    v.resumeWith({ pauseId: pauseIdOf(await pausedAt(v, 'tool:loose', 'before')), action: 'continue', input: { arguments: { b: 2 } } });
    expect(JSON.parse(receivedLine(await r.response(2)))).toMatchObject({ params: { arguments: { a: 1, b: 2 } } });
  });

  it('notifications/tools/list_changed forgets the schemas: a stale schema never refuses an edit', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', name: 'echoArgs' }] });
    await listTools(r);
    r.callTool(1, 'relist');
    await r.response(1);
    await r.nextLine((line) => line.includes('list_changed'));
    r.callTool(2, 'echoArgs', { text: 'hi' });
    const pauseId = pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'before'));
    v.resumeWith({ pauseId, action: 'continue', input: { arguments: { times: 0 } } });
    expect(JSON.parse(receivedLine(await r.response(2)))).toMatchObject({ params: { arguments: { text: 'hi', times: 0 } } });
    expect(v.ofType('exec.refused')).toHaveLength(0);
  });

  it('a call made without arguments can be given them', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', name: 'echoArgs' }] });
    r.request(1, 'tools/call', { name: 'echoArgs' });
    const paused = await pausedAt(v, 'tool:echoArgs', 'before');
    expect(paused.payload['editable']).toBe(true);
    v.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { arguments: { text: 'supplied' } } });
    expect(receivedLine(await r.response(1))).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"supplied"}}}',
    );
  });

  it('two calls in a row: editing the second leaves the first on its own bytes', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', name: 'echoArgs' }] });
    const first = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"one"}}}';
    r.sendRaw(`${first}\n`);
    const a = await pausedAt(v, 'tool:echoArgs', 'before', 1);
    // The relay holds the client->server direction while a gate is held; the
    // second call queues behind the first, so release it before editing #2.
    v.resume(pauseIdOf(a), 'continue');
    expect(receivedLine(await r.response(1))).toBe(first);
    r.callTool(2, 'echoArgs', { text: 'two' });
    v.resumeWith({ pauseId: pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'before', 2)), action: 'continue', input: { arguments: { text: 'TWO' } } });
    expect(JSON.parse(receivedLine(await r.response(2)))).toMatchObject({ params: { arguments: { text: 'TWO' } } });
  });

  it('non-tool requests are not editable', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'resource' }] });
    r.request(1, 'resources/read', { uri: 'test://x' });
    const paused = await pausedAt(v, 'resource:test://x', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    v.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { uri: 'test://y' } });
    expect((await refusal(v, pauseIdOf(paused))).payload['code']).toBe('unsupported');
    v.resume(pauseIdOf(paused), 'continue');
    const response = (await r.response(1)) as { result: { contents: { uri: string }[] } };
    expect(response.result.contents[0]?.uri).toBe('test://x');
  });
});

describe('retry + input at the error and after gates', () => {
  it('an isError result: retry + input re-sends the rewritten request; the client only sees the good answer', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', point: 'error' }] });
    r.callTool(1, 'divide', { a: 10, b: 0 });
    const paused = await pausedAt(v, 'tool:divide', 'error');
    expect(paused.payload['editable']).toBe(true);
    v.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { arguments: { b: 4 } } });
    const response = await r.response(1);
    expect((response['result'] as { quotient?: number }).quotient).toBe(2.5);
    expect(JSON.parse(receivedLine(response))).toMatchObject({ params: { arguments: { a: 10, b: 4 } } });
    expect(r.out.toString('utf8')).not.toContain('division by zero');
    const finished = await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:divide');
    expect(finished.payload['status']).toBe('ok');
    expect(finished.payload['retries']).toBe(1);
  });

  it('a JSON-RPC error: retry + input fixes it; a later plain retry re-sends what last ran', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'tool', point: 'error' }, { kind: 'tool', point: 'after' }],
    });
    r.callTool(1, 'strict', { token: 'bad', keep: 'me' });
    v.resumeWith({ pauseId: pauseIdOf(await pausedAt(v, 'tool:strict', 'error')), action: 'retry', input: { arguments: { token: 'ok' } } });
    // The fixed call succeeds and holds at `after`; a plain retry re-sends the EDITED bytes.
    v.resume(pauseIdOf(await pausedAt(v, 'tool:strict', 'after', 1)), 'retry');
    v.resume(pauseIdOf(await pausedAt(v, 'tool:strict', 'after', 2)), 'continue');
    const response = await r.response(1);
    expect(receivedLine(response)).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"strict","arguments":{"token":"ok","keep":"me"}}}',
    );
    const finished = await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:strict');
    expect(finished.payload['retries']).toBe(2);
  });

  it('retry without input re-sends the original bytes, as before', async () => {
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ kind: 'tool', point: 'after' }] });
    const sent = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"x","times":1.50}}}';
    r.sendRaw(`${sent}\n`);
    v.resume(pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'after', 1)), 'retry');
    v.resume(pauseIdOf(await pausedAt(v, 'tool:echoArgs', 'after', 2)), 'continue');
    expect(receivedLine(await r.response(1))).toBe(sent);
  });

  it('the after gate hands the JSON-RPC result to the detectors; retry + input there re-sends the edit', async () => {
    const { viewer: v, rig: r } = await attach();
    const seen: AfterGateContext[] = [];
    detectorsOf(r.handle.session).push((context) => {
      seen.push(context);
      const text = (context.result as { content?: { text?: string }[] }).content?.[0]?.text ?? '';
      return text.includes('"bad"') ? { rule: 'error-result' } : undefined;
    });
    r.callTool(1, 'echoArgs', { text: 'bad' });
    const paused = await pausedAt(v, 'tool:echoArgs', 'after');
    expect(paused.payload['smart']).toEqual({ rule: 'error-result' });
    expect(paused.payload['editable']).toBe(true);
    expect(seen[0]?.node).toEqual({
      nodeId: 'tool:echoArgs',
      kind: 'tool',
      name: 'echoArgs',
      instanceId: paused.payload['instanceId'],
    });
    expect(typeof paused.payload['instanceId']).toBe('string');
    expect(seen[0]?.result).toMatchObject({ ratio: 1.5, content: [{ type: 'text' }] });
    v.resumeWith({ pauseId: pauseIdOf(paused), action: 'retry', input: { arguments: { text: 'good' } } });
    const response = await r.response(1);
    expect(JSON.parse(receivedLine(response))).toMatchObject({ params: { arguments: { text: 'good' } } });
    expect(r.out.toString('utf8').match(/"id":1,/g)).toHaveLength(1);
  });
});

describe('nothing changes without edit support', () => {
  it('a 0.5 debugger: no editable flag, the edit is refused (disabled), continue relays the original bytes', async () => {
    const { viewer: v, rig: r } = await attach({ hubCapabilities: undefined, breakpoints: [{ kind: 'tool' }] });
    const sent = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"orig"}}}';
    r.sendRaw(`${sent}\n`);
    const paused = await pausedAt(v, 'tool:echoArgs', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    v.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { arguments: { text: 'edited' } } });
    expect((await refusal(v, pauseIdOf(paused))).payload['code']).toBe('disabled');
    v.resume(pauseIdOf(paused), 'continue');
    expect(receivedLine(await r.response(1))).toBe(sent);
  });

  it('GRAPHMIND_DISABLE_EDIT_INPUT: no editable flag, the edit is refused (disabled)', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'tool' }],
      sessionOptions: { env: { GRAPHMIND_DISABLE_EDIT_INPUT: '1' } },
    });
    const hello = await v.waitForType('hello');
    expect(hello.payload['capabilities']).not.toContain('edit-input');
    r.callTool(1, 'echoArgs', { text: 'orig' });
    const paused = await pausedAt(v, 'tool:echoArgs', 'before');
    expect(paused.payload['editable']).toBeUndefined();
    v.resumeWith({ pauseId: pauseIdOf(paused), action: 'continue', input: { arguments: { text: 'edited' } } });
    expect((await refusal(v, pauseIdOf(paused))).payload['code']).toBe('disabled');
    v.resume(pauseIdOf(paused), 'continue');
    expect(JSON.parse(receivedLine(await r.response(1)))).toMatchObject({ params: { arguments: { text: 'orig' } } });
  });

  it('detached: gates are called exactly as in 0.5 (no options) and the bytes pass untouched', async () => {
    rig = new ProxyRig({ server: 'args-server.mjs', sessionOptions: { env: {} } });
    const gate = vi.spyOn(rig.handle.session, 'gate');
    const sent = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echoArgs","arguments":{"text":"x","times":1.50}}}';
    rig.sendRaw(`${sent}\n`);
    expect(receivedLine(await rig.response(1))).toBe(sent);
    rig.callTool(2, 'divide', { a: 1, b: 0 });
    await rig.response(2);
    expect(rig.handle.session.attached).toBe(false);
    expect(gate.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
  });
});
