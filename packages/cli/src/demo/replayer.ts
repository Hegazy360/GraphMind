/**
 * The demo replayer: replays the bundled fixture through the REAL ingest
 * pipeline. It is a faithful fake app client — it dials `WS /ingest`, does
 * the `hello` -> `hello.ack` handshake (announcing `source: 'demo'` so the
 * run is registered as a recorded session), streams the captured envelopes
 * with their recorded pacing, and HONORS the control protocol:
 *
 *  - The planted bug genuinely pauses: when the recorded `exec.paused` is
 *    reached and an armed breakpoint matches (the server default-arms
 *    `{point:'error'}`, delivered via `hello.ack` and kept current from
 *    relayed `breakpoint.set`/`breakpoint.clear`), the replayer emits
 *    `exec.paused` and stops streaming until a real `exec.resume` arrives.
 *  - Resume actions map to the pre-recorded branches:
 *      continue -> the captured error propagation (error ending)
 *      inject   -> the captured fixed-path continuation, with the debugger's
 *                  own `output` substituted into the injected result
 *      retry    -> re-plays the captured failing segment (fresh instance,
 *                  fresh pause)
 *      abort    -> synthesized aborted ending
 *  - If no armed breakpoint matches the recorded pause (the user cleared the
 *    error chip), the pause is skipped and the error propagates — exactly
 *    what a real client would do.
 *
 * Envelopes are re-minted on the way out: fresh runId per replay, a fresh
 * monotonically-increasing seq, and wall-clock `ts` (the recording only
 * contributes relative timing, scaled by `speed` and clamped to `maxGapMs`).
 */
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  WILDCARD_RUN_ID,
  parseEnvelopeJson,
  type BreakpointMatcher,
} from '@graphmind-ai/schema';
import WebSocket from 'ws';
import { VERSION } from '../version.js';
import type { DemoFixture, DemoFixtureEvent } from './fixture.js';
import { loadBundledFixture } from './fixture.js';

export type DemoReplayOutcome = 'finished' | 'stopped' | 'failed';

export interface DemoReplayOptions {
  /** Ingest endpoint, e.g. `ws://127.0.0.1:4747/ingest`. */
  url: string;
  /** Fixture override (tests). Default: the bundled one. */
  fixture?: DemoFixture;
  /** Playback speed multiplier. 1 = recorded pacing. Default 1. */
  speed?: number;
  /** Clamp recorded gaps so long pauses still demo well. Default 1200ms. */
  maxGapMs?: number;
  /** Run id override (tests). Default `demo-<random>`. */
  runId?: string;
  /** Log sink. Default: silent. */
  log?: (message: string) => void;
}

export interface DemoReplay {
  readonly runId: string;
  /** True once the replay reached a terminal state (any outcome). */
  readonly finished: boolean;
  /** True while holding at a pause waiting for `exec.resume`. */
  readonly paused: boolean;
  /** Resolves on the terminal state. Never rejects. */
  readonly done: Promise<DemoReplayOutcome>;
  /** Abort the replay and close the socket. Idempotent. */
  stop(): void;
}

const WS_OPEN = 1;
const HELLO_TIMEOUT_MS = 3000;
/** Small settle delay after the last envelope before closing the socket. */
const FLUSH_MS = 120;

interface NodeIdentity {
  kind: string;
  name: string;
  instanceId: string;
}

function matcherArms(
  matchers: readonly BreakpointMatcher[],
  node: { kind: string; name: string },
  point: string,
): boolean {
  return matchers.some(
    (m) =>
      (m.point ?? 'before') === point &&
      (m.kind === undefined || m.kind === node.kind) &&
      (m.name === undefined || m.name === node.name),
  );
}

class Replayer implements DemoReplay {
  readonly runId: string;
  readonly done: Promise<DemoReplayOutcome>;

  private readonly ws: WebSocket;
  private readonly fixture: DemoFixture;
  private readonly speed: number;
  private readonly maxGapMs: number;
  private readonly log: (message: string) => void;

  private seq = 0;
  private outcome: DemoReplayOutcome | undefined;
  private resolveDone!: (outcome: DemoReplayOutcome) => void;
  private breakpoints: BreakpointMatcher[] = [];
  private currentPauseId: string | undefined;
  private pauseSerial = 0;
  private retrySerial = 0;
  /** Wakes the pacing sleep early on stop(). */
  private wake: (() => void) | undefined;
  /** Identity of the failing node (kind/name for matching, instance for retry). */
  private readonly failingNode: NodeIdentity;
  private readonly agentNodeId: string | undefined;

  constructor(options: DemoReplayOptions, fixture: DemoFixture) {
    this.fixture = fixture;
    this.speed = options.speed !== undefined && options.speed > 0 ? options.speed : 1;
    this.maxGapMs = options.maxGapMs ?? 1200;
    this.log = options.log ?? (() => {});
    this.runId = options.runId ?? `demo-${randomBytes(4).toString('hex')}`;
    this.done = new Promise<DemoReplayOutcome>((resolve) => {
      this.resolveDone = resolve;
    });

    const started = fixture.base[fixture.pause.failingSegmentStart] as DemoFixtureEvent;
    this.failingNode = {
      kind: typeof started.payload['kind'] === 'string' ? (started.payload['kind'] as string) : 'tool',
      name: typeof started.payload['name'] === 'string' ? (started.payload['name'] as string) : '',
      instanceId:
        typeof started.payload['instanceId'] === 'string'
          ? (started.payload['instanceId'] as string)
          : 'demo-instance',
    };
    this.agentNodeId = fixture.base.find(
      (e) => e.type === 'node.started' && e.payload['kind'] === 'agent',
    )?.payload['nodeId'] as string | undefined;

    this.ws = new WebSocket(options.url);
    this.ws.on('error', (error) => this.fail(`socket error (${String(error)})`));
    this.ws.on('close', () => {
      if (this.outcome === undefined) this.finish('stopped');
    });
    this.ws.on('message', (data) => this.onFrame(String(data)));
    this.ws.on('open', () => this.sendHello());

    const helloTimer = setTimeout(() => {
      if (this.outcome === undefined && !this.helloAcked) {
        this.fail('server did not answer hello in time');
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();
  }

  get finished(): boolean {
    return this.outcome !== undefined;
  }

  get paused(): boolean {
    return this.currentPauseId !== undefined;
  }

  stop(): void {
    if (this.outcome === undefined) this.finish('stopped');
  }

  // -- wire ----------------------------------------------------------------

  private helloAcked = false;

  private sendHello(): void {
    this.sendRaw({
      gm: PROTOCOL_VERSION,
      seq: this.seq++,
      ts: Date.now(),
      runId: WILDCARD_RUN_ID,
      type: 'hello',
      payload: {
        versions: { protocol: PROTOCOL_VERSION, client: `demo-replayer/${VERSION}` },
        capabilities: ['pause', 'inject', 'retry', 'abort'],
        app: this.fixture.app,
        // Loose-schema extension read by the hub: registers runs as 'demo'.
        source: 'demo',
      },
    });
  }

  private onFrame(text: string): void {
    const result = parseEnvelopeJson(text);
    if (result.kind !== 'ok') return;
    const envelope = result.envelope;
    switch (envelope.type) {
      case 'hello.ack': {
        if (this.helloAcked) return;
        this.helloAcked = true;
        this.breakpoints = [...envelope.payload.breakpoints];
        void this.playBase();
        return;
      }
      case 'breakpoint.set':
        this.breakpoints = [...this.breakpoints, envelope.payload.matcher];
        return;
      case 'breakpoint.clear': {
        const key = JSON.stringify(envelope.payload.matcher);
        this.breakpoints = this.breakpoints.filter((m) => JSON.stringify(m) !== key);
        return;
      }
      case 'exec.resume': {
        if (envelope.runId !== this.runId) return;
        const { pauseId, action } = envelope.payload;
        if (this.currentPauseId === undefined || pauseId !== this.currentPauseId) return;
        this.currentPauseId = undefined;
        void this.handleResume(action, envelope.payload.output);
        return;
      }
      default:
        return; // mode.set etc. — nothing a recording can honor
    }
  }

  private sendRaw(frame: unknown): void {
    if (this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (error) {
      this.fail(`failed to send frame (${String(error)})`);
    }
  }

  /** Re-mint a recorded event onto the wire: fresh runId/seq/ts. */
  private emit(type: string, payload: Record<string, unknown>): void {
    this.sendRaw({
      gm: PROTOCOL_VERSION,
      seq: this.seq++,
      ts: Date.now(),
      runId: this.runId,
      type,
      payload,
    });
  }

  // -- playback ------------------------------------------------------------

  private sleep(recordedMs: number): Promise<void> {
    const ms = Math.min(Math.max(recordedMs, 0), this.maxGapMs) / this.speed;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }

  private async playBase(): Promise<void> {
    const { base } = this.fixture;
    for (let i = 0; i < base.length; i += 1) {
      if (this.outcome !== undefined) return;
      const event = base[i] as DemoFixtureEvent;
      await this.sleep(event.dt);
      if (this.outcome !== undefined) return;
      if (event.type === 'exec.paused') {
        // Base always ends at the recorded pause — honor the CURRENT debug
        // state, exactly like a real client's gate engine would.
        if (matcherArms(this.breakpoints, this.failingNode, this.fixture.pause.point)) {
          this.holdAtPause();
        } else {
          this.log('demo: no error breakpoint armed — letting the error propagate');
          await this.playBranch(this.fixture.cont);
        }
        return;
      }
      this.emit(event.type, event.payload);
    }
    // A fixture whose base does not end in exec.paused never parses, so this
    // is unreachable — kept for safety.
    this.finish('finished');
  }

  private holdAtPause(): void {
    this.pauseSerial += 1;
    const pauseId = `demo-pause-${this.pauseSerial}`;
    this.currentPauseId = pauseId;
    this.emit('exec.paused', {
      pauseId,
      nodeId: this.fixture.pause.nodeId,
      point: this.fixture.pause.point,
    });
    this.log(`demo: paused at ${this.fixture.pause.nodeId} — resume from the viewer`);
  }

  private async handleResume(action: string, output: unknown): Promise<void> {
    if (this.outcome !== undefined) return;
    this.emit('exec.resumed', { pauseId: `demo-pause-${this.pauseSerial}`, action });
    this.log(`demo: resumed (${action})`);
    switch (action) {
      case 'inject':
        await this.playBranch(this.fixture.inject, output);
        return;
      case 'retry':
        await this.playRetrySegment();
        return;
      case 'abort':
        this.playAbortEnding();
        return;
      default: // 'continue'
        await this.playBranch(this.fixture.cont);
    }
  }

  /**
   * Play a captured continuation. For the inject branch, the debugger's own
   * `output` (when provided) replaces the recorded injected result on the
   * failing node's `node.finished`.
   */
  private async playBranch(events: readonly DemoFixtureEvent[], injectOutput?: unknown): Promise<void> {
    let patched = false;
    for (const event of events) {
      if (this.outcome !== undefined) return;
      await this.sleep(event.dt);
      if (this.outcome !== undefined) return;
      let payload = event.payload;
      if (
        !patched &&
        injectOutput !== undefined &&
        event.type === 'node.finished' &&
        payload['nodeId'] === this.fixture.pause.nodeId
      ) {
        payload = { ...payload, output: injectOutput, injected: true };
        patched = true;
      }
      this.emit(event.type, payload);
    }
    await this.settleAndFinish();
  }

  /** `retry`: re-play the captured failing segment as a fresh execution. */
  private async playRetrySegment(): Promise<void> {
    this.retrySerial += 1;
    const freshInstance = `${this.failingNode.instanceId}#retry${this.retrySerial}`;
    const { base, pause } = this.fixture;
    for (let i = pause.failingSegmentStart; i < base.length; i += 1) {
      if (this.outcome !== undefined) return;
      const event = base[i] as DemoFixtureEvent;
      await this.sleep(event.dt);
      if (this.outcome !== undefined) return;
      if (event.type === 'exec.paused') {
        // Same bug, same result: honor the (possibly changed) debug state.
        if (matcherArms(this.breakpoints, this.failingNode, pause.point)) {
          this.holdAtPause();
        } else {
          await this.playBranch(this.fixture.cont);
        }
        return;
      }
      let payload = event.payload;
      if (payload['nodeId'] === pause.nodeId && typeof payload['instanceId'] === 'string') {
        payload = { ...payload, instanceId: freshInstance };
      }
      this.emit(event.type, payload);
    }
  }

  /** `abort`: synthesized ending (the recording has no aborted take). */
  private playAbortEnding(): void {
    if (this.outcome !== undefined) return;
    this.emit('node.finished', {
      nodeId: this.fixture.pause.nodeId,
      instanceId: this.failingNode.instanceId,
      output: null,
      durationMs: 0,
      status: 'aborted',
    });
    if (this.agentNodeId !== undefined) {
      this.emit('node.finished', {
        nodeId: this.agentNodeId,
        output: null,
        durationMs: 0,
        status: 'aborted',
      });
    }
    this.emit('run.finished', {
      status: 'aborted',
      error: { name: 'AbortError', message: 'aborted from the debugger' },
    });
    void this.settleAndFinish();
  }

  private async settleAndFinish(): Promise<void> {
    if (this.outcome !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
    this.finish('finished');
  }

  // -- teardown ------------------------------------------------------------

  private fail(reason: string): void {
    if (this.outcome !== undefined) return;
    this.log(`demo: replay failed — ${reason}`);
    this.finish('failed');
  }

  private finish(outcome: DemoReplayOutcome): void {
    if (this.outcome !== undefined) return;
    this.outcome = outcome;
    this.currentPauseId = undefined;
    this.wake?.();
    try {
      this.ws.close();
    } catch {
      this.ws.terminate();
    }
    this.resolveDone(outcome);
  }
}

/** Start a demo replay against a running server's ingest endpoint. */
export function startDemoReplay(options: DemoReplayOptions, fixture: DemoFixture): DemoReplay {
  return new Replayer(options, fixture);
}

/** Start a demo replay using the bundled fixture. */
export async function startBundledDemoReplay(
  options: Omit<DemoReplayOptions, 'fixture'>,
): Promise<DemoReplay> {
  const fixture = await loadBundledFixture();
  return new Replayer(options, fixture);
}
