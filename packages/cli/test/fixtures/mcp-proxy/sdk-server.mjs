#!/usr/bin/env node
/**
 * A REAL MCP server built with @modelcontextprotocol/sdk 1.30 (the low-level
 * `Server` + `StdioServerTransport`, so the fixture needs no zod of its own).
 *
 * The hand-rolled fixtures prove the framing; this one proves the proxy is
 * invisible to the SDK's own client/server pair — the thing users actually
 * run. Tools, resources and prompts are all exercised, plus a tool that
 * throws so the error path is a real SDK error, not a synthetic one.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'graphmind-test-server', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
    {
      name: 'explode',
      description: 'Always throws',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'add') {
    const sum = Number(args?.a ?? 0) + Number(args?.b ?? 0);
    return { content: [{ type: 'text', text: String(sum) }] };
  }
  if (name === 'explode') throw new Error('kaboom');
  throw new Error(`unknown tool: ${name}`);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: 'test://greeting', name: 'greeting', mimeType: 'text/plain' }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'hello from the resource' }],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'summarize',
      description: 'Summarize something',
      arguments: [{ name: 'topic', required: true }],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
  messages: [
    {
      role: 'user',
      content: { type: 'text', text: `Summarize ${request.params.arguments?.topic ?? '?'}` },
    },
  ],
}));

process.stderr.write('sdk-server: ready\n');
await server.connect(new StdioServerTransport());
