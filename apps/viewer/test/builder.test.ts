/** The Build page's pure helpers: defaults, local validation, target switching, the preview layout. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  PREVIEW_CARD,
  TARGETS,
  defaultSpec,
  emptyParam,
  emptyTool,
  isJobRun,
  issueFor,
  localIssues,
  previewGraph,
  runErrorOf,
  slugify,
  withProvider,
  withTarget,
} from '../src/builder/model.js';
import { useBuilderStore } from '../src/builder/builderStore.js';

describe('defaults and switching', () => {
  it('starts valid', () => {
    expect(localIssues(defaultSpec())).toEqual([]);
  });

  it('moves the provider (and a default model) when the target cannot call it', () => {
    const spec = defaultSpec(); // anthropic + default model
    const openaiOnly = withTarget(spec, 'ts-openai');
    expect(openaiOnly.provider).toBe('openai');
    expect(openaiOnly.model).toBe(DEFAULT_MODEL.openai);
    // a hand-picked model survives the switch
    const custom = withTarget({ ...spec, model: 'claude-custom' }, 'py-openai');
    expect(custom.provider).toBe('openai');
    expect(custom.model).toBe('claude-custom');
    // a target that supports the current provider changes nothing else
    expect(withTarget(spec, 'py-anthropic')).toEqual({ ...spec, target: 'py-anthropic' });
  });

  it('withProvider swaps the default model only', () => {
    expect(withProvider(defaultSpec(), 'openai').model).toBe(DEFAULT_MODEL.openai);
    expect(withProvider({ ...defaultSpec(), model: 'mine' }, 'openai').model).toBe('mine');
  });

  it('slugifies names into directory-safe form', () => {
    expect(slugify('Support Agent v2!')).toBe('support-agent-v2');
    expect(slugify('---')).toBe('');
    expect(slugify('x'.repeat(80)).length).toBe(48);
  });

  it('names new tools and parameters without colliding', () => {
    const tools = [emptyTool([])];
    expect(tools[0]?.name).toBe('tool1');
    expect(emptyTool(tools).name).toBe('tool2');
    expect(emptyTool([{ ...emptyTool([]), name: 'tool2' }]).name).toBe('tool3');
    expect(emptyParam([]).name).toBe('arg1');
  });

  it('lists every target the server offers', () => {
    expect(TARGETS.map((t) => t.id)).toEqual(['ts-ai-sdk', 'ts-anthropic', 'ts-openai', 'py-openai', 'py-anthropic']);
  });
});

describe('local validation', () => {
  it('flags the fields a user is most likely to break while typing, by path', () => {
    const spec = defaultSpec();
    const issues = localIssues({
      ...spec,
      name: 'Bad Name',
      prompt: ' ',
      model: '',
      tools: [
        { name: 'search-flights', description: '', params: [{ name: '1st', type: 'string', required: true }], returns: '' },
        { name: 'dup', description: 'a', params: [{ name: 'p', type: 'string', required: true }, { name: 'p', type: 'number', required: true }], returns: '' },
        { name: 'dup', description: 'b', params: [], returns: '' },
      ],
    });
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'prompt', 'model', 'tools.0.name', 'tools.0.description', 'tools.0.params.0.name', 'tools.1.params.1.name', 'tools.2.name']));
    expect(issueFor(issues, 'tools.2.name')).toBe('duplicate tool name');
    expect(issueFor(issues, 'nope')).toBeUndefined();
  });
});

describe('preview graph', () => {
  it('lays out agent -> llm -> tools with one edge per tool', () => {
    const graph = previewGraph(defaultSpec());
    expect(graph.nodes.map((n) => n.kind)).toEqual(['agent', 'llm', 'tool', 'tool']);
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['agent->llm', 'llm->tool:0', 'llm->tool:1']);
    // the first two columns centre on the tool stack
    const [agent, llm, t0, t1] = graph.nodes;
    expect(agent?.y).toBe(llm?.y);
    expect(agent?.y).toBeCloseTo(((t1?.y ?? 0) + (t0?.y ?? 0)) / 2);
    expect(graph.width).toBeGreaterThan(3 * PREVIEW_CARD.width);
    for (const edge of graph.edges) expect(edge.d).toMatch(/^M [\d.]+ [\d.]+ C /);
  });

  it('shrinks to two columns with no tools', () => {
    const graph = previewGraph({ ...defaultSpec(), tools: [] });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.height).toBe(PREVIEW_CARD.height);
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
