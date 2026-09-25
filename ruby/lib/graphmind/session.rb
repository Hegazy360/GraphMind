# frozen_string_literal: true

require_relative "clock"
require_relative "env"
require_relative "errors"
require_relative "gate_engine"
require_relative "held_ledger"
require_relative "integrations/support"
require_relative "ids"
require_relative "loop_guard"
require_relative "protocol"
require_relative "redaction"
require_relative "ring_buffer"
require_relative "runtime"
require_relative "safe"
require_relative "shrink"
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

  # `dropped` counts frames the replay buffer EVICTED; `lost` counts events
  # that never reached the debugger at all — evicted while dark, or refused
  # because one frame was bigger than the whole buffer. Parity with the
  # TypeScript client's SessionStats, where `lost` is "the number that
  # matters": without it a refused oversize frame was warned about in the log
  # but invisible to the host program (`dropped` stayed 0).
  SessionStats = Struct.new(:enabled, :attached, :buffered, :dropped, :lost, :held_gates, :seq,
                            keyword_init: true) do
    def to_h
      {
        "enabled" => enabled, "attached" => attached, "buffered" => buffered,
        "dropped" => dropped, "lost" => lost, "heldGates" => held_gates, "seq" => seq
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
                   env: nil, logger: nil, warn_interval: 60.0,
                   clock: nil, loop_guard: nil,
                   hide_inputs: nil, hide_outputs: nil, hide_tool_args: nil, hide_tool_results: nil)
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
      # What the attached debugger implements (hello.ack.hubCapabilities,
      # 0.6.0+); nil for a 0.5 debugger, which sends none, and while detached.
      # This gem announces no `edit-input`, so it only decides whether a
      # refused inject is also worth a line in the app's log.
      @hub_capabilities = nil

      @ready_mutex = Mutex.new
      @ready_cv = ConditionVariable.new

      # Pins gate holds to node instances so node.finished can carry `heldMs`.
      # `clock` is a monotonic millisecond clock, injectable for tests.
      @ledger = HeldLedger.new(clock: clock)
      env_source = env.nil? ? ENV : env
      # Coarse redaction (W7 port): the GRAPHMIND_HIDE_* kill switches, applied
      # in emit_internal before the ring buffer. Either the option or the
      # environment turning a switch on turns it on (the env is a floor).
      @redactor = Redaction::Redactor.new(
        Redaction.resolve({ hide_inputs: hide_inputs, hide_outputs: hide_outputs,
                            hide_tool_args: hide_tool_args, hide_tool_results: hide_tool_results },
                          env_source),
        # Fail-closed reports (a failed form sent, or an event dropped), one
        # line per key per interval — never the payload, never the error text.
        warn: ->(key, message) { @warner.warn(key, message) }
      )
      # Loop hold (W5 port; rule v3): identical tool calls made back-to-back,
      # recorded at node.started and consulted at the before-gate. `loop_guard:` is false
      # or a Hash (threshold / mode / ignore_keys / allow_nodes / kinds);
      # GRAPHMIND_LOOP_THRESHOLD / GRAPHMIND_ON_LOOP / GRAPHMIND_LOOP_ALLOW fill
      # the rest.
      @loop_guard = LoopGuard::Guard.new(LoopGuard.resolve(loop_guard, env_source))

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
        lost: @mutex.synchronize { @lost },
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
      started = Clock.now_ms
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
      emit_event(type, payload, NO_RAW_INPUT)
    end

    # Loop hold (W5 port): the redaction switches and the loop guard as this
    # session resolved them (diagnostics / tests).
    def redaction_switches = @redactor.switches
    def loop_guard_config = @loop_guard.config

    # `raw_input` is what the caller handed to #start_node before `sanitize`
    # (which truncates long arrays and hashes): the loop fingerprint must see
    # every argument, or two calls that differ past the 200th element would
    # look identical.
    def emit_event(type, payload, raw_input)
      return unless active?

      ensure_started
      emit_internal(type, payload, resolve_run_id, raw_input)
      nil
    rescue StandardError => e
      @warner.warn("emit", "internal error in emit(); GraphMind degrading to a no-op", e)
      nil
    end
    private :emit_event

    def start_node(node_id:, kind:, name:, instance_id:, parent_id: nil, input: nil, extra: nil)
      payload = {
        "nodeId" => node_id, "kind" => kind, "name" => name, "instanceId" => instance_id
      }
      payload["parentId"] = parent_id unless parent_id.nil?
      payload["input"] = sanitize(input) unless input.nil?
      payload.merge!(extra) if extra
      raw = extra.is_a?(Hash) && (extra.key?("input") || extra.key?(:input)) ? NO_RAW_INPUT : input
      emit_event("node.started", payload, raw)
    end

    def finish_node(node_id:, instance_id:, duration_ms:, status: "ok", output: nil, usage: nil,
                    extra: nil)
      @batcher.flush_node(node_id)
      payload = {
        "nodeId" => node_id,
        "instanceId" => instance_id,
        "durationMs" => Clock.normalize_duration_ms(duration_ms),
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
      return CONTINUE unless @transport.attached?

      loop_info = consult_loop(point, node)
      return CONTINUE if loop_info.nil? && !@engine.should_pause?(point, node)

      hold = @engine.hold(point, node, resolve_run_id, loop_info)
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

    # Serialize the payload (held to the payload budget), then take the seq,
    # frame, buffer and hand off under one lock.
    #
    # The enqueue stays inside the lock deliberately: two host threads emitting
    # at once must reach the socket in the same order they took their sequence
    # numbers, or the viewer sees `seq` going backwards. `Transport#enqueue` is
    # a non-blocking push onto a bounded queue, so the critical section stays
    # short. The payload's JSON — and, for an oversized one, its parse and
    # shrink — happens BEFORE the lock: a 17 MB tool result must not stall every
    # other thread's emit while it is measured. The frame is the envelope's
    # small head spliced with that text, byte-identical to JSON.generate of the
    # whole envelope (`payload` is its last key and the generator writes no
    # whitespace).
    def emit_internal(type, payload, run_id, raw_input = NO_RAW_INPUT, node_kind: nil)
      original = payload
      # Loop hold (W5 port): fingerprint a watched node's input exactly as the
      # caller handed it over — before redaction can replace it — and outside
      # the lock (it walks the whole input).
      loop_call = type == "node.started" ? loop_call_for(payload, raw_input) : nil
      # Coarse redaction (W7 port) runs before the ring buffer and before any
      # other bookkeeping reads the payload: nothing past this line may see a
      # hidden input/output. A no-op when every switch is off. It fails closed:
      # DROP means the payload could not be redacted nor replaced by a valid
      # failed form, so the event is not emitted (the redactor already warned;
      # no seq is taken, so there is no hole).
      # `node_kind`: the paused node's kind, for exec.resumed / exec.refused.
      payload = @redactor.apply(type, payload, run_id, node_kind)
      if payload.equal?(Redaction::DROP)
        # The call happened but nothing of it reached the wire: it is not
        # provably the call right before the next one (loop rule 3), and a
        # hold's lastSeq must never point at an event that was never sent.
        @mutex.synchronize { record_loop(run_id, loop_call, nil, LoopGuard::UNREADABLE) } if loop_call
        release_tool_schemas_of(original, raw_input) if type == "node.started"
        return nil
      end
      payload = with_held_time(type, payload, run_id)
      lost_now = 0
      record = nil
      oversize = nil
      frame = nil
      begin
        # Payload budget, AFTER redaction and held time, BEFORE the ring
        # buffer: what is buffered and sent is exactly what the server stores.
        payload_json, whole = payload_json_within_budget(type, payload)
      rescue StandardError
        # Never sent (a NaN, a to_json that raises...): it takes no seq, and
        # like a dropped start it must not count; it clears the streak (loop
        # rule 3). emit rescues.
        @mutex.synchronize { record_loop(run_id, loop_call, nil, LoopGuard::UNREADABLE) } if loop_call
        release_tool_schemas_of(original, raw_input) if type == "node.started"
        raise
      end
      # Tool definitions go out once per run (Support.capture_tools): ones this
      # shrink emptied (`required: []`) must be sent again next step.
      release_tool_schemas_of(original, raw_input) if !whole && type == "node.started"
      @mutex.synchronize do
        seq = @seq
        @seq += 1
        begin
          frame = frame_with_payload(Protocol.create_envelope(type, nil, seq, run_id), payload_json)
        rescue StandardError
          # The head itself cannot be written (a run id that is not UTF-8):
          # give the seq back — nothing else can have taken one under the lock.
          @seq = seq
          record_loop(run_id, loop_call, nil, LoopGuard::UNREADABLE) if loop_call
          raise
        end
        # Recorded only once the frame exists, so a hold's lastSeq always
        # names an event that was serialised.
        record = record_loop(run_id, loop_call, seq) if loop_call
        dropped_before = @buffer.dropped
        if !@buffer.push(frame)
          # Larger than the whole replay buffer: refused rather than evicting
          # every older frame for it. Attached, it is sent live (not
          # replayable, but not lost); dark, it is lost — counted like any
          # other loss, with a warning of its own.
          if @attached_mirror && @transport.enqueue(frame)
            oversize = :sent
          else
            @lost += 1
            oversize = :lost
          end
        elsif @attached_mirror
          @transport.enqueue(frame)
        else
          # An evicted frame that was already delivered is merely forgotten;
          # one evicted while we were dark is a hole in the recorded run.
          lost_now = @buffer.dropped - dropped_before
          @lost += lost_now
        end
      end
      warn_unbuffered(oversize, frame.bytesize) if oversize
      warn_loss if lost_now.positive?
      warn_loop(run_id, loop_call, record) if record&.at_threshold
      nil
    end

    # -- payload budget (port of session.ts serializeWithinBudget) -------------
    #
    # The payload's JSON text, held to the protocol's payload budget
    # (Shrink::MAX_PAYLOAD_BYTES, 512 KB of UTF-8 as JavaScript writes it).
    #
    # The server always shrank a larger payload before storing it. Doing it
    # only there meant a 17 MB payload was framed whole: bigger than the 8 MiB
    # replay buffer (evicting every older frame) and than the server's 16 MiB
    # frame cap, so the event vanished and its node hung "running". Applying
    # the SAME algorithm here, with the event type, makes the event degrade
    # exactly as the server would have stored it (a valid event stays valid);
    # the server's own pass is then a no-op.
    #
    # The shrink runs on the payload parsed back out of the generated JSON —
    # what the server parses — never on the live object: json writes a Time, a
    # Struct, anything with #to_json or #to_s as text, and the shrink must see
    # that text, not the object.
    #
    # Under the budget the text is JSON.generate's, unchanged. The pre-check is
    # exact: token by token, JavaScript's spelling is never longer than json's
    # except for a float json writes with an exponent, and then at most 21/5
    # times as long ("1e+20" -> 21 digits; measured over 23,196 doubles with
    # json 2.7, 2.21 and 3.0). So only a text over MAX * 5/21 bytes that is
    # over the budget or has an exponent pays for the parse and the measure.
    #
    # A payload json cannot generate at all (a cycle, a string that is not
    # UTF-8, a #to_json that raises) is degraded field by field when the shrink
    # can blame a field, and sent with a marker in its place; when it cannot
    # (a NaN, which JavaScript would write as null) the error propagates and
    # the event is dropped as before. Warnings are one per event type per
    # interval and never quote content.
    EXPONENT_RE = /\de[+-]/
    private_constant :EXPONENT_RE

    # Returns [json, whole]: whole is false when the payload was shrunk or
    # degraded (what capture_tools' once-per-run tool definitions must know).
    def payload_json_within_budget(type, payload)
      type_name = type.is_a?(Symbol) ? type.name : type
      degraded = nil
      begin
        json = JSON.generate(payload)
      rescue StandardError => e
        degraded_json, degraded, truncated = Shrink.serialize_payload(payload, Float::INFINITY, type_name)
        raise e unless truncated

        json = degraded_json
        if Shrink.valid_for?(type_name, degraded)
          @warner.warn("payload-unserializable:#{type_name}",
                       "a #{type_name} event had a value that could not be serialized to JSON; it was sent " \
                       "with that value replaced by a marker")
        else
          @warner.warn("payload-invalid:#{type_name}",
                       "a #{type_name} event had a value that could not be serialized to JSON, and it could " \
                       "not be degraded to a valid event; the debugger will drop it")
        end
        # Fall through: the fields that DID serialize may still be over budget
        # (a cycle next to a 17 MB string), exactly as the server would see it.
      end
      bytes = json.bytesize
      return [json, degraded.nil?] if bytes * 21 <= Shrink::MAX_PAYLOAD_BYTES * 5 ||
                                      (bytes <= Shrink::MAX_PAYLOAD_BYTES && !json.match?(EXPONENT_RE))

      wire =
        begin
          # allow_duplicate_key: {a: 1, "a" => 2} generates a duplicate key,
          # which json 3 refuses by default (older versions ignore the option).
          JSON.parse(json, max_nesting: false, allow_duplicate_key: true)
        rescue StandardError
          # Only the shrink's own text can fail here (an escaped lone
          # surrogate half, which json refuses to parse): it is JSON-shaped.
          raise if degraded.nil?

          degraded
        end
      shrunk_json, shrunk, truncated = Shrink.serialize_payload(wire, Shrink::MAX_PAYLOAD_BYTES, type_name)
      return [json, degraded.nil?] unless truncated

      size = shrunk.is_a?(Hash) && shrunk["bytes"].is_a?(Integer) ? shrunk["bytes"] : "unknown"
      limit = Shrink::MAX_PAYLOAD_BYTES / 1024
      if Shrink.valid_for?(type_name, shrunk)
        @warner.warn("payload-budget:#{type_name}",
                     "an event of #{size} bytes was shrunk to a preview (the debugger stores at most " \
                     "#{limit} KB per payload)")
      else
        @warner.warn("payload-invalid:#{type_name}",
                     "a #{type_name} event of #{size} bytes could not be shrunk to a valid event (the debugger " \
                     "stores at most #{limit} KB per payload, and this payload is not a valid #{type_name} " \
                     "event); the debugger will drop it")
      end
      [shrunk_json, false]
    end

    # The input.toolSchemas of a node.started as the integration built it
    # (start_node's input before sanitize copies it), handed back to
    # Support.capture_tools' memory.
    def release_tool_schemas_of(payload, raw_input)
      input = raw_input.equal?(NO_RAW_INPUT) ? (payload.is_a?(Hash) ? payload["input"] : nil) : raw_input
      return unless input.is_a?(Hash)

      Integrations::Support.release_tool_schemas(input["toolSchemas"] || input[:toolSchemas])
    rescue StandardError
      nil
    end

    # JSON.generate(envelope with payload) from its head and the payload text.
    def frame_with_payload(envelope, payload_json)
      envelope.delete("payload")
      head = Protocol.serialize_envelope(envelope)
      text = payload_json.encoding == Encoding::UTF_8 ? payload_json : payload_json.dup.force_encoding(Encoding::UTF_8)
      "#{head.byteslice(0, head.bytesize - 1)},\"payload\":#{text}}"
    end

    # The ring buffer refused a frame larger than its whole byte budget.
    def warn_unbuffered(outcome, bytes)
      limit = "max_buffer_bytes is #{@buffer.max_bytes}"
      if outcome == :sent
        @warner.warn("buffer-oversize-sent",
                     "an event of #{bytes} bytes is larger than the whole replay buffer (#{limit}); it was " \
                     "sent but not kept for replay")
      else
        @warner.warn("buffer-oversize-lost",
                     "dropped an event of #{bytes} bytes: it is larger than the whole replay buffer (#{limit}) " \
                     "and the debugger is not attached; the recorded run is incomplete. Raise `max_buffer_bytes`")
      end
    rescue StandardError
      nil
    end

    NO_RAW_INPUT = Object.new.freeze
    private_constant :NO_RAW_INPUT

    # [kind, node_id, name, fingerprint] for a WATCHED node.started (loop rule
    # v3), else nil. Each field is read once, in its own rescue, as the
    # TypeScript session does: a kind that cannot be read touches no streak
    # (which one would it be?); a nodeId/name that cannot be read, or an input
    # whose read raises, yields an UNREADABLE fingerprint, which clears the
    # kind's streak (rule 3) — never counted as identical, never raised.
    def loop_call_for(payload, raw_input)
      return nil unless @loop_guard.enabled? && Hash === payload

      kind = begin
        payload["kind"]
      rescue StandardError
        return nil
      end
      node_id, name = begin
        [payload["nodeId"], payload["name"]]
      rescue StandardError
        [nil, nil]
      end
      return nil unless @loop_guard.watched?(kind, node_id, name)

      input =
        if raw_input.equal?(NO_RAW_INPUT)
          begin
            payload["input"]
          rescue StandardError
            LoopGuard::UNREADABLE
          end
        else
          raw_input
        end
      [kind, node_id, name, @loop_guard.fingerprint(node_id, input)]
    rescue StandardError
      nil
    end

    def record_loop(run_id, loop_call, seq, fingerprint = loop_call[3])
      @loop_guard.record(run_id, loop_call[0], loop_call[1], loop_call[2], fingerprint, seq)
    rescue StandardError
      nil
    end

    # The built-in loop breakpoint: only at `before`, only in mode pause, only
    # when attached (the caller checked).
    def consult_loop(point, node)
      return nil unless point == "before" && @loop_guard.enabled? && @loop_guard.mode == "pause"

      @loop_guard.consult(resolve_run_id, node.kind, node.node_id, node.name)
    rescue StandardError
      nil
    end

    # A looping agent is never silent: when nothing will hold it — no debugger
    # attached, or mode warn — say so once per streak. Names the tool, never an
    # argument.
    def warn_loop(run_id, loop_call, record)
      return if @loop_guard.mode == "pause" && @transport.attached?

      kind, node_id, name = loop_call
      node_id = node_id.to_s if node_id.is_a?(Symbol)
      name = name.is_a?(String) || name.is_a?(Symbol) ? name.to_s : node_id
      return unless @loop_guard.claim_warning(run_id, node_id, kind)

      because =
        if @loop_guard.mode == "warn"
          "GRAPHMIND_ON_LOOP=warn, so it is not being held"
        else
          "no debugger is attached to hold it (start `npx graphmind-ai` to pause it there)"
        end
      @warner.warn(
        "loop:#{node_id}",
        "possible loop: #{name} (#{node_id}) was called #{record.repeats}\u00d7 in a row with " \
        "identical arguments; #{because}. Polling on purpose? add it to " \
        "loop_guard: { allow_nodes: [...] } or GRAPHMIND_LOOP_ALLOW; GRAPHMIND_ON_LOOP=off silences this"
      )
    rescue StandardError
      nil
    end

    # exec.paused.loop as it may leave the process. The fingerprint is an
    # unsalted digest of the node's input: when a switch hides that input
    # (hide_inputs, or hide_tool_args on a tool) a low-entropy argument would be
    # a dictionary attack away from it, so it is hidden too.
    def loop_on_wire(info, node)
      wire = info.to_wire
      switches = @redactor.switches
      # The literal's own == (a Symbol counts as its name): a String subclass that
      # lies in #== must not decide that a hidden input's digest is safe to send.
      tool = Redaction.wire_eq?(node.kind, "tool")
      wire["fingerprint"] = Redaction::REDACTED if switches.hide_inputs || (switches.hide_tool_args && tool)
      wire
    end

    # Held time is not run time. Track node instances as they start, pin gate
    # holds to them (see HeldLedger) and stamp the total onto node.finished /
    # node.error as the loose field `heldMs`. `durationMs` is left as measured
    # (wall clock, held time included) apart from being normalised to the wire
    # contract; "ran" is `durationMs - heldMs`. A `heldMs` the caller already
    # set wins. Any failure leaves the payload untouched.
    def with_held_time(type, payload, run_id)
      node_id = payload["nodeId"]
      return payload unless node_id.is_a?(String)

      instance_id = payload["instanceId"]
      instance_id = nil unless instance_id.is_a?(String)
      case type
      when "node.started"
        @ledger.started(run_id, node_id, instance_id, payload["parentId"]) if instance_id
        payload
      when "node.error"
        @ledger.errored(run_id, node_id, instance_id)
        return payload if payload["heldMs"].is_a?(Numeric)

        held = @ledger.peek(run_id, node_id, instance_id)
        held.nil? ? payload : payload.merge("heldMs" => held)
      when "node.finished"
        out = payload.dup
        out["durationMs"] = Clock.normalize_duration_ms(out["durationMs"]) if out.key?("durationMs")
        held = @ledger.finished(run_id, node_id, instance_id)
        out["heldMs"] = held if !held.nil? && !out["heldMs"].is_a?(Numeric)
        out
      else
        payload
      end
    rescue StandardError
      payload
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
      # What THIS debugger implements (0.6.0+). Not the echoed `capabilities`.
      hub = ack["hubCapabilities"]
      @hub_capabilities = hub.is_a?(Array) ? hub.select { |entry| entry.is_a?(String) }.freeze : nil
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
      # FAIL-OPEN: no debugger, no holds. Forget its breakpoints, mode and
      # capabilities too; the next hello.ack re-arms them.
      @hub_capabilities = nil
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
        handle_resume(payload) if payload.is_a?(Hash)
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

    # An exec.resume for a held gate (0.6.0 rules, W1 scope: this gem does not
    # announce `edit-input`):
    #   * `requestId` (any String) is echoed on the exec.resumed / exec.refused
    #     it causes, so the debugger can correlate its answer;
    #   * an edited `input` is refused (`disabled`) and the gate stays held — it
    #     is never run as a plain resume, which would silently drop the edit;
    #   * the inject guard: an output holding the redaction placeholder or a
    #     truncated preview (EditGuard) is refused and the gate stays held,
    #     under every debugger; a 0.5 debugger does not show exec.refused, so
    #     the app's log says why too.
    # Unknown pauses and unknown actions are ignored.
    def handle_resume(payload)
      pause_id = payload["pauseId"]
      action = payload["action"]
      return unless pause_id.is_a?(String) && action.is_a?(String) && Protocol::RESUME_ACTIONS.include?(action)

      gate = @engine.peek(pause_id)
      return if gate.nil?

      raw = payload["requestId"]
      request_id = raw.is_a?(String) ? raw : nil
      if payload.key?("input")
        emit_refused(gate, "disabled",
                     "this app cannot run a call with an edited input (the Ruby SDK does not support input edits)",
                     request_id)
        return
      end
      if action == "inject"
        refusal = EditGuard.proposed_value_refusal(payload["output"])
        unless refusal.nil?
          emit_refused(gate, refusal.code, refusal.message, request_id)
          if @hub_capabilities.nil?
            @warner.warn("inject-refused",
                         "refused an injected value: #{refusal.message}. The call is still paused " \
                         "(inject the full value, or continue, retry or abort); this debugger does not " \
                         "show refusals — upgrade it to see them there")
          end
          return
        end
      end
      @engine.resume(pause_id, action, payload["output"], request_id: request_id)
    end

    # exec.refused, redacted by the paused node's kind.
    def emit_refused(gate, code, message, request_id)
      payload = { "pauseId" => gate[:pause_id], "code" => code }
      payload["message"] = message unless message.nil?
      payload["requestId"] = request_id unless request_id.nil?
      emit_or_warn("exec.refused", payload, gate[:run_id], gate[:node].kind)
    end

    def on_paused(pause_id, node, point, run_id, reason = nil)
      swallow { @ledger.hold_opened(pause_id, run_id, node.node_id, point) }
      payload = { "pauseId" => pause_id, "nodeId" => node.node_id, "point" => point }
      if reason.is_a?(LoopGuard::Info)
        swallow do
          loop_wire = loop_on_wire(reason, node)
          payload["reason"] = "loop"
          payload["loop"] = loop_wire
        end
      end
      emit_or_warn("exec.paused", payload, run_id)
    end

    def on_resumed(pause_id, node, action, run_id, request_id = nil)
      swallow { @ledger.hold_closed(pause_id) }
      payload = { "pauseId" => pause_id, "action" => action }
      payload["requestId"] = request_id unless request_id.nil?
      emit_or_warn("exec.resumed", payload, run_id, node.kind)
    end

    def emit_or_warn(type, payload, run_id, node_kind = nil)
      return unless active?

      emit_internal(type, payload, run_id, node_kind: node_kind)
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
      duration_ms = Clock.elapsed_ms(started)
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
    # Nesting walked before a "[depth]" marker — the loop fingerprint's bound.
    # Deeper values used to exhaust the stack here, or (below ~97 levels) make
    # JSON.generate refuse the whole envelope (max_nesting 100), losing the event.
    MAX_SANITIZE_DEPTH = 64

    # A cycle (a Hash holding itself, a #to_h that returns a Hash holding the
    # object) becomes "[circular]" and runaway nesting "[depth]": before, both
    # recursed until SystemStackError — not a StandardError — which escaped
    # every rescue into the host's own call.
    def sanitize(value, depth = 0, path = nil)
      case value
      when nil, true, false, Integer, String then return value
      when Float then return value.finite? ? value : value.to_s
      when Symbol then return value.to_s
      end
      return "[depth]" if depth > MAX_SANITIZE_DEPTH

      path ||= {}.compare_by_identity
      return "[circular]" if path.key?(value)

      path[value] = true
      begin
        sanitize_container(value, depth, path)
      ensure
        path.delete(value)
      end
    end

    def sanitize_container(value, depth, path)
      case value
      when Array then value.first(200).map { |v| sanitize(v, depth + 1, path) }
      when Hash
        value.first(200).each_with_object({}) { |(k, v), out| out[k.to_s] = sanitize(v, depth + 1, path) }
      else
        if value.respond_to?(:to_h)
          begin
            return sanitize(value.to_h, depth + 1, path)
          rescue StandardError, SystemStackError
            nil
          end
        end
        text = begin
          value.inspect
        rescue StandardError, SystemStackError
          value.class.name.to_s
        end
        text.length > MAX_PREVIEW ? "#{text[0, MAX_PREVIEW]}…" : text
      end
    end
  end
end
