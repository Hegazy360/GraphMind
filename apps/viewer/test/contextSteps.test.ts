/**
 * Which step the diff compares against, when the call actually went out, and
 * the "prompt cache has likely expired" note (held vs idle).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import {
  CACHE_TTL_MS,
  GAP_REFRESH_MS,
  cacheGapNote,
  cacheGapRecheckAt,
  callHeldOpen,
  callTimeOf,
  previousLlmStep,
  stepsSoFar,
  toolSchemaOf,
} from '../src/context/steps.js';
import type { RunState } from '../src/store/types.js';
import { RUN, ev, resetCounters, started } from './helpers.js';
import { recordedRun, recordedSteps } from './recorded.js';

beforeEach(resetCounters);

const MIN = 60_000;

function build(events: ReturnType<typeof ev>[]): RunState {
  const runs = events.reduce<RunsMap>((acc, e) => applyEvent(acc, e, 'fixture'), {});
  const run = runs[RUN];
  if (run === undefined) throw new Error('no run');
  return run;
}

const finish = (nodeId: string, instanceId: string, ts: number) =>
  ev('node.finished', { nodeId, instanceId, output: null, durationMs: 1, status: 'ok' }, { ts });

function llm(instanceId: string, ts: number, parentId = 'agent:a', nodeId = 'llm:step') {
  return started(nodeId, 'llm', { parentId, instanceId, ts, input: { prompt: [] } });
}

describe('previous LLM step', () => {
  it('is the latest earlier step with the same parent; the first step has none', () => {
    const run = build([
      started('agent:a', 'agent', { instanceId: RUN, ts: 0 }),
      started('agent:b', 'agent', { instanceId: 'b1', ts: 1 }),
      llm('s1', 10),
      finish('llm:step', 's1', 20),
      llm('other', 25, 'agent:b', 'llm:other'),
      llm('s2', 30),
    ]);
    expect(previousLlmStep(run, 'llm:step', 0)).toBeUndefined();
    const prev = previousLlmStep(run, 'llm:step', 1);
    expect(prev?.exec.instanceId).toBe('s1');
    expect(previousLlmStep(run, 'llm:other', 0)).toBeUndefined(); // agent:b has no earlier step
    expect(stepsSoFar(run, run.nodes['llm:step']!.executions[1]!).map((s) => s.exec.instanceId)).toEqual([
      's1',
      'other',
      's2',
    ]);
  });

  it('works across different LLM nodes under one parent (LangGraph names nodes by model)', () => {
    const run = build([
      llm('a1', 10, 'chain:agent', 'llm:gpt-4o'),
      finish('llm:gpt-4o', 'a1', 20),
      llm('b1', 30, 'chain:agent', 'llm:claude'),
    ]);
    expect(previousLlmStep(run, 'llm:claude', 0)?.nodeId).toBe('llm:gpt-4o');
  });

  it('AI SDK steps pair only within their own invocation: a generateText run inside a tool is not the agent\'s previous step', () => {
    // The AI SDK middleware gives every call `llm:step` under `agent:<run>`;
    // only the instanceId's `<invocation>:s<k>` prefix tells the outer agent
    // (inv_1) from the summarizer its tool ran (inv_2).
    const ask = { role: 'user', content: [{ type: 'text', text: 'Summarize the Lisbon article for me.' }] };
    const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'summarize', input: {} }] };
    const result = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'summarize', output: { type: 'json', value: {} } }] };
    const outer = (prompt: unknown[]) => ({ prompt: [{ role: 'system', content: 'You are the main agent.' }, ...prompt], modelId: 'gpt-4o' });
    const inner = {
      prompt: [
        { role: 'system', content: 'You summarize text in one line.' },
        { role: 'user', content: [{ type: 'text', text: 'Lisbon is the capital of Portugal.' }] },
      ],
      modelId: 'gpt-4o-mini',
    };
    const step = (instanceId: string, ts: number, input: unknown) =>
      started('llm:step', 'llm', { parentId: 'agent:a', instanceId, ts, input });
    const run = build([
      step('inv_x_1:s0', 10, outer([ask])),
      finish('llm:step', 'inv_x_1:s0', 20),
      step('inv_x_2:s0', 30, inner),
      finish('llm:step', 'inv_x_2:s0', 40),
      // The adapter's tracker starts a NEW invocation for the agent's next
      // step (the nested call replaced its state) — the conversation is the
      // same, and that is what pairs it.
      step('inv_x_3:s0', 50, outer([ask, call, result])),
      finish('llm:step', 'inv_x_3:s0', 60),
      step('inv_x_3:s1', 70, outer([ask, call, result, { role: 'assistant', content: 'Done.' }])),
    ]);
    expect(previousLlmStep(run, 'llm:step', 1)).toBeUndefined(); // the nested call: a conversation of its own
    expect(previousLlmStep(run, 'llm:step', 2)?.exec.instanceId).toBe('inv_x_1:s0');
    expect(previousLlmStep(run, 'llm:step', 3)?.exec.instanceId).toBe('inv_x_3:s0');
  });
});

describe('cache gap note', () => {
  it('idle: > 5 min since the previous call, no holds', () => {
    const run = build([llm('s1', 0), finish('llm:step', 's1', 1_000), llm('s2', 1_000 + 8 * MIN)]);
    const prev = previousLlmStep(run, 'llm:step', 1)!;
    const note = cacheGapNote(run, prev, { nodeId: 'llm:step', exec: run.nodes['llm:step']!.executions[1]! }, 0);
    expect(note).toEqual({
      kind: 'idle',
      gapMs: 8 * MIN,
      heldMs: 0,
      text: '8 min since the previous call — the prompt cache has likely expired',
    });
  });

  it('nothing under five minutes', () => {
    const run = build([llm('s1', 0), finish('llm:step', 's1', 1_000), llm('s2', 1_000 + 4 * MIN)]);
    const prev = previousLlmStep(run, 'llm:step', 1)!;
    expect(cacheGapNote(run, prev, { nodeId: 'llm:step', exec: run.nodes['llm:step']!.executions[1]! }, 0)).toBeUndefined();
  });

  it('held: a gate hold in between accounts for the gap', () => {
    const run = build([
      started('agent:a', 'agent', { instanceId: RUN, ts: 0 }),
      llm('s1', 0),
      finish('llm:step', 's1', 1_000),
      started('tool:t', 'tool', { parentId: 'llm:step', instanceId: 'c1', ts: 2_000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'before' }, { ts: 10_000 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 10_000 + 7 * MIN }),
      finish('tool:t', 'c1', 10_100 + 7 * MIN),
      llm('s2', 30_000 + 7 * MIN),
    ]);
    const prev = previousLlmStep(run, 'llm:step', 1)!;
    const note = cacheGapNote(run, prev, { nodeId: 'llm:step', exec: run.nodes['llm:step']!.executions[1]! }, 0);
    expect(note?.kind).toBe('held');
    expect(note?.heldMs).toBe(7 * MIN);
    expect(note?.text).toBe("Held 7 min before this call — the provider's 5-minute prompt cache has likely expired");
  });

  it("held at this step's own `before` gate: the call left when the gate opened", () => {
    const run = build([
      llm('s1', 0),
      finish('llm:step', 's1', 1_000),
      llm('s2', 2_000),
      ev('exec.paused', { pauseId: 'p2', nodeId: 'llm:step', point: 'before' }, { ts: 2_100 }),
      ev('exec.resumed', { pauseId: 'p2', action: 'continue' }, { ts: 2_100 + 12 * MIN }),
    ]);
    const exec = run.nodes['llm:step']!.executions[1]!;
    expect(callTimeOf(run, 'llm:step', exec, 0)).toBe(2_100 + 12 * MIN);
    const note = cacheGapNote(run, previousLlmStep(run, 'llm:step', 1)!, { nodeId: 'llm:step', exec }, 0);
    expect(note?.kind).toBe('held');
    expect(note?.text).toMatch(/^Held 12 min before this call/);
  });

  it('a hold still OPEN at this step\'s before gate: the note appears once the gap crosses the cache lifetime, and keeps counting', () => {
    // No event arrives while it is held, so the view re-checks on the clock
    // (cacheGapRecheckAt) instead of waiting for one.
    const run = build([
      llm('s1', 0),
      finish('llm:step', 's1', 900),
      llm('s2', 1_000),
      ev('exec.paused', { pauseId: 'p2', nodeId: 'llm:step', point: 'before', instanceId: 's2' }, { ts: 1_100 }),
    ]);
    const exec = run.nodes['llm:step']!.executions[1]!;
    const prev = previousLlmStep(run, 'llm:step', 1)!;
    const cur = { nodeId: 'llm:step', exec };
    expect(callHeldOpen(run, 'llm:step', exec)).toBe(true);
    const inside = 900 + 296_000;
    expect(cacheGapNote(run, prev, cur, inside)).toBeUndefined();
    // Due exactly when the gap passes five minutes.
    const due = cacheGapRecheckAt(run, prev, cur, inside);
    expect(due).toBe(900 + CACHE_TTL_MS + 1);
    const note = cacheGapNote(run, prev, cur, due!);
    expect(note?.kind).toBe('held');
    expect(note?.text).toMatch(/^Held 5(\.0)? min before this call — the provider's 5-minute prompt cache has likely expired$/);
    // Past it, it recounts the minutes periodically.
    expect(cacheGapRecheckAt(run, prev, cur, 900 + 10 * MIN)).toBe(900 + 10 * MIN + GAP_REFRESH_MS);
    expect(cacheGapNote(run, prev, cur, 900 + 10 * MIN)?.text).toMatch(/^Held 10 min before this call/);
  });

  it('nothing to re-check once the hold is released, or when the step was never held', () => {
    const released = build([
      llm('s1', 0),
      finish('llm:step', 's1', 900),
      llm('s2', 1_000),
      ev('exec.paused', { pauseId: 'p2', nodeId: 'llm:step', point: 'before', instanceId: 's2' }, { ts: 1_100 }),
      ev('exec.resumed', { pauseId: 'p2', action: 'continue' }, { ts: 1_100 + 7 * MIN }),
    ]);
    const exec = released.nodes['llm:step']!.executions[1]!;
    expect(callHeldOpen(released, 'llm:step', exec)).toBe(false);
    expect(cacheGapRecheckAt(released, previousLlmStep(released, 'llm:step', 1), { nodeId: 'llm:step', exec }, 0)).toBeUndefined();
    const plain = build([llm('s1', 0), finish('llm:step', 's1', 900), llm('s2', 1_000)]);
    const exec2 = plain.nodes['llm:step']!.executions[1]!;
    expect(cacheGapRecheckAt(plain, previousLlmStep(plain, 'llm:step', 1), { nodeId: 'llm:step', exec: exec2 }, 0)).toBeUndefined();
  });

  it('a short hold inside a long idle gap is still "idle"', () => {
    const run = build([
      started('agent:a', 'agent', { instanceId: RUN, ts: 0 }),
      llm('s1', 0),
      finish('llm:step', 's1', 0),
      started('tool:t', 'tool', { parentId: 'llm:step', instanceId: 'c1', ts: 1_000 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'before' }, { ts: 1_000 }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: 1_000 + 2 * MIN }),
      llm('s2', 20 * MIN),
    ]);
    const note = cacheGapNote(run, previousLlmStep(run, 'llm:step', 1)!, {
      nodeId: 'llm:step',
      exec: run.nodes['llm:step']!.executions[1]!,
    }, 0);
    expect(note?.kind).toBe('idle');
    expect(note?.heldMs).toBe(2 * MIN);
    expect(note?.text).toBe('20 min since the previous call — the prompt cache has likely expired');
  });

  it('the previous step still running → no note', () => {
    const run = build([llm('s1', 0), llm('s2', 10 * MIN)]);
    const prev = previousLlmStep(run, 'llm:step', 1)!;
    expect(cacheGapNote(run, prev, { nodeId: 'llm:step', exec: run.nodes['llm:step']!.executions[1]! }, 0)).toBeUndefined();
  });
});

describe('model hints captured from node.started', () => {
  it('keeps top-level model/provider strings of an LLM start (LangGraph, imports)', () => {
    const run = build([
      ev('node.started', {
        nodeId: 'llm:ChatOpenAI',
        kind: 'llm',
        name: 'ChatOpenAI',
        instanceId: 'r1',
        input: { messages: [[]] },
        provider: 'openai',
        modelId: 'gpt-4o-mini',
      } as never),
      ev('node.started', { nodeId: 'tool:x', kind: 'tool', name: 'x', instanceId: 't1', model: 'nope' } as never),
    ]);
    expect(run.nodes['llm:ChatOpenAI']?.executions[0]?.modelHint).toEqual({ model: 'gpt-4o-mini', provider: 'openai' });
    expect(run.nodes['tool:x']?.executions[0]?.modelHint).toBeUndefined();
  });
});

describe('real recordings in the store', () => {
  it('every step of a recorded loop pairs with the one before it (same agent parent)', () => {
    for (const name of ['aiSdk', 'anthropicTs', 'langgraphTs', 'rubyLlm']) {
      const run = build(recordedRun(name, 0));
      const nodeId = recordedSteps(name)[0]?.nodeId ?? 'llm:step';
      const count = run.nodes[nodeId]!.executions.length;
      expect(previousLlmStep(run, nodeId, 0), name).toBeUndefined();
      for (let i = 1; i < count; i++) expect(previousLlmStep(run, nodeId, i)?.index, name).toBe(i - 1);
    }
  });

  it('a tool definition is found by hash on whichever step first carried it (toolSchemas once per run)', () => {
    const run = build(recordedRun('aiSdk', 0));
    const hash = (recordedSteps('aiSdk')[2]?.input as { tools: { schemaHash: string }[] }).tools[0]!.schemaHash;
    // Step 2 names the tool by hash only; step 0 carried the definition.
    expect(recordedSteps('aiSdk')[2]?.input).not.toHaveProperty('toolSchemas');
    expect(toolSchemaOf(run, hash)).toMatchObject({ type: 'function', name: 'searchFlights' });
    expect(toolSchemaOf(run, 'ffffffffffffffff')).toBeUndefined();
  });
});
