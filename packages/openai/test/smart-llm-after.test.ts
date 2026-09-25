/**
 * The model request's `after` gate (0.6.0, contract C4 / W4), both APIs, real
 * SDK against a scripted endpoint: while a debugger is attached it hands the
 * session the normalized output (`{text, finishReason, toolCalls, …}`), so a
 * completion the token limit cut off in the middle of a tool call is a smart
 * hold (`truncated-tool-call`) before `create()` resolves. Detached, the gate
 * is called with no options, as in 0.5. A streamed response is recorded, not
 * held (it is already the caller's by the time it is returned).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AfterGateContext, GateDetector, Session } from '@graphmind-ai/client';
import { graphmind } from '../src/index.js';
import OpenAI from 'openai';
import { chatChunks, chatCompletion, FakeOpenAI, RESPONSES_USAGE } from './helpers/fake-openai.js';
import { tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';
import { attach } from './helpers/scenario.js';
import { framesFor, setup } from './helpers/setup.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function detectorsOf(session: Session): GateDetector[] {
  return (session as unknown as { detectors: GateDetector[] }).detectors;
}

const CUT = '{"path":"a.txt","content":"hel';

/** A chat completion stopped by the token limit inside `write`'s arguments. */
function truncatedChat(): unknown {
  const completion = chatCompletion({ text: 'Writing.', toolCalls: [{ id: 'call_1', name: 'write', args: {} }], finishReason: 'length' }) as {
    choices: { message: { tool_calls: { function: { arguments: string } }[] } }[];
  };
  const call = completion.choices[0]?.message.tool_calls[0];
  if (call !== undefined) call.function.arguments = CUT;
  return completion;
}

/** A Responses object that ran out of output tokens inside a function call. */
function truncatedResponse(): unknown {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    model: 'gpt-5.4',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ id: 'fc_1', type: 'function_call', status: 'incomplete', call_id: 'call_1', name: 'write', arguments: CUT }],
    error: null,
    usage: RESPONSES_USAGE,
  };
}

function llmPause(rig: { viewer: { received: ReceivedFrame[] } }): Promise<ReceivedFrame> {
  const match = (f: ReceivedFrame): boolean => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:step';
  return waitUntil(() => rig.viewer.received.some(match), 8000, 'llm pause').then(
    () => rig.viewer.received.find(match) as ReceivedFrame,
  );
}

describe('chat.completions: truncated-tool-call at the after gate', () => {
  it('holds before create() resolves with the smart rule; the gate saw the normalized output; retry re-issues', async () => {
    const server = new FakeOpenAI().onChat((_body, index) =>
      index === 0 ? { kind: 'json', body: truncatedChat() } : { kind: 'json', body: chatCompletion({ text: 'Done.' }) },
    );
    const rig = await setup(server, {}, { env: {} }, cleanups);
    await attach(rig.gm);
    const seen: AfterGateContext[] = [];
    detectorsOf(rig.gm.session).unshift((context) => {
      if (context.node.kind === 'llm') seen.push(context);
      return undefined;
    });
    let settled = false;
    const promise = rig.client.chat.completions
      .create({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'write a.txt' }] })
      .then((value) => {
        settled = true;
        return value;
      });
    const paused = await llmPause(rig);
    const stepInstance = rig.viewer.received.find(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'llm:step',
    )?.payload['instanceId'];
    expect(typeof stepInstance).toBe('string');
    expect(paused.payload).toEqual({
      pauseId: paused.payload['pauseId'],
      nodeId: 'llm:step',
      point: 'after',
      reason: 'breakpoint',
      smart: {
        rule: 'truncated-tool-call',
        detail: 'the model was stopped at the token limit with 1 tool call requested; 1 call has arguments that did not parse',
      },
      // The pause names the step's execution (exec.paused.instanceId, 0.6.0).
      instanceId: stepInstance,
    });
    expect(seen[0]?.result).toMatchObject({
      text: 'Writing.',
      finishReason: 'length',
      rawFinishReason: 'length',
      toolCalls: [{ id: 'call_1', name: 'write', input: null, inputText: CUT }],
    });
    await tick(200);
    expect(settled).toBe(false);
    expect(framesFor(rig.viewer, 'node.finished', 'llm:step')).toHaveLength(0);

    rig.viewer.resume(paused.payload['pauseId'] as string, 'retry');
    const completion = await promise;
    expect(completion.choices[0]?.message.content).toBe('Done.');
    expect(server.callCount).toBe(2);
    const done = await rig.viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload).toMatchObject({ status: 'ok', attempts: 2 });
  });

  it('abort at the hold throws the AbortError', async () => {
    const server = new FakeOpenAI().onChat(() => ({ kind: 'json', body: truncatedChat() }));
    const rig = await setup(server, {}, { env: {} }, cleanups);
    await attach(rig.gm);
    const promise = rig.gm.run('abort-me', () =>
      rig.client.chat.completions.create({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'write' }] }),
    );
    const paused = await llmPause(rig);
    rig.viewer.resume(paused.payload['pauseId'] as string, 'abort');
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('GRAPHMIND_BREAK_ON_TRUNCATED=0: recorded, not held', async () => {
    const server = new FakeOpenAI().onChat(() => ({ kind: 'json', body: truncatedChat() }));
    const rig = await setup(server, {}, { env: { GRAPHMIND_BREAK_ON_TRUNCATED: '0' } }, cleanups);
    await attach(rig.gm);
    await rig.client.chat.completions.create({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'write' }] });
    const done = await rig.viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['output']).toMatchObject({ finishReason: 'length' });
    expect(rig.viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('a streamed completion cut off mid tool call is recorded, not held', async () => {
    const events = chatChunks({ toolCalls: [{ id: 'call_1', name: 'write', args: { path: 'a.txt', content: 'hello' } }], finishReason: 'length' });
    const server = new FakeOpenAI().onChat(() => ({ kind: 'sse', events }));
    const rig = await setup(server, {}, { env: {} }, cleanups);
    await attach(rig.gm);
    const stream = await rig.client.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'write' }],
      stream: true,
    });
    for await (const _chunk of stream) {
      // drain
    }
    const done = await rig.viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['output']).toMatchObject({ finishReason: 'length', toolCalls: [{ name: 'write' }] });
    expect(rig.viewer.ofType('exec.paused')).toHaveLength(0);
  });
});

describe('responses: truncated-tool-call at the after gate', () => {
  it('an incomplete response (max_output_tokens) inside a function call holds; continue returns it', async () => {
    const server = new FakeOpenAI().onResponses(() => ({ kind: 'json', body: truncatedResponse() }));
    const rig = await setup(server, {}, { env: {} }, cleanups);
    await attach(rig.gm);
    const promise = rig.client.responses.create({ model: 'gpt-5.4', input: 'write a.txt' });
    const paused = await llmPause(rig);
    expect(paused.payload).toMatchObject({
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'truncated-tool-call' },
    });
    rig.viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const response = await promise;
    expect(response.status).toBe('incomplete');
    const done = await rig.viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:step');
    expect(done.payload['output']).toMatchObject({
      finishReason: 'length',
      rawFinishReason: 'max_output_tokens',
      toolCalls: [{ name: 'write', inputText: CUT }],
    });
  });
});

describe('detached', () => {
  it('the after gate is called with no options, exactly as in 0.5', async () => {
    const server = new FakeOpenAI().onChat(() => ({ kind: 'json', body: truncatedChat() }));
    // Port 9 (discard): never a GraphMind server, so the session stays detached.
    const gm = graphmind({ url: 'ws://127.0.0.1:9/ingest', enabled: true, env: {}, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const client = gm.wrapClient(new OpenAI({ apiKey: 'test-key', fetch: server.fetch, maxRetries: 0 }));
    const gate = vi.spyOn(gm.session, 'gate');
    const completion = await client.chat.completions.create({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'x' }] });
    expect(completion.choices[0]?.finish_reason).toBe('length');
    expect(gm.session.attached).toBe(false);
    expect(gate.mock.calls.map((call) => call[0])).toEqual(['before', 'after']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
  });
});
