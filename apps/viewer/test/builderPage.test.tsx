// @vitest-environment jsdom
/**
 * The Build page: the palette, the three panels, and the form behind the
 * selected card.
 *
 * The canvas itself is React Flow and belongs to the e2e suite, which can
 * drag things; what is testable here is everything around it — that adding
 * a node wires and selects it, that the form edits the right node, that the
 * generated code follows the canvas, and that the Run tab's buttons are
 * disabled for a reason it states. The generator is the CLI's own source,
 * aliased in, so "the code follows the canvas" is checked against the real
 * thing rather than a stub.
 */
import userEvent from '@testing-library/user-event';
import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderPage } from '../src/builder/BuilderPage.js';
import { useBuilderStore } from '../src/builder/builderStore.js';
import { ROOT_ID } from '../src/builder/graph.js';
import { useUiStore } from '../src/store/uiStore.js';
import { makeRun, resetStores, seedRuns, setConnection } from './render.js';

// React Flow needs layout the jsdom canvas cannot give it; the page under
// test is everything around it, so it is stubbed to a marker.
vi.mock('../src/builder/BuilderCanvas.js', () => ({
  BuilderCanvas: ({ problems }: { problems: Record<string, string[]> }) => (
    <div data-testid="canvas" data-bad={Object.keys(problems).length} />
  ),
}));

// The targets probe is a fetch to the local server; offline it simply fails.
vi.mock('../src/builder/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/builder/api.js')>()),
  fetchTargets: vi.fn().mockRejectedValue(new Error('offline')),
}));

beforeEach(() => {
  resetStores();
  setConnection('detached');
});

const show = () => render(<BuilderPage />);
const graph = () => useBuilderStore.getState().graph;
const tab = (name: 'Node' | 'Code' | 'Run') => screen.getByRole('tab', { name });

describe('the bar', () => {
  it('names the project being built and its target, not the page', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('my-agent');
    expect(document.querySelector('.gm-builder-sub')).toHaveTextContent(
      'TypeScript · Vercel AI SDK · anthropic',
    );
  });

  it('follows a rename and a change of target', async () => {
    const user = userEvent.setup();
    show();
    const name = screen.getByLabelText('Project name');
    await user.clear(name);
    // A dash has to survive being typed: the default name has one, and the
    // trailing-dash trim used to eat it on the keystroke that made it.
    await user.type(name, 'trip-bot');
    expect(name).toHaveValue('trip-bot');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('trip-bot');

    await user.click(screen.getByRole('radio', { name: 'Python · OpenAI SDK' }));
    expect(document.querySelector('.gm-builder-sub')).toHaveTextContent('Python · OpenAI SDK');
  });

  it('goes back to the debugger, and resets to the starter graph', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: '+ Tool' }));
    expect(graph().nodes).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(graph().nodes).toHaveLength(3);
    expect(useBuilderStore.getState().selectedId).toBe(ROOT_ID);

    await user.click(screen.getByRole('button', { name: 'Close the builder' }));
    expect(useUiStore.getState().page).toBe('runs');
  });
});

describe('with no server attached', () => {
  it('says so once, quietly, and does not claim the canvas needs one', () => {
    show();
    const notice = document.querySelector('.gm-builder-blocked');
    expect(notice).toHaveTextContent(/canvas and the code work anyway/);
    expect(notice).toHaveTextContent(/npx graphmind-ai/);
  });

  it('still generates the code: that is the point of the page', () => {
    show();
    // The Code tab carries its file count before you ever open it.
    expect(tab('Code')).toHaveTextContent(/\d/);
  });
});

describe('the palette', () => {
  it('adds a node wired to the agent and selects it for editing', async () => {
    const user = userEvent.setup();
    show();
    expect(graph().nodes).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: '+ MCP server' }));

    expect(graph().nodes).toHaveLength(4);
    const added = graph().nodes[graph().nodes.length - 1];
    expect(useBuilderStore.getState().selectedId).toBe(added?.id);
    expect(graph().edges.some((e) => e.from === ROOT_ID && e.to === added?.id)).toBe(true);
    // …and the form that came up is the one for what was added.
    expect(screen.getByLabelText('MCP server name')).toHaveValue('mcp');
  });

  it('keeps adding to the sub-agent once one is selected', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: '+ Sub-agent' }));
    const sub = useBuilderStore.getState().selectedId;

    await user.click(screen.getByRole('button', { name: '+ Tool' }));
    const tool = graph().nodes[graph().nodes.length - 1];
    expect(graph().edges.some((e) => e.from === sub && e.to === tool?.id)).toBe(true);
  });

  it('names each button plainly and says what the node is for', () => {
    show();
    for (const [name, hint] of [
      ['+ Tool', /function the model can call/i],
      ['+ MCP server', /MCP server to connect to/i],
      ['+ Sub-agent', /nested agent/i],
    ] as const) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('title', expect.stringMatching(hint));
    }
  });
});

describe('the node form', () => {
  it('splits the agent card into what the project is and what the agent does', () => {
    show();
    const labels = [...document.querySelectorAll('.gm-bsection .gm-section-label')].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['Project', 'Agent']);
  });

  it('edits the selected tool, and the canvas sees it', async () => {
    const user = userEvent.setup();
    show();
    const tool = graph().nodes.find((n) => n.kind === 'tool');
    act(() => useBuilderStore.getState().select(tool?.id));

    const name = screen.getByLabelText('Tool name');
    await user.clear(name);
    await user.type(name, 'lookUp');
    expect(graph().nodes.find((n) => n.id === tool?.id)).toMatchObject({ name: 'lookUp' });
  });

  /** Enforced as you type — it used to need a server round trip. */
  it('flags a name that is a reserved word in the languages it emits', async () => {
    const user = userEvent.setup();
    show();
    const tool = graph().nodes.find((n) => n.kind === 'tool');
    act(() => useBuilderStore.getState().select(tool?.id));

    const name = screen.getByLabelText('Tool name');
    await user.clear(name);
    await user.type(name, 'class');
    expect(screen.getByTestId('canvas')).toHaveAttribute('data-bad', '1');
    expect(tab('Node')).toHaveTextContent(/\d/); // the count rides the tab

    await user.clear(name);
    await user.type(name, 'lookUp');
    expect(screen.getByTestId('canvas')).toHaveAttribute('data-bad', '0');
  });

  it('adds and removes a tool parameter', async () => {
    const user = userEvent.setup();
    show();
    const tool = graph().nodes.find((n) => n.kind === 'tool');
    act(() => useBuilderStore.getState().select(tool?.id));
    const before = (graph().nodes.find((n) => n.id === tool?.id) as { params: unknown[] }).params.length;

    await user.click(screen.getByRole('button', { name: /Add a parameter/ }));
    const after = graph().nodes.find((n) => n.id === tool?.id) as { params: unknown[] };
    expect(after.params).toHaveLength(before + 1);

    await user.click(screen.getAllByRole('button', { name: 'Remove parameter' })[0] as HTMLElement);
    expect((graph().nodes.find((n) => n.id === tool?.id) as { params: unknown[] }).params).toHaveLength(before);
  });

  it('deletes a node, and never the root agent', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: '+ Tool' }));
    const added = useBuilderStore.getState().selectedId;
    expect(graph().nodes).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(graph().nodes).toHaveLength(3);
    expect(graph().nodes.some((n) => n.id === added)).toBe(false);

    // The agent has no Delete: a workflow without one is not a workflow.
    act(() => useBuilderStore.getState().select(ROOT_ID));
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('asks for what the chosen MCP transport actually needs', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: '+ MCP server' }));

    expect(screen.getByLabelText('MCP command')).toBeVisible();
    expect(screen.queryByLabelText('MCP URL')).toBeNull();

    await user.selectOptions(screen.getByLabelText('MCP transport'), 'http');
    expect(screen.getByLabelText('MCP URL')).toBeVisible();
    expect(screen.getByLabelText('MCP token variable')).toBeVisible();
    expect(screen.queryByLabelText('MCP command')).toBeNull();
  });

  it('keeps the token variable a NAME, never a token', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: '+ MCP server' }));
    await user.selectOptions(screen.getByLabelText('MCP transport'), 'http');

    const env = screen.getByLabelText('MCP token variable');
    await user.type(env, 'docs_token');
    expect(env).toHaveValue('DOCS_TOKEN');
  });

  it('marks the nodes a Python target cannot generate, rather than dropping them', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: '+ MCP server' }));
    await user.click(screen.getByRole('button', { name: '+ Sub-agent' }));
    expect(screen.getByTestId('canvas')).toHaveAttribute('data-bad', '0');

    act(() => useBuilderStore.getState().select(ROOT_ID));
    await user.click(screen.getByRole('radio', { name: 'Python · OpenAI SDK' }));
    expect(screen.getByTestId('canvas')).toHaveAttribute('data-bad', '2');
  });
});

describe('the Code panel', () => {
  it('generates the project in the page, with no server at all', async () => {
    const user = userEvent.setup();
    show();
    await user.click(tab('Code'));

    expect(screen.getByRole('tab', { name: 'src/main.ts' })).toBeVisible();
    expect(document.querySelector('.gm-bcode-pre')).toHaveTextContent(
      'generated by the GraphMind workflow builder',
    );
    expect(document.querySelector('.gm-bcode-pre')).toHaveTextContent('ANTHROPIC_API_KEY');
  });

  it('follows the canvas: a new node is a new file', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: '+ MCP server' }));
    await user.click(tab('Code'));
    expect(screen.getByRole('tab', { name: 'src/mcp.ts' })).toBeVisible();
  });

  it('follows the provider: the key the project reads changes with it', async () => {
    const user = userEvent.setup();
    show();
    await user.selectOptions(screen.getByLabelText('Provider'), 'groq');
    await user.click(tab('Code'));
    await user.click(screen.getByRole('tab', { name: 'src/main.ts' }));
    expect(document.querySelector('.gm-bcode-pre')).toHaveTextContent('GROQ_API_KEY');
  });

  it('copies one file or the lot', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show();
    await user.click(tab('Code'));

    await user.click(screen.getByRole('button', { name: /copy file/ }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('graphmind'));

    await user.click(screen.getByRole('button', { name: /copy all/ }));
    // The bundle carries every file and the commands to run them.
    const bundle = writeText.mock.calls[1]?.[0] as string;
    expect(bundle).toContain('package.json');
    expect(bundle).toContain('src/main.ts');
    expect(bundle).toContain('npm install');
  });
});

describe('the Run panel', () => {
  it('is three numbered steps, in the order you do them', async () => {
    const user = userEvent.setup();
    show();
    await user.click(tab('Run'));
    const labels = [...document.querySelectorAll('.gm-brun .gm-bsection .gm-section-label')].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['Create the project', 'Credentials', 'Run it']);
  });

  it('disables Create and Run with no server, and says why', async () => {
    const user = userEvent.setup();
    show();
    await user.click(tab('Run'));

    const create = screen.getByRole('button', { name: 'Create project' });
    const run = screen.getByRole('button', { name: /Install & run|^▶ Run/ });
    expect(create).toBeDisabled();
    expect(run).toBeDisabled();
    expect(create).toHaveAttribute('title', expect.stringContaining('debugger server'));
    expect(document.querySelector('.gm-builder-railbody .gm-btoken')).toHaveTextContent(
      /Create, Run and Test connection/,
    );
  });

  it('defaults to keeping the key out of the filesystem', async () => {
    const user = userEvent.setup();
    show();
    await user.click(tab('Run'));

    expect(screen.getByRole('radio', { name: /This session only/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /Save to .env/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('hides the key as it is typed and keeps it out of every store', async () => {
    const user = userEvent.setup();
    show();
    await user.click(tab('Run'));

    const key = screen.getByLabelText('ANTHROPIC_API_KEY');
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveAttribute('autocomplete', 'off');

    await user.type(key, 'sk-ant-secret-value');
    const everything = JSON.stringify({
      builder: useBuilderStore.getState(),
      ui: useUiStore.getState(),
      local: { ...localStorage },
    });
    expect(everything).not.toContain('sk-ant-secret-value');
  });

  it('asks for the keys the chosen provider actually needs', async () => {
    const user = userEvent.setup();
    show();
    await user.selectOptions(screen.getByLabelText('Provider'), 'groq');
    await user.click(tab('Run'));

    expect(screen.getByLabelText('GROQ_API_KEY')).toBeVisible();
    expect(screen.queryByLabelText('ANTHROPIC_API_KEY')).toBeNull();
  });

  /**
   * The reported bug, through the button that had it: "Open the run" called
   * `selectRun` (which navigates to the run) and then `setPage('runs')`,
   * and the second undid the first — so the one control whose entire job is
   * landing on a run landed on the list, with the run selected but unseen.
   */
  it('"Open the run" lands on the run, not back on the list', async () => {
    const user = userEvent.setup();
    const startedAt = Date.now();
    // A job that has produced a run the viewer can see.
    act(() => {
      useBuilderStore.setState({
        job: { id: 'job-1', dir: '/tmp/my-agent', name: 'my-agent', phase: 'running', startedAt, endedAt: undefined, exitCode: undefined, total: 0, pid: 123 },
      });
    });
    seedRuns(makeRun({ runId: 'built-run', app: 'my-agent', status: 'running', startedTs: startedAt + 10 }));
    show();
    await user.click(tab('Run'));

    await user.click(screen.getByRole('button', { name: /Open the run/ }));

    expect(useUiStore.getState().selectedRunId).toBe('built-run');
    expect(useUiStore.getState().page).toBe('run');
  });

  it('reports a blocked Test connection in the page rather than doing nothing', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: '+ MCP server' }));

    const probe = screen.getByRole('button', { name: 'Test connection' });
    // Enabled: a control that silently refuses reads as broken.
    expect(probe).toBeEnabled();
    await user.click(probe);
    expect(document.querySelector('.gm-builder-railbody .gm-btoken')).toHaveTextContent(
      /debugger server/,
    );
  });
});
