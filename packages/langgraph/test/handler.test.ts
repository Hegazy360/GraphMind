/**
 * The callback handler against a REAL compiled LangGraph and a fake debugger
 * WebSocket server: envelope sequence, parentage, node kinds, token batching,
 * and the pause proofs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { graphmind, type Graphmind, type GraphmindOptions } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type FakeViewerOptions } from './helpers/fake-viewer.js';
import { attach, buildGraph, Marks, type ScenarioFlags } from './helpers/graph.js';

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

function bodyStart(marks: Marks, toolName: string) {
  return marks.first('tool:body-start', (m) => m.data?.['toolName'] === toolName);
}

function run(gm: Graphmind, flags: ScenarioFlags = {}) {
  const { graph, marks } = buildGraph(gm, flags);
  const promise = graph.invoke(
    { topic: 'LIS' },
    { callbacks: [gm.handler()], configurable: { thread_id: 'thread-1' } },
  );
  return { marks, promise };
}

describe('observation', () => {
  it('maps the LangGraph run tree onto GraphMind nodes', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const { promise } = run(gm);
    const result = await promise;
    expect(result.reportText).toContain('TP1234');
    await waitUntil(
      () => viewer.ofType('run.finished').length >= 1,
      8000,
      'run.finished',
    );

    const started = viewer.ofType('node.started');
    const byNode = new Map(started.map((f) => [f.payload['nodeId'] as string, f.payload]));

    // The graph itself is the agent node; its LangGraph nodes are chains.
    expect(byNode.get('agent:LangGraph')?.['kind']).toBe('agent');
    expect(byNode.get('chain:plan')?.['kind']).toBe('chain');
    expect(byNode.get('chain:flights')?.['kind']).toBe('chain');
    expect(byNode.get('chain:budget')?.['kind']).toBe('chain');
    expect(byNode.get('chain:report')?.['kind']).toBe('chain');
    // The chat model and both tools.
    expect(byNode.get('llm:FakeListChatModel')?.['kind']).toBe('llm');
    expect(byNode.get('tool:searchFlights')?.['kind']).toBe('tool');
    expect(byNode.get('tool:convertCurrency')?.['kind']).toBe('tool');

    // Parentage follows LangChain's parentRunId, and LangGraph's hidden
    // `__start__` bookkeeping never becomes a node.
    expect(byNode.get('chain:plan')?.['parentId']).toBe('agent:LangGraph');
    expect(byNode.get('llm:FakeListChatModel')?.['parentId']).toBe('chain:plan');
    expect(byNode.get('tool:searchFlights')?.['parentId']).toBe('chain:flights');
    expect(byNode.get('tool:convertCurrency')?.['parentId']).toBe('chain:budget');
    expect(byNode.has('chain:__start__')).toBe(false);

    // LangGraph metadata rides along on the loose payload.
    expect(byNode.get('chain:plan')?.['langgraphNode']).toBe('plan');
    expect(byNode.get('chain:plan')?.['langgraphStep']).toBe(1);
    expect(byNode.get('agent:LangGraph')?.['threadId']).toBe('thread-1');

    // Every node.started has an instanceId, and every finish carries the same
    // one back (the attribution fix for concurrent instances).
    for (const frame of started) expect(typeof frame.payload['instanceId']).toBe('string');
    for (const frame of viewer.ofType('node.finished')) {
      expect(typeof frame.payload['instanceId']).toBe('string');
      expect(typeof frame.payload['durationMs']).toBe('number');
    }
    const startedIds = new Set(started.map((f) => f.payload['instanceId']));
    for (const frame of viewer.ofType('node.finished')) {
      expect(startedIds.has(frame.payload['instanceId'])).toBe(true);
    }
  });

  it('opens one run per invocation, with run.started/run.finished around it', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const first = buildGraph(gm);
    await first.graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler()] });
    const second = buildGraph(gm);
    await second.graph.invoke({ topic: 'OPO' }, { callbacks: [gm.handler()] });
    await waitUntil(() => viewer.ofType('run.finished').length >= 2, 8000, 'two runs');

    const starts = viewer.ofType('run.started');
    const finishes = viewer.ofType('run.finished');
    expect(starts.length).toBe(2);
    expect(finishes.length).toBe(2);
    // Distinct runs, and no event leaked into the session's implicit run.
    const runIds = new Set(starts.map((f) => f.runId));
    expect(runIds.size).toBe(2);
    for (const frame of viewer.ofType('node.started')) {
      expect(runIds.has(frame.runId)).toBe(true);
    }
    for (const frame of starts) expect(frame.payload['meta']).toMatchObject({ name: 'LangGraph' });
    for (const frame of finishes) expect(frame.payload['status']).toBe('ok');
  });

  it('keeps two CONCURRENT invocations in separate runs', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const a = buildGraph(gm, { toolDelayMs: 40 });
    const b = buildGraph(gm, { toolDelayMs: 40 });
    await Promise.all([
      a.graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler({ runName: 'run-a' })] }),
      b.graph.invoke({ topic: 'OPO' }, { callbacks: [gm.handler({ runName: 'run-b' })] }),
    ]);
    await waitUntil(() => viewer.ofType('run.finished').length >= 2, 8000, 'two runs');

    const starts = viewer.ofType('run.started');
    expect(starts.length).toBe(2);
    const names = starts.map((f) => (f.payload['meta'] as { name: string }).name).sort();
    expect(names).toEqual(['run-a', 'run-b']);

    // Every node event belongs to one of the two runs, and each run saw a
    // complete set of its own nodes (nothing crossed over or was dropped).
    const runIds = starts.map((f) => f.runId);
    for (const runId of runIds) {
      const ids = viewer
        .ofType('node.started')
        .filter((f) => f.runId === runId)
        .map((f) => f.payload['nodeId']);
      expect(ids.filter((id) => String(id).startsWith('agent:')).length).toBe(1);
      expect(ids).toContain('chain:plan');
      expect(ids).toContain('tool:searchFlights');
      expect(ids).toContain('tool:convertCurrency');
    }
    const stray = viewer
      .ofType('node.started')
      .filter((f) => !runIds.includes(f.runId));
    expect(stray).toEqual([]);
  });

  it('joins an ambient gm.run() instead of opening its own run', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const { graph } = buildGraph(gm);
    await gm.run('research', () => graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler()] }));
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    expect(viewer.ofType('run.started').length).toBe(1);
    expect(viewer.ofType('run.started')[0]?.payload['meta']).toMatchObject({ name: 'research' });
    const nodes = viewer.ofType('node.started').map((f) => f.payload['nodeId']);
    expect(nodes).toContain('agent:research'); // gm.run's own agent node
    expect(nodes).toContain('chain:plan');
  });

  it('batches streamed tokens into node.token events', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const { promise } = run(gm, { stream: true, toolDelayMs: 60 });
    await promise;
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    const tokenFrames = viewer.ofType('node.token');
    // More than one batch means the interval timer flushed mid-stream — the
    // path that runs outside the run's async context. Those batches must still
    // be attributed to the run they came from.
    expect(tokenFrames.length).toBeGreaterThanOrEqual(2);
    const runId = viewer.ofType('run.started')[0]?.runId;
    for (const frame of tokenFrames) expect(frame.runId).toBe(runId);
    expect(tokenFrames.length).toBeGreaterThan(0);
    const text = tokenFrames
      .flatMap((f) => f.payload['deltas'] as { t: string; v: string }[])
      .map((d) => d.v)
      .join('');
    expect(text).toBe('Plan: check the flight and the budget.');
    // Batched, not one envelope per token.
    expect(tokenFrames.length).toBeLessThan(text.length);
    for (const frame of tokenFrames) {
      expect(frame.payload['nodeId']).toBe('llm:FakeListChatModel');
    }
    // node.token always precedes the node.finished it belongs to.
    const lastToken = viewer.received.lastIndexOf(tokenFrames[tokenFrames.length - 1]!);
    const llmFinish = viewer.received.findIndex(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:FakeListChatModel',
    );
    expect(lastToken).toBeLessThan(llmFinish);
  });

  it('reports errors as node.error + node.finished(error)', async () => {
    const { viewer, gm } = await setup();
    await attach(gm);

    const { promise } = run(gm, { currencyThrows: true });
    const result = await promise;
    expect(result.findings.some((f: string) => f.startsWith('error:'))).toBe(true);
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');

    const errors = viewer.ofType('node.error');
    expect(errors.map((f) => f.payload['nodeId'])).toContain('tool:convertCurrency');
    const errorInfo = errors[0]?.payload['error'] as { message: string };
    expect(errorInfo.message).toContain('HTTP 500');
    const finish = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'tool:convertCurrency');
    expect(finish?.payload['status']).toBe('error');
    // The node caught it, so the graph (and the run) still succeeded.
    expect(viewer.ofType('run.finished')[0]?.payload['status']).toBe('ok');
  });
});

describe('pause', () => {
  it('PROOF: a gate in handleToolStart holds the tool body for >= 1s', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);

    const { marks, promise } = run(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(paused.payload['point']).toBe('before');
    const pausedAt = Date.now();

    await tick(1000);
    // The tool body has NOT started while the gate is held.
    expect(bodyStart(marks, 'searchFlights')).toBeUndefined();

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const result = await promise;

    const started = bodyStart(marks, 'searchFlights');
    expect(started).toBeDefined();
    expect(started!.at - pausedAt).toBeGreaterThanOrEqual(950);
    expect(result.reportText).toContain('TP1234');
    expect(viewer.ofType('exec.resumed').length).toBeGreaterThanOrEqual(1);
  });

  it('PROOF: a gate in handleChainStart holds a LangGraph node body', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'chain', name: 'report' }] });
    await attach(gm);

    const { marks, promise } = run(gm);
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'chain:report',
    );
    const pausedAt = Date.now();
    await tick(600);
    expect(marks.first('node:report')).toBeUndefined();

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await promise;
    const entered = marks.first('node:report');
    expect(entered).toBeDefined();
    expect(entered!.at - pausedAt).toBeGreaterThanOrEqual(550);
  });

  it('PROOF: a gate in handleChatModelStart holds the model call', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'llm' }] });
    await attach(gm);

    const { marks, promise } = run(gm);
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    expect(paused.payload['nodeId']).toBe('llm:FakeListChatModel');
    await tick(300);
    // `plan` was entered (the node started), but nothing downstream ran.
    expect(marks.first('node:flights')).toBeUndefined();
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await promise;
    expect(marks.first('node:flights')).toBeDefined();
  });

  it('holds two parallel branches independently', async () => {
    const { viewer, gm } = await setup({
      breakpoints: [
        { kind: 'tool', name: 'searchFlights' },
        { kind: 'tool', name: 'convertCurrency' },
      ],
    });
    await attach(gm);

    const { marks, promise } = run(gm);
    const flights = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    const currency = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:convertCurrency',
    );
    expect(flights.payload['pauseId']).not.toBe(currency.payload['pauseId']);

    // Releasing one branch does not release the other.
    viewer.resume(flights.payload['pauseId'] as string, 'continue');
    await waitUntil(() => bodyStart(marks, 'searchFlights') !== undefined, 5000, 'flights body');
    expect(bodyStart(marks, 'convertCurrency')).toBeUndefined();

    viewer.resume(currency.payload['pauseId'] as string, 'continue');
    const result = await promise;
    expect(result.findings.length).toBe(2);
  });

  it('pauses on error and resumes with continue', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ point: 'error' }] });
    await attach(gm);

    const { promise } = run(gm, { currencyThrows: true });
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    expect(paused.payload['point']).toBe('error');
    expect(paused.payload['nodeId']).toBe('tool:convertCurrency');

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const result = await promise;
    expect(result.findings.some((f: string) => f.startsWith('error:'))).toBe(true);
    // One pause for one failure, even though it bubbles through two chains.
    expect(viewer.ofType('exec.paused').length).toBe(1);
  });

  it('step mode pauses at every before point', async () => {
    const { viewer, gm } = await setup({ mode: 'step' });
    await attach(gm);

    const { promise } = run(gm);
    const seen: string[] = [];
    const drain = (async () => {
      for (;;) {
        const frame = await viewer.waitForNth(
          (f) => f.type === 'exec.paused',
          seen.length + 1,
          8000,
        );
        seen.push(frame.payload['nodeId'] as string);
        viewer.resume(frame.payload['pauseId'] as string, 'continue');
        if (seen.length >= 8) return;
      }
    })();
    await promise;
    await Promise.race([drain, tick(500)]);

    expect(seen[0]).toBe('agent:LangGraph');
    expect(seen).toContain('chain:plan');
    expect(seen).toContain('llm:FakeListChatModel');
    expect(seen).toContain('tool:searchFlights');
    expect(seen).toContain('chain:report');
  });
});

describe('abort', () => {
  it('aborts the graph from a before gate (abortMode: throw)', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool', name: 'searchFlights' }] });
    await attach(gm);

    const { marks, promise } = run(gm);
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'abort');

    await expect(promise).rejects.toThrow();
    // The tool body never ran, and the run is reported as aborted.
    expect(bodyStart(marks, 'searchFlights')).toBeUndefined();
    await waitUntil(() => viewer.ofType('run.finished').length >= 1, 8000, 'run.finished');
    expect(viewer.ofType('run.finished')[0]?.payload['status']).toBe('aborted');
    const finish = viewer
      .ofType('node.finished')
      .find((f) => f.payload['nodeId'] === 'tool:searchFlights');
    expect(finish?.payload['status']).toBe('aborted');
  });

  it('exposes an AbortSignal that gm.config() wires into LangChain', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'chain', name: 'report' }] });
    await attach(gm);

    const { graph } = buildGraph(gm);
    const config = gm.config({ configurable: { thread_id: 't' } });
    expect(config.signal).toBeInstanceOf(AbortSignal);
    expect(Array.isArray((config as { callbacks?: unknown }).callbacks)).toBe(true);

    const promise = graph.invoke({ topic: 'LIS' }, config);
    const paused = await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    await expect(promise).rejects.toThrow();
    expect(config.signal.aborted).toBe(true);
  });
});

describe('fail-open', () => {
  it('is a no-op when the session is disabled', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const gm = graphmind({ url: viewer.url, enabled: false });
    cleanups.push(() => gm.dispose());

    const { graph, marks } = buildGraph(gm, { wrapTools: true });
    const result = await graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler()] });
    expect(result.reportText).toContain('TP1234');
    expect(marks.count('tool:body-start')).toBe(2);
    expect(viewer.received.length).toBe(0);
    expect(gm.session.attached).toBe(false);
  });

  it('runs the graph normally with no debugger listening', async () => {
    const gm = graphmind({
      url: 'ws://127.0.0.1:1/ingest', // nothing is listening
      enabled: true,
      connectTimeoutMs: 50,
      retryIntervalMs: 60_000,
      logger: () => undefined,
    });
    cleanups.push(() => gm.dispose());

    const { graph } = buildGraph(gm, { wrapTools: true });
    const result = await graph.invoke({ topic: 'LIS' }, { callbacks: [gm.handler()] });
    expect(result.reportText).toContain('TP1234');
    expect(gm.session.attached).toBe(false);
  });

  it('releases held gates when the debugger disappears mid-hold', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool' }] });
    await attach(gm);

    const { promise } = run(gm);
    await viewer.waitFor((f) => f.type === 'exec.paused');
    viewer.killAbruptly();

    const result = await promise; // auto-continue on disconnect
    expect(result.reportText).toContain('TP1234');
  });

  it('gm.dispose() releases a held gate and closes the open run', async () => {
    const { viewer, gm } = await setup({ breakpoints: [{ kind: 'tool' }] });
    await attach(gm);

    const { promise } = run(gm);
    await viewer.waitFor((f) => f.type === 'exec.paused');
    await gm.dispose();

    const result = await promise; // the hold was released, not stranded
    expect(result.reportText).toContain('TP1234');
  });

  it('never breaks the graph when the handler itself throws internally', async () => {
    const { gm, warnings } = await setup();
    await attach(gm);

    const handler = gm.handler();
    // Force an internal failure deep inside the handler's bookkeeping.
    (handler as unknown as { tree: { rootFor: () => string } }).tree.rootFor = () => {
      throw new Error('synthetic internal failure');
    };

    const { graph, marks } = buildGraph(gm);
    const result = await graph.invoke({ topic: 'LIS' }, { callbacks: [handler] });
    expect(result.reportText).toContain('TP1234');
    expect(marks.count('tool:body-start')).toBe(2);
    expect(warnings.some((w) => w.includes('internal error in the LangChain callback'))).toBe(true);
  });
});
