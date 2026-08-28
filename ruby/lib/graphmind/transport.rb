# frozen_string_literal: true

require_relative "protocol"
require_relative "websocket"

module Graphmind
  # WebSocket transport: lazy connect with a hard connect timeout, the
  # hello/hello.ack handshake, background reconnect, and fail-open detach.
  #
  # Port of packages/client/src/transport.ts. It never raises into callers:
  # every failure degrades to "detached" plus a rate-limited warning, and a
  # background retry keeps trying.
  #
  # Threading: one supervisor thread owns the socket and the read loop; while
  # attached it spawns one writer thread that drains the outbox, so a host
  # thread calling #enqueue never blocks on the network. Both are ordinary
  # (non-main) threads, so they cannot keep a Ruby process alive at exit.
  #
  # Reconnect timing has two regimes, because they are not the same problem:
  #   * never attached (no debugger running) — retry every retry_interval;
  #   * lost an established attachment (a blip) — the debugger existed
  #     milliseconds ago and every millisecond dark eats the ring buffer, so
  #     burst first (FAST_RETRY_STEPS) and then settle.
  class Transport
    FAST_RETRY_STEPS = [0.2, 0.4, 0.8].freeze

    # Hard cap on frames waiting for a slow socket. Oldest are dropped first;
    # the ring buffer, not this queue, is what guarantees replay-on-attach.
    MAX_OUTBOX = 10_000

    Hooks = Struct.new(:build_hello, :on_attached, :on_detached, :on_control, keyword_init: true)

    attr_reader :url

    def initialize(url:, hooks:, warner:, connect_timeout: 0.3, handshake_timeout: 1.0,
                   retry_interval: 10.0)
      @url = url
      @hooks = hooks
      @warner = warner
      @connect_timeout = connect_timeout
      @handshake_timeout = handshake_timeout
      @retry_interval = retry_interval

      @state = :idle # :idle | :connecting | :attached | :disposed
      @started = false
      @mutex = Mutex.new
      @wake = ConditionVariable.new
      @kicked = false
      @supervisor = nil
      @connection = nil
      @outbox = nil
      @writer = nil
      @fast_retry_step = FAST_RETRY_STEPS.length
    end

    def attached? = @state == :attached
    def state = @state

    # Begin connecting (idempotent). Called lazily on first session use.
    def start
      return if @started || @state == :disposed

      @started = true
      @supervisor = Thread.new { supervise }
      @supervisor.name = "graphmind-transport" if @supervisor.respond_to?(:name=)
      @supervisor.report_on_exception = false
      nil
    end

    # Force an attempt now instead of waiting out the retry interval.
    def kick
      return if @state == :disposed
      return start unless @started

      @mutex.synchronize do
        @kicked = true
        @wake.broadcast
      end
      nil
    end

    # Queue one serialized frame. Non-blocking, safe from any thread.
    def enqueue(frame)
      return false unless @state == :attached

      outbox = @outbox
      return false if outbox.nil?

      # Drop-oldest so a stalled socket cannot grow without bound.
      begin
        outbox.pop(true) while outbox.size >= MAX_OUTBOX
      rescue ThreadError
        nil
      end
      outbox << frame
      true
    rescue StandardError
      false
    end

    # Approximate number of frames still waiting to be written.
    def pending = (@outbox&.size || 0)

    def dispose
      return if @state == :disposed

      @state = :disposed
      teardown_connection
      @mutex.synchronize { @wake.broadcast }
      supervisor = @supervisor
      @supervisor = nil
      supervisor&.join(0.5)
      supervisor&.kill if supervisor&.alive?
      nil
    end

    private

    def supervise
      until @state == :disposed
        @mutex.synchronize { @kicked = false }
        begin
          attempt
        rescue StandardError => e
          @warner.warn("transport-loop", "transport loop error", e)
        end
        break if @state == :disposed

        wait_for_retry
      end
    rescue StandardError => e
      @warner.warn("transport-loop", "transport supervisor stopped", e)
    end

    def wait_for_retry
      delay = next_retry_delay
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + delay
      @mutex.synchronize do
        loop do
          break if @kicked || @state == :disposed

          remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          break if remaining <= 0

          @wake.wait(@mutex, remaining)
        end
        @kicked = false
      end
    end

    def next_retry_delay
      step = FAST_RETRY_STEPS[@fast_retry_step]
      return @retry_interval if step.nil?

      @fast_retry_step += 1
      step < @retry_interval ? step : @retry_interval
    end

    def attempt
      return if @state == :disposed

      @state = :connecting
      connection =
        begin
          WebSocket.connect(@url, connect_timeout: @connect_timeout,
                                  handshake_timeout: @handshake_timeout)
        rescue WebSocket::Error => e
          @state = :idle
          @warner.warn("transport-connect", "could not reach the GraphMind viewer; staying detached", e)
          return
        rescue StandardError => e
          @state = :idle
          @warner.warn("transport-connect", "failed to open the viewer WebSocket", e)
          return
        end

      was_attached = false
      begin
        connection.send_text(@hooks.build_hello.call)
        ack = await_ack(connection)
        return if ack.nil?

        @connection = connection
        @outbox = Thread::Queue.new
        @state = :attached
        was_attached = true
        start_writer(connection, @outbox)
        safely { @hooks.on_attached.call(ack) }
        read_loop(connection)
      rescue WebSocket::Error => e
        @warner.warn("transport-io", "viewer connection lost", e)
      rescue StandardError => e
        @warner.warn("transport-io", "viewer connection error", e)
      ensure
        @state = :idle unless @state == :disposed
        stop_writer
        @connection = nil
        @outbox = nil
        begin
          connection.abort!
        rescue StandardError
          nil
        end
        if was_attached
          # Losing a live attachment arms the fast-reconnect burst.
          @fast_retry_step = 0
          # FAIL-OPEN: no debugger, no holds.
          safely { @hooks.on_detached.call }
        end
      end
    end

    # Read frames until hello.ack, honouring the handshake budget. Returns the
    # ack payload, or nil when the connection must be abandoned.
    def await_ack(connection)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + @handshake_timeout
      loop do
        message = connection.read_message(deadline: deadline)
        if message.nil?
          @warner.warn(
            "transport-ack-timeout",
            "viewer did not complete the handshake within #{(@handshake_timeout * 1000).round}ms; staying detached"
          )
          return nil
        end
        return nil if message == :closed

        result = Protocol.parse_envelope_json(message)
        case result.kind
        when :version_mismatch
          @warner.warn(
            "transport-version",
            "viewer speaks protocol v#{result.received}, this client speaks " \
            "v#{Protocol::PROTOCOL_VERSION}; staying detached"
          )
          return nil
        when :ok
          envelope = result.envelope
          next unless envelope["type"] == "hello.ack"

          payload = envelope["payload"] || {}
          versions = payload["versions"] || {}
          if versions["protocol"] != Protocol::PROTOCOL_VERSION
            @warner.warn(
              "transport-version",
              "viewer acked protocol v#{versions['protocol']}, this client speaks " \
              "v#{Protocol::PROTOCOL_VERSION}; staying detached"
            )
            return nil
          end
          return payload
        end
        # invalid / unknown-type before the ack: ignore and keep reading.
      end
    end

    def read_loop(connection)
      while @state == :attached
        message = connection.read_message
        break if message.nil? || message == :closed

        result = Protocol.parse_envelope_json(message)
        case result.kind
        when :ok
          safely { @hooks.on_control.call(result.envelope) }
        when :invalid
          @warner.warn("transport-invalid", "ignoring invalid frame: #{result.reason}")
        end
        # unknown-type / version-mismatch mid-stream: tolerate silently.
      end
    end

    def start_writer(connection, outbox)
      @writer = Thread.new do
        loop do
          frame = outbox.pop
          break if frame.nil? || frame.equal?(STOP)

          begin
            connection.send_text(frame)
          rescue StandardError
            # The socket is gone; the read loop will notice and reconnect.
            begin
              connection.abort!
            rescue StandardError
              nil
            end
            break
          end
        end
      end
      @writer.name = "graphmind-writer" if @writer.respond_to?(:name=)
      @writer.report_on_exception = false
    end

    def stop_writer
      writer = @writer
      @writer = nil
      return if writer.nil?

      begin
        @outbox&.<<(STOP)
      rescue StandardError
        nil
      end
      writer.join(0.2)
      writer.kill if writer.alive?
    end

    def teardown_connection
      connection = @connection
      @connection = nil
      return if connection.nil?

      begin
        connection.abort!
      rescue StandardError
        nil
      end
    end

    def safely
      yield
    rescue StandardError => e
      @warner.warn("transport-hook", "internal error in a transport callback", e)
    end

    STOP = Object.new
    private_constant :STOP
  end
end
