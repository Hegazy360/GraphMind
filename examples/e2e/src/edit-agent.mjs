/**
 * A REAL agent for the edit-input end-to-end proofs (Phase 7, contract C2):
 * the viewer's (apps/viewer/e2e/edit-e2e.spec.ts) and the CLI's
 * (packages/cli/test/edit-e2e.test.ts). No fixtures: @graphmind-ai/sdk wraps a
 * MockLanguageModelV4 from `ai/test` and a real `tool()`, streamText drives
 * the loop, and whatever GraphMind server GRAPHMIND_URL names is the debugger.
 *
 * The planted bug: the model asks `convertCurrency` for `to: "XYZ"`, which the
 * tool's schema accepts (three letters) but the tool itself does not know, so
 * `execute` throws. With the server's default `{point:'error'}` breakpoint the
 * call holds at an editable error gate. Whoever holds the debugger edits the
 * argument (`retry` + input); the SDK merges the edit into the live arguments,
 * re-validates it with the tool's own zod schema, and runs the REAL execute
 * with it. The model's second step reports whatever the tool returned.
 *
 * Plain .mjs on purpose: the engines floor (Node 22.13) predates type
 * stripping, and the proofs spawn this with `node` directly.
 *
 * Environment:
 *   GRAPHMIND_URL              the server's ingest socket (ws://127.0.0.1:<port>/ingest)
 *   EDIT_AGENT_VALIDATE_DELAY_MS  optional: the schema's async check waits this
 *                              long on every run, so a resume stays "being
 *                              answered" in the hub long enough for a second
 *                              resume to race it (the first-writer-wins proof).
 *                              An edit runs the schema twice (the raw-arguments
 *                              probe, then the merged edit): keep 2 x this under
 *                              the client's 4 s VALIDATION_TIMEOUT_MS.
 *
 * Output (stdout): `EDIT_AGENT_ATTACHED <runName>` once the handshake is done,
 * then one line `EDIT_AGENT_RESULT <json>` with the final text and every
 * argument object the tool actually executed with. Exit 0 on a finished run.
 */
import { simulateReadableStream, stepCountIs, streamText, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { graphmind } from '@graphmind-ai/sdk';

const RATES = { USD: 1.09, GBP: 0.85, JPY: 162.4 };
const delayMs = Number(process.env.EDIT_AGENT_VALIDATE_DELAY_MS ?? 0);

/** Every argument object `execute` was really called with, in order. */
const executedWith = [];

const usage = { inputTokens: 20, outputTokens: 12, totalTokens: 32 };
const finish = (unified) => ({ type: 'finish', usage, finishReason: { unified, raw: unified } });

function toolResults(prompt) {
  const out = [];
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      out.push(part.output?.value ?? part.output);
    }
  }
  return out;
}

function mockModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const index = call++;
      const parts =
        index === 0
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't0' },
              { type: 'text-delta', id: 't0', delta: 'Converting the budget. ' },
              { type: 'text-end', id: 't0' },
              {
                type: 'tool-call',
                toolCallId: 'call-fx-1',
                toolName: 'convertCurrency',
                // The bad argument: a currency code the tool does not know.
                input: JSON.stringify({ amount: 100, from: 'EUR', to: 'XYZ' }),
              },
              finish('tool-calls'),
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: `Converted: ${JSON.stringify(toolResults(options.prompt))}` },
              { type: 'text-end', id: 't1' },
              finish('stop'),
            ];
      return { stream: simulateReadableStream({ chunks: parts, initialDelayInMs: 5, chunkDelayInMs: 2 }) };
    },
  });
}

const inputSchema = z
  .object({
    amount: z.number().positive(),
    from: z.string().length(3),
    to: z.string().length(3),
  })
  .superRefine(async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  });

async function main() {
  const gm = graphmind({ app: 'edit-e2e-agent' });
  if (!(await gm.ready({ timeoutMs: 10_000 }))) {
    console.error('EDIT_AGENT_ERROR could not attach to the GraphMind server');
    process.exit(2);
  }
  console.log('EDIT_AGENT_ATTACHED edit-e2e');

  const model = gm.wrapModel(mockModel());
  const tools = gm.wrapTools({
    convertCurrency: tool({
      description: 'Convert an amount between currencies',
      inputSchema,
      execute: async (args) => {
        executedWith.push(args);
        const rate = RATES[args.to];
        if (rate === undefined) throw new Error(`unknown currency code "${args.to}"`);
        return { amount: args.amount, from: args.from, to: args.to, converted: Math.round(args.amount * rate * 100) / 100 };
      },
    }),
  });

  const result = await gm.run('edit-e2e', async () => {
    const stream = streamText({
      model,
      tools,
      prompt: 'Convert 100 EUR for the trip budget.',
      stopWhen: stepCountIs(4),
      onError: () => {},
    });
    await stream.consumeStream();
    return { text: await stream.text };
  });

  console.log(`EDIT_AGENT_RESULT ${JSON.stringify({ text: result.text, executedWith })}`);
  // Let the last envelopes (run.finished) reach the server before closing.
  await new Promise((resolve) => setTimeout(resolve, 300));
  gm.dispose();
  process.exit(0);
}

main().catch((error) => {
  console.error('EDIT_AGENT_ERROR', error);
  process.exit(1);
});
