# frozen_string_literal: true

module Graphmind
  # Bounded FIFO with drop-oldest semantics, holding the most recent frames
  # while no viewer is attached so they can be replayed on attach.
  #
  # Two independent bounds, both drop-oldest:
  #   * capacity  — a hard item count;
  #   * max_bytes — an approximate memory ceiling. Without it, N slots cost
  #     N x the largest payload the host ever emits. A single item bigger than
  #     the whole budget is still kept: the buffer never evicts down to empty
  #     just to satisfy the byte bound.
  #
  # Not thread-safe on its own — the session owns it under its mutex.
  class RingBuffer
    attr_reader :capacity, :dropped, :byte_size

    def initialize(capacity, max_bytes = nil)
      raise ArgumentError, "capacity must be a positive integer" unless capacity.is_a?(Integer) && capacity >= 1
      raise ArgumentError, "max_bytes must be > 0" if max_bytes && max_bytes <= 0

      @capacity = capacity
      @max_bytes = max_bytes
      @items = []
      @dropped = 0
      @byte_size = 0
    end

    # Append one serialized frame; drops the oldest when either bound trips.
    def push(frame)
      @items << frame
      @byte_size += frame.bytesize
      while @items.size > @capacity
        @byte_size -= @items.shift.bytesize
        @dropped += 1
      end
      if @max_bytes
        while @byte_size > @max_bytes && @items.size > 1
          @byte_size -= @items.shift.bytesize
          @dropped += 1
        end
      end
      nil
    end

    def to_a = @items.dup
    def size = @items.size

    def clear
      @items.clear
      @byte_size = 0
      nil
    end
  end
end
