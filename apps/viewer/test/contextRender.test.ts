/**
 * Render test of the Context & cost section (server-rendered markup — the
 * unit suite has no DOM): usage header, priced cost with the snapshot date,
 * run-so-far, the held-cache note and the prompt diff; the unknown-model and
 * refusal paths; and no dollar figure before the price table has loaded.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextCost } from '../src/components/ContextCost.js';
import { computeDiffOutcome } from '../src/context/diffOutcome.js';
import { setPriceTableForTests } from '../src/prices/loader.js';
import type { PriceTable } from '../src/prices/engine.js';
import { useRunStore } from '../src/store/runStore.js';
import { RUN, ev, resetCounters, started } from './helpers.js';
import { recordedRun } from './recorded.js';

const TABLE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/prices/data_slim.json', import.meta.url)), 'utf8'),
) as PriceTable;

const MIN = 60_000;
const T0 = Date.parse('2026-09-01T12:00:00Z');

const system = { role: 'system', content: 'You plan trips.' };
const ask = { role: 'user', content: 'Plan my trip to Lisbon.' };
const call = {
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'searchFlights', input: { to: 'LIS' } }],
};
const result = {
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'searchFlights', output: { type: 'json', value: { id: 'TP1234' } } }],
};

function load(events: ReturnType<typeof ev>[]): void {
  const store = useRunStore.getState();
  for (const e of events) store.applyEvent(e, 'fixture');
}

function render(nodeId: string, execIndex: number): string {
  const run = useRunStore.getState().runs[RUN];
  const node = run?.nodes[nodeId];
  const exec = node?.executions[execIndex];
  if (node === undefined || exec === undefined) throw new Error('missing exec');
  return renderToStaticMarkup(createElement(ContextCost, { runId: RUN, node, exec, execIndex }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

beforeEach(() => {
  resetCounters();
  useRunStore.setState({ runs: {} });
});
afterEach(() => setPriceTableForTests(undefined));

function agentLoop(model: string, provider: string): void {
  const input1 = { prompt: [system, ask], modelId: model, provider };
  const input2 = { prompt: [system, ask, call, result], modelId: model, provider };
  load([
    ev('run.started', { app: 'trip', sdk: { name: 'ai', version: '7' } }, { ts: T0 }),
    started('agent:trip', 'agent', { instanceId: RUN, ts: T0 }),
    started('llm:step', 'llm', { parentId: 'agent:trip', instanceId: 'inv1:s0', ts: T0 + 10, input: input1 }),
    ev(
      'node.finished',
      {
        nodeId: 'llm:step',
        instanceId: 'inv1:s0',
        output: { text: '' },
        durationMs: 900,
        status: 'ok',
        usage: { inputTokens: 12_000, outputTokens: 300, inclusive: true, cacheReadTokens: 0, cacheWriteTokens: 11_000 },
      },
      { ts: T0 + 1_000 },
    ),
    started('tool:searchFlights', 'tool', { parentId: 'llm:step', instanceId: 'c1', ts: T0 + 1_100 }),
    ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:searchFlights', point: 'before' }, { ts: T0 + 1_200 }),
    ev('exec.resumed', { pauseId: 'p1', action: 'continue' }, { ts: T0 + 1_200 + 9 * MIN }),
    ev('node.finished', { nodeId: 'tool:searchFlights', instanceId: 'c1', output: {}, durationMs: 5, status: 'ok' }, { ts: T0 + 1_300 + 9 * MIN }),
    started('llm:step', 'llm', { parentId: 'agent:trip', instanceId: 'inv1:s1', ts: T0 + 1_400 + 9 * MIN, input: input2 }),
    ev(
      'node.finished',
      {
        nodeId: 'llm:step',
        instanceId: 'inv1:s1',
        output: { text: 'Booked.' },
        durationMs: 800,
        status: 'ok',
        usage: { inputTokens: 12_400, outputTokens: 120, inclusive: true, cacheReadTokens: 0, cacheWriteTokens: 12_300, reasoningTokens: 40 },
      },
      { ts: T0 + 2_200 + 9 * MIN },
    ),
  ]);
  computeDiffOutcome(input1, input2); // the view computes after first paint; pre-warm for SSR
}

describe('Context & cost render', () => {
  it('usage header, priced cost, run so far, held-cache note and the diff', () => {
    setPriceTableForTests(TABLE);
    agentLoop('claude-sonnet-4-5', 'anthropic.messages');
    const out = text(render('llm:step', 1));

    expect(out).toContain('Context & cost');
    expect(out).toContain('≈ est. (prices as of 2026-09-22)');
    expect(out).toContain('12k tokens in'); // inclusive: no "as reported"
    expect(out).not.toContain('as reported');
    expect(out).toContain('12k cache write');
    expect(out).toContain('0 cache read');
    expect(out).toContain('40 reasoning');
    expect(out).toContain('120 tokens out');
    // 100 fresh × $3 + 12,300 written × $3.75 + 120 out × $15 per Mtok = $0.04823
    expect(out).toContain('$0.048 this step');
    // + step 1: 1,000 × $3 + 11,000 × $3.75 + 300 × $15 = $0.04875 → $0.097
    expect(out).toContain('$0.097 run so far');
    expect(out).toContain('Priced as Anthropic claude-sonnet-4-5');
    expect(out).toContain("Held 9 min before this call — the provider's 5-minute prompt cache has likely expired");

    expect(out).toContain('Prompt vs previous step');
    expect(out).toContain('first difference at message #2 of 3');
    expect(out).toContain('+2 added');
    expect(out).toContain('1 unchanged message');
    expect(out).toContain('assistant → searchFlights');
    expect(out).toContain('tool result: searchFlights');
    expect(out).not.toContain('trimmed?');
  });

  it('first step: nothing to compare; cost present', () => {
    setPriceTableForTests(TABLE);
    agentLoop('claude-sonnet-4-5', 'anthropic');
    const out = text(render('llm:step', 0));
    expect(out).toContain('First LLM step of this agent in the run');
    expect(out).toContain('this step');
    expect(out).not.toContain('Held');
  });

  it('unknown model: usage shown, no dollar figure anywhere', () => {
    setPriceTableForTests(TABLE);
    agentLoop('mock-model-id', 'mock-provider');
    const out = text(render('llm:step', 1));
    expect(out).toContain('tokens in');
    expect(out).toContain('No price for mock-model-id in the price snapshot (2026-09-22) — cost not shown.');
    expect(out).not.toMatch(/\$\d/);
    expect(out).not.toContain('≈ est.');
  });

  it('before the price table loads: no $ and a loading line (the table is lazy)', () => {
    agentLoop('claude-sonnet-4-5', 'anthropic');
    const out = text(render('llm:step', 1));
    expect(out).toContain('Loading prices…');
    expect(out).not.toMatch(/\$\d/);
  });

  it('legacy usage is labelled "as reported"; a preview prompt is refused with the reason', () => {
    setPriceTableForTests(TABLE);
    load([
      started('llm:step', 'llm', { parentId: 'agent:a', instanceId: 's1', ts: T0, input: { model: 'claude-sonnet-4-5', messages: [ask] } }),
      ev('node.finished', { nodeId: 'llm:step', instanceId: 's1', output: null, durationMs: 1, status: 'ok', usage: { inputTokens: 612, outputTokens: 187 } }, { ts: T0 + 10 }),
      started('llm:step', 'llm', { parentId: 'agent:a', instanceId: 's2', ts: T0 + 20, input: { model: 'claude-sonnet-4-5', messages: '« 4 messages + 2 tool results »' } }),
      ev('node.finished', { nodeId: 'llm:step', instanceId: 's2', output: null, durationMs: 1, status: 'ok', usage: { inputTokens: 1418, outputTokens: 156 } }, { ts: T0 + 30 }),
    ]);
    const [e1, e2] = useRunStore.getState().runs[RUN]?.nodes['llm:step']?.executions ?? [];
    computeDiffOutcome(e1?.input, e2?.input);
    const out = text(render('llm:step', 1));
    expect(out).toContain('tokens in (as reported)');
    expect(out).toContain("Can't compare: This step recorded a preview string instead of the messages.");
  });

  it('a real Anthropic loop: inclusive usage, cache rates, context fill, the appended round trip', () => {
    setPriceTableForTests(TABLE);
    load(recordedRun('anthropicTs', T0));
    const execs = useRunStore.getState().runs[RUN]!.nodes['llm:step']!.executions;
    computeDiffOutcome(execs[0]?.input, execs[1]?.input);
    computeDiffOutcome(execs[1]?.input, execs[2]?.input);
    const out = text(render('llm:step', 2));
    expect(out).toContain('2.1k tokens in');
    expect(out).toContain('1.9k cache read');
    expect(out).toContain('0 cache write');
    expect(out).toContain('140 tokens out');
    expect(out).toContain('1% of context'); // 2,130 of claude-sonnet-4-5's 200k window
    // 210 fresh x $3 + 1,920 read x $0.30 + 140 out x $15 per Mtok = $0.003306
    expect(out).toContain('$0.0033 this step');
    // + $0.00792 (step 0: 1,800 written at $3.75) + $0.00279 (step 1)
    expect(out).toContain('$0.014 run so far');
    expect(out).toContain('first difference at message #4 of 5');
    expect(out).toContain('+2 added');
    expect(out).toContain('3 unchanged messages');
    expect(out).toContain('Tools unchanged (3).');
    expect(out).not.toContain('cache misses');
    expect(out).not.toContain('params');
  });

  it('a changed system prompt and sampling params on a real recording: named, with the cache consequence', () => {
    setPriceTableForTests(TABLE);
    const events = recordedRun('anthropicTs', T0);
    const last = events.filter((e) => e.type === 'node.started').at(-1)!;
    const input = structuredClone((last.payload as { input: Record<string, unknown> }).input);
    (input['system'] as { text: string }[])[0]!.text = 'You plan trips.\nNever book red-eye flights.';
    input['temperature'] = 0.9;
    (last.payload as { input: unknown }).input = input;
    load(events);
    const execs = useRunStore.getState().runs[RUN]!.nodes['llm:step']!.executions;
    computeDiffOutcome(execs[1]?.input, execs[2]?.input);
    const out = text(render('llm:step', 2));
    expect(out).toContain('system prompt changed');
    expect(out).toContain('−1 +1 lines');
    expect(out).toContain('The system prompt changed — a provider prompt cache misses from the system prompt on.');
    expect(out).toContain('temperature 0.2 → 0.9');
  });
});

