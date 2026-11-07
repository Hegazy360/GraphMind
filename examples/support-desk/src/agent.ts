/**
 * The agent: Vercel AI SDK + Anthropic, instrumented with @graphmind-ai/sdk
 * the same two-line way the README teaches — `gm.wrapModel(...)` +
 * `gm.wrapTools(...)` — nothing example-specific. Fail-open: with no
 * GraphMind server running, every scenario still completes (the loop one
 * just wastes its calls unobserved, which is rather the point).
 */
import { setTimeout as delay } from 'node:timers/promises';
import { anthropic } from '@ai-sdk/anthropic';
import { graphmind, isAbortError } from '@graphmind-ai/sdk';
import { stepCountIs, streamText } from 'ai';
import { SYSTEM_PROMPT, type Scenario } from './scenarios.js';
import { supportTools } from './tools.js';

export interface TicketResult {
  text: string;
  aborted: boolean;
  attached: boolean;
}

export async function runTicket(
  scenario: Scenario,
  log: (message: string) => void,
): Promise<TicketResult> {
  const gm = graphmind({
    app: 'support-desk',
    enabled: true,
    ...(process.env['GRAPHMIND_URL'] !== undefined ? { url: process.env['GRAPHMIND_URL'] } : {}),
  });

  // Wait for the debugger handshake so pause-on-error and the smart holds
  // are armed before the first tool runs. An absent server resolves false
  // and the run proceeds undebugged — fail-open, never an error.
  const attached = await gm.session.ready();
  log(
    attached
      ? 'attached to GraphMind — holds are armed, watch the viewer'
      : 'no GraphMind server found — running undebugged (start one with: npx graphmind-ai)',
  );

  try {
    const model = gm.wrapModel(anthropic(process.env['SUPPORT_DESK_MODEL'] ?? 'claude-sonnet-5-5'));
    const tools = gm.wrapTools(supportTools);

    const result = await gm.run(scenario.runName, async () => {
      const stream = streamText({
        model,
        tools,
        system: SYSTEM_PROMPT,
        prompt: scenario.prompt,
        stopWhen: stepCountIs(scenario.maxSteps),
        onError: () => {}, // tool errors are part of the show
      });
      await stream.consumeStream();
      return { text: await stream.text };
    });
    await delay(400); // let the final envelopes flush through the transport
    return { text: result.text, aborted: false, attached };
  } catch (error) {
    if (isAbortError(error)) {
      await delay(400);
      return { text: '(run aborted from the debugger)', aborted: true, attached };
    }
    throw error;
  } finally {
    await gm.dispose();
  }
}
