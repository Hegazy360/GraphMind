// @vitest-environment jsdom
/**
 * The Behaviour strip on the run place: present only when there is
 * something to say, verdict readable without a click, evidence behind one.
 */
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { BehaviorSummary } from '../src/components/BehaviorSummary.js';
import { useRunStore } from '../src/store/runStore.js';
import type { NodeState, RunState } from '../src/store/types.js';
import { makeRun, resetStores } from './render.js';

beforeEach(() => resetStores());

function seed(run: RunState): void {
  useRunStore.setState({ runs: { [run.runId]: run } });
}

/** A run whose searchFlights tool was called twice with the same input. */
function loopyRun(): RunState {
  const run = makeRun({ runId: 'run-loop', app: 'trip-planner', status: 'ok' });
  const tool: NodeState = {
    nodeId: 'tool:searchFlights',
    kind: 'tool',
    name: 'searchFlights',
    ghost: false,
    executions: [
      { instanceId: 's1', seq: 1, input: { from: 'CAI' }, status: 'ok', startedTs: 1000, durationMs: 50 },
      { instanceId: 's2', seq: 3, input: { from: 'CAI' }, status: 'ok', startedTs: 2000, durationMs: 50 },
    ],
  };
  run.nodes[tool.nodeId] = tool;
  run.order.push(tool.nodeId);
  return run;
}

describe('BehaviorSummary', () => {
  it('renders nothing for a run with no tool calls or LLM steps', () => {
    seed(makeRun({ runId: 'run-empty' }));
    const { container } = render(<BehaviorSummary runId="run-empty" />);
    expect(container.querySelector('.gm-behavior')).toBeNull();
  });

  it('shows the verdict collapsed, and the evidence after a click', async () => {
    seed(loopyRun());
    render(<BehaviorSummary runId="run-loop" />);
    const strip = screen.getByRole('button', { name: /repeated earlier work/ });
    expect(strip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Wasted work')).toBeNull();

    await userEvent.click(strip);
    expect(strip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Wasted work')).toBeVisible();
    expect(screen.getByText('searchFlights', { selector: '.gm-behavior-chain' })).toBeVisible();
    expect(screen.getByText('Tools')).toBeVisible();
  });

  it('reports a clean run as clean', () => {
    const run = makeRun({ runId: 'run-clean', tools: 2, tokens: { in: 100, out: 10 } });
    seed(run);
    render(<BehaviorSummary runId="run-clean" />);
    expect(screen.getByText(/No wasted work detected/)).toBeVisible();
  });
});
