/**
 * The model step's `after` gate (0.6.0, contract C4 / W4), through the REAL
 * Anthropic SDK client against a scripted transport: while a debugger is
 * attached it hands the session the normalized output (`{text,
 * finishReason, toolCalls, …}`), so a step `max_tokens` cut off in the middle
 * of a tool call is a smart hold (`truncated-tool-call`) —
 *   - `messages.create`: before the `Message` is returned;
 *   - `stream: true` / `messages.stream()`: before `message_stop` is handed
 *     over, so `MessageStream.finalMessage()` waits too;
 *   - abort there rejects with the run's AbortError; detached, the gate is
 *     called with no options; GRAPHMIND_BREAK_ON_TRUNCATED=0 turns it off.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AfterGateContext, GateDetector, Session } from '@graphmind-ai/client';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';
import { FakeAnthropicTransport, type Script } from './helpers/fake-anthropic.js';
import { attach } from './helpers/scenario.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(gmOptions: Partial<GraphmindOptions> = {}): Promise<{ viewer: FakeViewer; gm: Graphmind; warnings: string[] }> {
  const viewer = await FakeViewer.start();
  const warnings: string[] = [];
  const gm = graphmind({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    env: {},
    logger: (message) => warnings.push(message),
    ...gmOptions,
  });
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  await attach(gm);
  return { viewer, gm, warnings };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeClient(gm: Graphmind, script: Script) {
  const transport = new FakeAnthropicTransport(script);
  const raw = new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch: transport.fetch });
  return { client: gm.wrapClient(raw) as any, transport };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function detectorsOf(session: Session): GateDetector[] {
  return (session as unknown as { detectors: GateDetector[] }).detectors;
}

function llm(viewer: FakeViewer, type: string): ReceivedFrame[] {
  return viewer.ofType(type).filter((f) => f.payload['nodeId'] === 'llm:step');
}

function llmPause(viewer: FakeViewer): Promise<ReceivedFrame> {
  return waitUntil(() => llm(viewer, 'exec.paused').length >= 1, 8000, 'llm pause').then(
    () => llm(viewer, 'exec.paused')[0] as ReceivedFrame,
  );
}

/** A whole Message that `max_tokens` stopped inside a tool call. */
const TRUNCATED_MESSAGE = {
  id: 'm1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [
    { type: 'text', text: 'Writing.', citations: null },
    { type: 'tool_use', id: 'toolu_cut', name: 'write_file', input: { path: 'a.txt' } },
  ],
  stop_reason: 'max_tokens',
  stop_sequence: null,
  usage: { input_tokens: 30, output_tokens: 64 },
};

/** The same step as an SSE script: the tool_use block never closes. */
const TRUNCATED_EVENTS = [
  {
    type: 'message_start',
    message: {
      id: 'm2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 1 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_cut', name: 'write_file', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt","content":"hel' } },
  { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 64 } },
  { type: 'message_stop' },
];

const DETAIL_PARSED = 'the model was stopped at the token limit with 1 tool call requested';
const DETAIL_CUT = `${DETAIL_PARSED}; 1 call has arguments that did not parse`;

describe('messages.create: held before the Message is returned', () => {
  it('holds with the smart rule; the gate saw the normalized output; continue returns the message', async () => {
    const { viewer, gm } = await setup();
    const seen: AfterGateContext[] = [];
    detectorsOf(gm.session).unshift((context) => {
      if (context.node.kind === 'llm') seen.push(context);
      return undefined;
    });
    const { client } = makeClient(gm, () => ({ message: TRUNCATED_MESSAGE }));
    let settled = false;
    const promise = client.messages
      .create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'write' }] })
      .then((message: unknown) => {
        settled = true;
        return message;
      });
    const paused = await llmPause(viewer);
    const stepInstance = llm(viewer, 'node.started')[0]?.payload['instanceId'];
    expect(typeof stepInstance).toBe('string');
    expect(paused.payload).toEqual({
      pauseId: paused.payload['pauseId'],
      nodeId: 'llm:step',
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'truncated-tool-call', detail: DETAIL_PARSED },
      // The pause names the step's execution (exec.paused.instanceId, 0.6.0).
      instanceId: stepInstance,
    });
    expect(seen[0]?.result).toMatchObject({
      text: 'Writing.',
      finishReason: 'length',
      rawFinishReason: 'max_tokens',
      toolCalls: [{ id: 'toolu_cut', name: 'write_file', input: { path: 'a.txt' } }],
    });
    await tick(200);
    expect(settled).toBe(false);
    expect(llm(viewer, 'node.finished')).toHaveLength(0);

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const message = (await promise) as { id: string; stop_reason: string };
    expect(message).toMatchObject({ id: 'm1', stop_reason: 'max_tokens' });
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['status']).toBe('ok');
  });

  it('abort rejects create() (and withResponse()) with the AbortError; the step finishes aborted', async () => {
    const { viewer, gm } = await setup();
    const { client } = makeClient(gm, () => ({ message: TRUNCATED_MESSAGE }));
    const promise = gm.run('abort-me', () =>
      client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'write' }] }),
    );
    const paused = await llmPause(viewer);
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['status']).toBe('aborted');
  });

  it('retry cannot re-run the call there: it continues, with one warning', async () => {
    const { viewer, gm, warnings } = await setup();
    const { client, transport } = makeClient(gm, () => ({ message: TRUNCATED_MESSAGE }));
    const promise = client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [] });
    const paused = await llmPause(viewer);
    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    expect(await promise).toMatchObject({ id: 'm1' });
    expect(transport.requests).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('model step at its after gate'))).toHaveLength(1);
  });
});

describe('streaming: held before message_stop', () => {
  it('stream: true — the host has message_delta but not message_stop until continue', async () => {
    const { viewer, gm } = await setup();
    const { client } = makeClient(gm, () => ({ events: TRUNCATED_EVENTS }));
    const stream = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [], stream: true });
    const types: string[] = [];
    const consumed = (async () => {
      for await (const event of stream) types.push((event as { type: string }).type);
    })();
    const paused = await llmPause(viewer);
    expect(paused.payload).toMatchObject({
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'truncated-tool-call', detail: DETAIL_CUT },
    });
    await tick(200);
    expect(types).toContain('message_delta');
    expect(types).not.toContain('message_stop');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await consumed;
    expect(types[types.length - 1]).toBe('message_stop');
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload).toMatchObject({ status: 'ok', output: { finishReason: 'length' } });
  });

  it('messages.stream(): finalMessage() waits for the hold; abort rejects it', async () => {
    const { viewer, gm } = await setup();
    const { client } = makeClient(gm, () => ({ events: TRUNCATED_EVENTS }));
    const messageStream = client.messages.stream({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [] });
    messageStream.on('error', () => undefined);
    let settled = false;
    const final = (messageStream.finalMessage() as Promise<unknown>).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    const paused = await llmPause(viewer);
    await tick(200);
    expect(settled).toBe(false);
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    const error = await final.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeDefined();
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['status']).toBe('aborted');
  });

  it('a normal streamed step (tool_use) passes without holding', async () => {
    const { viewer, gm } = await setup();
    const events = TRUNCATED_EVENTS.map((event) =>
      event.type === 'message_delta' ? { ...event, delta: { stop_reason: 'tool_use', stop_sequence: null } } : event,
    );
    const { client } = makeClient(gm, () => ({ events }));
    const stream = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [], stream: true });
    for await (const _event of stream) {
      // consume
    }
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('GRAPHMIND_BREAK_ON_TRUNCATED=0: recorded, not held', async () => {
    const { viewer, gm } = await setup({ env: { GRAPHMIND_BREAK_ON_TRUNCATED: '0' } });
    const { client } = makeClient(gm, () => ({ events: TRUNCATED_EVENTS }));
    const stream = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [], stream: true });
    for await (const _event of stream) {
      // consume
    }
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['output']).toMatchObject({ finishReason: 'length' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });
});

describe('detached', () => {
  it('the after gate is called with no options (message and stream), exactly as the other gates', async () => {
    // Port 9 (discard): never a GraphMind server, so the session stays detached.
    const gm = graphmind({ url: 'ws://127.0.0.1:9/ingest', enabled: true, env: {}, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const gate = vi.spyOn(gm.session, 'gate');
    const { client } = makeClient(gm, (_body, index) =>
      index === 0 ? { message: TRUNCATED_MESSAGE } : { events: TRUNCATED_EVENTS },
    );
    expect(await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [] })).toMatchObject({
      stop_reason: 'max_tokens',
    });
    const stream = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [], stream: true });
    for await (const _event of stream) {
      // consume
    }
    expect(gm.session.attached).toBe(false);
    expect(gate.mock.calls.map((call) => call[0])).toEqual(['before', 'after', 'before', 'after']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
  });
});
