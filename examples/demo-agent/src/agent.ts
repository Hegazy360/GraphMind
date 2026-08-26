/**
 * The GraphMind demo agent: a Vercel AI SDK trip planner instrumented with
 * @graphmind/ai-sdk. Two modes:
 *
 *  - 'mock' (default): the scripted MockLanguageModelV4 — deterministic,
 *    keyless, streams tokens. This is what the bundled demo fixture records.
 *  - 'live': a real model via the user's key — ANTHROPIC_API_KEY (Claude,
 *    preferred) or OPENAI_API_KEY. Override the model id with
 *    GRAPHMIND_DEMO_MODEL.
 *
 * Either way the tools are the same — including the PLANTED BUG in
 * convertCurrency (see tools.ts) that makes checkBudget throw. With a
 * GraphMind server attached, that error pauses the run (pause-on-error is
 * default-armed) and the debugger's inject/retry/continue/abort all work for
 * real.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { graphmind, isAbortError, type WrapModelInput } from '@graphmind/ai-sdk';
import { stepCountIs, streamText } from 'ai';
import { makeMockTripPlannerModel } from './mock-model.js';
import { demoTools } from './tools.js';

export type TripPlannerMode = 'mock' | 'live';

export interface TripPlannerOptions {
  mode: TripPlannerMode;
  /** GraphMind ingest endpoint. Default: GRAPHMIND_URL or ws://127.0.0.1:4747/ingest. */
  url?: string;
  /** Run name (the agent node's label). Default 'plan-tokyo-trip'. */
  runName?: string;
  log?: (message: string) => void;
}

export interface TripPlannerResult {
  text: string;
  aborted: boolean;
}

const PROMPT =
  'Plan a 5-day trip to Tokyo in November for 2 people flying from San Francisco, ' +
  'budget $3,800. Search flights, check the weather, convert the total cost to USD, ' +
  'verify it against the budget, then summarize the plan.';

function resolveLiveModel(): WrapModelInput {
  const override = process.env['GRAPHMIND_DEMO_MODEL'];
  if (process.env['ANTHROPIC_API_KEY'] !== undefined && process.env['ANTHROPIC_API_KEY'] !== '') {
    return anthropic(override ?? 'claude-opus-5');
  }
  if (process.env['OPENAI_API_KEY'] !== undefined && process.env['OPENAI_API_KEY'] !== '') {
    return openai(override ?? 'gpt-5.1');
  }
  throw new Error(
    'live mode needs an API key: set ANTHROPIC_API_KEY (or OPENAI_API_KEY), or drop --live for the keyless mock mode',
  );
}

export async function runTripPlanner(options: TripPlannerOptions): Promise<TripPlannerResult> {
  const log = options.log ?? (() => {});
  const gm = graphmind({
    app: 'trip-planner',
    enabled: true,
    ...(options.url !== undefined ? { url: options.url } : {}),
  });

  // Wait for the debugger handshake so pause-on-error is armed before the
  // first tool runs. Fail-open: an absent server just means no debugging.
  const attached = await gm.session.ready();
  log(attached ? 'attached to GraphMind' : 'no GraphMind server found — running undebugged');

  try {
    const model = gm.wrapModel(
      options.mode === 'live' ? resolveLiveModel() : makeMockTripPlannerModel(),
    );
    const tools = gm.wrapTools(demoTools);
    const result = await gm.run(options.runName ?? 'plan-tokyo-trip', async () => {
      const stream = streamText({
        model,
        tools,
        prompt: PROMPT,
        stopWhen: stepCountIs(6),
        onError: () => {}, // tool errors are part of the show
      });
      await stream.consumeStream();
      return { text: await stream.text };
    });
    await delay(400); // let the final envelopes flush through the transport
    return { text: result.text, aborted: false };
  } catch (error) {
    if (isAbortError(error)) {
      await delay(400);
      return { text: '(run aborted from the debugger)', aborted: true };
    }
    throw error;
  } finally {
    await gm.dispose();
  }
}
