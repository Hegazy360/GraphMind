/**
 * The same adversarial setup against the OpenAI adapter: a real `openai`
 * client whose apiKey, default headers, baseURL query token and per-request
 * headers are all canaries, driving a two-step tool-calling loop against the
 * mock provider.
 */
import OpenAI from 'openai';
import { graphmind } from '@graphmind-ai/openai';
import type { AgentRunOptions } from './anthropic-agent.js';

export async function runOpenAiAgent(options: AgentRunOptions): Promise<void> {
  const { canaries, provider, ingestUrl } = options;

  const client = new OpenAI({
    // Rides on the wire as `Authorization: Bearer <apiKey>`.
    apiKey: canaries.value('providerApiKey'),
    baseURL: `${provider.origin}/v1/gw/${canaries.value('baseUrlPathToken')}`,
    defaultQuery: { access_token: canaries.value('baseUrlToken') },
    defaultHeaders: {
      // A second auth header, as a corporate proxy in front of OpenAI wants.
      'x-proxy-authorization': canaries.value('authHeader'),
      'x-org-secret': canaries.value('orgHeader'),
    },
    maxRetries: 0,
    timeout: 10_000,
  });

  const gm = graphmind({
    url: ingestUrl,
    enabled: true,
    app: 'audit-openai',
    waitForAttach: 3000,
    retryIntervalMs: 60_000,
    logger: () => {},
  });

  const tools = gm.wrapTools({
    fetchCredential: async (input: { vault: string }) => ({
      vault: input.vault,
      credential: canaries.value('toolResultSecret'),
      rotatedAt: '2026-08-27T00:00:00.000Z',
    }),
  });

  const wrapped = gm.wrapClient(client);
  const requestOptions = {
    headers: { 'x-request-secret': canaries.value('perRequestHeader') },
  };

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are an ops assistant. Policy id ${canaries.value('systemPromptText')}.`,
    },
    {
      role: 'user',
      content:
        `Rotate the key ${canaries.value('promptSecret')} and notify ` +
        `${canaries.value('promptPii')}.`,
    },
  ];

  try {
    await gm.run('rotate-credential', async () => {
      const first = await wrapped.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          messages,
          tools: [
            {
              type: 'function',
              function: {
                name: 'fetchCredential',
                description: 'Fetch a credential from a vault',
                parameters: {
                  type: 'object',
                  properties: { vault: { type: 'string' } },
                  required: ['vault'],
                },
              },
            },
          ],
        },
        requestOptions,
      );

      const message = first.choices[0]?.message;
      const call = message?.tool_calls?.[0];
      if (message === undefined || call === undefined || call.type !== 'function') return;

      const args = JSON.parse(call.function.arguments) as { vault: string };
      const result = await tools.fetchCredential(args);

      await wrapped.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          messages: [
            ...messages,
            message,
            { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) },
          ],
        },
        requestOptions,
      );
    });
  } finally {
    await gm.dispose();
  }
}
