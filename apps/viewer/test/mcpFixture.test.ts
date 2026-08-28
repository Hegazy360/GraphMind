/**
 * The MCP fixture is the only MCP run that exists anywhere yet, so it has to
 * be a *valid* one: every envelope must survive the real parser, and feeding
 * it through the real reducer must produce the graph the canvas is designed
 * around.
 */
import { describe, expect, it } from 'vitest';
import { parseEnvelope, type EventEnvelope } from '@graphmind-ai/schema';
import { MCP_NODES, MCP_RUN_ID, generateMcpRun } from '../src/store/mcpFixture.js';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { runStateToFlow } from '../src/store/runStateToFlow.js';
import { nodeStatus, runHasActivePause, type RunState } from '../src/store/types.js';

const RUN = generateMcpRun(1_000_000);

function build(upTo = RUN.length): RunState {
  let runs: RunsMap = {};
  for (const raw of RUN.slice(0, upTo)) {
    const parsed = parseEnvelope(raw);
    if (parsed.kind !== 'ok') throw new Error(`bad envelope: ${JSON.stringify(parsed)}`);
    runs = applyEvent(runs, parsed.envelope as EventEnvelope, 'fixture');
  }
  const run = runs[MCP_RUN_ID];
  if (run === undefined) throw new Error('no run');
  return run;
}

describe('the MCP fixture is a real run on the wire', () => {
  it('parses every envelope against the shipped schema', () => {
    for (const raw of RUN) {
      const parsed = parseEnvelope(raw);
      expect(parsed.kind, `${raw.type} #${raw.seq} failed to parse`).toBe('ok');
    }
  });

  it('has strictly increasing seqs and non-decreasing timestamps', () => {
    for (let i = 1; i < RUN.length; i++) {
      const prev = RUN[i - 1];
      const next = RUN[i];
      if (prev === undefined || next === undefined) continue;
      expect(next.seq).toBeGreaterThan(prev.seq);
      expect(next.ts).toBeGreaterThanOrEqual(prev.ts);
    }
  });

  it('takes long enough to read as a session, not a single frame', () => {
    const first = RUN[0];
    const last = RUN[RUN.length - 1];
    expect((last?.ts ?? 0) - (first?.ts ?? 0)).toBeGreaterThan(5_000);
  });
});

describe('the MCP fixture builds the graph the canvas is designed for', () => {
  it('is one server session with every request hanging off it', () => {
    const run = build();
    const session = run.nodes[MCP_NODES.session];
    expect(session?.kind).toBe('server');
    expect(session?.parentId).toBeUndefined();
    for (const nodeId of Object.values(MCP_NODES)) {
      if (nodeId === MCP_NODES.session) continue;
      expect(run.nodes[nodeId]?.parentId, `${nodeId} should hang off the session`).toBe(
        MCP_NODES.session,
      );
    }
  });

  it('exercises all three MCP kinds plus a tool call and sampling', () => {
    const run = build();
    const kinds = Object.values(MCP_NODES).map((id) => run.nodes[id]?.kind);
    expect(new Set(kinds)).toEqual(new Set(['server', 'resource', 'prompt', 'tool', 'llm']));
  });

  it('advertises its catalogue before anything runs — hinted nodes are ghosts', () => {
    // Two envelopes in: run.started, node.started(session), graph.hint.
    const early = build(3);
    expect(early.nodes[MCP_NODES.create]?.ghost).toBe(true);
    expect(nodeStatus(early.nodes[MCP_NODES.create] as never)).toBe('ghost');
    expect(early.order.length).toBeGreaterThan(5);
  });

  it('streams sampling tokens on an llm node', () => {
    const tokens = RUN.filter(
      (e) => e.type === 'node.token' && e.payload['nodeId'] === MCP_NODES.sampling,
    );
    expect(tokens.length).toBeGreaterThan(1);
  });

  it('holds an error gate on a resources/read, and everything after it waits', () => {
    const gateIndex = RUN.findIndex((e) => e.type === 'exec.paused');
    expect(gateIndex).toBeGreaterThan(0);
    const held = build(gateIndex + 1);
    expect(runHasActivePause(held)).toBe(true);
    expect(held.nodes[MCP_NODES.issues]?.activePauseId).toBeDefined();
    expect(held.nodes[MCP_NODES.issues]?.lastError?.name).toBe('McpError');
    // create_issue is still only a hint at that point — the gate really is
    // holding the rest of the session.
    expect(held.nodes[MCP_NODES.create]?.executions).toHaveLength(0);
  });

  it('projects onto the canvas as a connected tree', () => {
    const { nodes, edges } = runStateToFlow(build());
    expect(nodes).toHaveLength(7);
    expect(nodes.find((n) => n.id === MCP_NODES.session)?.type).toBe('invocation');
    expect(nodes.find((n) => n.id === MCP_NODES.changelog)?.type).toBe('tool');
    expect(nodes.find((n) => n.id === MCP_NODES.sampling)?.type).toBe('llmStep');
    // Every non-root node is reachable from the session.
    const targets = new Set(edges.map((e) => e.target));
    for (const node of nodes) {
      if (node.id === MCP_NODES.session) continue;
      expect(targets.has(node.id), `${node.id} is orphaned on the canvas`).toBe(true);
    }
  });
});
