/**
 * Newline framing for MCP's stdio transport, done byte-faithfully.
 *
 * The whole value of the proxy rests on being invisible, so this framer never
 * reconstructs a frame: it hands back the EXACT bytes that sat between two
 * `\n` terminators. Callers relay `frame + "\n"`, which reproduces the input
 * stream verbatim (a `\r` before the newline is part of the frame bytes and
 * survives untouched, unlike the SDK's ReadBuffer which strips it).
 *
 * Chunks are kept as a list and only concatenated when a frame actually
 * completes, so a 10 MB payload arriving in 64 KB reads costs one copy rather
 * than 160 progressively larger ones.
 *
 * Overflow is reported, never thrown: a payload larger than `maxBytes` makes
 * the relay fall back to a dumb byte pipe (see relay.ts). A debugger that
 * breaks the thing it debugs is worthless, so the only acceptable failure
 * mode is "stop observing, keep relaying".
 */

const EMPTY: Buffer = Buffer.alloc(0);

export interface FramerResult {
  /** Completed frames, in order, WITHOUT their `\n` terminator. */
  frames: Buffer[];
  /** The incomplete tail now exceeds `maxBytes`; the caller should degrade. */
  overflowed: boolean;
}

export class LineFramer {
  private chunks: Buffer[] = [];
  private pendingSize = 0;

  constructor(private readonly maxBytes: number) {}

  /** Bytes buffered for the frame currently being assembled. */
  get pendingBytes(): number {
    return this.pendingSize;
  }

  append(chunk: Buffer): FramerResult {
    const frames: Buffer[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) break;
      const piece = chunk.subarray(start, nl);
      if (this.chunks.length === 0) {
        frames.push(piece);
      } else {
        this.chunks.push(piece);
        frames.push(Buffer.concat(this.chunks));
        this.chunks = [];
      }
      this.pendingSize = 0;
      start = nl + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.chunks.push(rest);
      this.pendingSize += rest.length;
    }
    return { frames, overflowed: this.pendingSize > this.maxBytes };
  }

  /** Take (and forget) the incomplete tail — used when degrading or at EOF. */
  takePending(): Buffer {
    if (this.chunks.length === 0) return EMPTY;
    const out = this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks);
    this.chunks = [];
    this.pendingSize = 0;
    return out;
  }
}
