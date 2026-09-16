/**
 * The surface both v2 fixtures serve: one tool that echoes its arguments and
 * can be told to fail, one resource, one prompt. Built with
 * `@modelcontextprotocol/server` 2.0.0's `McpServer`; schemas come from the
 * package's own `fromJsonSchema`, so the fixture needs no zod (the CLI package
 * does not depend on it).
 *
 *  - `echo`   `{ text }` is echoed back as text and as `structuredContent`.
 *             `{ mode: "throw" }` makes the handler THROW — the v2 McpServer
 *             answers that with an `isError: true` tool result (the 1.x
 *             low-level `Server` answered a throwing handler with a JSON-RPC
 *             error; both paths must trip the proxy's error gate).
 *             `{ mode: "isError" }` returns an in-band `isError: true` result.
 *  - `v2://greeting`   a static text resource.
 *  - `summarize`       a prompt with one required argument.
 */
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';

export const SERVER_INFO = { name: 'graphmind-v2-fixture', version: '2.0.0' };

export function buildServer() {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    'echo',
    {
      description:
        'Echo the arguments back; mode=throw makes the handler throw, mode=isError returns isError',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          text: { type: 'string' },
          mode: { type: 'string', enum: ['ok', 'throw', 'isError'] },
        },
        additionalProperties: true,
      }),
    },
    async (args) => {
      if (args?.mode === 'throw') throw new Error('kaboom v2');
      if (args?.mode === 'isError') {
        return { isError: true, content: [{ type: 'text', text: `refused: ${args.text ?? ''}` }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(args ?? {}) }],
        structuredContent: { echoed: args ?? {} },
      };
    },
  );

  server.registerResource(
    'greeting',
    'v2://greeting',
    { description: 'A static greeting', mimeType: 'text/plain' },
    async (uri) => ({
      contents: [{ uri: uri.toString(), mimeType: 'text/plain', text: 'hello from the v2 resource' }],
    }),
  );

  server.registerPrompt(
    'summarize',
    {
      description: 'Summarize something',
      argsSchema: fromJsonSchema({
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
      }),
    },
    ({ topic }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${topic}` } }],
    }),
  );

  return server;
}
