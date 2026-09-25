/**
 * The callback handler's `after` gates hand the session the recorded output
 * (0.6.0, contract C4 / W4) through real LangChain runs:
 *   - an LLM run: the normalized `{text, finishReason, toolCalls}` — a model
 *     stopped by `max_tokens` while writing a tool call is a smart hold
 *     (`truncated-tool-call`) before `invoke()` returns (LangChain awaits
 *     handleLLMEnd), and abort there rejects the run;
 *   - a callback-gated tool run: its result — an error-shaped one is a smart
 *     hold (`error-result`);
 *   - detached, every gate is called with no options, as in 0.5.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { Annotation, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import type { AfterGateContext, GateDetector, Session } from '@graphmind-ai/client';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';
import { attach } from './helpers/graph.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(gmOptions: Partial<GraphmindOptions> = {}): Promise<{ viewer: FakeViewer; gm: Graphmind }> {
  const viewer = await FakeViewer.start();
  const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {}, logger: () => {}, ...gmOptions });
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  await attach(gm);
  return { viewer, gm };
}

function detectorsOf(session: Session): GateDetector[] {
  return (session as unknown as { detectors: GateDetector[] }).detectors;
}

/** A chat model that answers with one scripted AIMessage. */
class ScriptedChatModel extends BaseChatModel {
  constructor(private readonly reply: () => AIMessage) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.reply();
    return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
  }
}

/** Stopped by max_tokens while writing `write`'s arguments (LangChain could not parse them). */
const truncated = (): AIMessage =>
  new AIMessage({
    content: 'Writing.',
    invalid_tool_calls: [{ id: 'call_9', name: 'write', args: '{"path":"a.txt","content":"hel', error: 'bad json', type: 'invalid_tool_call' }],
    response_metadata: { stop_reason: 'max_tokens' },
  } as never);

function pausedFor(viewer: FakeViewer, kind: string): Promise<ReceivedFrame> {
  const match = (f: ReceivedFrame): boolean => {
    if (f.type !== 'exec.paused') return false;
    const started = viewer.received.find((s) => s.type === 'node.started' && s.payload['nodeId'] === f.payload['nodeId']);
    return started?.payload['kind'] === kind;
  };
  return waitUntil(() => viewer.received.some(match), 8000, `${kind} pause`).then(
    () => viewer.received.find(match) as ReceivedFrame,
  );
}

describe('LLM runs: truncated-tool-call at the handler after gate', () => {
  it('holds before invoke() returns, with the smart rule; the gate saw the normalized output', async () => {
    const { viewer, gm } = await setup();
    const seen: AfterGateContext[] = [];
    detectorsOf(gm.session).unshift((context) => {
      if (context.node.kind === 'llm') seen.push(context);
      return undefined;
    });
    let settled = false;
    const promise = new ScriptedChatModel(truncated)
      .invoke([new HumanMessage('write a.txt')], { callbacks: [gm.handler()] })
      .then((value) => {
        settled = true;
        return value;
      });
    const paused = await pausedFor(viewer, 'llm');
    expect(paused.payload).toMatchObject({
      point: 'after',
      reason: 'breakpoint',
      smart: {
        rule: 'truncated-tool-call',
        detail: 'the model was stopped at the token limit with 1 tool call requested; 1 call has arguments that did not parse',
      },
    });
    const normalized = {
      text: 'Writing.',
      finishReason: 'length',
      rawFinishReason: 'max_tokens',
      toolCalls: [{ id: 'call_9', name: 'write', input: null, inputText: '{"path":"a.txt","content":"hel' }],
    };
    expect(seen[0]?.result).toEqual(normalized);
    // The callback path records the output first, then holds (observe-only).
    const finished = viewer.ofType('node.finished').find((f) => f.payload['nodeId'] === paused.payload['nodeId']);
    expect(finished?.payload['output']).toEqual(normalized);
    await tick(200);
    expect(settled).toBe(false);

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const message = await promise;
    expect(message.content).toBe('Writing.');
  });

  it('abort at the hold rejects the run with the AbortError', async () => {
    const { viewer, gm } = await setup();
    const promise = new ScriptedChatModel(truncated).invoke([new HumanMessage('write')], { callbacks: [gm.handler()] });
    const paused = await pausedFor(viewer, 'llm');
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('retry and inject are refused at the hold (a callback cannot re-run or replace the call)', async () => {
    const { viewer, gm } = await setup();
    let settled = false;
    const promise = new ScriptedChatModel(truncated)
      .invoke([new HumanMessage('write')], { callbacks: [gm.handler()] })
      .finally(() => {
        settled = true;
      });
    const paused = await pausedFor(viewer, 'llm');
    const pauseId = paused.payload['pauseId'] as string;
    viewer.resume(pauseId, 'retry');
    await waitUntil(() => viewer.ofType('exec.refused').length === 1, 3000, 'retry refused');
    viewer.resume(pauseId, 'inject', { content: 'forged' });
    await waitUntil(() => viewer.ofType('exec.refused').length === 2, 3000, 'inject refused');
    expect(viewer.ofType('exec.refused').map((f) => f.payload['code'])).toEqual(['unsupported', 'unsupported']);
    await tick(100);
    expect(settled).toBe(false);
    viewer.resume(pauseId, 'continue');
    expect((await promise).content).toBe('Writing.');
  });

  it('a normal answer, or GRAPHMIND_BREAK_ON_TRUNCATED=0, is not held', async () => {
    const { viewer, gm } = await setup({ env: { GRAPHMIND_BREAK_ON_TRUNCATED: '0' } });
    await new ScriptedChatModel(truncated).invoke([new HumanMessage('write')], { callbacks: [gm.handler()] });
    await new ScriptedChatModel(() => new AIMessage('fine')).invoke([new HumanMessage('hi')], { callbacks: [gm.handler()] });
    await waitUntil(() => viewer.ofType('run.finished').length >= 2, 8000, 'two runs');
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });
});

describe('callback-gated tools: error-result at the handler after gate', () => {
  it('an error-shaped result holds with the smart rule; a normal one does not', async () => {
    const { viewer, gm } = await setup();
    const deploy = tool(async ({ ok }: { ok: boolean }) => (ok ? { deployed: true } : { success: false, reason: 'quota' }), {
      name: 'deploy',
      description: 'Deploy',
      schema: z.object({ ok: z.boolean() }),
    });
    expect(await deploy.invoke({ ok: true }, { callbacks: [gm.handler()] })).toEqual({ deployed: true });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);

    const promise = deploy.invoke({ ok: false }, { callbacks: [gm.handler()] });
    const paused = await pausedFor(viewer, 'tool');
    // The second deploy run is the held one (the callback handler's instanceId).
    const heldRun = viewer
      .ofType('node.started')
      .filter((f) => f.payload['nodeId'] === 'tool:deploy')
      .at(-1)?.payload['instanceId'];
    expect(typeof heldRun).toBe('string');
    expect(paused.payload).toEqual({
      pauseId: paused.payload['pauseId'],
      nodeId: 'tool:deploy',
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'error-result', detail: 'the tool returned a result with success: false' },
      instanceId: heldRun,
    });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await promise).toEqual({ success: false, reason: 'quota' });
  });
});

/*
 * LangGraph's ToolNode (and createReactAgent) invokes a tool with a ToolCall;
 * @langchain/core then hands handleToolEnd a ToolMessage whose content is
 * JSON.stringify(result). The tool's own object must still reach the
 * error-result rule, the record and the loop guard.
 */
describe('callback-gated tools called with a ToolCall (ToolNode)', () => {
  const FAILURE = { success: false, reason: 'quota' };

  function makeDeploy() {
    return tool(
      async ({ ok }: { ok: boolean; attempt?: number }) => (ok ? { deployed: true } : { ...FAILURE }),
      {
        name: 'deploy',
        description: 'Deploy',
        schema: z.object({ ok: z.boolean(), attempt: z.number().optional() }),
      },
    );
  }

  /**
   * LangChain serializes an object tool result into the ToolMessage's content
   * itself — compact in current @langchain/core, indented at the 0.3.40 floor.
   * Either way the caller's content must be LangChain's own string, untouched:
   * compare what it says, not how LangChain spaced it.
   */
  function jsonContent(content: unknown): unknown {
    expect(typeof content).toBe('string');
    return JSON.parse(content as string);
  }

  function deployOutputs(viewer: FakeViewer): unknown[] {
    const starts = new Set(
      viewer
        .ofType('node.started')
        .filter((f) => f.payload['nodeId'] === 'tool:deploy')
        .map((f) => f.payload['instanceId']),
    );
    return viewer
      .ofType('node.finished')
      .filter((f) => starts.has(f.payload['instanceId']))
      .map((f) => f.payload['output']);
  }

  it('an error-shaped result invoked with a ToolCall holds with error-result and is recorded as the object', async () => {
    const { viewer, gm } = await setup();
    const deploy = makeDeploy();
    const promise = deploy.invoke(
      { name: 'deploy', args: { ok: false }, id: 'call_1', type: 'tool_call' },
      { callbacks: [gm.handler()] },
    );
    const paused = await pausedFor(viewer, 'tool');
    expect(paused.payload).toMatchObject({
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'error-result', detail: 'the tool returned a result with success: false' },
    });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    // LangChain still hands the caller its ToolMessage, content untouched.
    expect(jsonContent(((await promise) as { content?: unknown }).content)).toEqual(FAILURE);
    expect(deployOutputs(viewer)).toEqual([FAILURE]);
  });

  it('a real ToolNode in a StateGraph holds the error-shaped result; a normal one and a text one do not', async () => {
    const { viewer, gm } = await setup();
    const note = tool(async () => 'noted', { name: 'note', description: 'Note', schema: z.object({}) });
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('tools', new ToolNode([makeDeploy(), note]))
      .addEdge(START, 'tools')
      .addEdge('tools', END)
      .compile();
    const ask = (calls: { name: string; args: Record<string, unknown> }[]) =>
      graph.invoke(
        {
          messages: [
            new AIMessage({
              content: '',
              tool_calls: calls.map((c, i) => ({ ...c, id: `call_${i}`, type: 'tool_call' as const })),
            }),
          ],
        },
        { callbacks: [gm.handler()] },
      );

    await ask([{ name: 'deploy', args: { ok: true } }, { name: 'note', args: {} }]);
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'first run');
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    expect(deployOutputs(viewer)).toEqual([{ deployed: true }]);
    const noteRun = viewer.ofType('node.started').find((f) => f.payload['nodeId'] === 'tool:note')?.payload['instanceId'];
    const noteFinished = viewer.ofType('node.finished').find((f) => f.payload['instanceId'] === noteRun);
    expect(noteFinished?.payload['output']).toBe('noted'); // plain text stays text

    const promise = ask([{ name: 'deploy', args: { ok: false } }]);
    const paused = await pausedFor(viewer, 'tool');
    expect(paused.payload).toMatchObject({ nodeId: 'tool:deploy', point: 'after', smart: { rule: 'error-result' } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const state = await promise;
    expect(jsonContent((state.messages.at(-1) as BaseMessage).content)).toEqual(FAILURE);
  });

  it('three identical returned failures through ToolNode hold the 4th call with error-repeat', async () => {
    // Smart error-result holds off, so only the loop hold can pause.
    const { viewer, gm } = await setup({ env: { GRAPHMIND_BREAK_ON_ERROR_RESULT: '0' } });
    const LoopState = Annotation.Root({
      ...MessagesAnnotation.spec,
      attempt: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
    });
    // agent -> tools -> agent ... four times in one run; distinct args per
    // attempt (the identical-call rule stays out of it), one failure each time.
    const graph = new StateGraph(LoopState)
      .addNode('agent', (state: typeof LoopState.State) => {
        const attempt = state.attempt + 1;
        return {
          attempt,
          messages: [
            new AIMessage({
              content: '',
              tool_calls: [{ name: 'deploy', args: { ok: false, attempt }, id: `call_${attempt}`, type: 'tool_call' }],
            }),
          ],
        };
      })
      .addNode('tools', new ToolNode([makeDeploy()]))
      .addEdge(START, 'agent')
      .addEdge('agent', 'tools')
      .addConditionalEdges('tools', (state: typeof LoopState.State) => (state.attempt >= 4 ? END : 'agent'), {
        agent: 'agent',
        [END]: END,
      })
      .compile();
    const release = viewer.releaseEveryPause('continue');
    cleanups.push(() => release.stop());
    await graph.invoke({ messages: [] }, { callbacks: [gm.handler()], recursionLimit: 50 });
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run');
    expect(deployOutputs(viewer)).toEqual([FAILURE, FAILURE, FAILURE, FAILURE]);
    const loop = viewer
      .ofType('exec.paused')
      .filter((f) => f.payload['nodeId'] === 'tool:deploy' && f.payload['reason'] === 'loop');
    expect(loop).toHaveLength(1);
    expect(loop[0]?.payload).toMatchObject({ point: 'before', loop: { kind: 'error-repeat', repeats: 3 } });
  });
});

describe('detached', () => {
  it('the LLM and tool after gates are called with no options', async () => {
    // Port 9 (discard): never a GraphMind server, so the session stays detached.
    const gm = graphmind({ url: 'ws://127.0.0.1:9/ingest', enabled: true, env: {}, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const gate = vi.spyOn(gm.session, 'gate');
    await new ScriptedChatModel(truncated).invoke([new HumanMessage('write')], { callbacks: [gm.handler()] });
    const deploy = tool(async () => ({ success: false }), { name: 'deploy', description: 'Deploy', schema: z.object({}) });
    await deploy.invoke({}, { callbacks: [gm.handler()] });
    expect(gm.session.attached).toBe(false);
    const afters = gate.mock.calls.filter((call) => call[0] === 'after');
    expect(afters.map((call) => call[1].kind)).toEqual(['llm', 'tool']);
    for (const call of gate.mock.calls) expect(call[2]).toBeUndefined();
  });
});
