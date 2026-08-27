/**
 * A realistic instrumented Anthropic agent, wired for maximum leak surface.
 *
 * Credentials planted (all 'forbidden'):
 *   - `apiKey` on the real Anthropic client
 *   - `Authorization` and `x-org-secret` in `defaultHeaders`
 *   - an `access_token=` in the query string of a custom `baseURL`
 *   - a per-request header passed in the SDK's request-options argument
 *   - AWS keys / DB password / PII in `process.env`
 *
 * Data the user deliberately supplies (all 'by-design', MUST be recorded):
 *   - a secret pasted into the user message, and PII in the same message
 *   - text in the `system` prompt
 *   - the tool argument the model chooses
 *   - the credential the wrapped tool returns
 */
import Anthropic from '@anthropic-ai/sdk';
import { graphmind } from '@graphmind-ai/anthropic';
import type { CanarySet } from '../canaries.js';
import type { MockProvider } from '../mock-provider.js';

export interface AgentRunOptions {
  readonly ingestUrl: string;
  readonly canaries: CanarySet;
  readonly provider: MockProvider;
  /** Force an error from the provider so the node.error path is exercised. */
  readonly expectFailure?: boolean;
}

export async function runAnthropicAgent(options: AgentRunOptions): Promise<void> {
  const { canaries, provider, ingestUrl } = options;

  const client = new Anthropic({
    apiKey: canaries.value('providerApiKey'),
    // A gateway URL that carries its own token in the path, plus a token
    // appended to every request's query string — the classic "secret in the
    // client config" shapes.
    baseURL: `${provider.origin}/v1/gw/${canaries.value('baseUrlPathToken')}`,
    defaultQuery: { access_token: canaries.value('baseUrlToken') },
    defaultHeaders: {
      Authorization: canaries.value('authHeader'),
      'x-org-secret': canaries.value('orgHeader'),
    },
    maxRetries: 0,
    timeout: 10_000,
  });

  const gm = graphmind({
    url: ingestUrl,
    enabled: true,
    app: 'audit-anthropic',
    waitForAttach: 3000,
    retryIntervalMs: 60_000,
    logger: () => {},
  });

  // A tool that fetches a credential: its argument and its return value are
  // both recorded ON PURPOSE (that is the debugger doing its job).
  const tools = gm.wrapTools({
    fetchCredential: async (input: { vault: string }) => ({
      vault: input.vault,
      credential: canaries.value('toolResultSecret'),
      rotatedAt: '2026-08-27T00:00:00.000Z',
    }),
  });

  const wrapped = gm.wrapClient(client);

  try {
    await gm.run('rotate-credential', async () => {
      const requestOptions = {
        headers: { 'x-request-secret': canaries.value('perRequestHeader') },
      };

      const first = await wrapped.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 64,
          system: `You are an ops assistant. Policy id ${canaries.value('systemPromptText')}.`,
          messages: [
            {
              role: 'user',
              content:
                `Rotate the key ${canaries.value('promptSecret')} and notify ` +
                `${canaries.value('promptPii')}.`,
            },
          ],
          tools: [
            {
              name: 'fetchCredential',
              description: 'Fetch a credential from a vault',
              input_schema: {
                type: 'object' as const,
                properties: { vault: { type: 'string' } },
                required: ['vault'],
              },
            },
          ],
        },
        requestOptions,
      );

      const toolUse = first.content.find((block) => block.type === 'tool_use');
      if (toolUse === undefined || toolUse.type !== 'tool_use') return;

      const result = await tools.fetchCredential(toolUse.input as { vault: string });

      await wrapped.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 64,
          system: `You are an ops assistant. Policy id ${canaries.value('systemPromptText')}.`,
          messages: [
            {
              role: 'user',
              content:
                `Rotate the key ${canaries.value('promptSecret')} and notify ` +
                `${canaries.value('promptPii')}.`,
            },
            { role: 'assistant', content: first.content },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result' as const,
                  tool_use_id: toolUse.id,
                  content: JSON.stringify(result),
                },
              ],
            },
          ],
        },
        requestOptions,
      );
    });
  } finally {
    await gm.dispose();
  }
}
