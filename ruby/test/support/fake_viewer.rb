# frozen_string_literal: true

require "socket"
require "json"
require "base64"
require "digest"

# A real WebSocket server that speaks the GraphMind wire protocol.
#
# The test double for the viewer: it accepts a connection, completes the RFC
# 6455 handshake, replies to `hello` with `hello.ack`, records every envelope,
# and can send control frames or crash abruptly.
#
# It deliberately uses the *server* half of Graphmind::WebSocket::Frame
# (mask: false), so a suite that passes has exercised masked client frames
# being unmasked by a server and unmasked server frames being parsed by the
# client. The cross-check against a third-party implementation is
# test/live_server_check.rb, which runs this gem against the real
# `graphmind serve` (Node `ws`).
class FakeViewer
  PROTOCOL_VERSION = 1

  attr_reader :port, :breakpoints, :mode

  #: Handed out in every `hello.ack`, so a test can assert the client echoes
  #: it back as `resumeToken` on reconnect (the run-claim capability).
  SESSION_TOKEN = "fake-session-token"

  def initialize(breakpoints: [], mode: "run", auto_ack: true, ack_protocol: PROTOCOL_VERSION,
                 refuse_upgrade: false)
    @breakpoints = breakpoints
    @mode = mode
    @auto_ack = auto_ack
    @ack_protocol = ack_protocol
    @refuse_upgrade = refuse_upgrade
    @session_token = SESSION_TOKEN

    @mutex = Mutex.new
    @received = []
    @connections = []
    @connection_count = 0
    @seq = 0
    @stopped = false

    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
    @thread = Thread.new { accept_loop }
    @thread.report_on_exception = false
    @workers = []
  end

  def url = "ws://127.0.0.1:#{@port}/ingest"

  def received = @mutex.synchronize { @received.dup }

  def frames_of(type) = received.select { |f| f["type"] == type }

  def connection_count = @mutex.synchronize { @connection_count }

  def live_connections = @mutex.synchronize { @connections.dup }

  # Send one control envelope to every attached client.
  def send_control(type, payload, run_id: "*")
    frame = JSON.generate(envelope(type, payload, run_id))
    live_connections.each do |connection|
      connection.send_text(frame)
    rescue StandardError
      nil
    end
    nil
  end

  def resume(pause_id, action, output = nil)
    payload = { "pauseId" => pause_id, "action" => action }
    payload["output"] = output unless output.nil?
    send_control("exec.resume", payload)
  end

  def set_breakpoint(matcher) = send_control("breakpoint.set", { "matcher" => matcher })
  def clear_breakpoint(matcher) = send_control("breakpoint.clear", { "matcher" => matcher })
  def set_mode(mode) = send_control("mode.set", { "mode" => mode })

  # Wait until `predicate` is true, or fail the test.
  def wait_until(timeout: 5.0, label: "condition")
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    until yield
      raise "timed out waiting for #{label}" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.005
    end
    true
  end

  def wait_for_frame(type, count: 1, timeout: 5.0)
    wait_until(timeout: timeout, label: "#{count}x #{type}") { frames_of(type).length >= count }
    frames_of(type)
  end

  # Simulate a viewer crash: drop the sockets with no close handshake.
  def kill_abruptly
    live_connections.each do |connection|
      connection.abort!
    rescue StandardError
      nil
    end
    @mutex.synchronize { @connections.clear }
    nil
  end

  def close
    @stopped = true
    kill_abruptly
    begin
      @server.close
    rescue StandardError
      nil
    end
    @thread&.join(1)
    @thread&.kill if @thread&.alive?
    @workers.each { |w| w.kill if w.alive? }
    nil
  end

  private

  def envelope(type, payload, run_id)
    seq = @mutex.synchronize do
      value = @seq
      @seq += 1
      value
    end
    {
      "gm" => PROTOCOL_VERSION, "seq" => seq, "ts" => (Time.now.to_f * 1000).round,
      "runId" => run_id, "type" => type, "payload" => payload
    }
  end

  def accept_loop
    until @stopped
      socket =
        begin
          @server.accept
        rescue StandardError
          break
        end
      worker = Thread.new(socket) { |io| handle(io) }
      worker.report_on_exception = false
      @workers << worker
    end
  end

  def handle(io)
    request = +""
    request << io.readpartial(4096) until request.include?("\r\n\r\n")
    key = request[/Sec-WebSocket-Key:\s*(\S+)/i, 1]

    if @refuse_upgrade || key.nil?
      io.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
      io.close
      return
    end

    accept = Base64.strict_encode64(Digest::SHA1.digest(key + Graphmind::WebSocket::GUID))
    io.write("HTTP/1.1 101 Switching Protocols\r\n" \
             "Upgrade: websocket\r\n" \
             "Connection: Upgrade\r\n" \
             "Sec-WebSocket-Accept: #{accept}\r\n\r\n")

    connection = Graphmind::WebSocket::Connection.new(io, mask: false)
    @mutex.synchronize do
      @connections << connection
      @connection_count += 1
    end

    loop do
      message = connection.read_message
      break if message.nil? || message == :closed

      frame =
        begin
          JSON.parse(message)
        rescue StandardError
          next
        end
      @mutex.synchronize { @received << frame }
      next unless frame["type"] == "hello" && @auto_ack

      connection.send_text(JSON.generate(envelope("hello.ack", {
                                                    "versions" => { "protocol" => @ack_protocol,
                                                                    "viewer" => "fake-viewer/0.0.0" },
                                                    "capabilities" => %w[pause step inject retry abort],
                                                    "breakpoints" => @breakpoints,
                                                    "mode" => @mode,
                                                    "sessionToken" => @session_token
                                                  }, "*")))
    end
  rescue StandardError
    nil
  ensure
    @mutex.synchronize { @connections.delete(connection) } if defined?(connection) && connection
    begin
      io.close
    rescue StandardError
      nil
    end
  end
end
