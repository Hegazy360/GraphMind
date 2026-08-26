// Probe 2: runtime arg order, parallelism, errors, streaming, and whether an
// awaited handler genuinely HOLDS execution.
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const t0 = Date.now();
const log = [];
const rel = () => Date.now() - t0;
const short = (s) => (typeof s === 'string' ? s.slice(-6) : s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Probe extends BaseCallbackHandler {
  name = 'probe';
  constructor(opts = {}) {
    super({ _awaitHandler: true, ...opts });
    this.holdTool = opts.holdTool;
  }
  handleChainStart(chain, inputs, runId, a4, tags, metadata, a7, a8) {
    log.push({
      at: rel(), cb: 'chainStart', runId: short(runId),
      a4: short(a4), a7, a8,
      tags, lc: chain?.id?.at(-1),
      lgNode: metadata?.langgraph_node, lgStep: metadata?.langgraph_step,
    });
  }
  handleChainEnd(outputs, runId, parentRunId, tags) {
    log.push({ at: rel(), cb: 'chainEnd', runId: short(runId), parent: short(parentRunId), tags });
  }
  handleChainError(err, runId, parentRunId, tags) {
    log.push({ at: rel(), cb: 'chainError', runId: short(runId), parent: short(parentRunId), msg: String(err?.message).slice(0, 60) });
  }
  handleChatModelStart(llm, messages, runId, parentRunId, extraParams, tags, metadata, runName) {
    log.push({ at: rel(), cb: 'chatModelStart', runId: short(runId), parent: short(parentRunId), runName, lc: llm?.id?.at(-1), lsProvider: metadata?.ls_provider, lsModel: metadata?.ls_model_name });
  }
  handleLLMNewToken(token, idx, runId) {
    log.push({ at: rel(), cb: 'token', runId: short(runId), token });
  }
  handleLLMEnd(output, runId, parentRunId) {
    log.push({ at: rel(), cb: 'llmEnd', runId: short(runId), parent: short(parentRunId), llmOutput: output?.llmOutput, usageMeta: output?.generations?.[0]?.[0]?.message?.usage_metadata });
  }
  async handleToolStart(t, input, runId, parentRunId, tags, metadata, runName, toolCallId) {
    log.push({ at: rel(), cb: 'toolStart', runId: short(runId), parent: short(parentRunId), runName, input, toolCallId, lgNode: metadata?.langgraph_node });
    if (this.holdTool === runName) {
      log.push({ at: rel(), cb: 'HOLD-begin', runName });
      await sleep(300);
      log.push({ at: rel(), cb: 'HOLD-end', runName });
    }
  }
  handleToolEnd(output, runId, parentRunId) {
    log.push({ at: rel(), cb: 'toolEnd', runId: short(runId), parent: short(parentRunId), out: String(output?.content ?? output).slice(0, 40) });
  }
  handleToolError(err, runId, parentRunId) {
    log.push({ at: rel(), cb: 'toolError', runId: short(runId), parent: short(parentRunId), msg: String(err?.message).slice(0, 60) });
  }
  handleRetrieverStart(r, query, runId, parentRunId, tags, metadata, name) {
    log.push({ at: rel(), cb: 'retrieverStart', runId: short(runId), parent: short(parentRunId), query, name });
  }
  handleRetrieverEnd(docs, runId, parentRunId) {
    log.push({ at: rel(), cb: 'retrieverEnd', runId: short(runId), parent: short(parentRunId), n: docs.length });
  }
}

const echo = tool(
  async ({ text }) => {
    log.push({ at: rel(), cb: 'BODY:echo' });
    await sleep(20);
    return `echo:${text}`;
  },
  { name: 'echo', description: 'echo text', schema: z.object({ text: z.string() }) },
);

const boom = tool(
  async () => {
    log.push({ at: rel(), cb: 'BODY:boom' });
    throw new Error('boom failed');
  },
  { name: 'boom', description: 'always throws', schema: z.object({}) },
);

const State = Annotation.Root({
  value: Annotation({ reducer: (a, b) => b ?? a, default: () => '' }),
  notes: Annotation({ reducer: (a, b) => [...(a ?? []), ...(b ?? [])], default: () => [] }),
});

const model = new FakeListChatModel({ responses: ['hello from the model'] });

const graph = new StateGraph(State)
  .addNode('plan', async (state) => {
    const res = await model.invoke('plan for ' + state.value);
    return { value: res.content };
  })
  .addNode('left', async (state) => {
    const out = await echo.invoke({ text: 'L' });
    return { notes: [String(out?.content ?? out)] };
  })
  .addNode('right', async () => {
    try {
      await boom.invoke({});
    } catch (e) {
      return { notes: ['caught:' + e.message] };
    }
    return {};
  })
  .addNode('join', async (state) => ({ value: state.notes.join('|') }))
  .addEdge(START, 'plan')
  .addEdge('plan', 'left')
  .addEdge('plan', 'right')
  .addEdge('left', 'join')
  .addEdge('right', 'join')
  .addEdge('join', END)
  .compile();

const probe = new Probe({ holdTool: 'echo' });
const result = await graph.invoke({ value: 'trip' }, { callbacks: [probe], configurable: { thread_id: 't1' } });
console.log('RESULT', JSON.stringify(result));
console.log('--- callbacks ---');
for (const e of log) console.log(JSON.stringify(e));

// Proof: did the echo body start only after the hold ended?
const holdBegin = log.find((e) => e.cb === 'HOLD-begin');
const holdEnd = log.find((e) => e.cb === 'HOLD-end');
const body = log.find((e) => e.cb === 'BODY:echo');
console.log('\nPAUSE PROOF: holdBegin', holdBegin?.at, 'holdEnd', holdEnd?.at, 'bodyStart', body?.at,
  '=> held?', body && holdEnd && body.at >= holdEnd.at);
// Did the parallel branch (boom) proceed while echo was held?
const boomBody = log.find((e) => e.cb === 'BODY:boom');
console.log('PARALLEL: boom body at', boomBody?.at, '(held echo from', holdBegin?.at, 'to', holdEnd?.at, ')');
