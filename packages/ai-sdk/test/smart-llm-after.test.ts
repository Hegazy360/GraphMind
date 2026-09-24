/**
 * The model step's `after` gate (0.6.0, contract C4 / W4): it hands the
 * session the normalized LLM output (`{text, finishReason, rawFinishReason,
 * toolCalls}`), so a step the token limit cut off in the middle of a tool call
 * is a smart hold (`reason: 'breakpoint'`, `smart.rule:
 * 'truncated-tool-call'`) — end to end through `streamText` / `generateText`
 * on mock models against a fake debugger:
 *   - streamed: the SDK's copy of the stream waits at its `finish` part, so
 *     the step does not complete while held; continue finishes it, abort
 *     errors it with the run's AbortError;
 *   - generated: the SDK has not seen the result while held; retry runs the
 *     step again;
 *   - detached: the after gate is called with no options (generate) or not at
 *     all (stream: the SDK's branch is untouched), exactly as in 0.5;
 *   - GRAPHMIND_BREAK_ON_TRUNCATED=0 / breakOnTruncated: false: no hold.
 */
import { generateText, simulateReadableStream, streamText, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AfterGateContext, GateDetector, Session } from '@graphmind-ai/client';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';
import { attach } from './helpers/scenario.js';
import { MockLanguageModel, type CallOptions, type GenerateResult, type StreamPart } from './helpers/sdk-compat.js';

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

function detectorsOf(session: Session): GateDetector[] {
  return (session as unknown as { detectors: GateDetector[] }).detectors;
}

function llmFrames(viewer: FakeViewer, type: string): ReceivedFrame[] {
  return viewer.ofType(type).filter((f) => f.payload['nodeId'] === 'llm:step');
}

function llmPause(viewer: FakeViewer, n = 1): Promise<ReceivedFrame> {
  return waitUntil(() => llmFrames(viewer, 'exec.paused').length >= n, 8000, `llm pause #${n}`).then(
    () => llmFrames(viewer, 'exec.paused')[n - 1] as ReceivedFrame,
  );
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4096, text: 4096, reasoning: undefined },
};

/** A streamed step the token limit cut off while the model was writing `write`'s arguments. */
const TRUNCATED_PARTS = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Writing the file.' },
  { type: 'text-end', id: 't1' },
  { type: 'tool-input-start', id: 'call-9', toolName: 'write' },
  { type: 'tool-input-delta', id: 'call-9', delta: '{"path":"a.txt","content":"hel' },
  { type: 'finish', usage: USAGE, finishReason: { unified: 'length', raw: 'max_tokens' } },
] as StreamPart[];

const TRUNCATED_OUTPUT = {
  text: 'Writing the file.',
  finishReason: 'length',
  rawFinishReason: 'max_tokens',
  toolCalls: [{ id: 'call-9', name: 'write', input: null, inputText: '{"path":"a.txt","content":"hel' }],
};

const TRUNCATED_DETAIL =
  'the model was stopped at the token limit with 1 tool call requested; 1 call has arguments that did not parse';

function streamingModel(parts: StreamPart[] = TRUNCATED_PARTS) {
  return new MockLanguageModel({
    doStream: async () => ({ stream: simulateReadableStream<StreamPart>({ chunks: parts }) }),
  });
}

/** doGenerate: a truncated `write` call first, then (if retried) a plain answer. */
function generatingModel(calls: { count: number }) {
  return new MockLanguageModel({
    doGenerate: async () => {
      calls.count += 1;
      if (calls.count === 1) {
        return {
          content: [
            { type: 'text' as const, text: 'Writing the file.' },
            { type: 'tool-call' as const, toolCallId: 'call-9', toolName: 'write', input: '{"path":"a.txt","content":"hel' },
          ],
          finishReason: { unified: 'length' as const, raw: 'max_tokens' },
          usage: USAGE,
          warnings: [],
        } as unknown as GenerateResult;
      }
      return {
        content: [{ type: 'text' as const, text: 'Done: a.txt written.' }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: USAGE,
        warnings: [],
      } as unknown as GenerateResult;
    },
  });
}

const writeTool = (ran: unknown[]) =>
  tool({
    description: 'Write a file',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async (input) => {
      ran.push(input);
      return { ok: true };
    },
  });

describe('streamed step: truncated-tool-call holds the SDK at the finish part', () => {
  it('holds after the step with the smart rule; nothing finishes until continue', async () => {
    const { viewer, gm } = await setup();
    const ran: unknown[] = [];
    const finished: string[] = [];
    const result = streamText({
      model: gm.wrapModel(streamingModel()),
      prompt: 'write a.txt',
      tools: gm.wrapTools({ write: writeTool(ran) }),
      onFinish: ({ finishReason }) => {
        finished.push(finishReason);
      },
    });
    const consumed = result.consumeStream();

    const paused = await llmPause(viewer);
    expect(paused.payload).toEqual({
      pauseId: paused.payload['pauseId'],
      nodeId: 'llm:step',
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'truncated-tool-call', detail: TRUNCATED_DETAIL },
    });

    // Held for real: the SDK has not seen the finish part, so the step (and
    // the whole call) is still open, and the node has not finished.
    await tick(300);
    expect(finished).toEqual([]);
    expect(llmFrames(viewer, 'node.finished')).toHaveLength(0);
    expect(gm.session.stats().heldGates).toBe(1);

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await consumed;
    expect(await result.finishReason).toBe('length');
    expect(finished).toEqual(['length']);
    expect(ran).toEqual([]); // the cut-off call never ran
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['status']).toBe('ok');
    expect(done.payload['output']).toEqual(TRUNCATED_OUTPUT);
    expect(llmFrames(viewer, 'exec.paused')).toHaveLength(1);
  });

  it('the after gate receives the normalized output', async () => {
    const { viewer, gm } = await setup({ breakOnTruncated: false });
    const seen: AfterGateContext[] = [];
    detectorsOf(gm.session).push((context) => {
      if (context.node.kind === 'llm') seen.push(context);
      return undefined;
    });
    const res = await gm.wrapModel(streamingModel()).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
    } as CallOptions);
    const reader = res.stream.getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.node).toEqual({ nodeId: 'llm:step', kind: 'llm', name: 'step' });
    expect(seen[0]?.result).toEqual(TRUNCATED_OUTPUT);
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('abort errors the SDK stream with the run AbortError and finishes the node aborted', async () => {
    const { viewer, gm } = await setup();
    const res = await gm.wrapModel(streamingModel()).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
    } as CallOptions);
    const seenTypes: string[] = [];
    const drained = (async () => {
      const reader = res.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        seenTypes.push((value as { type: string }).type);
      }
    })();
    const paused = await llmPause(viewer);
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    const error = await drained.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error | undefined)?.name).toBe('AbortError');
    expect(seenTypes).not.toContain('finish'); // the SDK never saw the step finish
    expect(seenTypes).toContain('tool-input-delta'); // everything before it passed through
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['status']).toBe('aborted');
  });

  it('an SDK that cancelled its copy of the stream is not held for (nothing waits at the finish part)', async () => {
    const { viewer, gm } = await setup();
    const mock = new MockLanguageModel({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({ chunks: TRUNCATED_PARTS, chunkDelayInMs: 40 }),
      }),
    });
    const res = await gm.wrapModel(mock).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
    } as CallOptions);
    const reader = res.stream.getReader();
    await reader.read();
    await reader.cancel('the host stopped reading');
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['status']).toBe('ok');
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('retry cannot rewrite a consumed stream: it continues, with one warning', async () => {
    const { viewer, gm, warnings } = await setup();
    const result = streamText({ model: gm.wrapModel(streamingModel()), prompt: 'write a.txt' });
    const consumed = result.consumeStream();
    const paused = await llmPause(viewer);
    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    await consumed;
    expect(await result.finishReason).toBe('length');
    expect(warnings.filter((w) => w.includes('streamed model step'))).toHaveLength(1);
  });

  it('a normal step (finish reason tool-calls) passes the after gate without holding', async () => {
    const { viewer, gm } = await setup();
    const parts = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'write', input: '{"path":"a.txt","content":"hi"}' },
      { type: 'finish', usage: USAGE, finishReason: { unified: 'tool-calls', raw: 'tool_use' } },
    ] as StreamPart[];
    const ran: unknown[] = [];
    const result = streamText({
      model: gm.wrapModel(streamingModel(parts)),
      prompt: 'write a.txt',
      tools: gm.wrapTools({ write: writeTool(ran) }),
    });
    await result.consumeStream();
    expect(await result.finishReason).toBe('tool-calls');
    expect(ran).toEqual([{ path: 'a.txt', content: 'hi' }]);
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it.each<[string, Partial<GraphmindOptions>]>([
    ['GRAPHMIND_BREAK_ON_TRUNCATED=0', { env: { GRAPHMIND_BREAK_ON_TRUNCATED: '0' } }],
    ['breakOnTruncated: false', { breakOnTruncated: false }],
  ])('%s: a truncated step is not held', async (_label, options) => {
    const { viewer, gm } = await setup(options);
    const result = streamText({ model: gm.wrapModel(streamingModel()), prompt: 'write a.txt' });
    await result.consumeStream();
    expect(await result.finishReason).toBe('length');
    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('an explicit after breakpoint on llm steps holds a normal streamed step too (reason breakpoint, no smart)', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'llm', point: 'after' }] });
    const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {}, logger: () => {} });
    cleanups.push(async () => {
      await gm.dispose();
      await viewer.close();
    });
    await attach(gm);
    const parts = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'hello' },
      { type: 'text-end', id: 't' },
      { type: 'finish', usage: USAGE, finishReason: { unified: 'stop', raw: 'end_turn' } },
    ] as StreamPart[];
    const result = streamText({ model: gm.wrapModel(streamingModel(parts)), prompt: 'hi' });
    const consumed = result.consumeStream();
    const paused = await llmPause(viewer);
    expect(paused.payload).toMatchObject({ point: 'after', reason: 'breakpoint' });
    expect(paused.payload).not.toHaveProperty('smart');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await consumed;
    expect(await result.text).toBe('hello');
  });
});

describe('generated step: truncated-tool-call holds before the SDK sees the result', () => {
  it('holds with the smart rule; retry runs the step again and the SDK only ever sees the second answer', async () => {
    const { viewer, gm } = await setup();
    const calls = { count: 0 };
    const ran: unknown[] = [];
    const promise = generateText({
      model: gm.wrapModel(generatingModel(calls)),
      prompt: 'write a.txt',
      tools: gm.wrapTools({ write: writeTool(ran) }),
    });
    const paused = await llmPause(viewer);
    expect(paused.payload).toMatchObject({
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'truncated-tool-call', detail: TRUNCATED_DETAIL },
    });
    await tick(200);
    expect(calls.count).toBe(1);
    expect(llmFrames(viewer, 'node.finished')).toHaveLength(0);

    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    const result = await promise;
    expect(calls.count).toBe(2);
    expect(result.text).toBe('Done: a.txt written.');
    expect(result.finishReason).toBe('stop');
    expect(ran).toEqual([]);
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload).toMatchObject({
      status: 'ok',
      attempts: 2,
      output: { text: 'Done: a.txt written.', finishReason: 'stop', rawFinishReason: 'end_turn' },
    });
    expect(llmFrames(viewer, 'exec.paused')).toHaveLength(1);
    expect(llmFrames(viewer, 'node.started')).toHaveLength(1); // one execution, two attempts
  });

  it('the after gate receives the normalized output; abort throws the AbortError', async () => {
    const { viewer, gm } = await setup();
    const seen: AfterGateContext[] = [];
    detectorsOf(gm.session).unshift((context) => {
      if (context.node.kind === 'llm') seen.push(context);
      return undefined;
    });
    const calls = { count: 0 };
    const promise = gm.wrapModel(generatingModel(calls)).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
    } as CallOptions);
    const paused = await llmPause(viewer);
    expect(seen[0]?.result).toEqual({
      text: 'Writing the file.',
      finishReason: 'length',
      rawFinishReason: 'max_tokens',
      toolCalls: [{ id: 'call-9', name: 'write', input: null, inputText: '{"path":"a.txt","content":"hel' }],
    });
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    const done = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['status']).toBe('aborted');
  });

  it('inject is not meaningful there: the real result is returned, with one warning', async () => {
    const { viewer, gm, warnings } = await setup();
    const calls = { count: 0 };
    const promise = gm.wrapModel(generatingModel(calls)).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
    } as CallOptions);
    const paused = await llmPause(viewer);
    viewer.resume(paused.payload['pauseId'] as string, 'inject', { text: 'nope' });
    const result = (await promise) as unknown as { finishReason: unknown };
    expect(result.finishReason).toEqual({ unified: 'length', raw: 'max_tokens' });
    expect(warnings.filter((w) => w.includes('inject at a model step'))).toHaveLength(1);
  });
});

describe('detached: the model step is exactly as in 0.5', () => {
  it('generate: the after gate is called with no options; stream: no after gate at all', async () => {
    // Port 9 (discard): never a GraphMind server, so the session stays detached.
    const gm = graphmind({ url: 'ws://127.0.0.1:9/ingest', enabled: true, env: {}, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const gate = vi.spyOn(gm.session, 'gate');
    const calls = { count: 0 };
    const generated = (await gm.wrapModel(generatingModel(calls)).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
    } as CallOptions)) as unknown as { finishReason: unknown };
    expect(generated.finishReason).toEqual({ unified: 'length', raw: 'max_tokens' });
    expect(gate.mock.calls.map((call) => call[0])).toEqual(['before', 'after']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();

    gate.mockClear();
    const result = streamText({ model: gm.wrapModel(streamingModel()), prompt: 'write a.txt' });
    await result.consumeStream();
    expect(await result.finishReason).toBe('length');
    expect(gm.session.attached).toBe(false);
    expect(gate.mock.calls.map((call) => call[0])).toEqual(['before']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
  });
});
