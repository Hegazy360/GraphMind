/**
 * A synthetic run for "edit tool arguments" (0.6.0, contract C2) — replayed
 * with `?fixture=edit`, for the browser suite, design work and the demo.
 *
 * An agent asks `run_sql` for recent signups from a table named `user`; the
 * call throws, and the error gate holds with `editable: true`. The fixture's
 * stand-in for the app (`simulateEditResume`) applies the client's rules in
 * miniature: the edit must ride on `retry` at this error gate, must be a
 * plain object, must not carry a placeholder or truncation marker, and the
 * merged arguments must pass the tool's schema (`limit` an integer 1–100).
 * A refusal keeps the gate held; an accepted edit releases it with
 * `edited.after`, and the recorded continuation plays out.
 *
 * `context` is recorded as a truncated preview, the way a large argument
 * reaches the viewer: it can be left alone (the live value is kept) but not
 * edited inside.
 */
import { TRUNCATION_SUFFIX } from '@graphmind-ai/schema';
import type { LoopFixtureEnvelope } from './loop.js';

export const EDIT_RUN_ID = 'run-edit-5d2b';

export const EDIT_NODES = {
  agent: 'agent:sql-agent',
  llm: 'llm:step',
  sql: 'tool:run_sql',
} as const;

export const EDIT_PAUSE_ID = 'pause-edit-1';

/** The tool's schema bound the fixture enforces. */
export const EDIT_MAX_LIMIT = 100;

const CONTEXT =
  'Weekly growth review for the analytics team. Count signups per day for the last 14 days, ' +
  'compare with the previous period, and flag any day that deviates more than two standard ' +
  'deviations from the trailing mean. Exclude internal test accounts.';

/** What the model actually asked for — the LIVE arguments inside the app. */
export const EDIT_LIVE_ARGS = {
  query: 'SELECT name, created_at FROM user ORDER BY created_at DESC',
  limit: 20,
  database: 'analytics',
  context: CONTEXT,
} as const;

/** The same arguments as the viewer received them: `context` cut to a preview. */
export const EDIT_RECORDED_ARGS = {
  ...EDIT_LIVE_ARGS,
  context: `${CONTEXT.slice(0, 48)}${TRUNCATION_SUFFIX}`,
} as const;

export const EDIT_ERROR = {
  name: 'DatabaseError',
  message: 'relation "user" does not exist',
} as const;

export const EDIT_OUTPUT = {
  rowCount: 3,
  rows: [
    { name: 'Ana Duarte', created_at: '2026-09-22T18:04:11Z' },
    { name: 'Joost de Vries', created_at: '2026-09-22T16:47:02Z' },
    { name: 'Mei Tanaka', created_at: '2026-09-22T09:31:45Z' },
  ],
} as const;

export function generateEditRun(startTs: number = Date.now() - 4_000): LoopFixtureEnvelope[] {
  const out: LoopFixtureEnvelope[] = [];
  let seq = 0;
  let ts = startTs;
  const emit = (type: string, payload: Record<string, unknown>, gapMs = 0): void => {
    ts += gapMs;
    out.push({ gm: 1, seq: seq++, ts, runId: EDIT_RUN_ID, type, payload });
  };

  emit('run.started', {
    app: 'sql-agent',
    sdk: { name: 'ai', version: '7.0.79' },
    meta: { name: 'sql-agent', env: 'dev' },
  });
  emit(
    'node.started',
    {
      nodeId: EDIT_NODES.agent,
      kind: 'agent',
      name: 'sql-agent',
      instanceId: EDIT_RUN_ID,
      input: { prompt: 'Who signed up most recently?' },
    },
    40,
  );
  emit(
    'node.started',
    {
      nodeId: EDIT_NODES.llm,
      kind: 'llm',
      name: 'step',
      parentId: EDIT_NODES.agent,
      instanceId: 'step-1',
      input: { model: 'gpt-4o-mini', step: 1 },
    },
    120,
  );
  emit(
    'node.finished',
    {
      nodeId: EDIT_NODES.llm,
      instanceId: 'step-1',
      output: {
        finishReason: 'tool-calls',
        rawFinishReason: 'tool_calls',
        toolCalls: [{ id: 'call-1', name: 'run_sql', input: EDIT_RECORDED_ARGS }],
      },
      usage: { inputTokens: 1240, outputTokens: 64, inclusive: true },
      durationMs: 702.5,
      status: 'ok',
    },
    700,
  );
  emit(
    'node.started',
    {
      nodeId: EDIT_NODES.sql,
      kind: 'tool',
      name: 'run_sql',
      parentId: EDIT_NODES.llm,
      instanceId: 'call-1',
      input: { ...EDIT_RECORDED_ARGS },
    },
    30,
  );
  emit('node.error', { nodeId: EDIT_NODES.sql, error: { ...EDIT_ERROR } }, 180);
  emit(
    'exec.paused',
    { pauseId: EDIT_PAUSE_ID, nodeId: EDIT_NODES.sql, point: 'error', reason: 'error', editable: true },
    4,
  );

  // ── after the gate: the (edited) retry succeeds ──────────────────────────
  emit(
    'node.finished',
    {
      nodeId: EDIT_NODES.sql,
      instanceId: 'call-1',
      output: EDIT_OUTPUT,
      durationMs: 244.8,
      status: 'ok',
    },
    240,
  );
  emit(
    'node.started',
    {
      nodeId: EDIT_NODES.llm,
      kind: 'llm',
      name: 'step',
      parentId: EDIT_NODES.agent,
      instanceId: 'step-2',
      input: { model: 'gpt-4o-mini', step: 2 },
    },
    40,
  );
  emit(
    'node.finished',
    {
      nodeId: EDIT_NODES.llm,
      instanceId: 'step-2',
      output: { finishReason: 'stop', text: 'The most recent signup is Ana Duarte (22 September, 18:04 UTC).' },
      usage: { inputTokens: 1410, outputTokens: 22, inclusive: true },
      durationMs: 512.1,
      status: 'ok',
    },
    510,
  );
  emit(
    'node.finished',
    {
      nodeId: EDIT_NODES.agent,
      instanceId: EDIT_RUN_ID,
      output: { text: 'The most recent signup is Ana Duarte (22 September, 18:04 UTC).' },
      durationMs: 1840,
      status: 'ok',
    },
    20,
  );
  emit('run.finished', { status: 'ok' }, 10);
  return out;
}

export type EditVerdict =
  | { ok: true; after: Record<string, unknown> }
  | { ok: false; code: 'schema' | 'shape' | 'placeholder' | 'truncated'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The fixture's stand-in for the app answering an edited resume — the same
 * order of checks as @graphmind-ai/client (action fits the gate, no marker,
 * top-level merge into the live arguments, then the tool's schema), with
 * value-free messages. `after` is what the app would put on the wire: the
 * merged arguments, with the large `context` shrunk to the same preview the
 * recording carries.
 */
export function simulateEditResume(
  point: 'before' | 'after' | 'error',
  action: string,
  input: unknown,
): EditVerdict {
  const fits = (action === 'continue' && point === 'before') || (action === 'retry' && point !== 'before');
  if (!fits) {
    return {
      ok: false,
      code: 'shape',
      message: 'an edited input needs continue at a before gate, or retry at an after or error gate',
    };
  }
  const json = JSON.stringify(input) ?? '';
  if (json.includes('__REDACTED__')) {
    return { ok: false, code: 'placeholder', message: 'the value contains redacted content; replace it before running' };
  }
  if (json.includes('__graphmindTruncated') || json.includes(TRUNCATION_SUFFIX)) {
    return { ok: false, code: 'truncated', message: 'the value contains a truncated preview; replace it before running' };
  }
  if (!isRecord(input)) {
    return { ok: false, code: 'shape', message: 'the edited arguments must be a JSON object' };
  }
  const merged: Record<string, unknown> = { ...EDIT_LIVE_ARGS, ...input };
  if (typeof merged['query'] !== 'string' || merged['query'].trim() === '') {
    return { ok: false, code: 'schema', message: 'query: expected a non-empty string' };
  }
  const limit = merged['limit'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > EDIT_MAX_LIMIT) {
    return { ok: false, code: 'schema', message: `limit: must be an integer from 1 to ${EDIT_MAX_LIMIT}` };
  }
  const after = { ...merged };
  if (after['context'] === EDIT_LIVE_ARGS.context) after['context'] = EDIT_RECORDED_ARGS.context;
  return { ok: true, after };
}
