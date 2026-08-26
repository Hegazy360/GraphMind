// Probe: what callbacks does a small LangGraph graph actually fire?
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const log = [];

class Probe extends BaseCallbackHandler {
  name = 'probe';
  constructor() {
    super({ _awaitHandler: true });
  }
  handleChainStart(chain, inputs, runId, runType, tags, metadata, runName, parentRunId, extra) {
    log.push({
      cb: 'chainStart',
      runId: runId?.slice(0, 6),
      parent: parentRunId?.slice(0, 6),
      runType,
      runName,
      tags,
      lc_id: chain?.id,
      lgNode: metadata?.langgraph_node,
      lgStep: metadata?.langgraph_step,
      thread: metadata?.thread_id,
      metaKeys: metadata ? Object.keys(metadata) : undefined,
    });
  }
  handleChainEnd(outputs, runId, parentRunId, tags) {
    log.push({ cb: 'chainEnd', runId: runId?.slice(0, 6), parent: parentRunId?.slice(0, 6), tags });
  }
  handleChainError(err, runId, parentRunId, tags) {
    log.push({ cb: 'chainError', runId: runId?.slice(0, 6), parent: parentRunId?.slice(0, 6), msg: String(err?.message) });
  }
  handleChatModelStart(llm, messages, runId, parentRunId, extraParams, tags, metadata, runName) {
    log.push({
      cb: 'chatModelStart',
      runId: runId?.slice(0, 6),
      parent: parentRunId?.slice(0, 6),
      runName,
      lc_id: llm?.id,
      lgNode: metadata?.langgraph_node,
      ls: extraParams?.invocation_params ? Object.keys(extraParams.invocation_params) : undefined,
      metaKeys: metadata ? Object.keys(metadata) : undefined,
    });
  }
  handleLLMNewToken(token, idx, runId) {
    log.push({ cb: 'token', runId: runId?.slice(0, 6), token });
  }
  handleLLMEnd(output, runId, parentRunId) {
    log.push({
      cb: 'llmEnd',
      runId: runId?.slice(0, 6),
      parent: parentRunId?.slice(0, 6),
      llmOutput: output?.llmOutput,
      genInfo: output?.generations?.[0]?.[0]?.generationInfo,
      usageMeta: output?.generations?.[0]?.[0]?.message?.usage_metadata,
      text: output?.generations?.[0]?.[0]?.text,
    });
  }
  handleToolStart(t, input, runId, parentRunId, tags, metadata, runName, toolCallId) {
    log.push({
      cb: 'toolStart',
      runId: runId?.slice(0, 6),
      parent: parentRunId?.slice(0, 6),
      runName,
      input,
      toolCallId,
      lc_id: t?.id,
      lgNode: metadata?.langgraph_node,
    });
  }
  handleToolEnd(output, runId, parentRunId) {
    log.push({ cb: 'toolEnd', runId: runId?.slice(0, 6), out: typeof output === 'object' ? (output?.content ?? output) : output });
  }
  handleToolError(err, runId) {
    log.push({ cb: 'toolError', runId: runId?.slice(0, 6), msg: String(err?.message) });
  }
  handleRetrieverStart(r, query, runId, parentRunId, tags, metadata, name) {
    log.push({ cb: 'retrieverStart', runId: runId?.slice(0, 6), parent: parentRunId?.slice(0, 6), query, name });
  }
  handleRetrieverEnd(docs, runId) {
    log.push({ cb: 'retrieverEnd', runId: runId?.slice(0, 6), n: docs.length });
  }
}

const echo = tool(
  async ({ text }) => {
    return `echo:${text}`;
  },
  { name: 'echo', description: 'echo text', schema: z.object({ text: z.string() }) },
);

const State = Annotation.Root({
  value: Annotation({ reducer: (a, b) => b ?? a, default: () => '' }),
});

const model = new FakeListChatModel({ responses: ['hello from the model'] });

const graph = new StateGraph(State)
  .addNode('plan', async (state) => {
    const res = await model.invoke('plan for ' + state.value);
    return { value: res.content };
  })
  .addNode('act', async (state) => {
    const out = await echo.invoke({ text: state.value });
    return { value: String(out?.content ?? out) };
  })
  .addEdge(START, 'plan')
  .addEdge('plan', 'act')
  .addEdge('act', END)
  .compile();

const probe = new Probe();
const result = await graph.invoke({ value: 'trip' }, { callbacks: [probe], configurable: { thread_id: 't1' } });
console.log('RESULT', JSON.stringify(result));
console.log('--- callbacks ---');
for (const e of log) console.log(JSON.stringify(e));
