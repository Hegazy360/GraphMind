/**
 * The bundled demo fixture: a real trip-planner run (examples/demo-agent,
 * mock mode) captured through a real server, stored as NDJSON.
 *
 * Format — one JSON object per line. Every line is a valid @graphmind-ai/schema
 * envelope (the schema is loose, so the two extra bookkeeping fields ride
 * along on the wire shape without breaking validation):
 *
 *   { gm, seq, ts, runId, type, payload, branch, dt }
 *
 *   - `branch`  which stream segment the event belongs to:
 *       'base'      everything up to (and including) the recorded
 *                   `exec.paused` at the planted bug
 *       'inject'    the captured continuation after the debugger injected a
 *                   corrected result (happy ending)
 *       'continue'  the captured continuation after the debugger let the
 *                   error propagate (error ending)
 *   - `dt`      milliseconds since the previous event of the same branch
 *               (first event of each branch: ms since the branch point).
 *
 * The replayer (replayer.ts) re-mints runId/seq/ts on the way out; the
 * recorded values are kept for provenance and for `dt`-independent tooling.
 * Regenerate with `pnpm gen:fixture` in examples/demo-agent (see the
 * generator script there for the capture procedure).
 */
import { parseEnvelope } from '@graphmind-ai/schema';

/** Which stream segment a fixture event belongs to. */
export type DemoBranch = 'base' | 'inject' | 'continue';

/** One recorded envelope plus replay bookkeeping. */
export interface DemoFixtureEvent {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  branch: DemoBranch;
  /** Milliseconds since the previous event of the same branch. */
  dt: number;
}

export interface DemoFixture {
  /** The recorded run id (the replayer mints a fresh one per replay). */
  runId: string;
  /** App name announced in the recorded `run.started`. */
  app: string;
  /** Everything up to and including the recorded `exec.paused`. */
  base: DemoFixtureEvent[];
  /** Continuation when the pause is resolved with `inject`. */
  inject: DemoFixtureEvent[];
  /** Continuation when the pause is resolved with `continue` (and the
   * fallback when no error breakpoint is armed at the pause point). */
  cont: DemoFixtureEvent[];
  /** The recorded pause: which node, and where the failing segment starts. */
  pause: {
    nodeId: string;
    point: string;
    /** Index into `base` of the failing node's `node.started` (the segment
     * `graphmind demo` re-plays when the debugger picks `retry`). */
    failingSegmentStart: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse (and validate) a demo fixture from NDJSON. Throws with a descriptive
 * message on any malformed line — the fixture is a build artifact, so a
 * failure here means the bundle is broken, not user error.
 */
export function parseDemoFixture(ndjson: string): DemoFixture {
  const lines = ndjson.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error('demo fixture: empty');

  const base: DemoFixtureEvent[] = [];
  const inject: DemoFixtureEvent[] = [];
  const cont: DemoFixtureEvent[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    let value: unknown;
    try {
      value = JSON.parse(lines[i] as string);
    } catch {
      throw new Error(`demo fixture line ${lineNo}: not valid JSON`);
    }
    const result = parseEnvelope(value);
    if (result.kind !== 'ok') {
      const detail = result.kind === 'invalid' ? `: ${result.reason}` : ` (${result.kind})`;
      throw new Error(`demo fixture line ${lineNo}: invalid envelope${detail}`);
    }
    if (!isRecord(value)) throw new Error(`demo fixture line ${lineNo}: not an object`);
    const branch = value['branch'];
    if (branch !== 'base' && branch !== 'inject' && branch !== 'continue') {
      throw new Error(`demo fixture line ${lineNo}: missing/invalid "branch"`);
    }
    const dt = value['dt'];
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) {
      throw new Error(`demo fixture line ${lineNo}: missing/invalid "dt"`);
    }
    const envelope = result.envelope;
    const event: DemoFixtureEvent = {
      gm: envelope.gm,
      seq: envelope.seq,
      ts: envelope.ts,
      runId: envelope.runId,
      type: envelope.type,
      payload: envelope.payload as Record<string, unknown>,
      branch,
      dt,
    };
    if (branch === 'base') base.push(event);
    else if (branch === 'inject') inject.push(event);
    else cont.push(event);
  }

  const first = base[0];
  const last = base[base.length - 1];
  if (first === undefined || first.type !== 'run.started') {
    throw new Error('demo fixture: base must start with run.started');
  }
  if (last === undefined || last.type !== 'exec.paused') {
    throw new Error('demo fixture: base must end with exec.paused');
  }
  if (inject.length === 0 || cont.length === 0) {
    throw new Error('demo fixture: both continuation branches are required');
  }
  const pausedNodeId = last.payload['nodeId'];
  const point = last.payload['point'];
  if (typeof pausedNodeId !== 'string' || typeof point !== 'string') {
    throw new Error('demo fixture: exec.paused payload is malformed');
  }
  let failingSegmentStart = -1;
  for (let i = base.length - 1; i >= 0; i -= 1) {
    const event = base[i] as DemoFixtureEvent;
    if (event.type === 'node.started' && event.payload['nodeId'] === pausedNodeId) {
      failingSegmentStart = i;
      break;
    }
  }
  if (failingSegmentStart === -1) {
    throw new Error('demo fixture: paused node has no node.started in base');
  }
  const app = first.payload['app'];

  return {
    runId: first.runId,
    app: typeof app === 'string' ? app : 'demo',
    base,
    inject,
    cont,
    pause: { nodeId: pausedNodeId, point, failingSegmentStart },
  };
}

let cached: DemoFixture | undefined;

/** The bundled fixture, parsed once (lazy import keeps startup untouched). */
export async function loadBundledFixture(): Promise<DemoFixture> {
  if (cached === undefined) {
    const { DEMO_FIXTURE_NDJSON } = await import('./fixture-data.js');
    cached = parseDemoFixture(DEMO_FIXTURE_NDJSON);
  }
  return cached;
}
