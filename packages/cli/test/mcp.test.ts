/**
 * `graphmind mcp` end-to-end: seed a tmp DB via the storage API, then drive
 * the real command (`node dist/cli.js mcp`) as a child process over stdio
 * with the MCP SDK's client — the exact path Claude Code/Cursor take.
 *
 * The dist build happens in beforeAll so the test always exercises the
 * current source.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/sqlite-storage.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliJs = join(packageRoot, 'dist', 'cli.js');
const VIEWER = 'http://127.0.0.1:4747';

/** run-ok-1: three nodes, all ok; the tool output carries a huge payload. */
const T0 = Date.UTC(2026, 7, 25, 9, 0, 0);
/** run-fail-2: started later (listed first); tool:chargeCard fails. */
const T1 = Date.UTC(2026, 7, 25, 10, 0, 0);
const BLOB = 'x'.repeat(20_000);

function seed(dbPath: string): void {
  const storage = new SqliteStorage(dbPath);
  const put = (
    runId: string,
    seq: number,
    ts: number,
    type: string,
    payload: unknown,
    nodeId: string | null = null,
  ) => storage.insertEvent({ runId, seq, ts, type, nodeId, payload });

  storage.ensureRun({ id: 'run-ok-1', app: 'trip-planner', startedAt: T0, schemaVersion: 1, source: 'live' });
  put('run-ok-1', 0, T0, 'run.started', { app: 'trip-planner', sdk: { name: 'ai', version: '7.0.79' } });
  put('run-ok-1', 1, T0 + 10, 'node.started', {
    nodeId: 'agent:trip', kind: 'agent', name: 'trip', instanceId: 'a1', input: { prompt: 'plan a trip' },
  }, 'agent:trip');
  put('run-ok-1', 2, T0 + 20, 'node.started', {
    nodeId: 'llm:step', parentId: 'agent:trip', kind: 'llm', name: 'step', instanceId: 'l1',
    input: { messages: ['plan a trip'] },
  }, 'llm:step');
  put('run-ok-1', 3, T0 + 820, 'node.finished', {
    nodeId: 'llm:step', output: { text: 'searching flights' },
    usage: { inputTokens: 120, outputTokens: 45 }, durationMs: 800, status: 'ok',
  }, 'llm:step');
  put('run-ok-1', 4, T0 + 830, 'node.started', {
    nodeId: 'tool:searchFlights', parentId: 'agent:trip', kind: 'tool', name: 'searchFlights',
    instanceId: 't1', input: { from: 'CAI', to: 'BER' },
  }, 'tool:searchFlights');
  put('run-ok-1', 5, T0 + 1130, 'node.finished', {
    nodeId: 'tool:searchFlights', output: { flights: ['GM 42'], blob: BLOB }, durationMs: 300, status: 'ok',
  }, 'tool:searchFlights');
  put('run-ok-1', 6, T0 + 2000, 'node.finished', {
    nodeId: 'agent:trip', output: { itinerary: 'done' }, durationMs: 1990, status: 'ok',
  }, 'agent:trip');
  put('run-ok-1', 7, T0 + 2000, 'run.finished', { status: 'ok' });
  storage.markRunFinished('run-ok-1', 'ok', T0 + 2000);

  storage.ensureRun({ id: 'run-fail-2', app: 'trip-planner', startedAt: T1, schemaVersion: 1, source: 'live' });
  put('run-fail-2', 0, T1, 'run.started', { app: 'trip-planner', sdk: { name: 'ai', version: '7.0.79' } });
  put('run-fail-2', 1, T1 + 10, 'node.started', {
    nodeId: 'agent:trip', kind: 'agent', name: 'trip', instanceId: 'a1', input: { prompt: 'book it' },
  }, 'agent:trip');
  put('run-fail-2', 2, T1 + 20, 'node.started', {
    nodeId: 'tool:chargeCard', parentId: 'agent:trip', kind: 'tool', name: 'chargeCard',
    instanceId: 't1', input: { amountUsd: 412 },
  }, 'tool:chargeCard');
  put('run-fail-2', 3, T1 + 140, 'node.error', {
    nodeId: 'tool:chargeCard',
    error: {
      name: 'PaymentError',
      message: 'card declined',
      stack: 'PaymentError: card declined\n    at chargeCard (/app/tools/charge.ts:12:9)',
    },
  }, 'tool:chargeCard');
  put('run-fail-2', 4, T1 + 150, 'node.finished', {
    nodeId: 'tool:chargeCard', output: null, durationMs: 130, status: 'error',
  }, 'tool:chargeCard');
  put('run-fail-2', 5, T1 + 400, 'node.finished', {
    nodeId: 'agent:trip', output: null, durationMs: 390, status: 'error',
  }, 'agent:trip');
  put('run-fail-2', 6, T1 + 400, 'run.finished', {
    status: 'error', error: { name: 'PaymentError', message: 'card declined' },
  });
  storage.markRunFinished('run-fail-2', 'error', T1 + 400);
  storage.close();
}

interface McpChild {
  client: Client;
  stderrText(): string;
  close(): Promise<void>;
}

async function spawnMcp(dbPath: string): Promise<McpChild> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliJs, 'mcp'],
    env: { ...getDefaultEnvironment(), GRAPHMIND_DB: dbPath },
    stderr: 'pipe',
  });
  const chunks: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
  const client = new Client({ name: 'graphmind-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    stderrText: () => Buffer.concat(chunks).toString('utf8'),
    close: () => client.close(),
  };
}

/** Call a tool; parse the JSON text content when the call succeeded. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; value: any }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first !== undefined && first.type === 'text' ? first.text : '';
  const isError = result.isError === true;
  return { isError, text, value: isError || text === '' ? undefined : JSON.parse(text) };
}

let dir: string;
let seededDb: string;
let emptyDb: string;
let seeded: McpChild;
let empty: McpChild;

beforeAll(async () => {
  // Build the real artifact the command ships as (dist/cli.js). Scoped to
  // the binary's import closure (files: [src/cli.ts]) so unrelated
  // work-in-progress source elsewhere in the package cannot break this test.
  const scopedConfig = join(packageRoot, 'tsconfig.mcp-test.json');
  writeFileSync(
    scopedConfig,
    JSON.stringify({ extends: './tsconfig.build.json', include: [], files: ['src/cli.ts'] }),
  );
  try {
    execFileSync(join(packageRoot, 'node_modules', '.bin', 'tsc'), ['-p', scopedConfig], {
      cwd: packageRoot,
      stdio: 'pipe',
    });
  } catch (error) {
    const detail = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `tsc (dist build for the mcp E2E) failed:\n${detail.stdout?.toString() ?? ''}${detail.stderr?.toString() ?? ''}`,
    );
  } finally {
    rmSync(scopedConfig, { force: true });
  }
  const schemaDist = join(packageRoot, '..', 'schema', 'dist', 'index.js');
  if (!existsSync(schemaDist)) {
    execFileSync('pnpm', ['-C', join(packageRoot, '..', 'schema'), 'build'], { stdio: 'pipe' });
  }

  dir = mkdtempSync(join(tmpdir(), 'graphmind-mcp-test-'));
  seededDb = join(dir, 'seeded.db');
  emptyDb = join(dir, 'empty.db');
  seed(seededDb);

  [seeded, empty] = await Promise.all([spawnMcp(seededDb), spawnMcp(emptyDb)]);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([seeded?.close(), empty?.close()]);
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('graphmind mcp over stdio', () => {
  it('starts, identifies itself, and exposes the four tools', async () => {
    expect(seeded.client.getServerVersion()?.name).toBe('graphmind');
    expect(seeded.client.getInstructions()).toContain('GraphMind');
    expect(seeded.client.getInstructions()).toContain('find_errors');

    const { tools } = await seeded.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'find_errors', 'get_node', 'get_run', 'list_runs',
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('list_runs: newest first, counts, and viewer deep links', async () => {
    const { isError, value } = await call(seeded.client, 'list_runs');
    expect(isError).toBe(false);
    expect(value.total).toBe(2);
    expect(value.runs.map((run: any) => run.id)).toEqual(['run-fail-2', 'run-ok-1']);

    const [fail, ok] = value.runs;
    expect(fail.status).toBe('error');
    expect(fail.errorCount).toBe(1);
    expect(fail.eventCount).toBe(7);
    expect(fail.app).toBe('trip-planner');
    expect(fail.source).toBe('live');
    expect(fail.startedAt).toBe('2026-08-25T10:00:00.000Z');
    expect(fail.finishedAt).toBe('2026-08-25T10:00:00.400Z');
    expect(fail.link).toBe(`${VIEWER}/#/run/run-fail-2`);
    expect(ok.status).toBe('ok');
    expect(ok.errorCount).toBe(0);
    expect(ok.link).toBe(`${VIEWER}/#/run/run-ok-1`);
  });

  it('list_runs honors limit', async () => {
    const { value } = await call(seeded.client, 'list_runs', { limit: 1 });
    expect(value.total).toBe(2);
    expect(value.runs).toHaveLength(1);
    expect(value.runs[0].id).toBe('run-fail-2');
  });

  it('get_run: per-node breakdown with durations and per-node links', async () => {
    const { isError, value } = await call(seeded.client, 'get_run', { runId: 'run-ok-1' });
    expect(isError).toBe(false);
    expect(value.run.id).toBe('run-ok-1');
    expect(value.run.status).toBe('ok');
    expect(value.nodes).toHaveLength(3);

    const llm = value.nodes.find((node: any) => node.nodeId === 'llm:step');
    expect(llm).toMatchObject({
      kind: 'llm', name: 'step', status: 'ok', executions: 1, durationMs: 800,
      parentId: 'agent:trip',
    });
    expect(llm.errorMessage).toBeUndefined();
    expect(llm.link).toBe(`${VIEWER}/#/run/run-ok-1/node/llm%3Astep`);

    const failed = await call(seeded.client, 'get_run', { runId: 'run-fail-2' });
    const charge = failed.value.nodes.find((node: any) => node.nodeId === 'tool:chargeCard');
    expect(charge.status).toBe('error');
    expect(charge.errorMessage).toBe('card declined');
  });

  it('get_run: unknown run is a tool error, not a crash', async () => {
    const { isError, text } = await call(seeded.client, 'get_run', { runId: 'nope' });
    expect(isError).toBe(true);
    expect(text).toContain('"nope" not found');
  });

  it('get_node: full detail, usage, and huge-payload truncation', async () => {
    const { isError, value } = await call(seeded.client, 'get_node', {
      runId: 'run-ok-1', nodeId: 'tool:searchFlights',
    });
    expect(isError).toBe(false);
    expect(value).toMatchObject({
      runId: 'run-ok-1', nodeId: 'tool:searchFlights', kind: 'tool',
      name: 'searchFlights', status: 'ok', executions: 1, totalDurationMs: 300,
    });
    expect(value.link).toBe(`${VIEWER}/#/run/run-ok-1/node/tool%3AsearchFlights`);

    const [instance] = value.instances;
    expect(instance.instanceId).toBe('t1');
    expect(instance.startedAt).toBe('2026-08-25T09:00:00.830Z');
    expect(instance.input).toEqual({ from: 'CAI', to: 'BER' });
    // The 20k-char blob must come back truncated, with a note.
    expect(instance.output.truncated).toBe(true);
    expect(instance.output.note).toMatch(/truncated: showing first 4000 of \d+ JSON characters/);
    expect(instance.output.preview.length).toBe(4000);

    const llm = await call(seeded.client, 'get_node', { runId: 'run-ok-1', nodeId: 'llm:step' });
    expect(llm.value.instances[0].usage).toEqual({ inputTokens: 120, outputTokens: 45 });
    expect(llm.value.instances[0].output).toEqual({ text: 'searching flights' });
  });

  it('get_node: failed node carries the error + stack', async () => {
    const { value } = await call(seeded.client, 'get_node', {
      runId: 'run-fail-2', nodeId: 'tool:chargeCard',
    });
    expect(value.status).toBe('error');
    expect(value.runStatus).toBe('error');
    expect(value.error).toEqual({
      name: 'PaymentError',
      message: 'card declined',
      stack: 'PaymentError: card declined\n    at chargeCard (/app/tools/charge.ts:12:9)',
    });
    expect(value.instances[0].error.message).toBe('card declined');
    expect(value.instances[0].durationMs).toBe(130);
  });

  it('get_node: unknown node lists the known nodeIds', async () => {
    const { isError, text } = await call(seeded.client, 'get_node', {
      runId: 'run-ok-1', nodeId: 'tool:nope',
    });
    expect(isError).toBe(true);
    expect(text).toContain('known nodeIds');
    expect(text).toContain('tool:searchFlights');
  });

  it('find_errors: recent failed nodes across runs, with links', async () => {
    const { isError, value } = await call(seeded.client, 'find_errors');
    expect(isError).toBe(false);
    expect(value.errors).toHaveLength(1);
    expect(value.errors[0]).toEqual({
      runId: 'run-fail-2',
      app: 'trip-planner',
      runStatus: 'error',
      nodeId: 'tool:chargeCard',
      nodeKind: 'tool',
      nodeName: 'chargeCard',
      message: 'card declined',
      errorName: 'PaymentError',
      at: '2026-08-25T10:00:00.140Z',
      link: `${VIEWER}/#/run/run-fail-2/node/tool%3AchargeCard`,
    });
  });

  it('rejects bad arguments with a tool error', async () => {
    const { isError, text } = await call(seeded.client, 'list_runs', { limit: -3 });
    expect(isError).toBe(true);
    expect(text).toContain('"limit" must be a positive integer');
  });

  it('simulates the Claude Code flow: "why did my last run fail?"', async () => {
    // Step 1: the agent reaches for find_errors.
    const found = await call(seeded.client, 'find_errors', { limit: 5 });
    const top = found.value.errors[0];
    expect(top.message).toBe('card declined');

    // Step 2: it drills into the failing node with the ids it was given.
    const node = await call(seeded.client, 'get_node', { runId: top.runId, nodeId: top.nodeId });
    expect(node.value.error.stack).toContain('charge.ts:12');
    expect(node.value.instances[0].input).toEqual({ amountUsd: 412 });

    // Step 3: it can cite a deep link the user can open.
    expect(node.value.link).toBe(`${VIEWER}/#/run/run-fail-2/node/tool%3AchargeCard`);
  });
});

describe('graphmind mcp with an empty database', () => {
  it('starts and lists zero runs', async () => {
    expect(empty.stderrText()).toContain('serving runs from');
    const runs = await call(empty.client, 'list_runs');
    expect(runs.isError).toBe(false);
    expect(runs.value.total).toBe(0);
    expect(runs.value.runs).toEqual([]);
    expect(runs.value.note).toContain('no runs recorded');

    const errors = await call(empty.client, 'find_errors');
    expect(errors.value.errors).toEqual([]);
    expect(errors.value.note).toContain('no failed nodes');
  });
});
