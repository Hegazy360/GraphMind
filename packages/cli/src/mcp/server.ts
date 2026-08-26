/**
 * The GraphMind MCP server: read-only stdio access to the local run DB for
 * coding agents (Claude Code, Cursor, ...). Uses the SDK's low-level
 * `Server` with hand-written JSON Schemas — the CLI package deliberately has
 * no direct zod dependency.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../version.js';
import { findErrors, getNode, getRun, listRuns, ToolError, type ToolContext } from './tools.js';

const INSTRUCTIONS = `GraphMind is a local live debugger for AI agents: apps instrumented with @graphmind-ai/sdk record every run (agent, LLM step, and tool call) into a local SQLite database, and the GraphMind viewer renders those runs as a live execution graph.

This server reads that database directly, so it works even while the GraphMind server/viewer is closed. Reach for it whenever the user asks why an agent run failed, what a run actually did, what a tool or LLM call received/returned, or how long steps took.

Typical debugging flow:
1. find_errors — the most recent failed nodes across all runs (start here for "why did my run fail?").
2. get_node — full detail for one node: input, output, error + stack, timings, token usage.
3. list_runs / get_run — browse runs and their per-node breakdown.

Every result includes a deep link (http://127.0.0.1:4747/#/run/...) — cite it so the user can open the exact run or node in the GraphMind viewer (start it with \`graphmind\`). All tools are read-only.`;

const LIMIT_PROPERTY = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
  description: 'Maximum entries to return (default 20).',
} as const;

const RUN_ID_PROPERTY = {
  type: 'string',
  description: 'Run id, as returned by list_runs or find_errors.',
} as const;

const TOOLS: Tool[] = [
  {
    name: 'list_runs',
    title: 'List recent GraphMind runs',
    description:
      'Recent agent runs, most recently started first: id, app, status (running/ok/error/aborted), start/finish times, event and error counts, source (live/import/demo), and a viewer deep link.',
    inputSchema: {
      type: 'object',
      properties: { limit: LIMIT_PROPERTY },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_run',
    title: 'Get one run with its node breakdown',
    description:
      'Summary of one run plus its logical nodes (agents, LLM steps, tool calls): nodeId, kind, name, status, execution count, total duration, last error message, and a viewer deep link per node.',
    inputSchema: {
      type: 'object',
      properties: { runId: RUN_ID_PROPERTY },
      required: ['runId'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_node',
    title: 'Get full detail for one node of a run',
    description:
      'Everything recorded for one logical node in a run: every execution instance with input/output (huge payloads truncated with a note), error + stack trace, timings, and token usage. Use the nodeId reported by get_run or find_errors.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: RUN_ID_PROPERTY,
        nodeId: {
          type: 'string',
          description: "Logical node id (e.g. 'tool:searchFlights', 'llm:step', 'agent:planner').",
        },
      },
      required: ['runId', 'nodeId'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'find_errors',
    title: 'Find recent failed nodes across runs',
    description:
      'Recent node failures across all runs (newest runs first): run, node, error name + message, when it happened, and a viewer deep link. The right first call for "why did my (last) run fail?".',
    inputSchema: {
      type: 'object',
      properties: { limit: LIMIT_PROPERTY },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createMcpServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: 'graphmind', title: 'GraphMind agent debugger', version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (request.params.name) {
        case 'list_runs':
          return jsonResult(listRuns(ctx, args));
        case 'get_run':
          return jsonResult(getRun(ctx, args));
        case 'get_node':
          return jsonResult(getNode(ctx, args));
        case 'find_errors':
          return jsonResult(findErrors(ctx, args));
        default:
          throw new McpError(ErrorCode.MethodNotFound, `unknown tool "${request.params.name}"`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (error instanceof ToolError) return errorResult(error.message);
      return errorResult(
        `graphmind mcp: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return server;
}
