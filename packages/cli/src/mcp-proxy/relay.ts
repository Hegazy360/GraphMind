/**
 * One direction of the pipe: read frames from `source`, let an interceptor
 * look at (and optionally hold, replace or drop) each one, write to `sink`.
 *
 * Three properties matter more than anything else here:
 *
 *  1. **Order.** Everything — frames, and raw bytes in degraded mode — goes
 *     through a single FIFO queue drained by one pump. While a frame is held
 *     at a gate the source is paused, so the frames behind it queue rather
 *     than overtaking it: a held request means execution is stopped, and the
 *     server must not see frame N+1 before frame N.
 *  2. **Bytes.** A forwarded frame is written back exactly as it arrived
 *     (`raw + "\n"`). Nothing is re-serialized, so key order, number
 *     formatting, unicode escaping and stray `\r`s all survive.
 *  3. **Fail-open.** If the interceptor throws, the frame is forwarded
 *     unchanged. If a frame grows past `maxFrameBytes`, the relay stops
 *     framing and becomes a dumb byte pipe for the rest of the stream —
 *     observation is lost, the session is not.
 */
import type { Readable } from 'node:stream';
import { LineFramer } from './framing.js';
import type { FrameWriter } from './writer.js';

export type FrameAction =
  /** Relay the original bytes verbatim. */
  | { kind: 'forward' }
  /** Relay these bytes instead (injected/rewritten response). */
  | { kind: 'replace'; raw: Buffer }
  /** Do not relay anything (the interceptor already answered the sender). */
  | { kind: 'drop' };

export const FORWARD: FrameAction = Object.freeze({ kind: 'forward' });

export type FrameInterceptor = (raw: Buffer) => Promise<FrameAction>;

/** Queue item: a complete JSON-RPC frame, or opaque bytes to pass through. */
type QueueItem = { kind: 'frame'; data: Buffer } | { kind: 'raw'; data: Buffer };

export interface RelayOptions {
  source: Readable;
  sink: FrameWriter;
  intercept: FrameInterceptor;
  /** Frame-assembly ceiling before degrading to raw passthrough. */
  maxFrameBytes: number;
  /** Called once if the relay degrades; diagnostics only. */
  onDegrade?: (pendingBytes: number) => void;
  /** Called when the interceptor throws; diagnostics only. */
  onInterceptError?: (error: unknown) => void;
}

export class FrameRelay {
  private readonly framer: LineFramer;
  private readonly queue: QueueItem[] = [];
  private pumping = false;
  private degraded = false;
  private sourceEnded = false;
  private settled = false;
  private resolveFinished: (() => void) | undefined;
  private readonly finished: Promise<void>;

  constructor(private readonly options: RelayOptions) {
    this.framer = new LineFramer(options.maxFrameBytes);
    this.finished = new Promise<void>((resolve) => {
      this.resolveFinished = resolve;
    });
    options.source.on('data', (chunk: Buffer | string) => {
      this.onChunk(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    options.source.on('end', () => this.onSourceEnd());
    options.source.on('close', () => this.onSourceEnd());
    // A source that errors (child killed mid-read) is an end, not a crash.
    options.source.on('error', () => this.onSourceEnd());
  }

  /** Resolves once the source ended and every queued byte has been written. */
  whenFinished(): Promise<void> {
    return this.finished;
  }

  /** True once a frame exceeded `maxFrameBytes` and framing was abandoned. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  private onChunk(chunk: Buffer): void {
    if (this.degraded) {
      this.queue.push({ kind: 'raw', data: chunk });
    } else {
      const { frames, overflowed } = this.framer.append(chunk);
      for (const frame of frames) this.queue.push({ kind: 'frame', data: frame });
      if (overflowed) {
        this.degraded = true;
        const pending = this.framer.takePending();
        this.options.onDegrade?.(pending.length);
        if (pending.length > 0) this.queue.push({ kind: 'raw', data: pending });
      }
    }
    if (!this.pumping) void this.pump();
  }

  /**
   * Drain the queue one item at a time. The source stays paused for the whole
   * drain, which is what turns "a gate is held" into "this direction of the
   * conversation is stopped".
   */
  private async pump(): Promise<void> {
    this.pumping = true;
    this.options.source.pause();
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift() as QueueItem;
        if (item.kind === 'raw') await this.options.sink.writeRaw(item.data);
        else await this.relayOne(item.data);
      }
    } finally {
      this.pumping = false;
      if (this.sourceEnded) void this.finish();
      else this.options.source.resume();
    }
  }

  private async relayOne(raw: Buffer): Promise<void> {
    let action: FrameAction = FORWARD;
    try {
      action = await this.options.intercept(raw);
    } catch (error) {
      // The observer failed. The conversation must not.
      this.options.onInterceptError?.(error);
      action = FORWARD;
    }
    if (action.kind === 'drop') return;
    await this.options.sink.writeFrame(action.kind === 'replace' ? action.raw : raw);
  }

  private onSourceEnd(): void {
    if (this.sourceEnded) return;
    this.sourceEnded = true;
    if (this.pumping) return; // the pump's finally calls finish()
    if (this.queue.length > 0) {
      void this.pump();
      return;
    }
    void this.finish();
  }

  private async finish(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    // A trailing fragment with no terminator is not a frame; relay it as-is
    // rather than inventing a newline the sender never wrote.
    const pending = this.framer.takePending();
    if (pending.length > 0) await this.options.sink.writeRaw(pending);
    this.resolveFinished?.();
  }
}
