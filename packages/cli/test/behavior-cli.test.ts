/**
 * `graphmind runs --behavior` — the CLI surface of the behaviour report.
 * The numbers themselves are @graphmind-ai/analyze's (tested there); this
 * suite covers the command: run resolution (`last`, unknown ids), the text
 * rendering, and `--json`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultFlags, type ParsedCli } from '../src/args.js';
import { behaviorLines } from '../src/behavior.js';
import { runRuns } from '../src/commands/runs.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

let dir: string;
let db: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graphmind-behavior-'));
  db = join(dir, 'runs.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A run with one repeated tool call, one failing tool, and two LLM steps. */
function seedWastefulRun(dbPath: string, id = 'run-loop-1', offsetMs = 0): void {
  const storage = new SqliteStorage(dbPath);
  const T = Date.UTC(2026, 10, 1, 9, 0, 0) + offsetMs;
  let seq = 0;
  const put = (type: string, payload: unknown, nodeId: string | null = null) =>
    storage.insertEvent({ runId: id, seq: (seq += 1), ts: T + seq * 100, type, nodeId, payload });

  storage.ensureRun({ id, app: 'trip-planner', startedAt: T, schemaVersion: 1, source: 'live' });
  put('run.started', { app: 'trip-planner', sdk: { name: 'ai', version: '7.0.0' } });
  const llm = (inputTokens: number, finishReason = 'tool-calls') => {
    const instanceId = `l${seq}`;
    put('node.started', { nodeId: 'llm:step', kind: 'llm', name: 'step', instanceId, input: {} }, 'llm:step');
    put(
      'node.finished',
      {
        nodeId: 'llm:step',
        instanceId,
        status: 'ok',
        output: { finishReason },
        usage: { inputTokens, outputTokens: 10, inclusive: true },
        durationMs: 500,
      },
      'llm:step',
    );
  };
  const tool = (name: string, input: unknown, error?: string) => {
    const instanceId = `t${seq}`;
    const nodeId = `tool:${name}`;
    put('node.started', { nodeId, kind: 'tool', name, instanceId, input }, nodeId);
    if (error !== undefined) {
      put('node.error', { nodeId, instanceId, error: { name: 'Error', message: error } }, nodeId);
    }
    put(
      'node.finished',
      { nodeId, instanceId, status: error === undefined ? 'ok' : 'error', durationMs: 40 },
      nodeId,
    );
  };

  llm(100);
  tool('searchFlights', { from: 'CAI', to: 'BER' });
  llm(400);
  tool('searchFlights', { from: 'CAI', to: 'BER' });
  llm(900, 'length');
  tool('checkBudget', { amount: 1 }, 'over budget');
  put('run.finished', { status: 'error', error: { name: 'Error', message: 'over budget' } });
  storage.markRunFinished(id, 'error', T + seq * 100);
  storage.close();
}

function parsed(flags: Partial<ReturnType<typeof defaultFlags>>): ParsedCli {
  return { command: 'runs', positionals: [], flags: { ...defaultFlags(), db, ...flags }, errors: [] };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) }, out, err };
}

describe('graphmind runs --behavior', () => {
  it('prints the verdict, the incidents and the tool table for a run id', async () => {
    seedWastefulRun(db);
    const { io, out } = capture();
    const code = await runRuns(parsed({ behavior: 'run-loop-1' }), io);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Behaviour — trip-planner (run-loop-1), error');
    expect(text).toContain('1 of 3 tool calls (33%) repeated earlier work (1 repeat)');
    expect(text).toContain('1 LLM step stopped at the token limit');
    expect(text).toContain('Wasted work');
    expect(text).toContain('searchFlights ×2');
    expect(text).toContain('checkBudget');
    expect(text).toContain('Open it: http://127.0.0.1:4747/#/run/run-loop-1');
  });

  it('resolves "last" to the most recently started run', async () => {
    seedWastefulRun(db, 'run-old');
    seedWastefulRun(db, 'run-new', 60_000);
    const { io, out } = capture();
    const code = await runRuns(parsed({ behavior: 'last' }), io);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('(run-new)');
  });

  it('--json prints the raw report', async () => {
    seedWastefulRun(db);
    const { io, out } = capture();
    const code = await runRuns(parsed({ behavior: 'run-loop-1', json: true }), io);
    expect(code).toBe(0);
    const report = JSON.parse(out.join('\n'));
    expect(report.runId).toBe('run-loop-1');
    expect(report.waste.wastedCalls).toBe(1);
    expect(report.waste.spanLlmSteps).toBe(1);
    expect(report.tools.map((tool: { name: string }) => tool.name)).toContain('checkBudget');
    expect(typeof report.verdict).toBe('string');
  });

  it('fails readably on an unknown run id', async () => {
    seedWastefulRun(db);
    const { io, err } = capture();
    const code = await runRuns(parsed({ behavior: 'run-nope' }), io);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no run "run-nope"');
  });

  it('fails readably on an empty database', async () => {
    const storage = new SqliteStorage(db);
    storage.close();
    const { io, err } = capture();
    const code = await runRuns(parsed({ behavior: 'last' }), io);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no runs stored yet');
  });
});

describe('behaviorLines', () => {
  it('renders a clean report without waste or note sections', () => {
    const lines = behaviorLines({
      runId: 'r1',
      app: 'demo',
      status: 'ok',
      executions: 2,
      llmSteps: 1,
      toolCalls: 1,
      waste: { toolCalls: 1, wastedCalls: 0, share: 0, wastedDurationMs: 0, unreadableCalls: 0, incidents: [] },
      tools: [{ nodeId: 't:a', name: 'a', calls: 1, failures: 0, silentFailures: 0, failureRate: 0, recovered: 0 }],
      termination: { llmSteps: 1, byReason: { stop: 1 }, unreported: 0 },
      context: { points: [{ step: 0, inputTokens: 100 }], maxInputTokens: 100, reportedBasis: false },
      verdict: 'No wasted work detected across 1 tool call and 1 LLM step.',
      notes: [],
    });
    const text = lines.join('\n');
    expect(text).toContain('No wasted work detected');
    expect(text).not.toContain('Wasted work');
    expect(text).not.toContain('Note:');
    expect(text).toContain('LLM steps: 1 — stop 1');
  });
});
