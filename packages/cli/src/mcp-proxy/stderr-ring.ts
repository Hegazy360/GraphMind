/**
 * A bounded memory of the server's most recent stderr lines.
 *
 * When an MCP server dies before it has answered anything, the only
 * explanation it left is on stderr — and an MCP host either hides that or
 * scrolls it away. The proxy keeps the tail (last 200 lines, at most 32 KB)
 * and prints it with the failure, so "the server exited with code 1" arrives
 * together with the stack trace that says why.
 *
 * Bounded on both axes: a server that logs one enormous line cannot pin
 * megabytes, and one that logs a million short lines cannot either.
 */

export const STDERR_RING_MAX_LINES = 200;
export const STDERR_RING_MAX_BYTES = 32 * 1024;

export class StderrRing {
  private readonly lines: string[] = [];
  private bytes = 0;
  private partial = '';
  private droppedLines = 0;
  private totalLines = 0;

  constructor(
    private readonly maxLines: number = STDERR_RING_MAX_LINES,
    private readonly maxBytes: number = STDERR_RING_MAX_BYTES,
  ) {}

  /** Feed raw stderr bytes; lines are split on `\n` (a trailing `\r` is dropped). */
  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) break;
      this.addLine(this.partial + text.slice(start, nl));
      this.partial = '';
      start = nl + 1;
    }
    if (start < text.length) {
      this.partial += text.slice(start);
      // A line that never ends must not grow without bound either.
      if (this.partial.length > this.maxBytes) {
        this.addLine(this.partial);
        this.partial = '';
      }
    }
  }

  /** Lines received in total, including the ones that have been evicted. */
  get seen(): number {
    return this.totalLines + (this.partial === '' ? 0 : 1);
  }

  /** How many lines were evicted to stay within the bounds. */
  get dropped(): number {
    return this.droppedLines;
  }

  get isEmpty(): boolean {
    return this.lines.length === 0 && this.partial === '';
  }

  /** The retained tail, oldest first, including an unterminated last line. */
  tail(maxLines: number = this.maxLines): string[] {
    const all = this.partial === '' ? this.lines : [...this.lines, this.partial];
    return maxLines >= all.length ? [...all] : all.slice(all.length - maxLines);
  }

  private addLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    this.totalLines += 1;
    // One line larger than the whole budget is kept truncated rather than
    // dropped: it is probably the stack trace we are here for.
    const kept = line.length > this.maxBytes ? `${line.slice(0, this.maxBytes)}…` : line;
    this.lines.push(kept);
    this.bytes += kept.length;
    while (this.lines.length > this.maxLines || (this.bytes > this.maxBytes && this.lines.length > 1)) {
      const evicted = this.lines.shift() as string;
      this.bytes -= evicted.length;
      this.droppedLines += 1;
    }
  }
}
