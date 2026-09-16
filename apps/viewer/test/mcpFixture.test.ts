/**
 * The MCP fixture is the only MCP run that exists anywhere yet, so it has to
 * be a *valid* one: every envelope must survive the real parser, and feeding
 * it through the real reducer must produce the graph the canvas is designed
 * around.
 */
import { describe, expect, it } from 'vitest';
import { parseEnvelope, type EventEnvelope } from '@graphmind-ai/schema';
import {
  MCP_NODES,
  MCP_PROTOCOL_NODES,
  MCP_PROTOCOL_TOTAL_MS,
  MCP_RUN_ID,
  generateMcpRun,
} from '../src/store/mcpFixture.js';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { hintedCollapseRoots, summarizeGroup } from '../src/store/collapse.js';
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

  it('parents the six protocol calls under mcp:protocol, which opens folded', () => {
    const run = build();
    const protocol = run.nodes[MCP_NODES.protocol];
    expect(protocol).toMatchObject({ kind: 'custom', name: 'protocol', parentId: MCP_NODES.session });
    for (const nodeId of Object.values(MCP_PROTOCOL_NODES)) {
      expect(run.nodes[nodeId]?.parentId, `${nodeId} should be protocol traffic`).toBe(MCP_NODES.protocol);
      expect(run.nodes[nodeId]?.kind).toBe('custom');
    }
    // The hint is on the wire exactly as the proxy sends it…
    const started = RUN.find(
      (e) => e.type === 'node.started' && e.payload['nodeId'] === MCP_NODES.protocol,
    );
    expect(started?.payload['collapsed']).toBe(true);
    expect(started?.payload['instanceId']).toBe(MCP_NODES.protocol);
    // …the group is announced before its first child…
    const firstChild = RUN.find(
      (e) => e.type === 'node.started' && e.payload['parentId'] === MCP_NODES.protocol,
    );
    expect(started?.seq).toBeLessThan(firstChild?.seq ?? -1);
    // …and it closes with counts, before the session does.
    const protocolEnd = RUN.find(
      (e) => e.type === 'node.finished' && e.payload['nodeId'] === MCP_NODES.protocol,
    );
    const sessionEnd = RUN.find(
      (e) => e.type === 'node.finished' && e.payload['nodeId'] === MCP_NODES.session,
    );
    expect(protocolEnd?.payload['output']).toEqual({ calls: 6, errors: 0, stdoutNoise: 0 });
    expect(protocolEnd?.seq).toBeLessThan(sessionEnd?.seq ?? -1);
  });

  it('the folded protocol card reads "6 calls · 702ms"', () => {
    const run = build();
    const summary = summarizeGroup(run, MCP_NODES.protocol);
    expect(summary.nodes).toBe(6);
    expect(summary.executions).toBe(6);
    expect(summary.tools).toBe(6);
    expect(summary.durationMs).toBe(MCP_PROTOCOL_TOTAL_MS);
    expect(summary.errors).toBe(0);
    // Folded, the canvas shows the session, the group and the six work nodes.
    const folded = runStateToFlow(run, { collapsed: [MCP_NODES.protocol] });
    expect(folded.nodes).toHaveLength(8);
    expect(folded.nodes.find((n) => n.id === MCP_NODES.protocol)?.type).toBe('group');
    for (const nodeId of Object.values(MCP_PROTOCOL_NODES)) {
      expect(folded.nodes.some((n) => n.id === nodeId), `${nodeId} should be hidden`).toBe(false);
    }
  });

  it('the protocol group opens folded: the reducer keeps `collapsed` and the projection folds it', () => {
    const run = build();
    expect(run.nodes[MCP_NODES.protocol]?.collapsed).toBe(true);
    expect(hintedCollapseRoots(run)).toEqual([MCP_NODES.protocol]);
  });

  it('exercises all three MCP kinds plus a tool call, sampling and the protocol group', () => {
    const run = build();
    const kinds = Object.values(MCP_NODES).map((id) => run.nodes[id]?.kind);
    expect(new Set(kinds)).toEqual(new Set(['server', 'resource', 'prompt', 'tool', 'llm', 'custom']));
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
    // 1 session + 1 protocol group + 6 protocol calls + 6 work nodes.
    expect(nodes).toHaveLength(14);
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
