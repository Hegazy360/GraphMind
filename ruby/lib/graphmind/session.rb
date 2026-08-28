# frozen_string_literal: true

require_relative "env"
require_relative "errors"
require_relative "gate_engine"
require_relative "ids"
require_relative "protocol"
require_relative "ring_buffer"
require_relative "runtime"
require_relative "safe"
require_relative "token_batcher"
require_relative "transport"
require_relative "version"

module Graphmind
  # One top-level agent invocation.
  #
  # `aborted?` flips when the debugger resolves a gate with `abort`. Anything
  # GraphMind does not wrap (a raw HTTP call, a long loop) can poll it so an
  # abort reaches code the gem cannot see.
  class RunContext
    attr_reader :run_id, :name

    def initialize(run_id, name)
      @run_id = run_id
      @name = name
      @mutex = Mutex.new
      @aborted = false
      @reason = nil
    end

    def aborted? = @mutex.synchronize { @aborted }
    def reason   = @mutex.synchronize { @reason }

    def abort!(reason = nil)
      @mutex.synchronize do
        @aborted = true
        @reason ||= reason || Graphmind::AbortError.new
      end
      nil
    end

    def to_s = "#<Graphmind::RunContext #{@name} #{@run_id}#{aborted? ? ' aborted' : ''}>"
    alias inspect to_s
  end

  SessionStats = Struct.new(:enabled, :attached, :buffered, :dropped, :held_gates, :seq,
                            keyword_init: true) do
    def to_h
      {
        "enabled" => enabled, "attached" => attached, "buffered" => buffered,
        "dropped" => dropped, "heldGates" => held_gates, "seq" => seq
      }
    end
  end

  # The GraphMind session: the one object every integration talks to.
  #
  # Port of packages/client/src/session.ts.
  #
  # Guarantees:
  #   * NEVER raises into the host app. Internal failures no-op with a
  #     rate-limited warning. (Errors raised by the host's own code inside a
  #     run propagate untouched — they are the host's errors.)
  #   * Zero-cost when detached: #gate returns the shared CONTINUE after three
  #     reads and no allocation.
  #   * Fail-open: disconnect, dispose and interpreter exit auto-continue every
  #     held gate.
  #   * Kill switches: GRAPHMIND_DISABLED=1 always disables; a
  #     production-looking environment disables unless GRAPHMIND=1. A disabled
  #     session never touches the network.
  class Session
    DEFAULT_CONNECT_TIMEOUT = 0.3
    DEFAULT_HANDSHAKE_TIMEOUT = 1.0
    DEFAULT_RETRY_INTERVAL = 10.0
    DEFAULT_BUFFER_SIZE = 2000
    DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024
    DEFAULT_READY_TIMEOUT = 2.0
    DEFAULT_TOKEN_INTERVAL = 0.034

    # How often a blocked gate re-checks the fail-open conditions. The primary
    # release path is the disconnect callback (sub-millisecond); this poll only
    # exists so a blocked thread can never outlive the debugger even if a
    # callback is somehow missed.
    GATE_POLL = 0.25

    # Fiber-local, which under Puma/Sidekiq means thread-local: each request or
    # job runs on its own thread's root fiber. See README "Threads".
    RUN_KEY = :graphmind_run_context

    attr_reader :app_name, :sdk, :meta, :warner

    def initialize(url: nil, app_name: "ruby", sdk: nil, meta: nil, enabled: nil,
                   connect_timeout: DEFAULT_CONNECT_TIMEOUT,
                   handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
                   retry_interval: DEFAULT_RETRY_INTERVAL,
                   buffer_size: DEFAULT_BUFFER_SIZE,
                   max_buffer_bytes: DEFAULT_MAX_BUFFER_BYTES,
                   pause_timeout: nil,
                   token_interval: DEFAULT_TOKEN_INTERVAL,
                   env: nil, logger: nil, warn_interval: 60.0)
      @enabled = Env.resolve_enabled(enabled, env)
      @app_name = app_name.to_s
      @sdk = sdk || { "name" => "ruby", "version" => Graphmind::VERSION }
      @meta = meta

      @warner = Warner.new(warn_interval, logger)
      @mutex = Mutex.new
      @buffer = RingBuffer.new(buffer_size, max_buffer_bytes)
      @seq = 0
      # Identity handed out by the debugger in hello.ack; see build_hello.
      @session_token = nil
      @started = false
      @disposed = false
      @attached_mirror = false
      @implicit_run = nil
      @lost = 0

      @ready_mutex = Mutex.new
      @ready_cv = ConditionVariable.new

      @engine = GateEngine.new(
        on_paused: method(:on_paused),
        on_resumed: method(:on_resumed),
        new_pause_id: -> { Ids.next_id("pause") },
        pause_timeout: pause_timeout
      )
      @batcher = TokenBatcher.new(
        ->(node_id, deltas) { emit("node.token", { "nodeId" => node_id, "deltas" => deltas }) },
        token_interval
      )
      @transport = Transport.new(
        url: Env.resolve_url(url, env),
        hooks: Transport::Hooks.new(
          build_hello: method(:build_hello),
          on_attached: method(:handle_attached),
          on_detached: method(:handle_detached),
          on_control: method(:handle_control)
        ),
        warner: @warner,
        connect_timeout: connect_timeout,
        handshake_timeout: handshake_timeout,
        retry_interval: retry_interval
      )
      @shutdown_hook = -> { fail_open_now }
      Runtime.register(@shutdown_hook)
    end

    # -- state ---------------------------------------------------------------

    def enabled?  = @enabled
    def attached? = @transport.attached?
    def disposed? = @disposed
    def url       = @transport.url

    def stats
      SessionStats.new(
        enabled: @enabled,
        attached: attached?,
        buffered: @mutex.synchronize { @buffer.size },
        dropped: @mutex.synchronize { @buffer.dropped },
        held_gates: @engine.held_count,
        seq: @mutex.synchronize { @seq }
      )
    end

    # -- attach --------------------------------------------------------------

    # Block until the handshake completes (breakpoints armed).
    #
    # Returns false on timeout or when GraphMind is disabled. Never raises:
    # false means "carry on detached", it is not an error.
    def ready(timeout = DEFAULT_READY_TIMEOUT)
      return false unless active?

      ensure_started
      # Re-arm: after a failure or a disconnect, do not sit out the retry
      # interval — connect now.
      @transport.kick
      return true if @transport.attached?

      deadline = monotonic + timeout
      @ready_mutex.synchronize do
        loop do
          break if @transport.attached? || @disposed

          remaining = deadline - monotonic
          break if remaining <= 0

          @ready_cv.wait(@ready_mutex, remaining)
        end
      end
      @transport.attached? && active?
    rescue StandardError => e
      @warner.warn("ready", "internal error in ready(); resolving detached", e)
      false
    end

    # -- runs ----------------------------------------------------------------

    def current_run = Thread.current[RUN_KEY]

    # Run boundary. Emits run.started / run.finished plus an `agent:<name>`
    # node, and carries the RunContext the debugger's `abort` action targets.
    # The block's value is returned; the block's errors propagate untouched.
    def run(name, meta: nil)
      ctx = RunContext.new(Ids.new_id("run"), name.to_s)
      previous = Thread.current[RUN_KEY]
      Thread.current[RUN_KEY] = ctx
      node_id = Ids.agent_node_id(name)
      started = monotonic
      begin_run(ctx, name, meta, node_id)
      error = nil
      begin
        yield ctx
      rescue Exception => e # rubocop:disable Lint/RescueException
        error = e
        raise
      ensure
        Thread.current[RUN_KEY] = previous
        end_run(ctx, node_id, started, error)
      end
    end

    # Adopt an existing run context on this thread (for work you hand to a
    # thread pool yourself — see README "Threads").
    def with_run_context(ctx)
      previous = Thread.current[RUN_KEY]
      Thread.current[RUN_KEY] = ctx
      yield
    ensure
      Thread.current[RUN_KEY] = previous
    end

    # Forget any run context bound to this thread. Rails' executor calls this
    # after every request so a run cannot leak into the next one served by the
    # same Puma thread.
    def clear_run_context
      Thread.current[RUN_KEY] = nil
    end

    # -- events --------------------------------------------------------------

    def emit(type, payload)
      return unless active?

      ensure_started
      emit_internal(type, payload, resolve_run_id)
      nil
    rescue StandardError => e
      @warner.warn("emit", "internal error in emit(); GraphMind degrading to a no-op", e)
      nil
    end

    def start_node(node_id:, kind:, name:, instance_id:, parent_id: nil, input: nil, extra: nil)
      payload = {
        "nodeId" => node_id, "kind" => kind, "name" => name, "instanceId" => instance_id
      }
      payload["parentId"] = parent_id unless parent_id.nil?
      payload["input"] = sanitize(input) unless input.nil?
      payload.merge!(extra) if extra
      emit("node.started", payload)
    end

    def finish_node(node_id:, instance_id:, duration_ms:, status: "ok", output: nil, usage: nil,
                    extra: nil)
      @batcher.flush_node(node_id)
      payload = {
        "nodeId" => node_id,
        "instanceId" => instance_id,
        "durationMs" => [0.0, duration_ms.to_f].max,
        "status" => status
      }
      payload["output"] = sanitize(output) unless output.nil?
      payload["usage"] = usage unless usage.nil?
      payload.merge!(extra) if extra
      emit("node.finished", payload)
    end

    def error_node(node_id, instance_id, error)
      emit("node.error", {
             "nodeId" => node_id,
             "instanceId" => instance_id,
             "error" => Errors.to_error_info(error)
           })
    end

    def graph_hint(nodes)
      list = Array(nodes).select { |n| n.is_a?(Hash) }
      emit("graph.hint", { "nodes" => list }) unless list.empty?
    end

    # Queue one streamed delta (batched into node.token).
    def push_token(node_id, channel, value)
      return if !active? || value.nil? || value.to_s.empty?

      channel = "text" unless Protocol::TOKEN_CHANNELS.include?(channel)
      @batcher.push(node_id, channel, value.to_s)
      nil
    rescue StandardError
      nil
    end

    def flush
      @batcher.flush_all
    rescue StandardError
      nil
    end

    # -- gates ---------------------------------------------------------------

    # Hold the CALLING THREAD until the debugger resumes.
    #
    # Fast path (disabled, detached, or attached with nothing matching) returns
    # the shared CONTINUE without allocating.
    def gate(point, node)
      return CONTINUE unless active?

      ensure_started
      return CONTINUE unless @transport.attached? && @engine.should_pause?(point, node)

      hold = @engine.hold(point, node, resolve_run_id)
      settled = false
      begin
        decision = nil
        loop do
          decision = hold.wait(GATE_POLL)
          break unless decision.nil?

          if @disposed || !@transport.attached?
            # Belt and braces: the disconnect callback normally releases held
            # gates within a millisecond of the socket dying.
            settled = true
            @engine.discard(hold.pause_id)
            return CONTINUE
          end
        end
        settled = true
        apply_decision(decision)
      ensure
        # Interrupt (Ctrl-C) is not a StandardError and unwinds straight past
        # the rescue below; the gate must not stay registered.
        @engine.discard(hold.pause_id) unless settled
      end
    rescue Graphmind::AbortError
      raise
    rescue StandardError => e
      @warner.warn("gate", "internal gate error; continuing", e)
      CONTINUE
    end

    # The exception to raise after an `abort` decision.
    def abort_error(ctx = nil)
      ctx ||= current_run
      (ctx && ctx.reason) || Graphmind::AbortError.new
    end

    # -- lifecycle -----------------------------------------------------------

    def dispose
      return if @disposed

      @disposed = true
      Runtime.unregister(@shutdown_hook)
      swallow { @batcher.dispose }
      swallow do
        @engine.release_all
        @engine.disarm
      end
      swallow do
        implicit = @mutex.synchronize { @implicit_run }
        emit_internal("run.finished", { "status" => "ok" }, implicit.run_id) if implicit && @enabled
      end
      # Give the writer a moment to drain the last frames; bounded, so dispose
      # is never a hang.
      drain(0.25)
      swallow { @transport.dispose }
      settle_ready
      nil
    end

    private

    def active? = @enabled && !@disposed
    def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    def swallow
      yield
    rescue StandardError
      nil
    end

    def drain(timeout)
      return unless @attached_mirror

      deadline = monotonic + timeout
      sleep(0.005) while @transport.pending.positive? && monotonic < deadline
    rescue StandardError
      nil
    end

    def fail_open_now
      @engine.release_all
    rescue StandardError
      nil
    end

    def ensure_started
      return if @started

      start = @mutex.synchronize do
        if @started
          false
        else
          @started = true
        end
      end
      @transport.start if start
    end

    def resolve_run_id
      ctx = Thread.current[RUN_KEY]
      return ctx.run_id if ctx

      implicit = @mutex.synchronize { @implicit_run }
      return implicit.run_id if implicit

      created = nil
      run_id = @mutex.synchronize do
        if @implicit_run.nil?
          @implicit_run = RunContext.new(Ids.new_id("run"), "implicit")
          created = @implicit_run
        end
        @implicit_run.run_id
      end
      if created
        meta = { "name" => "implicit", "implicit" => true }
        meta.merge!(stringify(@meta)) if @meta
        emit_internal("run.started",
                      { "app" => @app_name, "sdk" => @sdk, "meta" => meta },
                      created.run_id)
      end
      run_id
    end

    # Serialize, buffer and hand off — all under one lock.
    #
    # The enqueue stays inside the lock deliberately: two host threads emitting
    # at once must reach the socket in the same order they took their sequence
    # numbers, or the viewer sees `seq` going backwards. `Transport#enqueue` is
    # a non-blocking push onto a bounded queue, so the critical section stays
    # short.
    def emit_internal(type, payload, run_id)
      lost_now = 0
      @mutex.synchronize do
        seq = @seq
        @seq += 1
        frame = Protocol.serialize_envelope(Protocol.create_envelope(type, payload, seq, run_id))
        dropped_before = @buffer.dropped
        @buffer.push(frame)
        if @attached_mirror
          @transport.enqueue(frame)
        else
          # An evicted frame that was already delivered is merely forgotten;
          # one evicted while we were dark is a hole in the recorded run.
          lost_now = @buffer.dropped - dropped_before
          @lost += lost_now
        end
      end
      warn_loss if lost_now.positive?
      nil
    end

    def warn_loss
      @warner.warn(
        "buffer-overflow",
        "dropped #{@lost} event#{@lost == 1 ? '' : 's'} while the debugger was unreachable; " \
        "the recorded run is incomplete. Raise `buffer_size` (currently #{@buffer.capacity}) " \
        "or attach the debugger sooner"
      )
    end

    def build_hello
      seq, token = @mutex.synchronize do
        value = @seq
        @seq += 1
        [value, @session_token]
      end
      payload = {
        "versions" => { "protocol" => Protocol::PROTOCOL_VERSION, "client" => Graphmind::VERSION },
        "capabilities" => Protocol::KNOWN_CAPABILITIES.dup,
        "app" => @app_name,
        "sdk" => @sdk
      }
      # Echoing the token from the last hello.ack is what lets the debugger
      # recognise a reconnect as the SAME app, and so refuse writes to our runs
      # from any other local process. Absent on a first connection.
      payload["resumeToken"] = token if token
      Protocol.serialize_envelope(
        Protocol.create_envelope("hello", payload, seq, Protocol::WILDCARD_RUN_ID)
      )
    end

    def handle_attached(ack)
      @engine.arm(ack["breakpoints"], ack["mode"])
      @mutex.synchronize do
        @attached_mirror = true
        # Kept across reconnects on purpose (see build_hello). Only ever
        # replaced, never cleared on detach: surviving the drop is the point.
        token = ack["sessionToken"]
        @session_token = token if token.is_a?(String) && !token.empty?
        # Replay-on-attach, oldest first, under the lock: a host thread
        # emitting right now must queue *after* the replay, not in the middle
        # of it. Envelopes keep their original `seq`, so the viewer
        # deduplicates on (runId, seq) — decisions.md #5.
        @buffer.to_a.each { |frame| @transport.enqueue(frame) }
      end
    rescue StandardError => e
      @warner.warn("attach", "internal error while attaching", e)
    ensure
      # Only after arming: a resolved ready() guarantees gates can pause.
      settle_ready
    end

    def handle_detached
      @mutex.synchronize { @attached_mirror = false }
      # FAIL-OPEN: no debugger, no holds. Forget its breakpoints and mode too;
      # the next hello.ack re-arms them.
      @engine.disarm
      @engine.release_all
      nil
    rescue StandardError => e
      @warner.warn("detach", "internal error while detaching", e)
    end

    def handle_control(envelope)
      payload = envelope["payload"] || {}
      case envelope["type"]
      when "exec.resume"
        pause_id = payload["pauseId"]
        action = payload["action"]
        @engine.resume(pause_id, action, payload["output"]) if pause_id.is_a?(String) && action.is_a?(String)
      when "breakpoint.set"
        @engine.add_breakpoint(payload["matcher"])
      when "breakpoint.clear"
        @engine.remove_breakpoint(payload["matcher"])
      when "mode.set"
        @engine.set_mode(payload["mode"])
      end
      # Events echoed back, duplicate handshakes, future additions: ignore.
      nil
    rescue StandardError => e
      @warner.warn("control", "internal error handling a control frame", e)
    end

    def settle_ready
      @ready_mutex.synchronize { @ready_cv.broadcast }
    end

    def on_paused(pause_id, node, point, run_id)
      emit_or_warn("exec.paused",
                   { "pauseId" => pause_id, "nodeId" => node.node_id, "point" => point }, run_id)
    end

    def on_resumed(pause_id, _node, action, run_id)
      emit_or_warn("exec.resumed", { "pauseId" => pause_id, "action" => action }, run_id)
    end

    def emit_or_warn(type, payload, run_id)
      return unless active?

      emit_internal(type, payload, run_id)
    rescue StandardError => e
      @warner.warn("emit", "internal error emitting a gate event", e)
    end

    def apply_decision(decision)
      if decision.abort?
        ctx = current_run
        ctx&.abort!(Graphmind::AbortError.new)
      end
      decision
    end

    def begin_run(ctx, name, meta, node_id)
      return unless active?

      ensure_started
      payload_meta = { "name" => name.to_s }
      payload_meta.merge!(stringify(@meta)) if @meta
      payload_meta.merge!(stringify(meta)) if meta
      emit_internal("run.started",
                    { "app" => @app_name, "sdk" => @sdk, "meta" => payload_meta }, ctx.run_id)
      emit_internal("node.started",
                    { "nodeId" => node_id, "kind" => "agent", "name" => name.to_s,
                      "instanceId" => ctx.run_id }, ctx.run_id)
    rescue StandardError => e
      @warner.warn("run-start", "internal error starting a run", e)
    end

    def end_run(ctx, node_id, started, error)
      return unless active?

      aborted = ctx.aborted? || Errors.abort_error?(error)
      status = if aborted
                 "aborted"
               else
                 error.nil? ? "ok" : "error"
               end
      duration_ms = (monotonic - started) * 1000.0
      if error && !aborted
        emit_internal("node.error",
                      { "nodeId" => node_id, "instanceId" => ctx.run_id,
                        "error" => Errors.to_error_info(error) }, ctx.run_id)
      end
      @batcher.flush_all
      emit_internal("node.finished",
                    { "nodeId" => node_id, "instanceId" => ctx.run_id,
                      "durationMs" => duration_ms, "status" => status }, ctx.run_id)
      payload = { "status" => status }
      payload["error"] = Errors.to_error_info(error) if error && !aborted
      emit_internal("run.finished", payload, ctx.run_id)
    rescue StandardError => e
      @warner.warn("run-finish", "internal error finishing a run", e)
    end

    def stringify(hash)
      return {} unless hash.is_a?(Hash)

      hash.each_with_object({}) { |(k, v), out| out[k.to_s] = v }
    end

    # Values reach the viewer as JSON, and a host object that cannot be
    # serialized must never break an emit. Anything JSON cannot express
    # degrades to its #inspect string.
    MAX_PREVIEW = 8000

    def sanitize(value)
      case value
      when nil, true, false, Integer, String then value
      when Float then value.finite? ? value : value.to_s
      when Symbol then value.to_s
      when Array then value.first(200).map { |v| sanitize(v) }
      when Hash
        value.first(200).each_with_object({}) { |(k, v), out| out[k.to_s] = sanitize(v) }
      else
        if value.respond_to?(:to_h)
          begin
            return sanitize(value.to_h)
          rescue StandardError
            nil
          end
        end
        text = begin
          value.inspect
        rescue StandardError
          value.class.name.to_s
        end
        text.length > MAX_PREVIEW ? "#{text[0, MAX_PREVIEW]}…" : text
      end
    end
  end
end
