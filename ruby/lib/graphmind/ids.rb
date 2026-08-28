# frozen_string_literal: true

require "securerandom"

module Graphmind
  # Node identity (internal/decisions.md #1) and compact unique ids.
  #
  # `node_id` is stable per LOGICAL node, so the canvas renders one node per
  # code location; `instance_id` distinguishes repeated executions. Concurrent
  # executions of the same logical node are told apart purely by instance id —
  # which is why every node.started / node.finished / node.error this gem
  # emits carries one.
  module Ids
    # The single logical LLM node of a provider-SDK agent loop. Matches the
    # TypeScript and Python adapters so the viewer renders every language's
    # runs identically.
    LLM_NODE_ID = "llm:step"
    LLM_NODE_NAME = "step"

    @mutex = Mutex.new
    @pid = Process.pid
    @base = SecureRandom.hex(3)
    @counter = 0

    module_function

    def tool_node_id(name)  = "tool:#{name}"
    def agent_node_id(name) = "agent:#{name}"
    def llm_node_id(name)   = "llm:#{name}"
    def chain_node_id(name) = "chain:#{name}"

    # Globally unique id (runs).
    def new_id(prefix)
      "#{prefix}_#{SecureRandom.hex(6)}"
    end

    # Compact per-process unique id (pauses, node instances). Re-seeded after a
    # fork so a Puma/Unicorn worker cannot mint ids that collide with its
    # parent's.
    def next_id(prefix)
      @mutex.synchronize do
        if @pid != Process.pid
          @pid = Process.pid
          @base = SecureRandom.hex(3)
          @counter = 0
        end
        @counter += 1
        "#{prefix}_#{@base}_#{@counter}"
      end
    end
  end
end
