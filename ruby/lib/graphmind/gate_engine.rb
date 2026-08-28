# frozen_string_literal: true

require_relative "protocol"

module Graphmind
  # How a gate was released.
  class GateDecision
    attr_reader :action, :output

    def initialize(action, output = nil)
      @action = action
      @output = output
      freeze
    end

    def continue? = @action == "continue"
    def retry?    = @action == "retry"
    def inject?   = @action == "inject"
    def abort?    = @action == "abort"

    def ==(other)
      other.is_a?(GateDecision) && other.action == @action && other.output == @output
    end
    alias eql? ==

    def hash = [@action, @output].hash

    def to_s = @action == "inject" ? "GateDecision(inject, #{@output.inspect})" : "GateDecision(#{@action})"
    alias inspect to_s
  end

  # Shared instance returned on every fast path (detached / nothing matching).
  # Allocating nothing on the hot path is the whole point.
  CONTINUE = GateDecision.new("continue")

  # The logical node a gate belongs to.
  class GateNode
    attr_reader :node_id, :kind, :name

    def initialize(node_id, kind, name)
      @node_id = node_id
      @kind = kind
      @name = name
      freeze
    end

    def to_s = "GateNode(#{@node_id}, #{@kind}, #{@name})"
    alias inspect to_s
  end

  # One held gate. The waiting thread blocks in #wait; the transport thread
  # calls #settle. A Mutex + ConditionVariable (rather than Queue#pop(timeout:))
  # keeps the gem usable on Ruby 3.1.
  class Hold
    attr_reader :pause_id

    def initialize(pause_id)
      @pause_id = pause_id
      @mutex = Mutex.new
      @cv = ConditionVariable.new
      @decision = nil
    end

    # Block up to `timeout` seconds. Returns the decision, or nil on timeout so
    # the caller can re-check fail-open conditions.
    def wait(timeout)
      @mutex.synchronize do
        @cv.wait(@mutex, timeout) if @decision.nil?
        @decision
      end
    end

    def settle(decision)
      @mutex.synchronize do
        return false unless @decision.nil?

        @decision = decision
        @cv.broadcast
        true
      end
    end

    def settled? = !@mutex.synchronize { @decision }.nil?
  end

  # Gate engine: cooperative pause points inside the instrumented process.
  #
  # Port of packages/client/src/gate-engine.ts, made thread-safe because a Ruby
  # agent may be running on many threads at once (Puma, Sidekiq) while the
  # transport lives on its own background thread.
  #
  # The session owns the decision of WHETHER to gate (attached? matching
  # breakpoint? step mode?); this engine owns the bookkeeping of HELD gates:
  # registration, resume routing, pause timeouts and fail-open release.
  #
  # Fail-open invariants:
  #   * release_all releases every held gate with `continue` (on disconnect,
  #     on dispose, and from the at_exit hook);
  #   * an optional per-gate pause timeout auto-continues a gate nobody
  #     resumes.
  class GateEngine
    def initialize(on_paused:, on_resumed:, new_pause_id:, pause_timeout: nil)
      @on_paused = on_paused
      @on_resumed = on_resumed
      @new_pause_id = new_pause_id
      @pause_timeout = pause_timeout
      @mutex = Mutex.new
      @breakpoints = []
      @mode = "run"
      @held = {}
    end

    # -- viewer state --------------------------------------------------------

    # Adopt the viewer's full debug state (from hello.ack).
    def arm(breakpoints, mode)
      @mutex.synchronize do
        @breakpoints = Array(breakpoints).select { |m| m.is_a?(Hash) }.map { |m| normalize(m) }
        @mode = Protocol::RUN_MODES.include?(mode) ? mode : "run"
      end
    end

    # Drop viewer state (on detach). Held gates are released separately.
    def disarm
      @mutex.synchronize do
        @breakpoints = []
        @mode = "run"
      end
    end

    def mode = @mutex.synchronize { @mode }

    def set_mode(mode)
      return unless Protocol::RUN_MODES.include?(mode)

      @mutex.synchronize { @mode = mode }
    end

    def add_breakpoint(matcher)
      return unless matcher.is_a?(Hash)

      normalized = normalize(matcher)
      @mutex.synchronize do
        @breakpoints << normalized unless @breakpoints.any? { |m| matcher_equals(m, normalized) }
      end
    end

    def remove_breakpoint(matcher)
      return unless matcher.is_a?(Hash)

      normalized = normalize(matcher)
      @mutex.synchronize do
        @breakpoints = @breakpoints.reject { |m| matcher_equals(m, normalized) }
      end
    end

    def breakpoints = @mutex.synchronize { @breakpoints.map(&:dup) }

    # -- decisions -----------------------------------------------------------

    # Step mode pauses at every before/error point; run mode only on a matching
    # breakpoint (`after` always needs an explicit one — decisions.md #2).
    def should_pause?(point, node)
      @mutex.synchronize do
        return true if @mode == "step" && point != "after"

        @breakpoints.any? { |matcher| matcher_matches(matcher, point, node) }
      end
    end

    # -- holds ---------------------------------------------------------------

    # Register a held gate. Call only after #should_pause?.
    def hold(point, node, run_id)
      pause_id = @new_pause_id.call
      hold = Hold.new(pause_id)
      timer = nil
      @mutex.synchronize do
        @held[pause_id] = { hold: hold, node: node, point: point, run_id: run_id }
      end
      if @pause_timeout
        timer = Thread.new(pause_id) do |id|
          sleep(@pause_timeout)
          settle(id, CONTINUE, "continue")
        end
        timer.name = "graphmind-pause-timeout" if timer.respond_to?(:name=)
        @mutex.synchronize { @held[pause_id][:timer] = timer if @held.key?(pause_id) }
      end
      # Emitted after registration so a resume racing back always finds the gate.
      safely { @on_paused.call(pause_id, node, point, run_id) }
      hold
    end

    # Route a viewer exec.resume to its held gate. Unknown ids are ignored.
    def resume(pause_id, action, output = nil)
      return false unless Protocol::RESUME_ACTIONS.include?(action)

      decision = action == "inject" ? GateDecision.new("inject", output) : GateDecision.new(action)
      settle(pause_id, decision, action)
    end

    # FAIL-OPEN: release every held gate with `continue`. Returns the count.
    def release_all
      ids = @mutex.synchronize { @held.keys }
      ids.count { |pause_id| settle(pause_id, CONTINUE, "continue") }
    end

    # Drop a gate whose waiter gave up (fail-open poll, interrupt). Emits
    # exec.resumed like any other release so the viewer's pause history stays
    # reconstructable.
    def discard(pause_id)
      settle(pause_id, CONTINUE, "continue")
    end

    def held_count = @mutex.synchronize { @held.size }

    # -- matching ------------------------------------------------------------

    # Every present matcher field must match; absent fields match anything.
    def matcher_matches(matcher, point, node)
      return false if (matcher["point"] || "before") != point

      kind = matcher["kind"]
      return false if kind && kind != node.kind

      name = matcher["name"]
      name.nil? || name == node.name
    end

    def matcher_equals(a, b)
      a["kind"] == b["kind"] && a["name"] == b["name"] && a["point"] == b["point"]
    end

    private

    def normalize(matcher)
      out = {}
      %w[kind name point].each do |key|
        value = matcher[key] || matcher[key.to_sym]
        out[key] = value unless value.nil?
      end
      out
    end

    def settle(pause_id, decision, action)
      entry = @mutex.synchronize { @held.delete(pause_id) }
      return false if entry.nil?

      timer = entry[:timer]
      timer.kill if timer && timer != Thread.current
      # The callback and the wake-up happen OUTSIDE the lock: the waiting
      # thread must never contend with the transport to get moving again.
      released = entry[:hold].settle(decision)
      safely { @on_resumed.call(pause_id, entry[:node], action, entry[:run_id]) }
      released
    end

    def safely
      yield
    rescue StandardError
      nil
    end
  end
end
