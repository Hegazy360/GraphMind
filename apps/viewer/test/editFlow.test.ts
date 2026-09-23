/**
 * The whole edit loop in the store, without a browser: the `edit` fixture
 * holds `run_sql` at an editable error gate; the editor's plan goes out
 * through `editAndResume`; the fixture answers like the app — a refusal that
 * keeps the gate held and is matched to its request by requestId, then an
 * accepted edit that releases the gate and marks the instance edited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureConnection } from '../src/connection/FixtureConnection.js';
import { registerConnection } from '../src/connection/ServerConnection.js';
import { answerFor, editPrefill, heldExecution, latestRefusal, planEdit, refusalText, type PendingEdit } from '../src/lib/editArgs.js';
import { editAndResume } from '../src/lib/gate.js';
import { EDIT_NODES, EDIT_PAUSE_ID, EDIT_RECORDED_ARGS, EDIT_RUN_ID } from '../src/store/editFixture.js';
import { useRunStore } from '../src/store/runStore.js';

let unregister: (() => void) | undefined;
let conn: FixtureConnection | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  useRunStore.setState({ runs: {} });
});

afterEach(() => {
  conn?.dispose();
  unregister?.();
  vi.useRealTimers();
});

function held() {
  const run = useRunStore.getState().runs[EDIT_RUN_ID];
  const pause = run?.pauses[EDIT_PAUSE_ID];
  const node = run?.nodes[EDIT_NODES.sql];
  if (run === undefined || pause === undefined || node === undefined) throw new Error('not held yet');
  return { run, pause, node };
}

async function startHeld(): Promise<void> {
  conn = new FixtureConnection('edit');
  unregister = registerConnection(conn);
  conn.start();
  for (let i = 0; i < 40 && useRunStore.getState().runs[EDIT_RUN_ID]?.pauses[EDIT_PAUSE_ID] === undefined; i++) {
    await vi.advanceTimersByTimeAsync(500);
  }
}

function send(draft: string): PendingEdit {
  const { pause, node } = held();
  const plan = planEdit(heldExecution(node, pause)?.input, draft);
  if (plan.payload === undefined) throw new Error(`nothing to send: ${JSON.stringify(plan)}`);
  const requestId = `req-${Math.random().toString(16).slice(2)}`;
  const pending: PendingEdit = {
    runId: EDIT_RUN_ID,
    pauseId: pause.pauseId,
    requestId,
    sentAt: Date.now(),
    lastRefusalSeq: latestRefusal(pause)?.seq ?? -1,
  };
  expect(editAndResume(EDIT_RUN_ID, pause, plan.payload, requestId)).toEqual({ ok: true });
  return pending;
}

describe('edit arguments against the fixture app', () => {
  it('refused, fixed, retried: the gate stays held until the edit is accepted, then the call is marked edited', async () => {
    await startHeld();
    const { pause, node } = held();
    expect(pause.active).toBe(true);
    expect(pause.editable).toBe(true);
    expect(pause.point).toBe('error');

    const prefill = editPrefill(heldExecution(node, pause)?.input);
    expect(prefill.ok).toBe(true);
    if (!prefill.ok) return;

    // 1. Too big a limit: the tool's schema refuses; the gate is still held.
    const first = send(JSON.stringify({ ...EDIT_RECORDED_ARGS, limit: 500 }));
    const afterRefusal = held();
    expect(afterRefusal.pause.active).toBe(true);
    const answer = answerFor(afterRefusal.pause, first);
    expect(answer.state).toBe('refused');
    if (answer.state !== 'refused') return;
    expect(answer.refusal).toMatchObject({ code: 'schema', requestId: first.requestId });
    expect(refusalText(answer.refusal.code, answer.refusal.message)).toBe(
      "The tool's schema rejected this: limit: must be an integer from 1 to 100",
    );

    // 2. Fixed: the query and the limit. Only those two keys travel.
    const second = send(JSON.stringify({ ...EDIT_RECORDED_ARGS, query: 'SELECT name FROM users', limit: 50 }));
    const { run } = held();
    const released = run.pauses[EDIT_PAUSE_ID];
    expect(released?.active).toBe(false);
    expect(released?.resolvedAction).toBe('retry');
    expect(released?.resolvedRequestId).toBe(second.requestId);
    expect(answerFor(released ?? pause, second).state).toBe('resolved');
    const exec = run.nodes[EDIT_NODES.sql]?.executions[0];
    expect(exec?.input).toEqual(EDIT_RECORDED_ARGS);
    expect(exec?.edited?.after).toMatchObject({ query: 'SELECT name FROM users', limit: 50, database: 'analytics' });

    // 3. The recorded continuation plays out: the retry succeeds.
    await vi.advanceTimersByTimeAsync(3_000);
    const done = useRunStore.getState().runs[EDIT_RUN_ID];
    expect(done?.nodes[EDIT_NODES.sql]?.executions[0]?.status).toBe('ok');
    expect(done?.meta.status).toBe('ok');
  });

  it('a pause from a fixture that cannot edit refuses the edit as unsupported, gate still held', async () => {
    conn = new FixtureConnection('loop');
    unregister = registerConnection(conn);
    conn.start();
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(500);
    const run = Object.values(useRunStore.getState().runs)[0];
    const pause = run === undefined ? undefined : Object.values(run.pauses).find((p) => p.active);
    if (run === undefined || pause === undefined) throw new Error('loop fixture did not hold');
    editAndResume(run.runId, pause, { from: 'AMS' }, 'req-x');
    const after = useRunStore.getState().runs[run.runId]?.pauses[pause.pauseId];
    expect(after?.active).toBe(true);
    expect(after?.refusals?.[0]).toMatchObject({ code: 'unsupported', requestId: 'req-x' });
  });
});
