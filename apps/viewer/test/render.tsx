/**
 * The shared rig for the component suites.
 *
 * These tests drive the real pages against the real stores — no mocked
 * zustand, no shallow rendering. A page is wired to its store by a dozen
 * selectors, and a test that stubs the store stops being evidence that the
 * page works. What it costs is discipline about state: every store is a
 * module singleton, so each test has to start from a known one, which is
 * what `resetStores` is for.
 */
import type { RunInfo } from '../src/connection/protocol.js';
import { useRunStore } from '../src/store/runStore.js';
import { useUiStore, type ConnectionStatus } from '../src/store/uiStore.js';
import { useBuilderStore } from '../src/builder/builderStore.js';
import { EMPTY_FILTER } from '../src/store/filters.js';
import { defaultGraph, ROOT_ID } from '../src/builder/graph.js';
import type { NodeState, Pause, RunState } from '../src/store/types.js';

/** Put every store back to the state a freshly loaded tab would have. */
export function resetStores(): void {
  useRunStore.setState({ runs: {} });
  useUiStore.setState({
    page: 'runs',
    stackAt: 'runs',
    selectedRunId: undefined,
    selectedNodeId: undefined,
    selectedInstanceIdx: undefined,
    paletteOpen: false,
    customizeOpen: false,
    connection: 'off',
    fixtureActive: false,
    demoRequested: false,
    filters: EMPTY_FILTER,
    collapsedByRun: {},
    control: undefined,
  });
  useBuilderStore.setState({
    graph: defaultGraph(),
    selectedId: ROOT_ID,
    selectedFile: undefined,
    created: undefined,
    job: undefined,
    lines: [],
  });
  try {
    localStorage.clear();
  } catch {
    // jsdom always has one; a blocked store is the browser's problem
  }
}

export function setConnection(connection: ConnectionStatus): void {
  useUiStore.setState({ connection });
}

export interface RunOptions {
  runId?: string;
  app?: string;
  status?: RunState['meta']['status'];
  startedTs?: number | undefined;
  finishedTs?: number | undefined;
  /** `live` | `import` | `demo` — what the server said the run's origin was. */
  serverSource?: string;
  source?: RunState['meta']['source'];
  error?: { name: string; message: string };
  /** Add this many finished tool nodes, so the card has figures to show. */
  tools?: number;
  /** Add an llm node reporting these token counts. */
  tokens?: { in: number; out: number };
  /** Hold the run at an unresolved error gate. */
  heldOn?: { name: string; message: string };
}

const BASE = 1_700_000_000_000;

function toolNode(index: number, startedTs: number): NodeState {
  return {
    nodeId: `tool-${index}`,
    kind: 'tool',
    name: `tool${index}`,
    ghost: false,
    executions: [
      {
        instanceId: `tool-${index}#1`,
        input: {},
        output: {},
        status: 'ok',
        durationMs: 120,
        startedTs,
        finishedTs: startedTs + 120,
      },
    ],
  };
}

/**
 * A run shaped the way the list reads one. Deliberately built as state
 * rather than replayed through `applyEvent`: these suites are about what
 * the page does with a run, and the reducer has its own suite.
 */
export function makeRun(options: RunOptions = {}): RunState {
  const runId = options.runId ?? 'run-1';
  const startedTs = options.startedTs === undefined ? BASE : options.startedTs;
  const nodes: Record<string, NodeState> = {};
  const order: string[] = [];

  for (let i = 0; i < (options.tools ?? 0); i += 1) {
    const node = toolNode(i, startedTs + i * 10);
    nodes[node.nodeId] = node;
    order.push(node.nodeId);
  }

  if (options.tokens !== undefined) {
    nodes['llm-1'] = {
      nodeId: 'llm-1',
      kind: 'llm',
      name: 'chat',
      ghost: false,
      executions: [
        {
          instanceId: 'llm-1#1',
          input: {},
          output: {},
          status: 'ok',
          durationMs: 400,
          startedTs,
          finishedTs: startedTs + 400,
          usage: { inputTokens: options.tokens.in, outputTokens: options.tokens.out },
        },
      ],
    };
    order.push('llm-1');
  }

  const pauses: Record<string, Pause> = {};
  if (options.heldOn !== undefined) {
    // Shaped the way `applyEvent` leaves a run held at an error gate: the
    // call is still running (it has not returned — that is what held
    // means), and the pause names the execution it is holding. Without
    // both, `executionError` has nothing to attribute the error to and the
    // band falls back to "held after it ran".
    nodes['held'] = {
      nodeId: 'held',
      kind: 'tool',
      name: 'heldTool',
      ghost: false,
      executions: [
        { instanceId: 'held#1', input: {}, status: 'running', startedTs: startedTs + 40 },
      ],
      activePauseId: 'p1',
      lastError: options.heldOn,
    };
    order.push('held');
    pauses['p1'] = {
      pauseId: 'p1',
      nodeId: 'held',
      point: 'error',
      ts: startedTs + 50,
      active: true,
      heldBy: [{ nodeId: 'held', instanceId: 'held#1' }],
    };
  }

  return {
    runId,
    meta: {
      runId,
      app: options.app ?? 'trip-planner',
      status: options.status ?? 'ok',
      source: options.source ?? 'live',
      ...(options.serverSource !== undefined ? { serverSource: options.serverSource } : {}),
      ...(startedTs === undefined ? {} : { startedTs }),
      ...(options.finishedTs === undefined
        ? options.status === 'running' || options.heldOn !== undefined
          ? {}
          : { finishedTs: startedTs + 1000 }
        : { finishedTs: options.finishedTs }),
      ...(options.error !== undefined ? { error: options.error } : {}),
    },
    nodes,
    order,
    pauses,
    seqSeen: new Set<number>(),
    structureVersion: 0,
    statusVersion: 0,
  };
}

/** Put these runs on the list, in the order given. */
export function seedRuns(...runs: RunState[]): void {
  useRunStore.setState({ runs: Object.fromEntries(runs.map((run) => [run.runId, run])) });
}

/** The server's run-list frame, for the paths that go through `noteRunInfo`. */
export function runInfo(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    id: 'run-1',
    app: 'trip-planner',
    startedAt: BASE,
    finishedAt: null,
    status: 'running',
    schemaVersion: 1,
    source: 'live',
    eventCount: 3,
    errorCount: 0,
    live: true,
    ...overrides,
  };
}
