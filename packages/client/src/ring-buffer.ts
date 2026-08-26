/**
 * Bounded FIFO ring buffer with drop-oldest semantics. Used to retain the
 * most recent events while no viewer is attached, for replay-on-attach.
 */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private count = 0;
  private droppedTotal = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.items = new Array<T | undefined>(capacity);
  }

  /** Append; drops the oldest item when full. */
  push(item: T): void {
    if (this.count === this.capacity) {
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
      this.droppedTotal += 1;
    } else {
      this.items[(this.start + this.count) % this.capacity] = item;
      this.count += 1;
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
  }

  get size(): number {
    return this.count;
  }

  /** Total number of items dropped since construction (diagnostics). */
  get dropped(): number {
    return this.droppedTotal;
  }
}
