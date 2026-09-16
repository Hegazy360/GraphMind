# frozen_string_literal: true

module Graphmind
  # Bounded FIFO with drop-oldest semantics, holding the most recent frames
  # while no viewer is attached so they can be replayed on attach.
  #
  # Two independent bounds, both drop-oldest:
  #   * capacity  — a hard item count;
  #   * max_bytes — an approximate memory ceiling, in UTF-8 bytes of the
  #     frames. Without it, N slots cost N x the largest payload the host ever
  #     emits.
  #
  # An item bigger than the whole byte budget is REFUSED (push returns false,
  # `rejected` counts it) and nothing is evicted for it: one oversized frame
  # must never cost the replay buffer every older frame — while the debugger
  # was unreachable that turned one 17 MB event into the loss of every event
  # before it. The caller decides the refused item's fate (the session sends
  # it live when attached, else counts it lost). `reject_oversize: false`
  # restores the old behaviour: the item is kept alone and every other item is
  # evicted. Port of packages/client/src/ring-buffer.ts (`rejectOversize`,
  # which the TypeScript session always turns on).
  #
  # Not thread-safe on its own — the session owns it under its mutex.
  class RingBuffer
    attr_reader :capacity, :dropped, :byte_size, :rejected, :max_bytes

    def initialize(capacity, max_bytes = nil, reject_oversize: true)
      raise ArgumentError, "capacity must be a positive integer" unless capacity.is_a?(Integer) && capacity >= 1
      raise ArgumentError, "max_bytes must be > 0" if max_bytes && !(max_bytes.is_a?(Numeric) && max_bytes.positive?)

      @capacity = capacity
      @max_bytes = max_bytes
      @reject_oversize = reject_oversize ? true : false
      @items = []
      @dropped = 0
      @rejected = 0
      @byte_size = 0
    end

    # Append one serialized frame; drops the oldest when either bound trips.
    # Returns false only when the frame alone is larger than max_bytes and was
    # refused (the buffer is then exactly as it was); true otherwise.
    def push(frame)
      size = frame.bytesize
      if @max_bytes && @reject_oversize && size > @max_bytes
        @rejected += 1
        return false
      end

      @items << frame
      @byte_size += size
      while @items.size > @capacity
        @byte_size -= @items.shift.bytesize
        @dropped += 1
      end
      if @max_bytes
        # Never down to empty: the frame just pushed is the newest and stays.
        while @byte_size > @max_bytes && @items.size > 1
          @byte_size -= @items.shift.bytesize
          @dropped += 1
        end
      end
      true
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
