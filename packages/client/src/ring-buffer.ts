/**
 * Bounded FIFO ring buffer with drop-oldest semantics. Used to retain the
 * most recent events while no viewer is attached, for replay-on-attach.
 *
 * Two independent bounds, both drop-oldest:
 *  - `capacity`  — a hard item count.
 *  - `maxBytes`  — an approximate memory ceiling, measured with `sizeOf`.
 *    Without it a buffer of N slots costs N x the largest payload the host
 *    ever emits, which is unbounded (the 512 KB guard lives in the server,
 *    not here). A single item larger than the whole budget is still kept —
 *    the buffer never evicts down to empty just to satisfy the byte bound,
 *    because a lone huge event is still worth replaying.
 *
 * Every eviction is announced through `onEvict` so the owner can decide what
 * it means: an item that was already delivered is merely forgotten, while an
 * item that never made it to the debugger is *lost data* and must be
 * accounted for (see `session.ts`). `onEvict` must not throw.
 */
export interface RingBufferOptions<T> {
  /** Hard item-count bound. Must be a positive integer. */
  capacity: number;
  /** Approximate byte ceiling for the retained items. Default: unbounded. */
  maxBytes?: number | undefined;
  /** Approximate size of one item, in bytes. Required when `maxBytes` is set. */
  sizeOf?: ((item: T) => number) | undefined;
  /** Called with each evicted item, oldest first. Must not throw. */
  onEvict?: ((item: T) => void) | undefined;
}

export class RingBuffer<T> {
  readonly capacity: number;

  private readonly items: (T | undefined)[];
  private readonly maxBytes: number;
  private readonly sizeOf: (item: T) => number;
  private readonly onEvict: ((item: T) => void) | undefined;

  private start = 0;
  private count = 0;
  private bytes = 0;
  private droppedTotal = 0;

  constructor(options: RingBufferOptions<T>) {
    const { capacity } = options;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    if (options.maxBytes !== undefined && !(options.maxBytes > 0)) {
      throw new RangeError(`RingBuffer maxBytes must be > 0, got ${options.maxBytes}`);
    }
    this.capacity = capacity;
    this.items = new Array<T | undefined>(capacity);
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.sizeOf = options.sizeOf ?? (() => 0);
    this.onEvict = options.onEvict;
  }

  /** Append; drops the oldest item(s) when either bound is exceeded. */
  push(item: T): void {
    const size = this.maxBytes === Number.POSITIVE_INFINITY ? 0 : this.sizeOf(item);
    if (this.count === this.capacity) {
      const evicted = this.items[this.start] as T;
      this.bytes -= this.maxBytes === Number.POSITIVE_INFINITY ? 0 : this.sizeOf(evicted);
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
      this.droppedTotal += 1;
      this.bytes += size;
      this.announce(evicted);
    } else {
      this.items[(this.start + this.count) % this.capacity] = item;
      this.count += 1;
      this.bytes += size;
    }
    // Byte bound: shed from the oldest end, but never down to empty — the
    // just-pushed item is the newest and always survives.
    while (this.bytes > this.maxBytes && this.count > 1) {
      const evicted = this.items[this.start] as T;
      this.items[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.count -= 1;
      this.bytes -= this.sizeOf(evicted);
      this.droppedTotal += 1;
      this.announce(evicted);
    }
  }

  /** Oldest-to-newest snapshot. Does not consume. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i += 1) {
      out.push(this.items[(this.start + i) % this.capacity] as T);
    }
    return out;
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
    this.bytes = 0;
  }

  get size(): number {
    return this.count;
  }

  /** Approximate retained bytes (0 when no byte bound is configured). */
  get byteSize(): number {
    return this.bytes;
  }

  /** Total number of items evicted since construction (diagnostics). */
  get dropped(): number {
    return this.droppedTotal;
  }

  /** The eviction callback is a diagnostics path: it must never throw here. */
  private announce(item: T): void {
    if (this.onEvict === undefined) return;
    try {
      this.onEvict(item);
    } catch {
      // never let bookkeeping break the emit path
    }
  }
}
