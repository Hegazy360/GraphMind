/**
 * A synthetic MCP run, for `?fixture=mcp`.
 *
 * The schema gained `server`, `resource` and `prompt` before any adapter
 * could emit them, so this is how the viewer's MCP identity gets designed and
 * regression-tested at all: a hand-built session that exercises every shape an
 * MCP run has.
 *
 * The shape is deliberately what an MCP server session actually looks like
 * rather than an agent run with the labels swapped:
 *
 *  - the session is the root (`kind: 'server'`) and everything is a request
 *    the connected client made of it;
 *  - the server advertises its catalogue up front (`graph.hint`), which is
 *    exactly what `tools/list`, `resources/list` and `prompts/list` are — so
 *    the canvas opens showing what this server *can* do, greyed out, and each
 *    node lights up when the client actually calls it;
 *  - `prompts/get` and `resources/read` are first-class siblings of
 *    `tools/call`, because on the wire they are;
 *  - sampling (`sampling/createMessage`) is an `llm` node: the server asking
 *    the client's model for a completion is still a model call, and it
 *    streams;
 *  - one `resources/read` fails and holds an error gate, because that is the
 *    frame the product exists for and it must be reachable in an MCP run too.
 */
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';

export interface FixtureEnvelope {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
}

export const MCP_RUN_ID = 'mcp-docs-9b4c';

export const MCP_NODES = {
  session: 'server:docs-mcp',
  prompt: 'prompt:release_notes',
  changelog: 'resource:file:///CHANGELOG.md',
  issues: 'resource:db://issues/open',
  search: 'tool:search_issues',
  create: 'tool:create_issue',
  sampling: 'llm:sampling',
} as const;

const TEXT = [
  'Reading the changelog and the open issue list to draft release notes. ',
  'Three entries look user-visible: the gate timeout fix, the new ',
  'resources/read cache, and the Windows path handling. ',
];

/**
 * Build the run. `startTs` exists so a test can assert on exact offsets;
 * the viewer passes nothing and gets a session that looks like it happened
 * a moment ago.
 */
export function generateMcpRun(startTs: number = Date.now() - 12_000): FixtureEnvelope[] {
  const out: FixtureEnvelope[] = [];
  let seq = 1;
  let ts = startTs;

  const emit = (type: string, payload: Record<string, unknown>, stepMs = 0): void => {
    ts += stepMs;
    out.push({ gm: PROTOCOL_VERSION, seq: seq++, ts, runId: MCP_RUN_ID, type, payload });
  };

  emit('run.started', {
    app: 'docs-mcp',
    sdk: { name: '@modelcontextprotocol/sdk', version: '1.19.0' },
    meta: {
      transport: 'stdio',
      client: 'claude-desktop/1.4.2',
      protocol: '2026-03-26',
      entry: 'servers/docs/main.ts',
    },
  });

  emit(
    'node.started',
    {
      nodeId: MCP_NODES.session,
      kind: 'server',
      name: 'docs-mcp',
      instanceId: 'session#1',
      input: {
        method: 'initialize',
        clientInfo: { name: 'claude-desktop', version: '1.4.2' },
        capabilities: { sampling: {}, roots: { listChanged: true } },
      },
    },
    120,
  );

  // The catalogue this server advertises. Everything it *can* do is on the
  // canvas from the first frame, dashed, and lights up when it is called.
  emit(
    'graph.hint',
    {
      nodes: [
        {
          nodeId: MCP_NODES.prompt,
          kind: 'prompt',
          name: 'release_notes',
          parentId: MCP_NODES.session,
        },
        {
          nodeId: MCP_NODES.changelog,
          kind: 'resource',
          name: 'CHANGELOG.md',
          parentId: MCP_NODES.session,
        },
        {
          nodeId: MCP_NODES.issues,
          kind: 'resource',
          name: 'issues/open',
          parentId: MCP_NODES.session,
        },
        {
          nodeId: MCP_NODES.search,
          kind: 'tool',
          name: 'search_issues',
          parentId: MCP_NODES.session,
        },
        {
          nodeId: MCP_NODES.create,
          kind: 'tool',
          name: 'create_issue',
          parentId: MCP_NODES.session,
        },
        {
          nodeId: MCP_NODES.sampling,
          kind: 'llm',
          name: 'sampling',
          parentId: MCP_NODES.session,
        },
      ],
    },
    180,
  );

  // ── prompts/get ──────────────────────────────────────────────────────────
  emit(
    'node.started',
    {
      nodeId: MCP_NODES.prompt,
      parentId: MCP_NODES.session,
      kind: 'prompt',
      name: 'release_notes',
      instanceId: 'req-1',
      input: { method: 'prompts/get', name: 'release_notes', arguments: { version: '0.4.0' } },
    },
    620,
  );
  emit(
    'node.finished',
    {
      nodeId: MCP_NODES.prompt,
      instanceId: 'req-1',
      output: {
        description: 'Draft release notes from the changelog and open issues',
        messages: [{ role: 'user', content: { type: 'text', text: 'Draft notes for 0.4.0…' } }],
      },
      durationMs: 41,
      status: 'ok',
    },
    240,
  );

  // ── resources/read (ok) ──────────────────────────────────────────────────
  emit(
    'node.started',
    {
      nodeId: MCP_NODES.changelog,
      parentId: MCP_NODES.session,
      kind: 'resource',
      name: 'CHANGELOG.md',
      instanceId: 'req-2',
      input: { method: 'resources/read', uri: 'file:///CHANGELOG.md' },
    },
    460,
  );
  emit(
    'node.finished',
    {
      nodeId: MCP_NODES.changelog,
      instanceId: 'req-2',
      output: {
        contents: [
          {
            uri: 'file:///CHANGELOG.md',
            mimeType: 'text/markdown',
            bytes: 8412,
            text: '## 0.4.0\n- gates no longer leak on disconnect\n- resources/read is cached\n…',
          },
        ],
      },
      durationMs: 118,
      status: 'ok',
    },
    380,
  );

  // ── tools/call ───────────────────────────────────────────────────────────
  emit(
    'node.started',
    {
      nodeId: MCP_NODES.search,
      parentId: MCP_NODES.session,
      kind: 'tool',
      name: 'search_issues',
      instanceId: 'req-3',
      input: { method: 'tools/call', name: 'search_issues', arguments: { state: 'open', label: 'user-visible' } },
    },
    300,
  );
  emit(
    'node.finished',
    {
      nodeId: MCP_NODES.search,
      instanceId: 'req-3',
      output: { content: [{ type: 'text', text: '7 open issues, 3 labelled user-visible' }], isError: false },
      durationMs: 264,
      status: 'ok',
    },
    520,
  );

  // ── sampling/createMessage — the server asking the client's model ────────
  emit(
    'node.started',
    {
      nodeId: MCP_NODES.sampling,
      parentId: MCP_NODES.session,
      kind: 'llm',
      name: 'sampling',
      instanceId: 'req-4',
      input: {
        method: 'sampling/createMessage',
        maxTokens: 600,
        modelPreferences: { intelligencePriority: 0.8 },
        messages: 2,
      },
    },
    340,
  );
  for (const chunk of TEXT) {
    emit('node.token', { nodeId: MCP_NODES.sampling, deltas: [{ t: 'text', v: chunk }] }, 520);
  }
  emit(
    'node.finished',
    {
      nodeId: MCP_NODES.sampling,
      instanceId: 'req-4',
      output: { role: 'assistant', model: 'claude-haiku-4-5', stopReason: 'endTurn' },
      usage: { inputTokens: 1840, outputTokens: 216 },
      durationMs: 1_910,
      status: 'ok',
    },
    420,
  );

  // ── resources/read (fails, holds the gate) ───────────────────────────────
  emit(
    'node.started',
    {
      nodeId: MCP_NODES.issues,
      parentId: MCP_NODES.session,
      kind: 'resource',
      name: 'issues/open',
      instanceId: 'req-5',
      input: { method: 'resources/read', uri: 'db://issues/open', cursor: null },
    },
    480,
  );
  const error = {
    name: 'McpError',
    message: 'resources/read failed: -32002 Resource not found (db://issues/open)',
    stack:
      'McpError: resources/read failed: -32002 Resource not found (db://issues/open)\n' +
      '    at readResource (servers/docs/resources.ts:64:11)\n' +
      '    at async handleRequest (servers/docs/main.ts:132:20)',
  };
  emit('node.error', { nodeId: MCP_NODES.issues, instanceId: 'req-5', error }, 900);
  emit(
    'node.finished',
    {
      nodeId: MCP_NODES.issues,
      instanceId: 'req-5',
      output: null,
      durationMs: 902,
      status: 'error',
    },
    4,
  );
  emit('exec.paused', { pauseId: 'mcp-gate-1', nodeId: MCP_NODES.issues, point: 'error' }, 12);

  // Everything past the gate only plays once the debugger releases it.
  emit(
    'node.started',
    {
      nodeId: MCP_NODES.create,
      parentId: MCP_NODES.session,
      kind: 'tool',
      name: 'create_issue',
      instanceId: 'req-6',
      input: {
        method: 'tools/call',
        name: 'create_issue',
        arguments: { title: 'Release notes for 0.4.0', body: '…' },
      },
    },
    700,
  );
  emit(
    'node.finished',
    {
      nodeId: MCP_NODES.create,
      instanceId: 'req-6',
      output: { content: [{ type: 'text', text: 'created issue #412' }], isError: false },
      durationMs: 310,
      status: 'ok',
    },
    520,
  );
  emit(
    'node.finished',
    {
      nodeId: MCP_NODES.session,
      instanceId: 'session#1',
      output: { requests: 6, errors: 1, transport: 'stdio' },
      durationMs: Math.max(1, ts - startTs),
      status: 'ok',
    },
    240,
  );
  emit('run.finished', { status: 'ok' }, 40);

  return out;
}
