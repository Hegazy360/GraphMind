// Probe 3: throwing from a handler (raiseError), token streaming, abort signal.
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];

class Thrower extends BaseCallbackHandler {
  name = 'thrower';
  constructor(opts) {
    super({ _awaitHandler: true, raiseError: opts.raiseError });
    this.mode = opts.mode;
  }
  handleToolStart(t, input, runId, parentRunId, tags, metadata, runName) {
    log.push({ cb: 'toolStart', runName });
    if (this.mode === 'throw-tool') {
      const e = new Error('gm abort');
      e.name = 'AbortError';
      throw e;
    }
  }
  handleChatModelStart() {
    log.push({ cb: 'chatModelStart' });
    if (this.mode === 'throw-llm') {
      const e = new Error('gm abort');
      e.name = 'AbortError';
      throw e;
    }
  }
  handleLLMNewToken(token) {
    log.push({ cb: 'token', token });
  }
  handleLLMEnd(output) {
    log.push({ cb: 'llmEnd', usageMeta: output?.generations?.[0]?.[0]?.message?.usage_metadata, llmOutput: output?.llmOutput });
  }
  handleChainError(err, runId, parentRunId, tags) {
    log.push({ cb: 'chainError', msg: String(err?.message).slice(0, 40), name: err?.name });
  }
  handleToolError(err) {
    log.push({ cb: 'toolError', msg: String(err?.message).slice(0, 40) });
  }
}

const echo = tool(
  async ({ text }) => {
    log.push({ cb: 'BODY:echo' });
    return `echo:${text}`;
  },
  { name: 'echo', description: 'echo', schema: z.object({ text: z.string() }) },
);

const State = Annotation.Root({ value: Annotation({ reducer: (a, b) => b ?? a, default: () => '' }) });
const model = new FakeListChatModel({ responses: ['hello there friend'] });
const streamingModel = new FakeListChatModel({ responses: ['stream me please'], sleep: 1 });

function makeGraph(nodeFn) {
  return new StateGraph(State)
    .addNode('work', nodeFn)
    .addEdge(START, 'work')
    .addEdge('work', END)
    .compile();
}

async function scenario(label, fn) {
  log.length = 0;
  console.log('\n=== ' + label + ' ===');
  try {
    const r = await fn();
    console.log('OK', JSON.stringify(r));
  } catch (e) {
    console.log('THREW', e?.name, String(e?.message).slice(0, 80));
  }
  for (const e of log) console.log('  ', JSON.stringify(e));
}

const toolGraph = makeGraph(async (state) => {
  const out = await echo.invoke({ text: state.value });
  return { value: String(out?.content ?? out) };
});

await scenario('throw from handleToolStart, raiseError: FALSE', () =>
  toolGraph.invoke({ value: 'x' }, { callbacks: [new Thrower({ mode: 'throw-tool', raiseError: false })] }),
);

await scenario('throw from handleToolStart, raiseError: TRUE', () =>
  toolGraph.invoke({ value: 'x' }, { callbacks: [new Thrower({ mode: 'throw-tool', raiseError: true })] }),
);

const streamGraph = makeGraph(async () => {
  let text = '';
  for await (const chunk of await streamingModel.stream('hi')) text += chunk.content;
  return { value: text };
});

await scenario('token streaming via model.stream()', () =>
  streamGraph.invoke({ value: 'x' }, { callbacks: [new Thrower({ mode: 'none', raiseError: false })] }),
);

await scenario('throw from handleChatModelStart, raiseError: TRUE', () =>
  streamGraph.invoke({ value: 'x' }, { callbacks: [new Thrower({ mode: 'throw-llm', raiseError: true })] }),
);

// abort via config.signal while a handler holds
const holdGraph = makeGraph(async (state) => {
  log.push({ cb: 'BODY:node-start' });
  await sleep(400);
  log.push({ cb: 'BODY:node-end' });
  const out = await echo.invoke({ text: state.value });
  return { value: String(out?.content ?? out) };
});

await scenario('abort via config.signal mid-node', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('aborted by debugger')), 100);
  return holdGraph.invoke({ value: 'x' }, { callbacks: [new Thrower({ mode: 'none', raiseError: false })], signal: ac.signal });
});
