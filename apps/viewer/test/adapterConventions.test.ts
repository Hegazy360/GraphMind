/**
 * The ai-sdk adapter's wire conventions: one llm:step node per invocation,
 * instanceId-targeted finishes, ungated provider tools, injected results,
 * streaming-tool metadata, per-instance stream segmentation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { runStateToFlow } from '../src/store/runStateToFlow.js';
import { TokenBufferRegistry } from '../src/store/tokenBuffers.js';
import { RUN, ev, resetCounters, started } from './helpers.js';

beforeEach(resetCounters);

function reduce(events: ReturnType<typeof ev>[]): RunsMap {
  return events.reduce<RunsMap>((runs, event) => applyEvent(runs, event, 'fixture'), {});
}

describe('adapter conventions — llm:step as a single node', () => {
  it('derives agent → llm:step → tools from parentage', () => {
    const runs = reduce([
      started('agent:trip', 'agent'),
      started('llm:step', 'llm', { parentId: 'agent:trip', instanceId: 'inv1:s1' }),
      started('tool:a', 'tool', { parentId: 'llm:step', instanceId: 'call_1' }),
      started('tool:b', 'tool', { parentId: 'llm:step', instanceId: 'call_2' }),
      started('llm:step', 'llm', { parentId: 'agent:trip', instanceId: 'inv1:s2' }),
    ]);
    const run = runs[RUN];
    expect(run).toBeDefined();
    if (run === undefined) return;
    const { nodes, edges } = runStateToFlow(run);
    expect(nodes.map((n) => n.id)).toEqual(['agent:trip', 'llm:step', 'tool:a', 'tool:b']);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      'agent:trip->llm:step',
      'llm:step->tool:a',
      'llm:step->tool:b',
    ]);
    expect(run.nodes['llm:step']?.executions.map((e) => e.instanceId)).toEqual([
      'inv1:s1',
      'inv1:s2',
    ]);
  });
});

describe('adapter conventions — instanceId-targeted node.finished', () => {
  it('resolves parallel instances by instanceId, even out of order', () => {
    const runs = reduce([
      started('tool:w', 'tool', { instanceId: 'call_w1' }),
      started('tool:w', 'tool', { instanceId: 'call_w2' }),
      ev('node.finished', {
        nodeId: 'tool:w',
        instanceId: 'call_w1', // the FIRST one finishes first this time
        output: 'lisbon',
        durationMs: 10,
        status: 'ok',
      } as never),
    ]);
    const node = runs[RUN]?.nodes['tool:w'];
    expect(node?.executions[0]?.status).toBe('ok');
    expect(node?.executions[0]?.output).toBe('lisbon');
    expect(node?.executions[1]?.status).toBe('running');
  });
});

describe('adapter conventions — ungated provider tools', () => {
  it('marks nodes ungated from graph.hint and node.started', () => {
    const runs = reduce([
      ev('graph.hint', {
        nodes: [
          {
            nodeId: 'tool:webSearch',
            kind: 'tool',
            name: 'webSearch',
            providerExecuted: true,
            ungated: true,
          } as never,
        ],
      }),
      ev('node.started', {
        nodeId: 'tool:direct',
        kind: 'tool',
        name: 'direct',
        instanceId: 'c1',
        input: {},
        providerExecuted: true,
      } as never),
    ]);
    expect(runs[RUN]?.nodes['tool:webSearch']?.ungated).toBe(true);
    expect(runs[RUN]?.nodes['tool:direct']?.ungated).toBe(true);
  });
});

describe('adapter conventions — injected + streaming metadata', () => {
  it('records injected and streaming flags on the execution', () => {
    const runs = reduce([
      started('tool:fx', 'tool', { instanceId: 'c1' }),
      ev('node.finished', {
        nodeId: 'tool:fx',
        instanceId: 'c1',
        output: { rate: 1 },
        durationMs: 5,
        status: 'ok',
        injected: true,
        streaming: true,
        chunks: 4,
      } as never),
    ]);
    const exec = runs[RUN]?.nodes['tool:fx']?.executions[0];
    expect(exec?.injected).toBe(true);
    expect(exec?.streaming).toBe(true);
    expect(exec?.chunks).toBe(4);
  });
});

describe('adapter conventions — per-instance stream segmentation', () => {
  it('archives the live buffer at node.started boundaries', () => {
    const reg = new TokenBufferRegistry();
    reg.beginInstance(RUN, 'llm:step'); // execution 0 begins
    reg.push(RUN, 1, 'llm:step', [{ t: 'text', v: 'step one' }]);
    reg.beginInstance(RUN, 'llm:step'); // execution 1 begins
    reg.push(RUN, 2, 'llm:step', [{ t: 'text', v: 'step two' }]);
    reg.beginInstance(RUN, 'llm:step'); // execution 2 begins
    reg.push(RUN, 3, 'llm:step', [{ t: 'text', v: 'step three' }]);
    reg.flushNow();

    expect(reg.getInstanceSnapshot(RUN, 'llm:step', 0, 3).text).toBe('step one');
    expect(reg.getInstanceSnapshot(RUN, 'llm:step', 1, 3).text).toBe('step two');
    expect(reg.getInstanceSnapshot(RUN, 'llm:step', 2, 3).text).toBe('step three'); // live
    expect(reg.getSnapshot(RUN, 'llm:step').text).toBe('step three');
  });

  it('keeps the tail live for the latest execution before any archive exists', () => {
    const reg = new TokenBufferRegistry();
    reg.beginInstance(RUN, 'llm:step');
    reg.push(RUN, 1, 'llm:step', [{ t: 'text', v: 'only' }]);
    reg.flushNow();
    expect(reg.getInstanceSnapshot(RUN, 'llm:step', 0, 1).text).toBe('only');
  });
});
