/**
 * Reusing a rendered canvas node is a performance optimisation with a
 * correctness precondition, and the precondition was missing.
 *
 * `data` is the card's pointer into the store (`{runId, nodeId}`) — the card
 * reads its own status, badges, duration and error through it. Two runs of the
 * same agent have identical node ids and an identical graph shape, so the
 * layout is identical and every geometric check passes. Reusing on geometry
 * alone therefore kept the PREVIOUS run's nodes when you switched runs, and
 * the canvas rendered that run's results underneath the new run's header:
 * `compute_metric DONE injected 5ms` on a run where compute_metric had in fact
 * failed and was still held at its error gate.
 *
 * Reported from real use, on a real database of ten runs of the same agent.
 */
import { describe, expect, it } from 'vitest';
import { canReuseFlowNode, type FlowNodeData } from '../src/store/runStateToFlow.js';

const at = (runId: string, nodeId = 'tool:compute_metric') => ({
  position: { x: 10, y: 20 },
  width: 240,
  height: 100,
  type: 'tool',
  data: { runId, nodeId } satisfies FlowNodeData,
});

describe('canReuseFlowNode', () => {
  it('reuses a node that has not moved within the same run', () => {
    expect(canReuseFlowNode({ ...at('run_a'), className: undefined }, at('run_a'), undefined)).toBe(
      true,
    );
  });

  it('REFUSES to reuse across runs, even when the geometry is identical', () => {
    // The bug: same agent, same node id, same position — different run.
    expect(canReuseFlowNode({ ...at('run_a'), className: undefined }, at('run_b'), undefined)).toBe(
      false,
    );
  });

  it('refuses when the node id differs', () => {
    expect(
      canReuseFlowNode(
        { ...at('run_a', 'tool:one'), className: undefined },
        at('run_a', 'tool:two'),
        undefined,
      ),
    ).toBe(false);
  });

  it('still refuses on the geometric changes it always caught', () => {
    const previous = { ...at('run_a'), className: undefined };
    expect(canReuseFlowNode(previous, { ...at('run_a'), position: { x: 11, y: 20 } }, undefined)).toBe(false);
    expect(canReuseFlowNode(previous, { ...at('run_a'), width: 241 }, undefined)).toBe(false);
    expect(canReuseFlowNode(previous, { ...at('run_a'), height: 101 }, undefined)).toBe(false);
    expect(canReuseFlowNode(previous, { ...at('run_a'), type: 'llm' }, undefined)).toBe(false);
    // The filter dim class is applied by the same pass.
    expect(canReuseFlowNode(previous, at('run_a'), 'gm-dim')).toBe(false);
  });
});
