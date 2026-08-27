/**
 * Assertions shared by every adapter suite. They read only what the headless
 * debugger received over the wire — i.e. what a real viewer would have to work
 * with — never the adapter's internals.
 */
import type { HeadlessDebugger, WireEnvelope } from './debugger.js';
import type { Report } from './report.js';

export interface NodeStarted {
  nodeId: string;
  kind: string;
  name: string;
  instanceId: string;
  parentId: string | undefined;
  input: unknown;
  seq: number;
}

export interface NodeFinished {
  nodeId: string;
  instanceId: string | undefined;
  output: unknown;
  usage: { inputTokens?: number; outputTokens?: number } | undefined;
  status: string;
  durationMs: number;
  seq: number;
}

export function started(dbg: HeadlessDebugger, runId: string): NodeStarted[] {
  return dbg.events('node.started', runId).map((e) => ({
    nodeId: String(e.payload['nodeId']),
    kind: String(e.payload['kind']),
    name: String(e.payload['name']),
    instanceId: String(e.payload['instanceId']),
    parentId: e.payload['parentId'] === undefined ? undefined : String(e.payload['parentId']),
    input: e.payload['input'],
    seq: e.seq,
  }));
}

export function finished(dbg: HeadlessDebugger, runId: string): NodeFinished[] {
  return dbg.events('node.finished', runId).map((e) => ({
    nodeId: String(e.payload['nodeId']),
    instanceId:
      e.payload['instanceId'] === undefined ? undefined : String(e.payload['instanceId']),
    output: e.payload['output'],
    usage: e.payload['usage'] as NodeFinished['usage'],
    status: String(e.payload['status']),
    durationMs: Number(e.payload['durationMs']),
    seq: e.seq,
  }));
}

/** Concatenated `node.token` deltas for one node on one channel. */
export function tokenText(
  dbg: HeadlessDebugger,
  runId: string,
  nodeId: string,
  channel: 'text' | 'reasoning' | 'tool-args' = 'text',
): string {
  let out = '';
  for (const envelope of dbg.events('node.token', runId)) {
    if (envelope.payload['nodeId'] !== nodeId) continue;
    for (const delta of (envelope.payload['deltas'] as { t: string; v: string }[]) ?? []) {
      if (delta.t === channel) out += delta.v;
    }
  }
  return out;
}

export function tokenFrames(dbg: HeadlessDebugger, runId: string, nodeId: string): WireEnvelope[] {
  return dbg.events('node.token', runId).filter((e) => e.payload['nodeId'] === nodeId);
}

export interface GraphExpectation {
  agentNodeId: string;
  llmNodeId: string;
  /** How many llm executions the scenario should have produced. */
  llmSteps: number;
  /** Logical tool nodes expected, with how many executions each. */
  tools: { nodeId: string; instances: number }[];
  /** What the host itself saw the model produce, in order, per step. */
  hostText: string;
  /** Provider tool-call ids the host dispatched, if the adapter correlates them. */
  toolCallIds?: string[];
  /** Whether the llm node should carry a parentId pointing at the agent node. */
  expectLlmParent?: boolean;
}

/**
 * The core "the run appears with the right node graph" assertion set, plus
 * streaming reconstruction and real usage.
 */
export function checkRunGraph(
  report: Report,
  dbg: HeadlessDebugger,
  runId: string,
  expect: GraphExpectation,
): void {
  const starts = started(dbg, runId);
  const ends = finished(dbg, runId);

  const runStarted = dbg.events('run.started', runId);
  const runFinished = dbg.events('run.finished', runId);
  report.check(
    'run announced to the debugger (run.started + run.finished)',
    runStarted.length === 1 && runFinished.length === 1,
    `started=${runStarted.length} finished=${runFinished.length}`,
  );

  const agents = starts.filter((n) => n.nodeId === expect.agentNodeId);
  report.check(
    `agent node "${expect.agentNodeId}" started once`,
    agents.length === 1 && agents[0]?.kind === 'agent',
    `n=${agents.length}`,
  );

  const llm = starts.filter((n) => n.nodeId === expect.llmNodeId);
  report.check(
    `llm node "${expect.llmNodeId}" ran ${expect.llmSteps}x`,
    llm.length === expect.llmSteps,
    `n=${llm.length}`,
  );
  report.check(
    'llm executions have distinct instanceIds',
    new Set(llm.map((n) => n.instanceId)).size === llm.length,
    llm.map((n) => n.instanceId).join(', '),
  );
  if (expect.expectLlmParent !== false) {
    report.check(
      'llm node is parented to the agent node',
      llm.length > 0 && llm.every((n) => n.parentId === expect.agentNodeId),
      llm.map((n) => String(n.parentId)).join(', '),
    );
  }

  for (const tool of expect.tools) {
    const runs = starts.filter((n) => n.nodeId === tool.nodeId);
    report.check(
      `tool node "${tool.nodeId}" ran ${tool.instances}x`,
      runs.length === tool.instances,
      `n=${runs.length}`,
    );
    report.check(
      `tool "${tool.nodeId}" is parented to the llm node`,
      runs.length > 0 && runs.every((n) => n.parentId === expect.llmNodeId),
      runs.map((n) => String(n.parentId)).join(', '),
    );
    report.check(
      `tool "${tool.nodeId}" executions have distinct instanceIds`,
      new Set(runs.map((n) => n.instanceId)).size === runs.length,
      runs.map((n) => n.instanceId).join(', '),
    );
  }

  if (expect.toolCallIds !== undefined && expect.toolCallIds.length > 0) {
    const toolNodeIds = new Set(expect.tools.map((t) => t.nodeId));
    const seenIds = starts.filter((n) => toolNodeIds.has(n.nodeId)).map((n) => n.instanceId);
    const wanted = [...expect.toolCallIds].sort();
    const got = [...seenIds].sort();
    report.check(
      'tool instanceIds are the provider\'s real tool-call ids',
      wanted.length === got.length && wanted.every((id, i) => id === got[i]),
      `provider=[${wanted.join(', ')}] graphmind=[${got.join(', ')}]`,
    );
  }

  // -- every started node finished ------------------------------------------
  const openInstances = starts.filter(
    (s) => !ends.some((e) => e.nodeId === s.nodeId && e.instanceId === s.instanceId),
  );
  report.check(
    'every node.started has a matching node.finished (same instanceId)',
    openInstances.length === 0,
    openInstances.map((n) => `${n.nodeId}/${n.instanceId}`).join(', '),
  );

  // -- streaming reconstruction ---------------------------------------------
  const frames = tokenFrames(dbg, runId, expect.llmNodeId);
  const streamed = tokenText(dbg, runId, expect.llmNodeId, 'text');
  report.check(
    'node.token deltas arrived for the llm node',
    frames.length > 0,
    `${frames.length} batched frames`,
  );
  report.check(
    'streamed deltas reconstruct exactly to the text the model really produced',
    streamed === expect.hostText,
    streamed === expect.hostText
      ? `${streamed.length} chars`
      : `graphmind=${JSON.stringify(streamed.slice(0, 90))} host=${JSON.stringify(
          expect.hostText.slice(0, 90),
        )}`,
  );

  // -- real usage -----------------------------------------------------------
  const llmEnds = ends.filter((e) => e.nodeId === expect.llmNodeId && e.status === 'ok');
  const withUsage = llmEnds.filter(
    (e) => (e.usage?.inputTokens ?? 0) > 0 && (e.usage?.outputTokens ?? 0) > 0,
  );
  report.check(
    'every llm node.finished carries non-zero real input/output token usage',
    llmEnds.length > 0 && withUsage.length === llmEnds.length,
    llmEnds
      .map((e) => `${e.usage?.inputTokens ?? 'none'}/${e.usage?.outputTokens ?? 'none'}`)
      .join(' '),
  );
}

/** Sum the usage GraphMind recorded for a run and file it in the report. */
export function recordRunUsage(
  report: Report,
  dbg: HeadlessDebugger,
  runId: string,
  model: string,
): void {
  for (const end of finished(dbg, runId)) {
    const usage = end.usage;
    if (usage === undefined) continue;
    report.recordUsage(model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate` holds, polling every 20ms. */
export async function until(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await delay(20);
  }
}
