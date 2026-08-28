# frozen_string_literal: true

module Graphmind
  # Batches streamed deltas into `node.token` events.
  #
  # A streaming LLM produces tokens far faster than a canvas can paint, and one
  # WebSocket frame per token would swamp both the socket and the viewer. Every
  # delta lands in a per-node list, and a single background thread flushes them
  # on a fixed interval (~30 Hz by default) or when the node finishes.
  class TokenBatcher
    def initialize(sink, interval = 0.034)
      @sink = sink
      @interval = interval
      @mutex = Mutex.new
      @pending = {}
      @thread = nil
      @disposed = false
    end

    def push(node_id, channel, value)
      return if @disposed || value.nil? || value.empty?

      @mutex.synchronize do
        (@pending[node_id] ||= []) << { "t" => channel, "v" => value.to_s }
        ensure_thread
      end
      nil
    end

    # Flush one node's pending deltas immediately (called before node.finished
    # so a finished node never has tokens arriving after its result).
    def flush_node(node_id)
      deltas = @mutex.synchronize { @pending.delete(node_id) }
      emit(node_id, deltas)
      nil
    end

    def flush_all
      pending = @mutex.synchronize do
        snapshot = @pending
        @pending = {}
        snapshot
      end
      pending.each { |node_id, deltas| emit(node_id, deltas) }
      nil
    end

    def dispose
      @disposed = true
      thread = @mutex.synchronize do
        t = @thread
        @thread = nil
        t
      end
      thread&.kill
      flush_all
      nil
    end

    private

    # Called with the mutex held.
    def ensure_thread
      return if @thread || @disposed

      @thread = Thread.new do
        until @disposed
          sleep(@interval)
          flush_all
        end
      end
      @thread.name = "graphmind-tokens" if @thread.respond_to?(:name=)
      @thread.report_on_exception = false
    end

    def emit(node_id, deltas)
      return if deltas.nil? || deltas.empty?

      @sink.call(node_id, deltas)
    rescue StandardError
      nil
    end
  end
end
