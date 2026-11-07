/** The Build page's pure helpers: the graph, what it compiles to, and the checks it runs while you type. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  PROVIDERS,
  ROOT_ID,
  TARGETS,
  addEdge,
  attributeIssues,
  canConnect,
  compile,
  defaultGraph,
  emptyParam,
  envKeysFor,
  isJobRun,
  issueFor,
  issuesByNode,
  localIssues,
  makeNode,
  ownerOf,
  patchNode,
  providerMeta,
  removeNode,
  runErrorOf,
  slugify,
  slugifyWhileTyping,
  withProvider,
  withTarget,
  type McpNode,
  type SubAgentNode,
  type ToolNode,
  type WorkflowGraph,
} from '../src/builder/graph.js';
import { useBuilderStore } from '../src/builder/builderStore.js';

/** The starter graph plus a sub-agent wired to a tool and an MCP server. */
function richGraph(): WorkflowGraph {
  let graph = defaultGraph();
  const sub = makeNode('subagent', graph, { x: 360, y: 400 }) as SubAgentNode;
  const mcp = makeNode('mcp', graph, { x: 700, y: 400 }) as McpNode;
  graph = { ...graph, nodes: [...graph.nodes, sub, mcp] };
  graph = addEdge(graph, ROOT_ID, sub.id);
  graph = addEdge(graph, sub.id, mcp.id);
  // the sub-agent also gets one of the root's tools
  graph = addEdge(graph, sub.id, 'tool-weather');
  return graph;
}

describe('defaults and switching', () => {
  it('starts valid', () => {
    expect(localIssues(defaultGraph())).toEqual([]);
  });

  it('moves the provider (and a default model) when the target cannot call it', () => {
    const graph = defaultGraph(); // anthropic + default model
    const openaiOnly = withTarget(graph, 'ts-openai');
    expect(openaiOnly.provider).toBe('openai');
    expect(openaiOnly.model).toBe(DEFAULT_MODEL.openai);
    // a hand-picked model survives the switch
    const custom = withTarget({ ...graph, model: 'claude-custom' }, 'py-openai');
    expect(custom.provider).toBe('openai');
    expect(custom.model).toBe('claude-custom');
    // a target that supports the current provider changes nothing else
    expect(withTarget(graph, 'py-anthropic')).toEqual({ ...graph, target: 'py-anthropic' });
  });

  it('withProvider swaps the default model only', () => {
    expect(withProvider(defaultGraph(), 'openai').model).toBe(DEFAULT_MODEL.openai);
    expect(withProvider({ ...defaultGraph(), model: 'mine' }, 'openai').model).toBe('mine');
  });

  it('slugifies names into directory-safe form', () => {
    expect(slugify('Support Agent v2!')).toBe('support-agent-v2');
    expect(slugify('---')).toBe('');
    expect(slugify('x'.repeat(80)).length).toBe(48);
  });

  it('keeps a typed dash, and trims it only once the name is finished', () => {
    // PROJECT_NAME_RE allows a trailing dash, so every keystroke of
    // "trip-bot" stays a valid name. `slugify` trimming it per keystroke
    // meant the field could only ever produce "tripbot" — and the default
    // name it offers, "my-agent", was one nobody could type.
    expect(slugifyWhileTyping('trip-')).toBe('trip-');
    expect(slugifyWhileTyping('trip-bot')).toBe('trip-bot');
    expect(slugify('trip-')).toBe('trip');
    expect(slugify('trip-bot')).toBe('trip-bot');
  });

  it('refuses a leading dash and anything that is not a name, in both forms', () => {
    for (const slug of [slugify, slugifyWhileTyping]) {
      expect(slug('---lead')).toBe('lead');
      expect(slug('Trip Planner 2')).toBe('trip-planner-2');
      expect(slug('a'.repeat(80))).toHaveLength(48);
    }
    // Where they differ, and why: a trailing space is the start of the next
    // word while you type, and nothing at all once you have stopped.
    expect(slugifyWhileTyping('  My Agent ')).toBe('my-agent-');
    expect(slugify('  My Agent ')).toBe('my-agent');
  });

  it('names new nodes and parameters without colliding', () => {
    let graph = defaultGraph();
    const first = makeNode('tool', graph, { x: 0, y: 0 });
    graph = { ...graph, nodes: [...graph.nodes, first] };
    const second = makeNode('tool', graph, { x: 0, y: 0 });
    expect((first as ToolNode).name).toBe('myTool');
    expect((second as ToolNode).name).toBe('myTool2');
    expect(emptyParam([]).name).toBe('arg1');
  });

  it('lists every target the server offers, with what each can generate', () => {
    expect(TARGETS.map((t) => t.id)).toEqual(['ts-ai-sdk', 'ts-anthropic', 'ts-openai', 'py-openai', 'py-anthropic']);
    expect(TARGETS.filter((t) => t.supports.mcp).map((t) => t.id)).toEqual(['ts-ai-sdk', 'ts-anthropic', 'ts-openai']);
  });
});

describe('wiring', () => {
  it('allows only the edges the generators can emit', () => {
    expect(canConnect('agent', 'tool')).toBe(true);
    expect(canConnect('agent', 'mcp')).toBe(true);
    expect(canConnect('agent', 'subagent')).toBe(true);
    expect(canConnect('subagent', 'tool')).toBe(true);
    expect(canConnect('subagent', 'mcp')).toBe(true);
    // one level of delegation, and nothing points back at the root
    expect(canConnect('subagent', 'subagent')).toBe(false);
    expect(canConnect('tool', 'tool')).toBe(false);
    expect(canConnect('mcp', 'agent')).toBe(false);
  });

  it('refuses a duplicate edge, a self-edge and an edge the kinds forbid', () => {
    const graph = defaultGraph();
    expect(addEdge(graph, ROOT_ID, 'tool-weather').edges).toHaveLength(graph.edges.length);
    expect(addEdge(graph, ROOT_ID, ROOT_ID).edges).toHaveLength(graph.edges.length);
    expect(addEdge(graph, 'tool-weather', 'tool-packing').edges).toHaveLength(graph.edges.length);
  });

  it('deletes a node with its edges, and never the root agent', () => {
    const graph = removeNode(defaultGraph(), 'tool-weather');
    expect(graph.nodes.map((n) => n.id)).not.toContain('tool-weather');
    expect(graph.edges.every((e) => e.to !== 'tool-weather')).toBe(true);
    expect(removeNode(graph, ROOT_ID)).toEqual(graph);
  });
});

describe('compiling the graph', () => {
  it('turns the starter graph into a spec with both tools attached', () => {
    const { spec } = compile(defaultGraph());
    expect(spec.name).toBe('my-agent');
    expect(spec.tools.map((t) => t.name)).toEqual(['getWeather', 'packingAdvice']);
    expect(spec.attach).toEqual({ tools: ['getWeather', 'packingAdvice'], mcpServers: [], subAgents: [] });
    expect(spec.mcpServers).toEqual([]);
    expect(spec.subAgents).toEqual([]);
  });

  it('gives each agent exactly what is wired to it', () => {
    const graph = richGraph();
    const { spec } = compile(graph);
    const sub = spec.subAgents[0];
    expect(spec.attach?.subAgents).toEqual([sub?.name]);
    // the sub-agent's own wiring, not the root's
    expect(sub?.tools).toEqual(['getWeather']);
    expect(sub?.mcpServers).toEqual([spec.mcpServers[0]?.name]);
    expect(spec.attach?.mcpServers).toEqual([]);
  });

  it('parses an MCP node the way the generated client will read it', () => {
    let graph = defaultGraph();
    const mcp = makeNode('mcp', graph, { x: 0, y: 0 }) as McpNode;
    graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { ...mcp, name: 'fs', command: ' npx ', argsText: '-y\n\n  @scope/server  \n', toolsText: ' read , write ,' },
      ],
    };
    graph = addEdge(graph, ROOT_ID, mcp.id);
    const { spec } = compile(graph);
    expect(spec.mcpServers[0]).toMatchObject({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@scope/server'],
      tools: ['read', 'write'],
      url: '',
    });
    // a stdio server carries no URL and no token variable
    expect(spec.mcpServers[0]?.headerEnv).toBeUndefined();
  });

  it('drops the http fields of a stdio server and vice versa', () => {
    let graph = defaultGraph();
    const mcp = makeNode('mcp', graph, { x: 0, y: 0 }) as McpNode;
    graph = {
      ...graph,
      nodes: [...graph.nodes, { ...mcp, transport: 'http', url: 'https://x/mcp', headerEnv: 'TOK', command: 'npx' }],
    };
    const server = compile(graph).spec.mcpServers[0];
    expect(server?.command).toBe('');
    expect(server?.args).toEqual([]);
    expect(server?.headerEnv).toBe('TOK');
  });

  it('leaves an unwired node defined but attached to nothing', () => {
    let graph = defaultGraph();
    const orphan = makeNode('tool', graph, { x: 0, y: 0 }) as ToolNode;
    graph = { ...graph, nodes: [...graph.nodes, orphan] };
    const { spec } = compile(graph);
    expect(spec.tools.map((t) => t.name)).toContain(orphan.name);
    expect(spec.attach?.tools).not.toContain(orphan.name);
  });
});

describe('local validation', () => {
  it('flags what a user is most likely to break, pinned to the node that owns it', () => {
    let graph = defaultGraph();
    graph = { ...graph, name: 'Bad Name', model: '' };
    graph = patchNode(graph, ROOT_ID, { prompt: '  ' } as never);
    graph = patchNode(graph, 'tool-weather', {
      name: 'getWeather',
      description: '',
      params: [{ name: '1st', type: 'string', required: true }],
    } as never);
    graph = patchNode(graph, 'tool-packing', { name: 'getWeather' } as never);
    const issues = localIssues(graph);
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'model', 'prompt']));
    const byNode = issuesByNode(issues);
    // the bad parameter name and the empty description both land on the tool
    expect(byNode['tool-weather']?.join(' ')).toMatch(/letters, digits and underscores/);
    expect(byNode['tool-weather']?.join(' ')).toMatch(/say what it is for/);
    // the duplicate name lands on the node that took it, not on the original
    expect(byNode['tool-packing']?.join(' ')).toMatch(/already called "getWeather"/);
    expect(issueFor(issues, 'nope')).toBeUndefined();
  });

  it('says so when the chosen target cannot generate a node that was placed', () => {
    const graph = withTarget(richGraph(), 'py-openai');
    const messages = localIssues(graph).map((i) => i.message);
    expect(messages.some((m) => /no MCP generator/.test(m))).toBe(true);
    expect(messages.some((m) => /no sub-agent generator/.test(m))).toBe(true);
  });

  it('checks an MCP node against the transport it is using', () => {
    let graph = defaultGraph();
    const mcp = makeNode('mcp', graph, { x: 0, y: 0 }) as McpNode;
    graph = { ...graph, nodes: [...graph.nodes, { ...mcp, command: '' }] };
    expect(localIssues(graph).some((i) => /needs a command/.test(i.message))).toBe(true);

    const http = { ...mcp, transport: 'http' as const, url: 'ftp://x', headerEnv: 'lower case' };
    graph = { ...defaultGraph(), nodes: [...defaultGraph().nodes, http] };
    const messages = localIssues(graph).map((i) => i.message);
    expect(messages.some((m) => /https?:\/\/ URL/.test(m))).toBe(true);
    expect(messages.some((m) => /UPPER_CASE/.test(m))).toBe(true);
  });

  it('maps a server issue back onto the node that produced it', () => {
    const { nodeByPath } = compile(defaultGraph());
    const attributed = attributeIssues(
      [
        { path: 'tools.1.name', message: 'is a reserved word' },
        { path: 'provider', message: 'cannot call this' },
      ],
      nodeByPath,
    );
    expect(attributed[0]?.nodeId).toBe('tool-packing');
    // nothing to pin a project-wide issue on: it stays loose
    expect(attributed[1]?.nodeId).toBeUndefined();
  });
});

describe('job <-> run matching', () => {
  it('matches the app name and a start after the job (with slack for clock skew)', () => {
    expect(isJobRun({ meta: { app: 'my-agent', startedTs: 10_000 } }, 'my-agent', 9_000)).toBe(true);
    expect(isJobRun({ meta: { app: 'my-agent', startedTs: 8_500 } }, 'my-agent', 9_000)).toBe(true);
    expect(isJobRun({ meta: { app: 'my-agent', startedTs: 1_000 } }, 'my-agent', 9_000)).toBe(false);
    expect(isJobRun({ meta: { app: 'other', startedTs: 10_000 } }, 'my-agent', 9_000)).toBe(false);
  });
});

describe('the run error the Build page shows', () => {
  const apiError = { name: 'Error', message: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' };

  it('leads with the error an active error gate holds (the process is paused, the log is silent)', () => {
    const run = {
      meta: { status: 'running' as const },
      nodes: { 'llm:step': { lastError: apiError } },
      pauses: { p1: { active: true, point: 'error', nodeId: 'llm:step' } },
    };
    expect(runErrorOf(run)).toEqual({ text: `Error: ${apiError.message}`, held: true });
  });

  it('falls back to the error the run ended with', () => {
    const run = {
      meta: { status: 'error', error: apiError },
      nodes: {},
      pauses: { p1: { active: false, point: 'error', nodeId: 'llm:step' } },
    };
    expect(runErrorOf(run)).toEqual({ text: `Error: ${apiError.message}`, held: false });
  });

  it('says nothing for a clean or merely running run', () => {
    expect(runErrorOf({ meta: { status: 'running' }, nodes: {}, pauses: {} })).toBeUndefined();
    expect(runErrorOf({ meta: { status: 'ok' }, nodes: {}, pauses: {} })).toBeUndefined();
    // a gate held before a call runs is not an error
    expect(
      runErrorOf({
        meta: { status: 'running' },
        nodes: { t: {} },
        pauses: { p1: { active: true, point: 'before', nodeId: 't' } },
      }),
    ).toBeUndefined();
  });
});

describe('builder store', () => {
  it('adds a node wired to the agent that asked for it, and selects it', () => {
    const store = useBuilderStore.getState();
    store.reset();
    const id = store.addNode('mcp', { x: 10, y: 20 }, ROOT_ID);
    const state = useBuilderStore.getState();
    expect(state.selectedId).toBe(id);
    expect(state.graph.edges.some((e) => e.from === ROOT_ID && e.to === id)).toBe(true);
    state.deleteNode(id);
    expect(useBuilderStore.getState().graph.nodes.map((n) => n.id)).not.toContain(id);
    // deleting what was selected falls back to the agent
    expect(useBuilderStore.getState().selectedId).toBe(ROOT_ID);
  });

  it('appends only new log lines and keeps nothing secret-shaped', () => {
    const store = useBuilderStore.getState();
    store.reset();
    store.appendLines([{ i: 0, stream: 'sys', text: 'a', ts: 1 }, { i: 1, stream: 'out', text: 'b', ts: 2 }]);
    store.appendLines([{ i: 1, stream: 'out', text: 'b', ts: 2 }, { i: 2, stream: 'err', text: 'c', ts: 3 }]);
    expect(useBuilderStore.getState().lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
    store.resetJob();
    expect(useBuilderStore.getState().lines).toEqual([]);
    expect(Object.keys(useBuilderStore.getState())).not.toEqual(expect.arrayContaining(['secrets', 'apiKey', 'token']));
  });
});

describe('which agent a new node is wired to', () => {
  it('follows the selection to the agent that owns it, so adding to a sub-agent sticks', () => {
    const graph = richGraph();
    const sub = graph.nodes.find((n) => n.kind === 'subagent') as SubAgentNode;
    const mcp = graph.nodes.find((n) => n.kind === 'mcp') as McpNode;
    // the sub-agent itself, and anything it owns, both point at the sub-agent
    expect(ownerOf(graph, sub.id)).toBe(sub.id);
    expect(ownerOf(graph, mcp.id)).toBe(sub.id);
    // a tool shared by the root and the sub-agent prefers the sub-agent
    expect(ownerOf(graph, 'tool-weather')).toBe(sub.id);
    // a root-only tool, the root itself, nothing, and an unknown id all land on the root
    expect(ownerOf(graph, 'tool-packing')).toBe(ROOT_ID);
    expect(ownerOf(graph, ROOT_ID)).toBe(ROOT_ID);
    expect(ownerOf(graph, undefined)).toBe(ROOT_ID);
    expect(ownerOf(graph, 'nope')).toBe(ROOT_ID);
  });

  it('through the store: add, add again, both land on the sub-agent', () => {
    const store = useBuilderStore.getState();
    store.reset();
    const subId = store.addNode('subagent', { x: 0, y: 0 }, ROOT_ID);
    const first = store.addNode('tool', { x: 0, y: 0 }, ownerOf(useBuilderStore.getState().graph, subId));
    // the new tool is now selected; the next add must still go to the sub-agent
    const next = ownerOf(useBuilderStore.getState().graph, useBuilderStore.getState().selectedId);
    expect(next).toBe(subId);
    const second = store.addNode('mcp', { x: 0, y: 0 }, next);
    const edges = useBuilderStore.getState().graph.edges;
    expect(edges.some((e) => e.from === subId && e.to === first)).toBe(true);
    expect(edges.some((e) => e.from === subId && e.to === second)).toBe(true);
    expect(edges.some((e) => e.from === ROOT_ID && (e.to === first || e.to === second))).toBe(false);
  });
});

describe('providers', () => {
  it('every provider has a key name, a default model and a family; only Ollama needs no key', () => {
    for (const meta of PROVIDERS) {
      expect(meta.envKey).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(meta.defaultModel).not.toBe('');
      expect(providerMeta(meta.id)).toBe(meta);
    }
    expect(PROVIDERS.filter((p) => !p.keyRequired).map((p) => p.id)).toEqual(['ollama']);
  });

  it('the raw SDK targets take their family; the AI SDK target takes everyone', () => {
    const ids = (target: string) => TARGETS.find((t) => t.id === target)?.providers ?? [];
    expect(ids('ts-ai-sdk')).toEqual(PROVIDERS.map((p) => p.id));
    expect(ids('ts-anthropic')).toEqual(['anthropic']);
    expect(ids('py-anthropic')).toEqual(['anthropic']);
    expect(ids('ts-openai')).toContain('groq');
    expect(ids('py-openai')).toContain('ollama');
    expect(ids('ts-openai')).not.toContain('anthropic');
  });

  it('a provider that needs no key is not a required credential', () => {
    const graph = withProvider(withTarget(defaultGraph(), 'ts-openai'), 'ollama');
    expect(graph.model).toBe(DEFAULT_MODEL.ollama);
    const keys = envKeysFor(compile(graph).spec);
    expect(keys[0]).toMatchObject({ name: 'OLLAMA_API_KEY', required: false });
  });
});
