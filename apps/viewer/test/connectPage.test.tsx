// @vitest-environment jsdom
/**
 * Connect an agent: pick a stack, copy two things, watch it attach.
 *
 * The page's whole job is getting someone from "nothing attached" to "a run
 * arrived", so the two things worth pinning are that picking a stack
 * rewrites everything that depends on it, and that the rail tells the truth
 * about the connection in every state it can be in — including the replay,
 * where it once claimed "not connected" and "1 run recorded" at once.
 */
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectPage } from '../src/pages/ConnectPage.js';
import { STACKS } from '../src/connect/catalog.js';
import { useUiStore } from '../src/store/uiStore.js';
import { makeRun, resetStores, seedRuns, setConnection } from './render.js';

beforeEach(() => {
  resetStores();
});

const show = () => render(<ConnectPage />);
const codeBlocks = () => [...document.querySelectorAll('.gm-code pre')].map((el) => el.textContent ?? '');

describe('the stack chooser', () => {
  it('offers every stack in the catalogue, grouped by language', () => {
    show();
    const group = within(screen.getByRole('radiogroup', { name: 'Your stack' }));
    for (const stack of STACKS) {
      expect(group.getByRole('radio', { name: stack.framework })).toBeVisible();
    }
    expect(screen.getByText('TypeScript')).toBeVisible();
    expect(screen.getByText('Python')).toBeVisible();
    expect(screen.getByText('Any language')).toBeVisible();
  });

  /**
   * The blurb is how you recognise your own project, and it was the only
   * thing telling "MCP server you own" from "MCP server, via the proxy"
   * apart — so it cannot be behind a click on the thing you are choosing.
   */
  it('shows every stack\'s recognition line, not only the chosen one\'s', () => {
    show();
    for (const stack of STACKS) {
      expect(screen.getByText(stack.blurb)).toBeVisible();
    }
  });

  it('starts on the default stack, with exactly one chosen', () => {
    show();
    const chosen = screen
      .getAllByRole('radio')
      .filter((el) => el.getAttribute('aria-checked') === 'true');
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toHaveAccessibleName('Vercel AI SDK');
  });

  it('rewrites the install line, the code, the capability and the guide link', async () => {
    const user = userEvent.setup();
    show();
    expect(codeBlocks()[0]).toContain('npm i -D @graphmind-ai/sdk');
    expect(codeBlocks()[1]).toContain("from '@graphmind-ai/sdk'");

    await user.click(screen.getByRole('radio', { name: 'OpenAI or Anthropic SDK' }));

    expect(codeBlocks()[0]).toContain('pip install graphmind-ai');
    expect(codeBlocks()[1]).toContain('import graphmind as gm');
    // What a gate can do differs per stack, and is stated before you wire up.
    expect(screen.getByText(/pause, step, retry/)).toBeVisible();
    expect(screen.getByRole('link', { name: /OpenAI or Anthropic SDK integration guide/ })).toHaveAttribute(
      'href',
      'https://graphmind.ai/docs/integrations/python/',
    );
  });

  it('states the narrower capability where a gate genuinely cannot do everything', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('radio', { name: 'LangGraph / LangChain' }));
    expect(screen.getByText(/cannot substitute its return value/)).toBeVisible();
  });

  it('drops the install step for the stack that has nothing to install', async () => {
    const user = userEvent.setup();
    show();
    expect(codeBlocks()).toHaveLength(2);

    await user.click(screen.getByRole('radio', { name: 'MCP server, via the proxy' }));
    // One block, and it is the thing you actually edit.
    expect(codeBlocks()).toHaveLength(1);
    expect(codeBlocks()[0]).toContain('mcp-proxy');
    expect(screen.getByText(/Wrap the command your host already runs/)).toBeVisible();
  });

  it('remembers the choice, so it is not a question twice', async () => {
    const user = userEvent.setup();
    const first = show();
    await user.click(screen.getByRole('radio', { name: 'Anthropic SDK' }));
    first.unmount();

    show();
    expect(screen.getByRole('radio', { name: 'Anthropic SDK' })).toHaveAttribute('aria-checked', 'true');
  });

  it('survives a storage that refuses to remember', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    show();
    await user.click(screen.getByRole('radio', { name: 'OpenAI SDK' }));
    // The choice still applies for this session; it just is not persisted.
    expect(screen.getByRole('radio', { name: 'OpenAI SDK' })).toHaveAttribute('aria-checked', 'true');
    setItem.mockRestore();
  });
});

describe('copying', () => {
  it('puts the snippet on the clipboard and says so', async () => {
    // After `setup()`, which installs a clipboard stub of its own — the
    // page reads `navigator.clipboard` at click time, so the last one wins.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show();

    const [install] = screen.getAllByRole('button', { name: /copy/ });
    await user.click(install as HTMLElement);

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('npm i -D @graphmind-ai/sdk'));
    expect(await screen.findByText('copied')).toBeVisible();
  });
});

describe('the status rail', () => {
  it('counts nothing attached as three things still to do', () => {
    setConnection('detached');
    show();
    expect(screen.getByText('Not connected')).toBeVisible();
    expect(screen.getByText(/No debugger on/)).toBeVisible();
    expect(screen.getByText(/npx graphmind-ai serve/)).toBeVisible();
    expect(document.querySelectorAll('.gm-attach-step--done')).toHaveLength(0);
  });

  it('reports the handshake while it is happening', () => {
    setConnection('connecting');
    show();
    expect(screen.getByText('Connecting')).toBeVisible();
    expect(screen.getByText(/Reaching/)).toBeVisible();
  });

  it('attached with no runs is listening, and says what to do next', () => {
    setConnection('live');
    show();
    expect(screen.getByText('Listening')).toBeVisible();
    expect(screen.getByText('Waiting for your first run')).toBeVisible();
    expect(screen.getByText(/Run your agent/)).toBeVisible();
    // Two of the three facts are true; the run has not arrived.
    expect(document.querySelectorAll('.gm-attach-step--done')).toHaveLength(2);
  });

  it('a run arriving completes the checklist and offers the way in', async () => {
    const user = userEvent.setup();
    setConnection('live');
    seedRuns(makeRun({ runId: 'r1' }));
    show();

    expect(screen.getByText('Connected')).toBeVisible();
    expect(screen.getByText('1 run recorded')).toBeVisible();
    expect(document.querySelectorAll('.gm-attach-step--done')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: /See the runs/ }));
    expect(useUiStore.getState().page).toBe('runs');
  });

  /**
   * The bug this pins: a replay put runs on the list without a server, and
   * the rail reported "Not connected" and "1 run recorded" together — two
   * true sentences that are a lie side by side.
   */
  it('a replay says it is a replay, and claims no connection it does not have', () => {
    useUiStore.setState({ connection: 'off', fixtureActive: true });
    seedRuns(makeRun({ runId: 'r1', source: 'fixture' }));
    show();

    expect(screen.getByText('Replaying a recording')).toBeVisible();
    expect(screen.queryByText('Not connected')).toBeNull();
    expect(screen.queryByText('1 run recorded')).toBeNull();
    expect(screen.getByText(/showing a recorded run, not a live server/)).toBeVisible();
    expect(screen.getByRole('button', { name: /See the recording/ })).toBeVisible();
  });

  it('never counts a run as "yours" while nothing is attached', () => {
    setConnection('detached');
    seedRuns(makeRun({ runId: 'imported-1', serverSource: 'import' }));
    show();
    expect(screen.getByText('Waiting for your first run')).toBeVisible();
    expect(screen.queryByText(/1 run recorded/)).toBeNull();
  });

  it('does not repeat the header\'s connection label', () => {
    setConnection('detached');
    show();
    // The header owns `.gm-conn-label`; the page saying it too was two
    // claims about one socket (and a strict-mode ambiguity in the e2e).
    expect(document.querySelectorAll('.gm-conn-label')).toHaveLength(0);
  });
});

describe('the way onward', () => {
  it('offers the builder for someone starting from nothing', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /generate a starter project/ }));
    expect(useUiStore.getState().page).toBe('build');
  });
});
