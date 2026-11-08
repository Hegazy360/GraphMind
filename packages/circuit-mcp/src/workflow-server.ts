/**
 * Workflows as MCP tools: any MCP client (Claude Code, Cursor, an agent) can
 * start your Circuit workflows and read their results.
 *
 * Built on the v2 low-level Server with dynamic handlers, so `tools/list`
 * always reflects the workflows the Circuit server has RIGHT NOW (dev-mode
 * reload and scaffolded workflows included). Served through `serveStdio`,
 * which speaks the 2026-07-28 protocol era and falls back for older clients.
 *
 * Each workflow becomes a tool `run_<name>` with the workflow's input schema.
 * A call starts a run through the Circuit HTTP API and waits up to `wait`
 * seconds: finished runs return their output; runs still going (sleeping,
 * paused for a human) return their runId, which `get_run` reads later.
 */
import { Server } from '@modelcontextprotocol/server';

export interface WorkflowServerOptions {
  /** e.g. http://127.0.0.1:4810 */
  apiBase: string;
  apiKey?: string;
  /** Max seconds a run_* call waits for the run to finish (default 20). */
  maxWaitSeconds?: number;
  fetchImpl?: typeof fetch;
}

interface WorkflowInfo {
  name: string;
  inputSchema: Record<string, unknown> | null;
}

const toolName = (workflow: string) => `run_${workflow.replaceAll('-', '_')}`;
const TERMINAL = new Set(['completed', 'failed', 'aborted', 'timed_out']);

export function createWorkflowMcpServer(opts: WorkflowServerOptions): Server {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.apiBase.replace(/\/$/, '');
  const maxWait = opts.maxWaitSeconds ?? 20;

  async function api(method: string, path: string, body?: unknown) {
    const res = await f(`${base}/v1${path}`, {
      method,
      headers: {
        'x-circuit-actor': 'mcp-client',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new Error(String(data?.detail ?? data?.title ?? `HTTP ${res.status}`));
    return data ?? {};
  }

  const summarize = (detail: Record<string, unknown>) => {
    const run = detail.run as { id: string; status: string; output?: unknown; error?: unknown; pausedSeq?: number };
    const journal = (detail.journal ?? []) as Array<{ seq: number; name: string; status: string }>;
    const held = journal.find((e) => e.seq === run.pausedSeq);
    return {
      runId: run.id,
      status: run.status,
      ...(run.output !== undefined ? { output: run.output } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
      ...(held ? { waitingOn: `${held.name} (a human must act in the Circuit dashboard)` } : {}),
      dashboard: `${base}/#/runs/${run.id}`,
    };
  };

  const server = new Server({ name: 'graphmind-circuit-workflows', version: '0.0.1' }, { capabilities: { tools: {} } });

  server.setRequestHandler('tools/list', async () => {
    const { workflows } = (await api('GET', '/workflows')) as { workflows: WorkflowInfo[] };
    const tools = [
        ...workflows.map((w) => ({
          name: toolName(w.name),
          description: `Start a run of the Circuit workflow '${w.name}' and wait up to ${maxWait}s for its result. Long-running or paused runs return a runId to check with get_run.`,
          inputSchema: {
            type: 'object' as const,
            properties: {
              input: w.inputSchema ?? { type: 'object' },
              idempotencyKey: { type: 'string', description: 'Same key returns the same run instead of starting another.' },
            },
            required: ['input'],
          },
        })),
        {
          name: 'get_run',
          description: 'Read a Circuit run: status, output or error, and what it is waiting on.',
          inputSchema: { type: 'object' as const, properties: { runId: { type: 'string' } }, required: ['runId'] },
        },
      ];
    // The v2 SDK exports only zod schemas (no inferred TS types) and its Tool
    // type rejects a JSON-schema value in `properties`; the server validates
    // this result against ListToolsResultSchema at runtime, so the cast is
    // checked where it matters.
    return { tools: tools as never };
  });

  server.setRequestHandler('tools/call', async (req) => {
    const params = (req as { params: { name: string; arguments?: Record<string, unknown> } }).params;
    const args = params.arguments ?? {};
    try {
      if (params.name === 'get_run') {
        const detail = await api('GET', `/runs/${encodeURIComponent(String(args.runId))}`);
        return { content: [{ type: 'text', text: JSON.stringify(summarize(detail), null, 2) }] };
      }
      const { workflows } = (await api('GET', '/workflows')) as { workflows: WorkflowInfo[] };
      const wf = workflows.find((w) => toolName(w.name) === params.name);
      if (!wf) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${params.name}` }] };
      const started = (await api('POST', `/workflows/${wf.name}/runs`, {
        input: args.input ?? null,
        ...(typeof args.idempotencyKey === 'string' ? { idempotencyKey: args.idempotencyKey } : {}),
      })) as { runId: string };
      const deadline = Date.now() + maxWait * 1000;
      let detail = await api('GET', `/runs/${started.runId}`);
      let status = (detail.run as { status: string }).status;
      while (!TERMINAL.has(status) && status !== 'paused' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        detail = await api('GET', `/runs/${started.runId}`);
        status = (detail.run as { status: string }).status;
      }
      const summary = summarize(detail);
      return {
        ...(summary.status === 'failed' || summary.status === 'aborted' || summary.status === 'timed_out' ? { isError: true } : {}),
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  });

  return server;
}
