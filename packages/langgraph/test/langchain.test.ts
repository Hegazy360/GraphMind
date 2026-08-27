/**
 * Plain LangChain (no LangGraph): LCEL chains, retrievers, and the options
 * that shape what reaches the wire.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Document } from '@langchain/core/documents';
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { FakeListChatModel, FakeRetriever } from '@langchain/core/utils/testing';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, waitUntil, type FakeViewerOptions } from './helpers/fake-viewer.js';
import { attach, buildGraph } from './helpers/graph.js';

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

const nodeIds = (viewer: FakeViewer): string[] =>
  viewer.ofType('node.started').map((f) => f.payload['nodeId'] as string);

describe('LCEL chains', () => {
  it('maps a RunnableSequence + chat model + parser', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const chain = RunnableSequence.from([
      RunnableLambda.from((topic: string) => `Write about ${topic}`).withConfig({
        runName: 'buildPrompt',
      }),
      new FakeListChatModel({ responses: ['A short essay.'] }),
      new StringOutputParser(),
    ]);

    const out = await chain.invoke('otters', { callbacks: [gm.handler()] });
    expect(out).toBe('A short essay.');
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    const ids = nodeIds(viewer);
    expect(ids).toContain('agent:RunnableSequence'); // the root is the agent node
    expect(ids).toContain('chain:buildPrompt');
    expect(ids).toContain('llm:FakeListChatModel');
    const llm = viewer
      .ofType('node.started')
      .find((f) => f.payload['nodeId'] === 'llm:FakeListChatModel');
    expect(llm?.payload['parentId']).toBe('agent:RunnableSequence');
    const llmFinish = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'llm:FakeListChatModel');
    expect((llmFinish?.payload['output'] as { text: string }).text).toBe('A short essay.');
  });

  it('maps a retriever to kind "retriever"', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const retriever = new FakeRetriever({
      output: [new Document({ pageContent: 'otters are mustelids' })],
    });
    const docs = await retriever.invoke('otters', { callbacks: [gm.handler()] });
    expect(docs.length).toBe(1);
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    const started = viewer
      .ofType('node.started')
      .find((f) => f.payload['kind'] === 'retriever');
    expect(started?.payload['nodeId']).toBe('retriever:FakeRetriever');
    expect(started?.payload['input']).toEqual({ query: 'otters' });
    const finished = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'retriever:FakeRetriever');
    expect((finished?.payload['output'] as { count: number }).count).toBe(1);
  });
});

describe('options', () => {
  it('chains: "langgraph" renders only the graph and its named nodes', async () => {
    const { viewer, gm } = await setup({}, { chains: 'langgraph' });
    await attach(gm);

    const State = Annotation.Root({
      value: Annotation<string>({ reducer: (a, b) => b ?? a, default: () => '' }),
    });
    const inner = RunnableLambda.from((s: string) => s.toUpperCase()).withConfig({
      runName: 'shout',
    });
    const graph = new StateGraph(State)
      .addNode('work', async (state) => ({ value: await inner.invoke(state.value) }))
      .addEdge(START, 'work')
      .addEdge('work', END)
      .compile();

    await graph.invoke({ value: 'hi' }, { callbacks: [gm.handler()] });
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    const ids = nodeIds(viewer);
    expect(ids).toContain('agent:LangGraph');
    expect(ids).toContain('chain:work');
    expect(ids).not.toContain('chain:shout'); // an inner LCEL chain, filtered out
  });

  it('chains: "none" keeps only the run boundary and non-chain nodes', async () => {
    const { viewer, gm } = await setup({}, { chains: 'none' });
    await attach(gm);

    const { graph } = buildGraph(gm);
    await graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler()] });
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    const ids = nodeIds(viewer);
    expect(ids).toContain('agent:LangGraph');
    expect(ids).toContain('tool:searchFlights');
    expect(ids).toContain('llm:FakeListChatModel');
    expect(ids.some((id) => id.startsWith('chain:'))).toBe(false);
    // Parentage falls back to the nearest emitted ancestor.
    const tool = viewer
      .ofType('node.started')
      .find((f) => f.payload['nodeId'] === 'tool:searchFlights');
    expect(tool?.payload['parentId']).toBe('agent:LangGraph');
  });

  it('truncates oversized payloads instead of shipping them whole', async () => {
    const { viewer, gm } = await setup({}, { maxPayloadChars: 200 });
    await attach(gm);

    const State = Annotation.Root({
      blob: Annotation<string>({ reducer: (a, b) => b ?? a, default: () => '' }),
    });
    const graph = new StateGraph(State)
      .addNode('work', async () => ({ blob: 'y'.repeat(50_000) }))
      .addEdge(START, 'work')
      .addEdge('work', END)
      .compile();

    await graph.invoke({ blob: 'x'.repeat(50_000) }, { callbacks: [gm.handler()] });
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    const root = viewer.ofType('node.started').find((f) => f.payload['kind'] === 'agent');
    const input = root?.payload['input'] as { __graphmind: string; chars: number };
    expect(input.__graphmind).toBe('truncated');
    expect(input.chars).toBeGreaterThan(50_000);
    // Nothing anywhere near the raw size reached the wire.
    for (const frame of viewer.received) {
      expect(JSON.stringify(frame).length).toBeLessThan(5_000);
    }
  });

  it('autoRun: false attributes everything to the implicit run', async () => {
    const { viewer, gm } = await setup({}, { autoRun: false });
    await attach(gm);

    const first = buildGraph(gm);
    await first.graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler()] });
    const second = buildGraph(gm);
    await second.graph.invoke({ topic: 'OPO' }, { callbacks: [gm.handler()] });
    await waitUntil(() => nodeIds(viewer).length >= 8, 8000, 'nodes');

    const starts = viewer.ofType('run.started');
    expect(starts.length).toBe(1);
    expect(starts[0]?.payload['meta']).toMatchObject({ implicit: true });
  });

  it('abortMode: "signal" cancels the signal without throwing from the callback', async () => {
    const { viewer, gm, warnings } = await setup(
      { breakpoints: [{ kind: 'tool', name: 'searchFlights' }] },
      { abortMode: 'signal' },
    );
    await attach(gm);

    const { graph } = buildGraph(gm);
    const config = gm.config();
    const promise = graph.invoke({ topic: 'LIS' }, config);
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'abort');

    // The graph stops because LangGraph honours the config signal, not because
    // GraphMind threw into it.
    await expect(promise).rejects.toThrow();
    expect(config.signal.aborted).toBe(true);
    expect(warnings.some((w) => w.includes('abortMode is "signal"'))).toBe(true);
  });
});

describe('hintGraph', () => {
  it("pre-announces a compiled graph's nodes into the graph's OWN run", async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const { graph } = buildGraph(gm);
    // The documented order: hint first, then invoke.
    gm.hintGraph(graph);

    // Nothing is emitted yet — emitting here would open the session's implicit
    // run and leave an empty placeholder run in the viewer's run list.
    expect(viewer.ofType('graph.hint')).toHaveLength(0);
    expect(viewer.ofType('run.started')).toHaveLength(0);

    await graph.invoke({ topic: 'LIS' }, gm.config());
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    // Exactly one run, and the hint is inside it, ahead of every node.
    const runs = viewer.ofType('run.started');
    expect(runs).toHaveLength(1);
    const hints = viewer.ofType('graph.hint');
    expect(hints).toHaveLength(1);
    expect(hints[0]!.runId).toBe(runs[0]!.runId);
    const firstNode = viewer.ofType('node.started')[0];
    expect(firstNode).toBeDefined();
    expect(hints[0]!.seq).toBeLessThan(firstNode!.seq);

    const names = (hints[0]!.payload['nodes'] as { name: string }[]).map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(['plan', 'flights', 'budget', 'report']));
    expect(names).not.toContain('__start__');
  });

  it('called INSIDE gm.run() announces immediately, and only once for that run', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const { graph } = buildGraph(gm);
    await gm.run('trip', async () => {
      gm.hintGraph(graph);
      // Already inside a run: the roster ships straight away, no implicit run.
      await waitUntil(() => viewer.ofType('graph.hint').length >= 1, 8000, 'graph.hint');
      await graph.invoke({ topic: 'LIS' }, gm.config());
    });
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    expect(viewer.ofType('run.started')).toHaveLength(1);
    // The handler replays the roster when it adopts the run; that must not
    // announce the same graph twice.
    expect(viewer.ofType('graph.hint')).toHaveLength(1);
  });

  it('is a silent no-op for something that is not a compiled graph', async () => {
    const { viewer, gm, warnings } = await setup();
    await attach(gm);
    gm.hintGraph({ notAGraph: true });
    gm.hintGraph(undefined);
    expect(viewer.ofType('graph.hint').length).toBe(0);
    expect(warnings).toEqual([]);
  });
});
