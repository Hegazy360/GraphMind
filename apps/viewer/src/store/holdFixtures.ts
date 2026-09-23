/**
 * Synthetic runs that end held on each 0.6.0 hold kind (contract C4) — for
 * the browser suite and design work, the way `generateLoopRun` serves the
 * repeat hold. No SDK emits these yet in a recording we can ship; the shapes
 * follow the wire contract (packages/schema/src/events.ts).
 *
 *  - `generateCycleRun`        search → fetch, three identical laps, held at
 *                              the first call of lap four (`loop.kind: 'cycle'`);
 *  - `generateErrorRepeatRun`  run_sql failing three times with the same error
 *                              and different queries (`loop.kind: 'error-repeat'`);
 *  - `generateSmartRun`        a smart hold: `error-result` at a tool's after
 *                              gate, or `truncated-tool-call` at an LLM step's.
 */
import type { LoopFixtureEnvelope } from './loop.js';

export const HOLD_RUN_ID = 'run-holds-9e41';

export const HOLD_NODES = {
  agent: 'agent:researcher',
  llm: 'llm:step',
  search: 'tool:search',
  fetch: 'tool:fetch',
  sql: 'tool:run_sql',
} as const;

function emitter(startTs: number) {
  const out: LoopFixtureEnvelope[] = [];
  let seq = 0;
  let ts = startTs;
  const emit = (type: string, payload: Record<string, unknown>, gapMs = 0): LoopFixtureEnvelope => {
    ts += gapMs;
    const env = { gm: 1, seq: seq++, ts, runId: HOLD_RUN_ID, type, payload };
    out.push(env);
    return env;
  };
  emit('run.started', { app: 'researcher', sdk: { name: 'ai', version: '7.0.79' } });
  emit(
    'node.started',
    { nodeId: HOLD_NODES.agent, kind: 'agent', name: 'researcher', instanceId: HOLD_RUN_ID, input: { prompt: 'Find the paper.' } },
    30,
  );
  return { out, emit };
}

function llmStep(emit: ReturnType<typeof emitter>['emit'], n: number): void {
  emit(
    'node.started',
    { nodeId: HOLD_NODES.llm, kind: 'llm', name: 'step', parentId: HOLD_NODES.agent, instanceId: `step-${n}`, input: { step: n } },
    60,
  );
  emit(
    'node.finished',
    { nodeId: HOLD_NODES.llm, instanceId: `step-${n}`, output: { finishReason: 'tool-calls' }, durationMs: 300, status: 'ok' },
    300,
  );
}

export const CYCLE_LAPS = 3;

export function generateCycleRun(startTs: number = Date.now() - 8_000): LoopFixtureEnvelope[] {
  const { out, emit } = emitter(startTs);
  let firstSeq: number | undefined;
  let step = 0;
  for (let lap = 0; lap < CYCLE_LAPS; lap++) {
    for (const [nodeId, name, input, output] of [
      [HOLD_NODES.search, 'search', { q: 'attention is all you need' }, { hits: ['arxiv:1706.03762'] }],
      [HOLD_NODES.fetch, 'fetch', { url: 'https://arxiv.org/abs/1706.03762' }, { status: 429 }],
    ] as const) {
      llmStep(emit, ++step);
      const call = `${name}-${lap}`;
      const started = emit(
        'node.started',
        { nodeId, kind: 'tool', name, parentId: HOLD_NODES.llm, instanceId: call, input },
        20,
      );
      firstSeq ??= started.seq;
      emit('node.finished', { nodeId, instanceId: call, output, durationMs: 90, status: 'ok' }, 90);
    }
  }
  llmStep(emit, ++step);
  const held = emit(
    'node.started',
    {
      nodeId: HOLD_NODES.search,
      kind: 'tool',
      name: 'search',
      parentId: HOLD_NODES.llm,
      instanceId: 'search-held',
      input: { q: 'attention is all you need' },
    },
    20,
  );
  emit(
    'exec.paused',
    {
      pauseId: 'pause-cycle-1',
      nodeId: HOLD_NODES.search,
      point: 'before',
      reason: 'loop',
      loop: {
        repeats: CYCLE_LAPS * 2 + 1,
        firstSeq: firstSeq ?? 0,
        lastSeq: held.seq,
        fingerprint: 'salted-3f9a0c',
        kind: 'cycle',
        period: 2,
        laps: CYCLE_LAPS,
      },
      editable: true,
    },
    4,
  );
  return out;
}

export function generateErrorRepeatRun(startTs: number = Date.now() - 6_000): LoopFixtureEnvelope[] {
  const { out, emit } = emitter(startTs);
  let firstSeq: number | undefined;
  const queries = ['SELECT * FROM users', 'SELECT id FROM users', 'SELECT count(*) FROM users'];
  queries.forEach((query, i) => {
    llmStep(emit, i + 1);
    const started = emit(
      'node.started',
      { nodeId: HOLD_NODES.sql, kind: 'tool', name: 'run_sql', parentId: HOLD_NODES.llm, instanceId: `sql-${i}`, input: { query } },
      20,
    );
    firstSeq ??= started.seq;
    emit('node.error', { nodeId: HOLD_NODES.sql, error: { name: 'DatabaseError', message: 'relation "users" does not exist' } }, 40);
    emit('node.finished', { nodeId: HOLD_NODES.sql, instanceId: `sql-${i}`, durationMs: 40, status: 'error' }, 1);
  });
  llmStep(emit, queries.length + 1);
  const held = emit(
    'node.started',
    { nodeId: HOLD_NODES.sql, kind: 'tool', name: 'run_sql', parentId: HOLD_NODES.llm, instanceId: 'sql-held', input: { query: 'SELECT name FROM users' } },
    20,
  );
  emit(
    'exec.paused',
    {
      pauseId: 'pause-error-repeat-1',
      nodeId: HOLD_NODES.sql,
      point: 'before',
      reason: 'loop',
      loop: { repeats: queries.length, firstSeq: firstSeq ?? 0, lastSeq: held.seq, fingerprint: 'salted-77e1', kind: 'error-repeat' },
    },
    4,
  );
  return out;
}

export function generateSmartRun(
  rule: 'error-result' | 'truncated-tool-call',
  startTs: number = Date.now() - 4_000,
): LoopFixtureEnvelope[] {
  const { out, emit } = emitter(startTs);
  if (rule === 'error-result') {
    llmStep(emit, 1);
    emit(
      'node.started',
      { nodeId: HOLD_NODES.search, kind: 'tool', name: 'search', parentId: HOLD_NODES.llm, instanceId: 'search-1', input: { q: 'transformers' } },
      20,
    );
    emit(
      'exec.paused',
      {
        pauseId: 'pause-smart-1',
        nodeId: HOLD_NODES.search,
        point: 'after',
        reason: 'breakpoint',
        smart: { rule: 'error-result', detail: 'the result has isError: true' },
      },
      120,
    );
    return out;
  }
  emit(
    'node.started',
    { nodeId: HOLD_NODES.llm, kind: 'llm', name: 'step', parentId: HOLD_NODES.agent, instanceId: 'step-1', input: { step: 1, maxTokens: 256 } },
    60,
  );
  emit(
    'exec.paused',
    {
      pauseId: 'pause-smart-1',
      nodeId: HOLD_NODES.llm,
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'truncated-tool-call', detail: 'finish reason length with 1 tool call' },
    },
    400,
  );
  return out;
}
