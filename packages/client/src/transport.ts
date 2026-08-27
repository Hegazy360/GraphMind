/**
 * WebSocket transport: lazy connect with a hard connect timeout, handshake
 * (`hello` -> `hello.ack`), background retry, and fail-open detach
 * notification. Uses the platform WebSocket (Node >= 22 ships one); an
 * alternative constructor (e.g. the `ws` package) can be injected.
 *
 * The transport never throws into callers: every failure degrades to
 * "detached" plus a rate-limited warning, and a background retry keeps
 * trying every `retryIntervalMs`.
 *
 * Reconnect timing has two regimes, because the two situations are not the
 * same problem:
 *  - **never attached** (no debugger running): retry every `retryIntervalMs`
 *    from the first attempt. Nothing is being lost; being patient is right.
 *  - **lost an established attachment** (a blip): the debugger demonstrably
 *    existed milliseconds ago, and every millisecond dark is events pushed
 *    through a finite ring buffer. Retry fast first — `FAST_RETRY_STEPS` —
 *    then fall back to `retryIntervalMs` once the burst is spent.
 * Each fast step is clamped to `retryIntervalMs`, so a caller that asks for a
 * shorter interval than the burst still gets exactly what it asked for.
 */
import {
  PROTOCOL_VERSION,
  parseEnvelopeJson,
  type KnownEnvelope,
  type MessagePayloadMap,
} from '@graphmind-ai/schema';
import type { RateLimitedWarner } from './safe.js';

/** Minimal structural WebSocket contract (browser-style API). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface TransportOptions {
  url: string;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
  retryIntervalMs: number;
  webSocket: WebSocketConstructor | undefined;
  warner: RateLimitedWarner;
}

export interface TransportHooks {
  /** Serialized `hello` envelope for this connection attempt. */
  buildHello(): string;
  /** Handshake completed; the viewer's state should be adopted + buffer replayed. */
  onAttached(ack: MessagePayloadMap['hello.ack']): void;
  /** A previously attached connection was lost. Fail-open here. */
  onDetached(): void;
  /** A control envelope arrived while attached. */
  onControl(envelope: KnownEnvelope): void;
}

type TransportState = 'idle' | 'connecting' | 'attached' | 'disposed';

/**
 * Delays (ms) used for the first reconnect attempts after an *established*
 * attachment drops. 200 + 400 + 800 = 1.4s of eager retrying before the
 * steady-state `retryIntervalMs` takes over, which covers a socket blip
 * (where the debugger is still listening) without busy-looping against a
 * debugger that has really gone away.
 */
export const FAST_RETRY_STEPS: readonly number[] = [200, 400, 800];

function coerceFrameText(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return undefined;
}

export class Transport {
  private state: TransportState = 'idle';
  private started = false;
  private ws: WebSocketLike | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  /** Index into FAST_RETRY_STEPS; >= length means "use retryIntervalMs". */
  private fastRetryStep = FAST_RETRY_STEPS.length;

  constructor(
    private readonly options: TransportOptions,
    private readonly hooks: TransportHooks,
  ) {}

  get attached(): boolean {
    return this.state === 'attached';
  }

  /** Begin connecting (idempotent). Called lazily on first session use. */
  start(): void {
    if (this.started || this.state === 'disposed') return;
    this.started = true;
    this.connect();
  }

  /**
   * Force a connection attempt right now: lazily start if never started,
   * or short-circuit a pending retry backoff after a failure/disconnect.
   * No-op while connecting, attached, or disposed. Used by `session.ready()`
   * so an explicit attach wait never sits out a long retry interval.
   */
  kick(): void {
    if (this.state === 'disposed') return;
    if (!this.started) {
      this.start();
      return;
    }
    if (this.state !== 'idle') return;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.connect();
  }

  /** Send a frame if attached. Returns false (and degrades) otherwise. */
  send(json: string): boolean {
    if (this.state !== 'attached' || this.ws === undefined) return false;
    try {
      this.ws.send(json);
      return true;
    } catch (error) {
      this.options.warner.warn('transport-send', 'failed to send frame to viewer', error);
      this.handleClose(this.ws);
      return false;
    }
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.clearTimers();
    const ws = this.ws;
    this.ws = undefined;
    if (ws !== undefined) {
      try {
        ws.close(1000, 'session disposed');
      } catch {
        // ignore: dispose must never throw
      }
    }
  }

  private connect(): void {
    if (this.state === 'disposed' || this.state === 'connecting' || this.state === 'attached') {
      return;
    }
    const Ctor = this.options.webSocket;
    if (Ctor === undefined) {
      this.options.warner.warn(
        'transport-no-impl',
        'no WebSocket implementation available (need Node >= 22 or pass options.webSocket); GraphMind stays detached',
      );
      return; // retrying cannot help
    }
    this.state = 'connecting';
    let ws: WebSocketLike;
    try {
      ws = new Ctor(this.options.url);
    } catch (error) {
      this.options.warner.warn('transport-connect', 'failed to open WebSocket', error);
      this.state = 'idle';
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    this.openTimer = setTimeout(() => {
      this.options.warner.warn(
        'transport-timeout',
        `viewer did not accept the connection within ${this.options.connectTimeoutMs}ms; staying detached`,
      );
      this.abandon(ws);
    }, this.options.connectTimeoutMs);
    this.openTimer.unref?.();

    ws.addEventListener('open', () => {
      if (ws !== this.ws || this.state !== 'connecting') return;
      if (this.openTimer !== undefined) clearTimeout(this.openTimer);
      this.openTimer = undefined;
      try {
        ws.send(this.hooks.buildHello());
      } catch (error) {
        this.options.warner.warn('transport-hello', 'failed to send handshake', error);
        this.abandon(ws);
        return;
      }
      this.ackTimer = setTimeout(() => {
        this.options.warner.warn(
          'transport-ack-timeout',
          `viewer did not complete the handshake within ${this.options.handshakeTimeoutMs}ms; staying detached`,
        );
        this.abandon(ws);
      }, this.options.handshakeTimeoutMs);
      this.ackTimer.unref?.();
    });

    ws.addEventListener('message', (event: { data?: unknown }) => {
      this.handleMessage(ws, event?.data);
    });
    ws.addEventListener('close', () => this.handleClose(ws));
    ws.addEventListener('error', () => this.handleClose(ws));
  }

  private handleMessage(ws: WebSocketLike, data: unknown): void {
    if (ws !== this.ws || this.state === 'disposed') return;
    const text = coerceFrameText(data);
    if (text === undefined) return;

    const result = parseEnvelopeJson(text);
    if (result.kind === 'version-mismatch') {
      this.options.warner.warn(
        'transport-version',
        `viewer speaks protocol v${result.received}, this client speaks v${result.supported}; staying detached`,
      );
      this.abandon(ws);
      return;
    }
    if (result.kind === 'invalid') {
      this.options.warner.warn('transport-invalid', `ignoring invalid frame: ${result.reason}`);
      return;
    }
    if (result.kind === 'unknown-type') {
      return; // forward compatibility: tolerate silently
    }

    const envelope = result.envelope;
    if (this.state === 'connecting') {
      if (envelope.type !== 'hello.ack') return; // ignore anything pre-ack
      if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
      if (envelope.payload.versions.protocol !== PROTOCOL_VERSION) {
        this.options.warner.warn(
          'transport-version',
          `viewer acked protocol v${envelope.payload.versions.protocol}, this client speaks v${PROTOCOL_VERSION}; staying detached`,
        );
        this.abandon(ws);
        return;
      }
      this.state = 'attached';
      this.hooks.onAttached(envelope.payload);
      return;
    }
    if (this.state === 'attached') {
      this.hooks.onControl(envelope);
    }
  }

  /** Give up on a live (or half-open) socket and fall back to retry. */
  private abandon(ws: WebSocketLike): void {
    try {
      ws.close();
    } catch {
      // ignore
    }
    // Some implementations fire `close` asynchronously (or not at all when
    // closed pre-open); normalize by handling it now. handleClose is
    // idempotent per socket.
    this.handleClose(ws);
  }

  private handleClose(ws: WebSocketLike): void {
    if (ws !== this.ws || this.state === 'disposed') return;
    const wasAttached = this.state === 'attached';
    this.clearAttemptTimers();
    this.ws = undefined;
    this.state = 'idle';
    // Losing a live attachment arms the fast-reconnect burst: the debugger
    // was there a moment ago, and everything emitted meanwhile is eating the
    // ring buffer. A connection that never attached keeps the calm interval.
    if (wasAttached) {
      this.fastRetryStep = 0;
      this.hooks.onDetached();
    }
    this.scheduleRetry();
  }

  /** Next backoff delay, consuming one fast step if the burst is armed. */
  private nextRetryDelay(): number {
    const step = FAST_RETRY_STEPS[this.fastRetryStep];
    if (step === undefined) return this.options.retryIntervalMs;
    this.fastRetryStep += 1;
    return Math.min(step, this.options.retryIntervalMs);
  }

  private scheduleRetry(): void {
    if (this.state === 'disposed' || !this.started || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, this.nextRetryDelay());
    this.retryTimer.unref?.();
  }

  private clearAttemptTimers(): void {
    if (this.openTimer !== undefined) clearTimeout(this.openTimer);
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
    this.openTimer = undefined;
    this.ackTimer = undefined;
  }

  private clearTimers(): void {
    this.clearAttemptTimers();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
