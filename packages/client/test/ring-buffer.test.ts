/**
 * The ring buffer's two bounds and, above all, its eviction announcement —
 * the hook the session uses to notice that it has lost data. A buffer that
 * silently forgets is the whole bug this file guards against.
 */
import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../src/ring-buffer.js';

describe('RingBuffer', () => {
  it('rejects a nonsense capacity', () => {
    expect(() => new RingBuffer<string>({ capacity: 0 })).toThrow(RangeError);
    expect(() => new RingBuffer<string>({ capacity: 1.5 })).toThrow(RangeError);
    expect(() => new RingBuffer<string>({ capacity: 4, maxBytes: 0 })).toThrow(RangeError);
  });

  it('drops oldest at capacity and announces every eviction, oldest first', () => {
    const evicted: string[] = [];
    const buffer = new RingBuffer<string>({ capacity: 3, onEvict: (item) => evicted.push(item) });
    for (const item of ['a', 'b', 'c', 'd', 'e']) buffer.push(item);

    expect(buffer.toArray()).toEqual(['c', 'd', 'e']);
    expect(evicted).toEqual(['a', 'b']);
    expect(buffer.dropped).toBe(2);
    expect(buffer.size).toBe(3);
  });

  it('enforces the byte bound as well, and announces those evictions too', () => {
    const evicted: string[] = [];
    const buffer = new RingBuffer<string>({
      capacity: 100, // deliberately far from binding
      maxBytes: 10,
      sizeOf: (item) => item.length,
      onEvict: (item) => evicted.push(item),
    });
    buffer.push('aaaa'); // 4
    buffer.push('bbbb'); // 8
    expect(buffer.size).toBe(2);
    expect(buffer.byteSize).toBe(8);

    buffer.push('cccc'); // 12 > 10 -> shed 'aaaa'
    expect(buffer.toArray()).toEqual(['bbbb', 'cccc']);
    expect(evicted).toEqual(['aaaa']);
    expect(buffer.byteSize).toBe(8);
  });

  it('keeps a single item that is bigger than the whole byte budget', () => {
    const evicted: string[] = [];
    const buffer = new RingBuffer<string>({
      capacity: 10,
      maxBytes: 8,
      sizeOf: (item) => item.length,
      onEvict: (item) => evicted.push(item),
    });
    buffer.push('small');
    buffer.push('x'.repeat(64));

    // Never evicts down to empty: the newest frame is still worth replaying.
    expect(buffer.toArray()).toEqual(['x'.repeat(64)]);
    expect(evicted).toEqual(['small']);

    // ...and it is shed as soon as anything else arrives.
    buffer.push('tiny');
    expect(buffer.toArray()).toEqual(['tiny']);
    expect(evicted).toEqual(['small', 'x'.repeat(64)]);
  });

  it('a throwing onEvict cannot break the push path (fail-open)', () => {
    const buffer = new RingBuffer<string>({
      capacity: 1,
      onEvict: () => {
        throw new Error('bookkeeping exploded');
      },
    });
    buffer.push('a');
    expect(() => buffer.push('b')).not.toThrow();
    expect(buffer.toArray()).toEqual(['b']);
  });

  it('clear() resets size, bytes and contents (not the lifetime drop count)', () => {
    const buffer = new RingBuffer<string>({
      capacity: 2,
      maxBytes: 1024,
      sizeOf: (item) => item.length,
    });
    buffer.push('a');
    buffer.push('b');
    buffer.push('c');
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.byteSize).toBe(0);
    expect(buffer.toArray()).toEqual([]);
    expect(buffer.dropped).toBe(1);
  });
});
