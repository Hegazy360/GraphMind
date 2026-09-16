/**
 * Belt and braces in the ring buffer: with `rejectOversize`, an item whose
 * own size exceeds `maxBytes` never evicts anything. `push` returns false and
 * leaves the buffer exactly as it was; the owner decides what that means
 * (the session sends it live if attached, otherwise counts it as lost).
 *
 * Without the option the buffer keeps its original behaviour (a lone item
 * bigger than the budget is kept and sheds everything else), which
 * ring-buffer.test.ts still pins.
 */
import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../src/ring-buffer.js';

function makeBuffer(maxBytes = 10, capacity = 100) {
  const evicted: string[] = [];
  const buffer = new RingBuffer<string>({
    capacity,
    maxBytes,
    sizeOf: (item) => item.length,
    onEvict: (item) => evicted.push(item),
    rejectOversize: true,
  });
  return { buffer, evicted };
}

describe('RingBuffer rejectOversize', () => {
  it('an item larger than maxBytes is refused and evicts nothing', () => {
    const { buffer, evicted } = makeBuffer(10);
    expect(buffer.push('aaaa')).toBe(true);
    expect(buffer.push('bbbb')).toBe(true);
    expect(buffer.push('x'.repeat(11))).toBe(false);

    expect(buffer.toArray()).toEqual(['aaaa', 'bbbb']);
    expect(evicted).toEqual([]);
    expect(buffer.dropped).toBe(0);
    expect(buffer.rejected).toBe(1);
    expect(buffer.byteSize).toBe(8);
    expect(buffer.size).toBe(2);
  });

  it('an item of exactly maxBytes is accepted (it fits alone) and sheds older items as before', () => {
    const { buffer, evicted } = makeBuffer(10);
    buffer.push('aaaa');
    expect(buffer.push('y'.repeat(10))).toBe(true);
    expect(buffer.toArray()).toEqual(['y'.repeat(10)]);
    expect(evicted).toEqual(['aaaa']);
    expect(buffer.rejected).toBe(0);
  });

  it('refusal into an empty buffer and into a full-capacity buffer leaves both intact', () => {
    const empty = makeBuffer(5);
    expect(empty.buffer.push('toolong')).toBe(false);
    expect(empty.buffer.size).toBe(0);
    expect(empty.buffer.byteSize).toBe(0);

    const full = makeBuffer(5, 2);
    full.buffer.push('a');
    full.buffer.push('b');
    expect(full.buffer.push('toolong')).toBe(false);
    expect(full.buffer.toArray()).toEqual(['a', 'b']);
    expect(full.evicted).toEqual([]);
    // ...and the ring still wraps correctly afterwards.
    expect(full.buffer.push('c')).toBe(true);
    expect(full.buffer.toArray()).toEqual(['b', 'c']);
    expect(full.evicted).toEqual(['a']);
    expect(full.buffer.byteSize).toBe(2);
  });

  it('push returns true for ordinary pushes, including capacity and byte evictions', () => {
    const { buffer } = makeBuffer(6, 2);
    expect(buffer.push('aaa')).toBe(true);
    expect(buffer.push('bbb')).toBe(true);
    expect(buffer.push('cc')).toBe(true); // capacity eviction
    expect(buffer.push('dddd')).toBe(true); // byte eviction
    expect(buffer.toArray()).toEqual(['cc', 'dddd']);
  });

  it('sizeOf is consulted once per push, not again for a refused item', () => {
    let calls = 0;
    const buffer = new RingBuffer<string>({
      capacity: 4,
      maxBytes: 3,
      sizeOf: (item) => {
        calls += 1;
        return item.length;
      },
      rejectOversize: true,
    });
    buffer.push('abcd');
    expect(calls).toBe(1);
  });

  it('without a byte bound nothing is ever refused', () => {
    const buffer = new RingBuffer<string>({ capacity: 2, rejectOversize: true });
    expect(buffer.push('x'.repeat(1_000_000))).toBe(true);
    expect(buffer.rejected).toBe(0);
  });

  it('the legacy default (no rejectOversize) still keeps a lone oversized item', () => {
    const buffer = new RingBuffer<string>({ capacity: 10, maxBytes: 8, sizeOf: (item) => item.length });
    buffer.push('small');
    expect(buffer.push('x'.repeat(64))).toBe(true);
    expect(buffer.toArray()).toEqual(['x'.repeat(64)]);
  });
});
