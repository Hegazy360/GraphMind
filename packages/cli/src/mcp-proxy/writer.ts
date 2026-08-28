/**
 * A serialized, back-pressure-aware writer for one side of the pipe.
 *
 * Everything that can reach a destination stream — relayed frames, injected
 * responses, abort errors, re-sent retries — goes through the same queue, so
 * two writers can never interleave halfway through a frame, and ordering is
 * exactly the order the calls were made.
 *
 * Write errors (EPIPE when the peer has already gone) are swallowed: the
 * proxy must never crash the session it is observing.
 */
import type { Writable } from 'node:stream';

const NEWLINE: Buffer = Buffer.from('\n');

export class FrameWriter {
  private tail: Promise<void> = Promise.resolve();
  private ended = false;
  private failed = false;

  constructor(
    private readonly stream: Writable,
    onError?: (error: Error) => void,
  ) {
    // Without a listener an EPIPE on stdout is an unhandled 'error' event,
    // which kills the process — exactly the "debugger broke my server"
    // failure this proxy exists to avoid. Reported once: a broken pipe often
    // emits repeatedly, and this is a diagnostic, not a log stream.
    stream.on('error', (error: Error) => {
      const first = !this.failed;
      this.failed = true;
      if (first) onError?.(error);
    });
  }

  /** Queue one JSON-RPC frame (the `\n` terminator is added here). */
  writeFrame(raw: Buffer): Promise<void> {
    return this.enqueue(Buffer.concat([raw, NEWLINE]));
  }

  /** Queue raw bytes verbatim (degraded passthrough, EOF tails). */
  writeRaw(raw: Buffer): Promise<void> {
    if (raw.length === 0) return this.tail;
    return this.enqueue(raw);
  }

  /** Close the destination once everything queued has been flushed. */
  end(): Promise<void> {
    if (this.ended) return this.tail;
    this.ended = true;
    this.tail = this.tail.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.failed || this.stream.writableEnded || this.stream.destroyed) return resolve();
          try {
            this.stream.end(() => resolve());
          } catch {
            resolve();
          }
        }),
    );
    return this.tail;
  }

  /** Resolves when every queued write has been flushed. */
  drained(): Promise<void> {
    return this.tail;
  }

  private enqueue(data: Buffer): Promise<void> {
    this.tail = this.tail.then(() => this.writeOne(data));
    return this.tail;
  }

  private writeOne(data: Buffer): Promise<void> {
    return new Promise<void>((resolve) => {
      // NB: deliberately not checking `this.ended` — `end()` is chained after
      // the writes queued before it, but flips the flag synchronously, so
      // testing it here would silently drop those last frames.
      if (this.failed || this.stream.writableEnded || this.stream.destroyed) {
        return resolve();
      }
      try {
        // The callback fires once the chunk is flushed (or errors), which is
        // the back-pressure signal; `write`'s boolean return is redundant here.
        this.stream.write(data, () => resolve());
      } catch {
        this.failed = true;
        resolve();
      }
    });
  }
}
