/**
 * Hermetic replay, end to end, through the real public API.
 *
 * The shape of every test here is the same and is the whole claim: run the
 * scripted agent once against a fake viewer, turn the events it recorded
 * into a tape, then run the SAME agent again with that tape loaded and with
 * the model and the tool bodies rigged to EXPLODE if anything reaches them.
 * A replay that touches the outside world fails loudly rather than quietly
 * passing.
 *
 * The tape is built here from the recorded envelopes with the same rules as
 * the CLI's `buildTape` (packages/cli/src/replay/tape.ts, which has its own
 * unit tests) — this suite is about the client+adapter half: what a loaded
 * tape does to a running agent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import {
  canonicalCall,
  DEFAULT_LOOP_IGNORE_KEYS,
  ReplayTape,
  TAPE_VERSION,
  type Tape,
  type TapeEntry,
} from '@graphmind-ai/client';
import { graphmind, type Graphmind } from '../src/index.js';
import { FakeViewer, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';
import { Marks, makeMockModel, makeTools, runScenario } from './helpers/scenario.js';
import { MockLanguageModel, type MockLanguageModel as MockLanguageModelInstance } from './helpers/sdk-compat.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Build a tape from recorded frames — the CLI's rules, in miniature. */
function tapeFrom(frames: readonly ReceivedFrame[]): Tape {
  const entries: TapeEntry[] = [];
  const open = new Map<string, TapeEntry>();
  const ordinals = new Map<string, number>();
  for (const frame of frames) {
    const payload = frame.payload as Record<string, any>;
    if (frame.type === 'node.started') {
      if (payload['kind'] !== 'tool' && payload['kind'] !== 'llm') continue;
      const ordinal = ordinals.get(payload['nodeId']) ?? 0;
      ordinals.set(payload['nodeId'], ordinal + 1);
      const entry: TapeEntry = {
        nodeId: payload['nodeId'],
        kind: payload['kind'],
        name: payload['name'],
        ordinal,
        seq: frame.seq,
        status: 'aborted',
        ...(payload['input'] !== undefined
          ? { key: canonicalCall(payload['nodeId'], payload['input'], new Set(DEFAULT_LOOP_IGNORE_KEYS)) }
          : {}),
      };
      entries.push(entry);
      open.set(payload['instanceId'], entry);
    } else if (frame.type === 'node.finished') {
      const entry = open.get(payload['instanceId']) ?? entries.find((e) => e.nodeId === payload['nodeId'] && e.status === 'aborted');
      if (entry === undefined) continue;
      entry.status = payload['status'];
      if (payload['output'] !== undefined) entry.output = payload['output'];
      if (payload['usage'] !== undefined) entry.usage = payload['usage'];
    } else if (frame.type === 'node.error') {
      const entry = open.get(payload['instanceId']) ?? entries.find((e) => e.nodeId === payload['nodeId']);
      if (entry !== undefined) {
        entry.error = { name: payload['error']['name'], message: payload['error']['message'] };
        entry.status = 'error';
      }
    }
  }
  return {
    graphmindTape: TAPE_VERSION,
    runId: 'run_recorded',
    entries: entries.filter((entry) => entry.status !== 'aborted'),
  };
}

/**
 * Record one run of the scripted agent and return its tape.
 *
 * The wait before `dispose()` is not padding: the last step's
 * `node.finished` is emitted after `consumeStream()` resolves, and a
 * recording that loses it has an unfinished execution — which the tape
 * correctly refuses to answer for, so the replay would miss on the final
 * model step. Real agents do the same thing (see the examples' agent.ts).
 */
async function record(flags: Parameters<typeof runScenario>[1] = {}): Promise<{ tape: Tape; text: string }> {
  const viewer = await FakeViewer.start();
  const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
  try {
    const result = await runScenario(gm, flags);
    await waitUntil(
      () => viewer.received.filter((frame) => frame.type === 'node.finished' && frame.payload['nodeId'] === 'llm:step').length >= 3,
      2000,
    );
    await gm.dispose();
    return { tape: tapeFrom(viewer.received), text: result.text };
  } finally {
    await viewer.close();
  }
}

/** A session with `tape` loaded, plus a viewer recording the replayed run. */
async function replaying(tape: Tape, options: { onMiss?: 'error' | 'live' | 'skip' } = {}) {
  const viewer = await FakeViewer.start();
  const warnings: string[] = [];
  const events: { kind: string; nodeId: string }[] = [];
  const gm = graphmind({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    logger: (message) => warnings.push(message),
    replay: new ReplayTape(tape, {
      ...(options.onMiss !== undefined ? { onMiss: options.onMiss } : {}),
      onEvent: (event) => events.push({ kind: event.kind, nodeId: event.nodeId }),
    }),
  });
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  return { gm, viewer, warnings, events };
}

/**
 * The same tool set the recording used — same names, same schemas, so the
 * SDK parses the replayed tool calls exactly as it did live — but with
 * bodies that must never run.
 */
function explodingTools(touched: string[]) {
  const boom = async (name: string): Promise<Record<string, unknown>> => {
    touched.push(name);
    throw new Error(`REPLAY LEAK: ${name} really executed`);
  };
  return {
    searchFlights: tool({
      description: 'Search for flights between two airports',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async () => await boom('searchFlights'),
    }),
    checkWeather: tool({
      description: 'Get the weather forecast for a city',
      inputSchema: z.object({ city: z.string() }),
      execute: async () => await boom('checkWeather'),
    }),
    convertCurrency: tool({
      description: 'Convert an amount between currencies',
      inputSchema: z.object({ amount: z.number(), from: z.string(), to: z.string() }),
      execute: async () => await boom('convertCurrency'),
    }),
  };
}

/**
 * A model that must never be called during a replay. Built from the SDK's
 * own mock so it carries the installed major's `specificationVersion` —
 * the replay model inherits that, and a wrong one silently reshapes tool
 * calls (the SDK's cross-spec conversion).
 */
function explodingModel(touched: string[]): MockLanguageModelInstance {
  const explode = async (): Promise<never> => {
    touched.push('model');
    throw new Error('REPLAY LEAK: the provider was called');
  };
  return new MockLanguageModel({ doStream: explode, doGenerate: explode });
}

/**
 * Wait for the replayed run's own envelopes to reach the fake viewer.
 * `streamText` resolves before the adapter's last events are flushed, so an
 * assertion on `viewer.received` without this reads an empty list and
 * "proves" the opposite of what happened.
 */
async function flushed(viewer: FakeViewer, type: string, count: number): Promise<void> {
  await waitUntil(
    () => viewer.received.filter((frame) => frame.type === type && String(frame.payload['nodeId']).startsWith('tool:')).length >= count,
    2000,
  );
}

/**
 * Run the agent under replay. `realModel` substitutes a WORKING model for
 * the exploding one — needed by the counterfactual tests, where the run is
 * supposed to continue past the cut by genuinely calling the provider.
 */
async function runReplayed(
  gm: Graphmind,
  touched: string[],
  realModel?: MockLanguageModelInstance,
): Promise<{ text: string; steps: number }> {
  const model = gm.wrapModel(realModel ?? explodingModel(touched));
  const tools = gm.wrapTools(explodingTools(touched));
  return await gm.run('replayed', async () => {
    const result = streamText({
      model,
      tools,
      prompt: 'Plan my trip from Vienna to Lisbon with a 100 EUR budget check.',
      stopWhen: stepCountIs(5),
      onError: () => {},
    });
    await result.consumeStream();
    const steps = await result.steps;
    return { text: await result.text, steps: steps.length };
  });
}

describe('hermetic replay of a recorded run', () => {
  it('reaches neither the provider nor a tool body, and reproduces the answer', async () => {
    const recorded = await record();
    const touched: string[] = [];
    const { gm, viewer } = await replaying(recorded.tape);

    const replayed = await runReplayed(gm, touched);
    await flushed(viewer, 'node.finished', 3);

    expect(touched).toEqual([]); // nothing real ran
    expect(replayed.text).toBe(recorded.text);
    expect(replayed.steps).toBe(3);

    // The replayed run is recorded like any other run.
    const toolFinishes = viewer.received.filter(
      (frame) => frame.type === 'node.finished' && String(frame.payload['nodeId']).startsWith('tool:'),
    );
    expect(toolFinishes.length).toBe(3);
  });

  it('replays the tools with the arguments the recording captured', async () => {
    const recorded = await record();
    const { gm, viewer } = await replaying(recorded.tape);
    await runReplayed(gm, []);
    await flushed(viewer, 'node.started', 3);

    const started = viewer.received.filter((frame) => frame.type === 'node.started' && frame.payload['kind'] === 'tool');
    expect(started.map((frame) => frame.payload['name'])).toEqual([
      'searchFlights',
      'checkWeather',
      'convertCurrency',
    ]);
    expect(started[0]?.payload['input']).toEqual({ from: 'VIE', to: 'LIS' });
  });

  it('replays a tool that THREW as a throw, not as a value', async () => {
    const recorded = await record({ currencyThrows: true });
    const { gm, viewer } = await replaying(recorded.tape);
    const touched: string[] = [];
    await runReplayed(gm, touched);
    await waitUntil(() => viewer.received.some((frame) => frame.type === 'node.error'), 2000);

    expect(touched).toEqual([]);
    const errors = viewer.received.filter((frame) => frame.type === 'node.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload['nodeId']).toBe('tool:convertCurrency');
    expect(String((errors[0]?.payload['error'] as any).message)).toContain('HTTP 500');
  });

  it('is deterministic: two replays of one tape agree', async () => {
    const recorded = await record();
    const first = await replaying(recorded.tape);
    const a = await runReplayed(first.gm, []);
    const second = await replaying(recorded.tape);
    const b = await runReplayed(second.gm, []);
    expect(a.text).toBe(b.text);
  });
});

describe('divergence and misses', () => {
  it('a tape that runs out stops the run instead of calling the provider', async () => {
    const recorded = await record();
    // Keep only the first LLM step: the agent will ask for a second.
    const truncated: Tape = {
      ...recorded.tape,
      entries: recorded.tape.entries.filter((entry) => entry.kind !== 'llm' || entry.ordinal === 0),
    };
    const { gm } = await replaying(truncated);
    const touched: string[] = [];
    await runReplayed(gm, touched);
    // The provider was never reached; the run ended on the replay miss.
    expect(touched).toEqual([]);
  });

  it('--on-miss=live lets an unmatched call run for real', async () => {
    const recorded = await record();
    const toolsOnly: Tape = {
      ...recorded.tape,
      entries: recorded.tape.entries.filter((entry) => entry.kind === 'llm'),
    };
    const { gm } = await replaying(toolsOnly, { onMiss: 'live' });
    const touched: string[] = [];
    await runReplayed(gm, touched);
    // The LLM steps replayed; the tools, absent from the tape, really ran.
    expect(touched).toContain('searchFlights');
  });
});

describe('the counterfactual (--substitute sets Tape.cutSeq)', () => {
  /** The seq of the first tool call in a recording — where a cut would land. */
  const firstToolSeq = (tape: Tape): number =>
    tape.entries.find((entry) => entry.kind === 'tool')?.seq ?? 0;

  it('replays up to the cut, substitutes there, and runs everything after for real', async () => {
    const recorded = await record();
    const cutSeq = firstToolSeq(recorded.tape);
    const entries = recorded.tape.entries.map((entry) =>
      entry.seq === cutSeq ? { ...entry, output: { flights: [{ id: 'SUBSTITUTED' }] } } : entry,
    );
    const { gm } = await replaying({ ...recorded.tape, entries, cutSeq });

    const touched: string[] = [];
    await runReplayed(gm, touched);

    // The model step AFTER the cut must reach the real provider, and the
    // later tools must really execute — that is what a counterfactual is.
    expect(touched).toContain('model');
  });

  it('answers the substituted call itself from the tape, not for real', async () => {
    const recorded = await record();
    const cutSeq = firstToolSeq(recorded.tape);
    const entries = recorded.tape.entries.map((entry) =>
      entry.seq === cutSeq ? { ...entry, output: { flights: [{ id: 'SUBSTITUTED' }] } } : entry,
    );
    const { gm, events } = await replaying({ ...recorded.tape, entries, cutSeq });
    await runReplayed(gm, []);

    // searchFlights (the cut call) was answered; nothing before it ran.
    expect(events.filter((event) => event.kind === 'answered').map((event) => event.nodeId)).toContain(
      'tool:searchFlights',
    );
  });

  it('reports calls past the cut as live rather than as misses', async () => {
    const recorded = await record();
    const cutSeq = firstToolSeq(recorded.tape);
    const { gm, events } = await replaying({ ...recorded.tape, cutSeq });
    // A working model, so the run actually continues past the cut and the
    // later tool calls get as far as asking the tape.
    const marks = new Marks();
    const model = gm.wrapModel(makeMockModel(marks));
    const tools = gm.wrapTools(makeTools(marks, {}));
    await gm.run('counterfactual', async () => {
      const stream = streamText({ model, tools, prompt: 'go', stopWhen: stepCountIs(5), onError: () => {} });
      await stream.consumeStream();
      return stream.text;
    });

    // Past the cut the tape steps aside: those calls are reported live and
    // their bodies really ran. Nothing is reported as a miss — a cut is not
    // a gap in the recording.
    expect(events.filter((event) => event.kind === 'live').length).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === 'miss')).toBe(false);
    expect(marks.count('mock:doStream')).toBeGreaterThan(0);
  });
});

describe('--live-model (Tape.liveModel)', () => {
  it('serves tool calls from the tape but calls the provider for model steps', async () => {
    const recorded = await record();
    const { gm, events } = await replaying({ ...recorded.tape, liveModel: true });
    const marks = new Marks();
    // A real (mock) model drives the conversation; the tools must still be
    // answered from the recording, so their bodies must not run.
    const model = gm.wrapModel(makeMockModel(marks));
    const touched: string[] = [];
    const tools = gm.wrapTools(explodingTools(touched));
    await gm.run('live-model', async () => {
      const stream = streamText({ model, tools, prompt: 'go', stopWhen: stepCountIs(5), onError: () => {} });
      await stream.consumeStream();
      return stream.text;
    });

    expect(marks.count('mock:doStream')).toBeGreaterThan(0); // the model really ran
    expect(touched).toEqual([]); // ...and no tool body did
    expect(events.filter((event) => event.kind === 'answered').length).toBeGreaterThan(0);
  });
});

describe('what a replayed run tells its reader', () => {
  it('warns which replay mode this is — the token cost differs between them', async () => {
    const recorded = await record();

    const plain = await replaying(recorded.tape);
    plain.gm.wrapModel(explodingModel([]));
    expect(plain.warnings.join('\n')).toContain('no provider will be called');

    // Both of these DO call the provider. A warning that said otherwise
    // would understate what the run costs, which is the worst kind of wrong.
    const live = await replaying({ ...recorded.tape, liveModel: true });
    live.gm.wrapModel(explodingModel([]));
    expect(live.warnings.join('\n')).toContain('--live-model');
    expect(live.warnings.join('\n')).toContain('calls the provider for real');

    const cut = await replaying({ ...recorded.tape, cutSeq: 1 });
    cut.gm.wrapModel(explodingModel([]));
    expect(cut.warnings.join('\n')).toContain('the provider IS called for real');
  });

  it('a session with no tape is untouched (every call runs)', async () => {
    const viewer = await FakeViewer.start();
    const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(async () => {
      await gm.dispose();
      await viewer.close();
    });
    expect(gm.session.replay).toBeUndefined();
    const marks = new Marks();
    const model = gm.wrapModel(makeMockModel(marks));
    const tools = gm.wrapTools(makeTools(marks, {}));
    const result = await gm.run('live', async () => {
      const stream = streamText({ model, tools, prompt: 'go', stopWhen: stepCountIs(5), onError: () => {} });
      await stream.consumeStream();
      return stream.text;
    });
    expect(result).toContain('TP1234');
    expect(marks.count('mock:doStream')).toBeGreaterThan(0);
  });
});
