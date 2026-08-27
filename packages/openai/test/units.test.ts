/**
 * Unit-level guarantees: the proxy contract (no mutation, stable identity,
 * idempotence), the disabled / detached fast paths and their overhead, the
 * never-throw discipline, signal chaining, and the pure mapping helpers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { graphmind, GRAPHMIND_WRAPPED } from '../src/index.js';
import { chainAbortSignals, isTimeoutAbortReason } from '../src/signals.js';
import { InvocationTracker, promptKey } from '../src/invocation.js';
import { TokenBatcher } from '../src/token-batcher.js';
import {
  isProviderExecutedItem,
  mapChatUsage,
  mapResponsesUsage,
  outputItemName,
  parseToolInput,
  toolRoster,
} from '../src/sdk-types.js';
import { chatCompletion, chunked, FakeOpenAI, responseEvents } from './helpers/fake-openai.js';
import { tick, waitUntil } from './helpers/fake-viewer.js';
import { attach } from './helpers/scenario.js';
import { framesFor, setup } from './helpers/setup.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function jsonServer(text = 'ok'): FakeOpenAI {
  return new FakeOpenAI().onChat(() => ({ kind: 'json', body: chatCompletion({ text }) }));
}

describe('the proxy contract', () => {
  it('does not mutate the client and keeps resource identity stable', async () => {
    const server = jsonServer();
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const raw = new OpenAI({ apiKey: 'k', fetch: server.fetch });
    const rawCreate = raw.chat.completions.create;
    const client = gm.wrapClient(raw);

    expect(client).not.toBe(raw);
    expect(raw.chat.completions.create).toBe(rawCreate); // untouched
    expect(client.chat.completions.create).not.toBe(rawCreate); // instrumented
    // Proxies are cached: repeated access returns the same object/function.
    expect(client.chat).toBe(client.chat);
    expect(client.chat.completions).toBe(client.chat.completions);
    expect(client.chat.completions.create).toBe(client.chat.completions.create);
    // instanceof still works, and untouched resources pass through.
    expect(client instanceof OpenAI).toBe(true);
    expect(client.baseURL).toBe(raw.baseURL);
  });

  it('is idempotent: wrapping a wrapped client returns it unchanged', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const client = gm.wrapClient(new OpenAI({ apiKey: 'k' }));
    expect(gm.wrapClient(client)).toBe(client);
    expect((client as unknown as Record<symbol, unknown>)[GRAPHMIND_WRAPPED]).toBe(true);
  });

  it('client methods that use #private fields still work through the proxy', async () => {
    const server = jsonServer('via post');
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const client = gm.wrapClient(new OpenAI({ apiKey: 'k', fetch: server.fetch }));
    // `post` reads `#encoder` — it would throw if `this` were the Proxy.
    const raw = await client.post('/chat/completions', {
      body: { model: 'gpt-5.4', messages: [] },
    });
    expect((raw as { choices: { message: { content: string } }[] }).choices[0]?.message.content).toBe(
      'via post',
    );
  });

  it('passes non-objects and unknown shapes through untouched', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    expect(gm.wrapClient(undefined)).toBeUndefined();
    expect(gm.wrapClient('not a client')).toBe('not a client');
    const bare = { chat: 42 };
    expect(gm.wrapClient(bare).chat).toBe(42);
  });
});

describe('disabled / detached fast paths', () => {
  it('disabled: wrapClient and wrapTools are identity functions', async () => {
    const gm = graphmind({ enabled: false });
    cleanups.push(() => gm.dispose());
    const server = jsonServer();
    const raw = new OpenAI({ apiKey: 'k', fetch: server.fetch });
    const tools = { searchFlights: async () => ({ ok: true }) };

    expect(gm.wrapClient(raw)).toBe(raw);
    expect(gm.wrapTools(tools)).toBe(tools);
    expect(gm.session.enabled).toBe(false);

    await gm.run('noop', async () => {
      await raw.chat.completions.create({ model: 'gpt-5.4', messages: [] });
    });
    expect(gm.session.stats().seq).toBe(0); // nothing emitted, nothing buffered
  });

  it('enabled but detached: runs to completion, buffering for replay, zero holds', async () => {
    const server = jsonServer('detached answer');
    const gm = graphmind({ enabled: true, webSocket: undefined });
    cleanups.push(() => gm.dispose());
    const client = gm.wrapClient(new OpenAI({ apiKey: 'k', fetch: server.fetch }));

    const completion = await gm.run('detached', () =>
      client.chat.completions.create({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'x' }] }),
    );
    expect(completion.choices[0]?.message.content).toBe('detached answer');
    const stats = gm.session.stats();
    expect(stats.attached).toBe(false);
    expect(stats.heldGates).toBe(0);
    expect(stats.buffered).toBeGreaterThan(0); // ring buffer holds replay events
  });

  it('detached overhead per call stays in the noise', async () => {
    const server = jsonServer();
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const raw = new OpenAI({ apiKey: 'k', fetch: server.fetch });
    const client = gm.wrapClient(raw);
    const body = { model: 'gpt-5.4', messages: [{ role: 'user' as const, content: 'x' }] };
    const rounds = 100;

    const time = async (target: OpenAI): Promise<number> => {
      const start = performance.now();
      for (let i = 0; i < rounds; i += 1) await target.chat.completions.create(body);
      return performance.now() - start;
    };
    await time(raw); // warm up both paths
    await time(client);
    const baseline = await time(raw);
    const wrapped = await time(client);

    const addedPerCall = (wrapped - baseline) / rounds;
    // Generous bound: the claim is "no measurable cost", not a benchmark.
    expect(addedPerCall).toBeLessThan(2.5);

    // Property resolution is cached, so the proxy tree costs ~nothing to walk.
    const walkStart = performance.now();
    for (let i = 0; i < 20_000; i += 1) void client.chat.completions.create;
    expect(performance.now() - walkStart).toBeLessThan(150);
  });
});

describe('never throws into the host', () => {
  it('survives unserializable payloads flowing through tools and results', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic; // JSON.stringify throws inside emit

    const tools = gm.wrapTools({
      weird: async (_input: unknown, _call?: unknown) => cyclic,
    });
    const result = await tools.weird(cyclic, { toolCallId: 'call-weird-1' });
    expect(result).toBe(cyclic); // host result untouched, no throw
  });

  it('a throwing logger cannot escape', async () => {
    const gm = graphmind({
      enabled: true,
      webSocket: undefined,
      logger: () => {
        throw new Error('logger exploded');
      },
    });
    cleanups.push(() => gm.dispose());
    const tools = gm.wrapTools({ ok: async (_input: unknown) => 1 });
    await expect(tools.ok({})).resolves.toBe(1);
  });

  it('leaves non-function tool entries alone', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const schema = { description: 'not callable' };
    const tools = gm.wrapTools({ schema, run: async (_input: unknown) => 'ran' });
    expect(tools.schema).toBe(schema);
    await expect(tools.run({})).resolves.toBe('ran');
  });

  it('wraps an object-with-execute tool shape', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const tool = { description: 'x', execute: async (input: { n: number }) => input.n * 2 };
    const tools = gm.wrapTools({ double: tool });
    expect(tools.double.description).toBe('x');
    expect(tools.double.execute).not.toBe(tool.execute);
    await expect(tools.double.execute({ n: 21 })).resolves.toBe(42);
  });
});

describe('abort signals (decisions.md #3)', () => {
  it('attached: neutralizes a timeout signal that fires during a hold, warning once', async () => {
    const server = jsonServer('survived the hold');
    const rig = await setup(server, { breakpoints: [{ kind: 'llm' }] }, {}, cleanups);
    await attach(rig.gm);

    const promise = rig.client.chat.completions.create(
      { model: 'gpt-5.4', messages: [{ role: 'user', content: 'x' }] },
      { signal: AbortSignal.timeout(60) },
    );
    const paused = await rig.viewer.waitFor((frame) => frame.type === 'exec.paused');
    await tick(300); // the timeout fires while the gate is held
    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');

    const completion = await promise;
    expect(completion.choices[0]?.message.content).toBe('survived the hold');
    expect(rig.warnings.filter((w) => w.includes('neutralized'))).toHaveLength(1);
  });

  it('detached: request signals are untouched', async () => {
    const warnings: string[] = [];
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'json',
      body: chatCompletion({ text: 'too late' }),
      delayMs: 300,
    }));
    const gm = graphmind({
      enabled: true,
      webSocket: undefined,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => gm.dispose());
    const client = gm.wrapClient(new OpenAI({ apiKey: 'k', fetch: server.fetch, maxRetries: 0 }));

    await expect(
      client.chat.completions.create(
        { model: 'gpt-5.4', messages: [{ role: 'user', content: 'x' }] },
        { signal: AbortSignal.timeout(40) },
      ),
    ).rejects.toThrow();
    expect(warnings.filter((w) => w.includes('neutralized'))).toHaveLength(0);
  });

  it('chainAbortSignals: forwards user aborts, swallows timeout aborts', () => {
    expect(isTimeoutAbortReason(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTimeoutAbortReason(new Error('nope'))).toBe(false);
    expect(chainAbortSignals(undefined, undefined, () => {})).toBeUndefined();

    const user = new AbortController();
    const chained = chainAbortSignals(user.signal, undefined, () => {});
    const reason = new Error('user cancelled');
    user.abort(reason);
    expect(chained?.aborted).toBe(true);
    expect(chained?.reason).toBe(reason);

    let neutralized = 0;
    const timeout = new AbortController();
    const filtered = chainAbortSignals(timeout.signal, undefined, () => {
      neutralized += 1;
    });
    timeout.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    expect(filtered?.aborted).toBe(false);
    expect(neutralized).toBe(1);
  });
});

describe('waitForAttach', () => {
  it('holds the first call until the handshake lands, so gates are armed', async () => {
    const server = jsonServer('after attach');
    const rig = await setup(
      server,
      { breakpoints: [{ kind: 'llm' }] },
      { waitForAttach: 2000 },
      cleanups,
    );
    // NOTE: no attach() here — the first request must wait on its own.
    const promise = rig.client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'x' }],
    });
    const paused = await rig.viewer.waitFor((frame) => frame.type === 'exec.paused');
    expect(server.callCount).toBe(0);
    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const completion = await promise;
    expect(completion.choices[0]?.message.content).toBe('after attach');
  });
});

describe('stream disposal', () => {
  it('reports a terminal node.finished even when the caller stops reading early', async () => {
    const server = new FakeOpenAI().onResponses(() => ({
      kind: 'sse',
      events: responseEvents({ textChunks: chunked('a longer streamed answer', 3) }),
    }));
    const rig = await setup(server, {}, {}, cleanups);
    await attach(rig.gm);

    const stream = await rig.client.responses.create({
      model: 'gpt-5.4',
      input: 'hi',
      stream: true,
    });
    let seen = 0;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        seen += 1;
        if (seen === 2) break; // abandon the stream
      }
    }
    await waitUntil(
      () => framesFor(rig.viewer, 'node.finished', 'llm:step').length === 1,
      5000,
      'observer still finishes the node',
    );
  });
});

describe('pure helpers', () => {
  it('mapChatUsage / mapResponsesUsage map both shapes with loose extras', () => {
    expect(mapChatUsage(undefined)).toBeUndefined();
    expect(mapChatUsage({})).toBeUndefined();
    expect(
      mapChatUsage({
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    });
    expect(mapResponsesUsage({ input_tokens: 5, output_tokens: 2, total_tokens: 7 })).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
    });
    // Garbage in, nothing out (never a NaN on the wire).
    expect(mapChatUsage({ prompt_tokens: Number.NaN } as never)).toBeUndefined();
  });

  it('toolRoster reads both tool shapes and flags built-ins', () => {
    expect(
      toolRoster([
        { type: 'function', function: { name: 'chatStyle' } },
        { type: 'function', name: 'responsesStyle' },
        { type: 'web_search' },
        { type: 'custom', custom: { name: 'grammar' } },
        'nonsense',
      ]),
    ).toEqual([
      { name: 'chatStyle', providerExecuted: false },
      { name: 'responsesStyle', providerExecuted: false },
      { name: 'web_search', providerExecuted: true },
      { name: 'grammar', providerExecuted: false },
    ]);
    expect(toolRoster(undefined)).toEqual([]);
  });

  it('classifies Responses output items', () => {
    expect(isProviderExecutedItem('web_search_call')).toBe(true);
    expect(isProviderExecutedItem('mcp_call')).toBe(true);
    expect(isProviderExecutedItem('function_call')).toBe(false);
    expect(isProviderExecutedItem('custom_tool_call')).toBe(false);
    expect(isProviderExecutedItem('message')).toBe(false);
    expect(outputItemName({ type: 'web_search_call' })).toBe('web_search');
    expect(outputItemName({ type: 'mcp_call', name: 'fetch_issue' })).toBe('fetch_issue');
  });

  it('parseToolInput unwraps stringified JSON only', () => {
    expect(parseToolInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolInput('not json')).toBe('not json');
    expect(parseToolInput({ a: 1 })).toEqual({ a: 1 });
  });

  it('InvocationTracker chains growing prompts and previous_response_id', () => {
    const tracker = new InvocationTracker();
    const first = tracker.next('run-1', promptKey([{ role: 'user', content: 'hi' }]));
    expect(first.isFirstStep).toBe(true);
    const second = tracker.next(
      'run-1',
      promptKey([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'a' }]),
    );
    expect(second.invocationId).toBe(first.invocationId);
    expect(second.stepIndex).toBe(1);

    // A different first message starts a new invocation.
    const other = tracker.next('run-1', promptKey([{ role: 'user', content: 'different' }]));
    expect(other.invocationId).not.toBe(first.invocationId);

    // Responses-style chaining: the input array does NOT grow.
    const t2 = new InvocationTracker();
    const a = t2.next('run-2', promptKey('start'));
    t2.noteResponseId('run-2', 'resp_1');
    const b = t2.next('run-2', promptKey('next', 'resp_1'));
    expect(b.invocationId).toBe(a.invocationId);
    expect(b.stepIndex).toBe(1);

    // Concurrent runs never cross-talk.
    const t3 = new InvocationTracker();
    const runA = t3.next('run-a', promptKey([{ role: 'user', content: 'same' }]));
    const runB = t3.next('run-b', promptKey([{ role: 'user', content: 'same' }]));
    expect(runA.invocationId).not.toBe(runB.invocationId);
  });

  it('TokenBatcher batches per execution and flushes on demand', async () => {
    const flushes: { nodeId: string; instanceId: string; text: string }[] = [];
    const batcher = new TokenBatcher(
      (nodeId, instanceId, deltas) =>
        flushes.push({ nodeId, instanceId, text: deltas.map((d) => d.v).join('') }),
      5,
    );
    for (let i = 0; i < 20; i += 1) batcher.push('llm:step', 'inv:s0', { t: 'text', v: `${i}` });
    expect(flushes).toHaveLength(0);
    await tick(25);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.instanceId).toBe('inv:s0');

    // Two concurrent executions of the same logical node never share a batch.
    batcher.push('llm:step', 'inv:s0', { t: 'text', v: 'A' });
    batcher.push('llm:step', 'other:s0', { t: 'text', v: 'B' });
    await tick(25);
    expect(flushes.slice(1)).toEqual([
      { nodeId: 'llm:step', instanceId: 'inv:s0', text: 'A' },
      { nodeId: 'llm:step', instanceId: 'other:s0', text: 'B' },
    ]);

    batcher.push('llm:step', 'inv:s0', { t: 'text', v: 'x' });
    batcher.flush('llm:step', 'inv:s0');
    expect(flushes).toHaveLength(4);
    batcher.dispose();
    batcher.push('llm:step', 'inv:s0', { t: 'text', v: 'ignored' });
    expect(flushes).toHaveLength(4);
  });
});
