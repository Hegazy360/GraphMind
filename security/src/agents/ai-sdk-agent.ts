/**
 * The Vercel AI SDK adapter, driven through `streamText` (so the middleware's
 * `wrapStream` + stream-tee path is exercised, not just `wrapGenerate`).
 *
 * The "provider client" here is a hand-rolled LanguageModelV4 that holds the
 * canary credentials in its closure and performs a REAL fetch to the mock
 * provider with them — an Authorization header, an x-org-secret header, and an
 * access_token in the URL. That is exactly the shape of a real
 * `createOpenAICompatible({ apiKey, baseURL, headers })` provider.
 *
 * Additionally the per-call `headers` option of `streamText` carries a canary:
 * it lands in `LanguageModelV4CallOptions.headers`, i.e. inside the very
 * `params` object the GraphMind middleware inspects.
 */
import { simulateReadableStream, stepCountIs, streamText, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { graphmind } from '@graphmind-ai/sdk';
import type { AgentRunOptions } from './anthropic-agent.js';

const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function finish(unified: 'stop' | 'tool-calls'): LanguageModelV4StreamPart {
  return { type: 'finish', usage, finishReason: { unified, raw: unified } };
}

function textParts(id: string, text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
  ];
}

export async function runAiSdkAgent(options: AgentRunOptions): Promise<void> {
  const { canaries, provider, ingestUrl } = options;

  // The provider "client config": credentials that live outside the data path.
  const providerUrl =
    `${provider.origin}/v1/gw/${canaries.value('baseUrlPathToken')}/chat/completions` +
    `?access_token=${canaries.value('baseUrlToken')}`;
  const providerHeaders: Record<string, string> = {
    'content-type': 'application/json',
    Authorization: canaries.value('authHeader'),
    'x-api-key': canaries.value('providerApiKey'),
    'x-org-secret': canaries.value('orgHeader'),
  };

  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (callOptions: LanguageModelV4CallOptions) => {
      const index = call++;
      // A REAL request carrying the credentials, so the mock provider can
      // prove they were on the wire.
      // A real provider merges the per-call `headers` into the HTTP request;
      // this one does too, so the per-request canary is provably on the wire.
      const headers: Record<string, string> = { ...providerHeaders };
      for (const [key, value] of Object.entries(callOptions.headers ?? {})) {
        if (typeof value === 'string') headers[key] = value;
      }
      const response = await fetch(providerUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: callOptions.prompt, step: index }),
      });
      const body = (await response.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[];
      };
      const text = body.choices?.[0]?.message?.content ?? '';
      const toolCalls = body.choices?.[0]?.message?.tool_calls ?? [];

      const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        ...textParts(`t${index}`, text),
      ];
      if (index === 0 && toolCalls.length > 0) {
        parts.push({
          type: 'tool-call',
          toolCallId: 'call-audit-1',
          toolName: 'fetchCredential',
          input: JSON.stringify({ vault: canaries.value('toolArg') }),
        });
        parts.push(finish('tool-calls'));
      } else {
        parts.push(finish('stop'));
      }

      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: parts,
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
        }),
      };
    },
  });

  const gm = graphmind({
    url: ingestUrl,
    enabled: true,
    app: 'audit-ai-sdk',
    waitForAttach: 3000,
    retryIntervalMs: 60_000,
    logger: () => {},
  });

  const tools = gm.wrapTools({
    fetchCredential: tool({
      description: 'Fetch a credential from a vault',
      inputSchema: z.object({ vault: z.string() }),
      execute: async ({ vault }) => ({
        vault,
        credential: canaries.value('toolResultSecret'),
        rotatedAt: '2026-08-27T00:00:00.000Z',
      }),
    }),
  });

  try {
    await gm.run('rotate-credential', async () => {
      const result = streamText({
        model: gm.wrapModel(model),
        tools,
        stopWhen: stepCountIs(3),
        system: `You are an ops assistant. Policy id ${canaries.value('systemPromptText')}.`,
        prompt:
          `Rotate the key ${canaries.value('promptSecret')} and notify ` +
          `${canaries.value('promptPii')}.`,
        // A credential in the SDK's per-call request headers: it reaches the
        // middleware inside `params`, and must never be recorded.
        headers: { 'x-request-secret': canaries.value('perRequestHeader') },
      });
      // Drain: the tee only reports what actually flows.
      for await (const _ of result.textStream) {
        void _;
      }
      await result.finishReason;
    });
  } finally {
    await gm.dispose();
  }
}
