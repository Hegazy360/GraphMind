/**
 * Observation-side behavior: stream tee byte-exactness, thinking / tool-input
 * deltas, usage (including cache accounting), graph.hint, server-executed
 * tools, the APIPromise stand-in, and the detached / disabled fast paths.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions } from './helpers/fake-viewer.js';
import {
  FakeAnthropicTransport,
  USAGE,
  assistantMessage,
  type Script,
} from './helpers/fake-anthropic.js';
import { Marks, TURN_TEXT, attach, makeTools, runScenario } from './helpers/scenario.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(
  viewerOptions: FakeViewerOptions = {},
  gmOptions: Partial<GraphmindOptions> = {},
): Promise<{ viewer: FakeViewer; gm: Graphmind; warnings: string[] }> {
  const viewer = await FakeViewer.start(viewerOptions);
  const warnings: string[] = [];
  const gm = graphmind({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    logger: (message) => warnings.push(message),
    ...gmOptions,
  });
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  return { viewer, gm, warnings };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeClient(gm: Graphmind, script: Script) {
  const transport = new FakeAnthropicTransport(script);
  const raw = new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch: transport.fetch });
  return { raw, client: gm.wrapClient(raw) as any, transport };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function deltas(viewer: FakeViewer, channel: string): string {
  return viewer
    .ofType('node.token')
    .filter((f) => f.payload['nodeId'] === 'llm:step')
    .flatMap((f) => f.payload['deltas'] as { t: string; v: string }[])
    .filter((d) => d.t === channel)
    .map((d) => d.v)
    .join('');
}

async function waitForLlmFinishes(viewer: FakeViewer, count: number): Promise<void> {
  await waitUntil(
    () =>
      viewer.ofType('node.finished').filter((f) => f.payload['nodeId'] === 'llm:step').length >=
      count,
    5000,
    `${count} llm node.finished frames`,
  );
}

describe('stream tee', () => {
  it('observed token deltas are byte-exact vs what the host consumed', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const result = await runScenario(gm, { mode: 'create-stream', thinking: true });
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    await waitForLlmFinishes(viewer, 3);

    // Text: exactly what the host accumulated from the stream, in order.
    expect(deltas(viewer, 'text')).toBe(result.turnTexts.join(''));
    expect(result.turnTexts[0]).toBe(TURN_TEXT[0]);

    // Thinking blocks are observed on the `reasoning` channel.
    expect(deltas(viewer, 'reasoning')).toBe('Let me think about this. '.repeat(3));

    // tool_use input JSON deltas are observed on the `tool-args` channel.
    expect(deltas(viewer, 'tool-args')).toBe(
      JSON.stringify({ from: 'VIE', to: 'LIS' }) +
        JSON.stringify({ city: 'Lisbon' }) +
        JSON.stringify({ amount: 100, from: 'EUR', to: 'USD' }),
    );

    // Batched, not one frame per delta.
    const frames = viewer
      .ofType('node.token')
      .filter((f) => f.payload['nodeId'] === 'llm:step');
    const count = frames.reduce((n, f) => n + (f.payload['deltas'] as unknown[]).length, 0);
    expect(count).toBeGreaterThan(frames.length);
  });

  it('reports usage with Anthropic cache accounting on every turn', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const result = await runScenario(gm, { mode: 'stream-helper' });
    expect(result.runError).toBeUndefined();
    await waitForLlmFinishes(viewer, 3);

    for (const frame of viewer
      .ofType('node.finished')
      .filter((f) => f.payload['nodeId'] === 'llm:step')) {
      expect(frame.payload['status']).toBe('ok');
      expect(frame.payload['usage']).toEqual({
        inputTokens: USAGE.input_tokens,
        outputTokens: USAGE.output_tokens,
        cacheReadTokens: USAGE.cache_read_input_tokens,
        cacheCreationTokens: USAGE.cache_creation_input_tokens,
      });
    }
  });

  it('non-streaming create reports text, stop reason and usage', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const result = await runScenario(gm, { mode: 'create' });
    expect(result.runError).toBeUndefined();
    await waitForLlmFinishes(viewer, 3);

    const finished = viewer
      .ofType('node.finished')
      .filter((f) => f.payload['nodeId'] === 'llm:step');
    const first = finished[0]!.payload['output'] as Record<string, unknown>;
    expect(first['text']).toBe(TURN_TEXT[0]);
    expect(first['stopReason']).toBe('tool_use');
    expect(first['model']).toBe('claude-sonnet-4-5');
    const last = finished[2]!.payload['output'] as Record<string, unknown>;
    expect(last['stopReason']).toBe('end_turn');
    expect(finished[0]!.payload['usage']).toMatchObject({
      inputTokens: USAGE.input_tokens,
      outputTokens: USAGE.output_tokens,
    });
  });
});

describe('graph.hint', () => {
  it('emits the roster from the first request tools, marking ungated tools', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const result = await runScenario(gm, { runName: 'trip-run' });
    expect(result.runError).toBeUndefined();
    await waitForLlmFinishes(viewer, 3);

    const hints = viewer.ofType('graph.hint');
    expect(hints).toHaveLength(1); // 3 turns chain into ONE invocation
    const nodes = hints[0]!.payload['nodes'] as Record<string, unknown>[];
    const byId = new Map(nodes.map((n) => [n['nodeId'], n]));
    expect(byId.get('agent:trip-run')).toMatchObject({ kind: 'agent', name: 'trip-run' });
    expect(byId.get('llm:step')).toMatchObject({ kind: 'llm', parentId: 'agent:trip-run' });
    for (const name of ['searchFlights', 'checkWeather', 'convertCurrency']) {
      expect(byId.get(`tool:${name}`)).toMatchObject({
        kind: 'tool',
        name,
        parentId: 'llm:step',
      });
      // Wrapped by gm.wrapTools => gated, so not marked ungated.
      expect(byId.get(`tool:${name}`)!['ungated']).toBeUndefined();
    }

    // The turns chain into one invocation: shared prefix, increasing indices.
    const starts = viewer
      .ofType('node.started')
      .filter((f) => f.payload['nodeId'] === 'llm:step')
      .map((f) => f.payload['instanceId'] as string);
    expect(starts).toHaveLength(3);
    const invocation = starts[0]!.split(':s')[0]!;
    expect(starts).toEqual([`${invocation}:s0`, `${invocation}:s1`, `${invocation}:s2`]);
  });

  it('marks tools the host never wrapped, and built-in tools, as ungated', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const { client } = makeClient(gm, () => ({ message: assistantMessage('m0', 'hi') }));
    await gm.run('hint-run', async () => {
      await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'notWrapped', input_schema: { type: 'object' } },
          { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
        ],
      });
    });

    const hint = await viewer.waitForType('graph.hint');
    const nodes = hint.payload['nodes'] as Record<string, unknown>[];
    const byId = new Map(nodes.map((n) => [n['nodeId'], n]));
    expect(byId.get('tool:notWrapped')).toMatchObject({ ungated: true });
    expect(byId.get('tool:web_search')).toMatchObject({ builtin: true, ungated: true });
  });
});

describe('server-executed tools', () => {
  it('observes server_tool_use / *_tool_result blocks, marked and ungated', async () => {
    const { viewer, gm } = await setup({
      // A breakpoint on the server tool must have no effect: it is never gated.
      breakpoints: [{ name: 'web_search' }],
    });
    await attach(gm);

    const message = {
      id: 'msg_srv',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'lisbon' },
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [{ type: 'web_search_result', title: 'Lisbon', url: 'https://example.test' }],
        },
        { type: 'text', text: 'Lisbon is sunny.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 4 },
    };
    const { client } = makeClient(gm, () => ({ message }));
    await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'search' }],
    });

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:web_search',
    );
    const started = viewer
      .ofType('node.started')
      .find((f) => f.payload['nodeId'] === 'tool:web_search');
    expect(started?.payload['serverExecuted']).toBe(true);
    expect(started?.payload['ungated']).toBe(true);
    expect(started?.payload['instanceId']).toBe('srvtoolu_1');
    expect(started?.payload['input']).toEqual({ query: 'lisbon' });
    expect(finished.payload['status']).toBe('ok');
    expect(finished.payload['serverExecuted']).toBe(true);

    // Despite the armed breakpoint, nothing ever paused (observe-only).
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });
});

describe('the APIPromise stand-in', () => {
  it('supports withResponse() and asResponse() and resolves the same value', async () => {
    const { gm } = await setup();
    await attach(gm);

    const { client } = makeClient(gm, () => ({ message: assistantMessage('m1', 'hello there') }));
    const promise = client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { data, response, request_id } = await promise.withResponse();
    expect(response.status).toBe(200);
    expect(request_id).toBe('req_0');
    expect(data.content[0].text).toBe('hello there');
    // Awaiting the same call resolves the identical object.
    expect(await promise).toBe(data);

    const raw = await client.messages
      .create({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .asResponse();
    expect(raw.status).toBe(200);
  });

  it('reports an API error once and rethrows it to the host', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const { client } = makeClient(gm, () => ({
      status: 500,
      error: { type: 'error', error: { type: 'api_error', message: 'boom' } },
    }));
    await expect(
      client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow();

    const errored = await viewer.waitFor(
      (f) => f.type === 'node.error' && f.payload['nodeId'] === 'llm:step',
    );
    expect(errored).toBeDefined();
    const finished = viewer
      .ofType('node.finished')
      .filter((f) => f.payload['nodeId'] === 'llm:step');
    expect(finished).toHaveLength(1);
    expect(finished[0]!.payload['status']).toBe('error');
  });
});

describe('wrapClient is a non-mutating view', () => {
  it('never mutates the client and forwards everything it does not instrument', async () => {
    const { gm } = await setup();
    const { raw, client } = makeClient(gm, () => ({ message: assistantMessage('m', 'x') }));

    expect(client).not.toBe(raw);
    expect(raw.messages.create).toBe(
      Object.getPrototypeOf(raw.messages).create as unknown,
    ); // the original method is untouched
    expect(client.messages.create).not.toBe(raw.messages.create);
    expect(client instanceof Anthropic).toBe(true);
    expect(client.apiKey).toBe('test-key');
    expect(typeof client.messages.countTokens).toBe('function');
    expect(typeof client.beta.messages.create).toBe('function');
    // Bound methods keep a stable identity across reads.
    expect(client.messages.countTokens).toBe(client.messages.countTokens);
  });
});

describe('detached / disabled fast paths', () => {
  it('disabled: wrapClient / wrapTools / tool are identity functions', async () => {
    const gm = graphmind({ enabled: false });
    cleanups.push(() => gm.dispose());
    const marks = new Marks();
    const tools = makeTools(marks);
    const raw = new Anthropic({ apiKey: 'k', fetch: async () => new Response('{}') });
    const fn = async (): Promise<number> => 1;

    expect(gm.wrapClient(raw)).toBe(raw);
    expect(gm.wrapTools(tools)).toBe(tools as never);
    expect(gm.tool('x', fn)).toBe(fn as never);
    expect(gm.session.enabled).toBe(false);

    const result = await runScenario(gm);
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    expect(gm.session.stats().seq).toBe(0); // nothing emitted, nothing buffered
  });

  it('enabled but detached: completes with zero pauses, buffered events only', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined });
    cleanups.push(() => gm.dispose());

    const result = await runScenario(gm, { mode: 'stream-helper' });
    expect(result.runError).toBeUndefined();
    expect(result.turns).toBe(3);
    expect(result.text).toContain('TP1234');
    const stats = gm.session.stats();
    expect(stats.attached).toBe(false);
    expect(stats.heldGates).toBe(0);
    expect(stats.buffered).toBeGreaterThan(0); // ring buffer holds replay events
  });

  it('detached overhead stays negligible over many gated tool calls', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const wrapped = gm.tool('noop', async (n: number) => n + 1);

    const iterations = 2000;
    const started = Date.now();
    for (let i = 0; i < iterations; i += 1) await wrapped(i);
    const perCall = (Date.now() - started) / iterations;

    // Detached gates take the shared-resolved-promise fast path; a whole call
    // (3 gates + 2 events) must stay far under a millisecond.
    expect(perCall).toBeLessThan(0.5);
    expect(gm.session.stats().heldGates).toBe(0);
  });

  it('the adapter never throws into the host app on unserializable payloads', async () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const weird = gm.tool('weird', async () => cyclic);
    expect(await weird(cyclic)).toBe(cyclic); // host result untouched, no throw

    const { client } = makeClient(gm, () => ({
      message: { ...assistantMessage('m', 'ok'), extra: 'field' },
    }));
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: cyclic as unknown as string }],
    });
    expect(message.content[0].text).toBe('ok');
  });
});

describe('multi-turn grouping outside gm.run', () => {
  it('still chains growing turns into one invocation (documented limit)', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const result = await runScenario(gm, { noRun: true });
    expect(result.runError).toBeUndefined();
    await waitForLlmFinishes(viewer, 3);

    const starts = viewer
      .ofType('node.started')
      .filter((f) => f.payload['nodeId'] === 'llm:step')
      .map((f) => f.payload['instanceId'] as string);
    expect(starts).toHaveLength(3);
    const invocation = starts[0]!.split(':s')[0]!;
    expect(starts).toEqual([`${invocation}:s0`, `${invocation}:s1`, `${invocation}:s2`]);
    // No agent node without an explicit run boundary.
    const hint = viewer.ofType('graph.hint')[0]!;
    const nodes = hint.payload['nodes'] as Record<string, unknown>[];
    expect(nodes.some((n) => String(n['nodeId']).startsWith('agent:'))).toBe(false);
    await tick(10);
  });
});
