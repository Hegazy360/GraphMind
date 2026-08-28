# frozen_string_literal: true

require "socket"
require "io/wait"
require "uri"
require "base64"
require "digest"
require "securerandom"

module Graphmind
  # A minimal RFC 6455 client, hand-rolled over TCPSocket.
  #
  # Why not a websocket gem? This gem is a *debugger* that gets added to
  # someone else's Gemfile — often a Rails app with a carefully pinned
  # dependency graph. A debug tool that forces a resolution on faraday,
  # websocket-driver or eventmachine is a tool people cannot install. Every
  # byte below is stdlib (socket/uri/base64/digest/securerandom/openssl), the
  # gem has zero runtime dependencies, and the client half of RFC 6455 that a
  # local debug link actually needs is small: one masked opcode, ping/pong,
  # close, and fragment reassembly.
  #
  # Scope, stated honestly: text frames, client role, no permessage-deflate,
  # no subprotocol negotiation, no HTTP proxies. That is exactly what
  # `ws://127.0.0.1:4747/ingest` needs and nothing more.
  module WebSocket
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    # A frame bigger than this from the peer is treated as hostile and the
    # connection is dropped (the viewer never sends anything near it).
    MAX_FRAME_BYTES = 16 * 1024 * 1024

    OPCODE_CONTINUATION = 0x0
    OPCODE_TEXT = 0x1
    OPCODE_BINARY = 0x2
    OPCODE_CLOSE = 0x8
    OPCODE_PING = 0x9
    OPCODE_PONG = 0xA

    class Error < StandardError; end
    class ProtocolError < Error; end
    class Closed < Error; end

    # How often a blocking read wakes up to re-check `closed?`.
    POLL_INTERVAL = 0.25

    module Frame
      module_function

      # Encode one frame. `mask` must be true for client->server frames.
      def encode(payload, opcode: OPCODE_TEXT, mask: true)
        data = payload.to_s.dup.force_encoding(Encoding::BINARY)
        length = data.bytesize
        header = +"".b
        header << (0x80 | opcode).chr
        flag = mask ? 0x80 : 0x00
        if length < 126
          header << (flag | length).chr
        elsif length < 65_536
          header << (flag | 126).chr
          header << [length].pack("n")
        else
          header << (flag | 127).chr
          header << [length].pack("Q>")
        end
        return header + data unless mask

        key = SecureRandom.bytes(4)
        header + key + apply_mask(data, key)
      end

      def apply_mask(data, key)
        k = key.bytes
        out = data.bytes
        i = 0
        n = out.length
        while i < n
          out[i] ^= k[i & 3]
          i += 1
        end
        out.pack("C*")
      end
    end

    # One framed connection over an already-open IO.
    #
    # `mask: true` is the client role (this gem); `mask: false` is the server
    # role (used by the test double so both halves of the codec are exercised).
    class Connection
      attr_reader :io

      def initialize(io, mask:, prebuffer: nil)
        @io = io
        @mask = mask
        @write_mutex = Mutex.new
        @closed = false
        @fragments = nil
        @fragment_opcode = nil
        # Bytes the opening handshake read past the end of the HTTP response
        # (a server is allowed to pipeline its first frame into the same TCP
        # segment). Dropping them would lose a message.
        @prebuffer = prebuffer.nil? || prebuffer.empty? ? nil : prebuffer.dup.force_encoding(Encoding::BINARY)
        # Set when a deadline expired part-way through a frame: the stream is
        # no longer aligned, so the connection must be thrown away.
        @torn = false
      end

      def closed? = @closed

      def send_text(text)
        write_frame(Frame.encode(text, opcode: OPCODE_TEXT, mask: @mask))
      end

      def send_ping(payload = "")
        write_frame(Frame.encode(payload, opcode: OPCODE_PING, mask: @mask))
      end

      def send_pong(payload = "")
        write_frame(Frame.encode(payload, opcode: OPCODE_PONG, mask: @mask))
      end

      def send_close(code = 1000, reason = "")
        body = [code].pack("n") + reason.to_s.b
        write_frame(Frame.encode(body, opcode: OPCODE_CLOSE, mask: @mask))
      rescue StandardError
        nil
      end

      # Read one application message.
      #
      # Returns a String for a text/binary message, `:closed` when the peer
      # closed, or `nil` when `deadline` passed with nothing complete. Control
      # frames (ping/pong) are answered internally and do not return.
      #
      # `deadline` is an absolute Process.clock_gettime(CLOCK_MONOTONIC) value,
      # or nil to block until a message, a close, or #close from another
      # thread.
      def read_message(deadline: nil)
        loop do
          frame = read_frame(deadline)
          return nil if frame == :timeout
          return :closed if frame.nil?

          fin, opcode, payload = frame
          case opcode
          when OPCODE_PING
            send_pong(payload)
            next
          when OPCODE_PONG
            next
          when OPCODE_CLOSE
            send_close(1000)
            return :closed
          when OPCODE_CONTINUATION
            raise ProtocolError, "continuation frame with no start" if @fragments.nil?

            @fragments << payload
          when OPCODE_TEXT, OPCODE_BINARY
            raise ProtocolError, "interleaved data frame" unless @fragments.nil?

            if fin
              return finish_message(opcode, payload)
            end

            @fragments = +"".b << payload
            @fragment_opcode = opcode
            next
          else
            raise ProtocolError, "unknown opcode #{opcode}"
          end

          next unless fin && !@fragments.nil?

          payload = @fragments
          opcode = @fragment_opcode
          @fragments = nil
          @fragment_opcode = nil
          return finish_message(opcode, payload)
        end
      end

      def close
        return if @closed

        @closed = true
        send_close(1000)
        begin
          @io.close
        rescue StandardError
          nil
        end
      end

      # Drop the socket without a close handshake (simulates a crash).
      def abort!
        @closed = true
        begin
          @io.close
        rescue StandardError
          nil
        end
      end

      private

      def finish_message(opcode, payload)
        return payload.dup.force_encoding(Encoding::BINARY) if opcode == OPCODE_BINARY

        text = payload.dup.force_encoding(Encoding::UTF_8)
        text.valid_encoding? ? text : payload.dup.force_encoding(Encoding::BINARY)
      end

      def write_frame(bytes)
        raise Closed, "connection closed" if @closed

        @write_mutex.synchronize { @io.write(bytes) }
        true
      end

      # Returns [fin, opcode, payload], nil on EOF/close, or :timeout.
      def read_frame(deadline)
        raise ProtocolError, "connection desynchronised by a read timeout" if @torn

        head = read_exactly(2, deadline)
        return head if head.nil? || head == :timeout

        b0, b1 = head.bytes
        fin = (b0 & 0x80) != 0
        raise ProtocolError, "reserved bits set" if (b0 & 0x70) != 0

        opcode = b0 & 0x0F
        masked = (b1 & 0x80) != 0
        length = b1 & 0x7F

        if length == 126
          ext = read_rest(2, deadline)
          return ext if ext.nil? || ext == :timeout

          length = ext.unpack1("n")
        elsif length == 127
          ext = read_rest(8, deadline)
          return ext if ext.nil? || ext == :timeout

          length = ext.unpack1("Q>")
        end
        raise ProtocolError, "frame of #{length} bytes exceeds the cap" if length > MAX_FRAME_BYTES

        key = nil
        if masked
          key = read_rest(4, deadline)
          return key if key.nil? || key == :timeout
        end

        payload = length.zero? ? +"".b : read_rest(length, deadline)
        return payload if payload.nil? || payload == :timeout

        payload = Frame.apply_mask(payload, key) if key
        [fin, opcode, payload]
      end

      # Read part of a frame whose header has already been consumed. A timeout
      # here leaves the stream mid-frame, so the connection is marked torn and
      # the caller must drop it.
      def read_rest(count, deadline)
        result = read_exactly(count, deadline)
        @torn = true if result == :timeout
        result
      end

      # Read exactly n bytes. nil on EOF or after #close; :timeout on deadline.
      def read_exactly(count, deadline)
        buffer = +"".b
        if @prebuffer
          take = [count, @prebuffer.bytesize].min
          buffer << @prebuffer.byteslice(0, take)
          rest = @prebuffer.byteslice(take, @prebuffer.bytesize - take)
          @prebuffer = rest.nil? || rest.empty? ? nil : rest
          return buffer if buffer.bytesize == count
        end
        while buffer.bytesize < count
          return nil if @closed

          chunk =
            begin
              @io.read_nonblock(count - buffer.bytesize, exception: false)
            rescue EOFError, IOError, Errno::ECONNRESET, Errno::EPIPE
              return nil
            end
          if chunk == :wait_readable
            wait = POLL_INTERVAL
            if deadline
              remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
              return :timeout if remaining <= 0

              wait = remaining < POLL_INTERVAL ? remaining : POLL_INTERVAL
            end
            ready =
              begin
                @io.wait_readable(wait)
              rescue IOError
                return nil
              end
            next if ready

            return :timeout if deadline && (deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)) <= 0

            next
          end
          return nil if chunk.nil? || chunk == :wait_writable

          buffer << chunk
        end
        buffer
      end
    end

    module_function

    # Dial `url` and complete the RFC 6455 opening handshake.
    #
    # Raises Graphmind::WebSocket::Error on any failure — the transport turns
    # that into "stay detached" plus a rate-limited warning.
    def connect(url, connect_timeout: 0.3, handshake_timeout: 1.0)
      uri = parse_url(url)
      socket =
        begin
          Socket.tcp(uri[:host], uri[:port], connect_timeout: connect_timeout)
        rescue StandardError => e
          raise Error, "could not connect to #{uri[:host]}:#{uri[:port]} (#{e.class}: #{e.message})"
        end
      begin
        socket.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)
      rescue StandardError
        nil
      end

      io = uri[:tls] ? upgrade_tls(socket, uri[:host]) : socket
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + handshake_timeout
      key = Base64.strict_encode64(SecureRandom.bytes(16))
      leftover = nil
      begin
        io.write(handshake_request(uri, key))
        response = read_http_response(io, deadline)
        head, _, leftover = response.partition("\r\n\r\n")
        verify_handshake(head, key)
      rescue StandardError => e
        begin
          io.close
        rescue StandardError
          nil
        end
        raise e.is_a?(Error) ? e : Error.new("handshake failed (#{e.class}: #{e.message})")
      end
      Connection.new(io, mask: true, prebuffer: leftover)
    end

    def parse_url(url)
      uri = URI.parse(url.to_s)
      scheme = (uri.scheme || "ws").downcase
      raise Error, "unsupported scheme #{scheme.inspect} (expected ws or wss)" unless %w[ws wss].include?(scheme)
      raise Error, "missing host in #{url.inspect}" if uri.host.nil? || uri.host.empty?

      tls = scheme == "wss"
      path = uri.path.nil? || uri.path.empty? ? "/" : uri.path
      path = "#{path}?#{uri.query}" if uri.query
      {
        host: uri.host,
        port: uri.port || (tls ? 443 : 80),
        path: path,
        tls: tls
      }
    end

    def handshake_request(uri, key)
      host_header = uri[:port] == (uri[:tls] ? 443 : 80) ? uri[:host] : "#{uri[:host]}:#{uri[:port]}"
      [
        "GET #{uri[:path]} HTTP/1.1",
        "Host: #{host_header}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: #{key}",
        "Sec-WebSocket-Version: 13",
        "User-Agent: graphmind-ruby/#{Graphmind::VERSION}",
        "",
        ""
      ].join("\r\n")
    end

    def accept_token(key)
      Base64.strict_encode64(Digest::SHA1.digest(key + GUID))
    end

    def read_http_response(io, deadline)
      buffer = +"".b
      until buffer.include?("\r\n\r\n")
        raise Error, "handshake timed out" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

        chunk = io.read_nonblock(4096, exception: false)
        if chunk == :wait_readable
          remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          raise Error, "handshake timed out" if remaining <= 0

          io.wait_readable(remaining) or raise Error, "handshake timed out"
          next
        end
        raise Error, "connection closed during handshake" if chunk.nil?

        buffer << chunk
        raise Error, "handshake response too large" if buffer.bytesize > 64 * 1024
      end
      buffer
    end

    def verify_handshake(head, key)
      lines = head.to_s.split("\r\n")
      status = lines.first.to_s
      unless status =~ %r{\AHTTP/1\.1 101}
        raise Error, "viewer refused the upgrade (#{status.empty? ? 'no status line' : status})"
      end

      headers = {}
      lines[1..].to_a.each do |line|
        name, _, value = line.partition(":")
        headers[name.strip.downcase] = value.strip
      end
      unless headers["upgrade"].to_s.downcase == "websocket"
        raise Error, "missing Upgrade: websocket in the response"
      end
      unless headers["sec-websocket-accept"] == accept_token(key)
        raise Error, "bad Sec-WebSocket-Accept"
      end

      true
    end

    def upgrade_tls(socket, host)
      require "openssl"
      context = OpenSSL::SSL::SSLContext.new
      context.verify_mode = OpenSSL::SSL::VERIFY_PEER
      ssl = OpenSSL::SSL::SSLSocket.new(socket, context)
      ssl.hostname = host
      ssl.sync_close = true
      ssl.connect
      ssl
    rescue LoadError => e
      raise Error, "wss:// requires openssl (#{e.message})"
    end
  end
end
