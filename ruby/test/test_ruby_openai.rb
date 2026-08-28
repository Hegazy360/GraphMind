# frozen_string_literal: true

require_relative "test_helper"

begin
  require "openai"
  require "faraday"
  require "graphmind/integrations/ruby_openai"
  RUBY_OPENAI_AVAILABLE = true
rescue LoadError
  RUBY_OPENAI_AVAILABLE = false
end

# Instrumentation for the `ruby-openai` gem, exercised against a Faraday test
# adapter: no API key, no network, real gem code path.
class TestRubyOpenAI < Minitest::Test
  CHAT_RESPONSE = {
    "id" => "chatcmpl-1",
    "model" => "gpt-4o-mini",
    "choices" => [{ "message" => { "role" => "assistant", "content" => "Hello there" } }],
    "usage" => { "prompt_tokens" => 11, "completion_tokens" => 3 }
  }.freeze

  def setup
    super
    skip("ruby-openai is not installed") unless RUBY_OPENAI_AVAILABLE
    @calls = 0
  end

  def test_a_chat_call_becomes_an_llm_node
    session, viewer = attached_session
    client = instrumented_client(session)

    response = client.chat(parameters: { model: "gpt-4o-mini",
                                         messages: [{ role: "user", content: "hi" }] })

    assert_equal "Hello there", response.dig("choices", 0, "message", "content")
    assert_equal 1, @calls

    started = viewer.wait_for_frame("node.started").first
    finished = viewer.wait_for_frame("node.finished").first
    assert_equal "llm:step", started["payload"]["nodeId"]
    assert_equal "llm", started["payload"]["kind"]
    assert_equal "gpt-4o-mini", started["payload"]["input"]["model"]
    assert_equal "hi", started["payload"]["input"]["messages"].first["content"]
    assert_equal "Hello there", finished["payload"]["output"]["text"]
    assert_equal({ "inputTokens" => 11, "outputTokens" => 3 }, finished["payload"]["usage"])
    assert_valid_frame(started)
    assert_valid_frame(finished)
  end

  def test_inject_at_the_before_gate_skips_the_request_entirely
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "llm", "point" => "before" }] }
    )
    client = instrumented_client(session)

    fake = { "choices" => [{ "message" => { "content" => "injected answer" } }] }
    worker = Thread.new do
      client.chat(parameters: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] })
    end

    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "inject", fake)

    assert_equal "injected answer", worker.value.dig("choices", 0, "message", "content")
    assert_equal 0, @calls, "no HTTP request may leave the process when a response is injected"
  end

  def test_retry_at_the_error_gate_re_sends_the_request
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "llm", "point" => "error" }] }
    )
    client = instrumented_client(session, fail_first: true)

    worker = Thread.new do
      client.chat(parameters: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] })
    end

    paused = viewer.wait_for_frame("exec.paused").first
    assert_equal "error", paused["payload"]["point"]
    viewer.resume(paused["payload"]["pauseId"], "retry")

    assert_equal "Hello there", worker.value.dig("choices", 0, "message", "content")
    assert_equal 2, @calls
  end

  # Streaming needs a real HTTP response: Faraday's test adapter never calls
  # `on_data`, which is the hook ruby-openai streams through. So this one talks
  # to a loopback socket serving Server-Sent Events.
  def test_streaming_deltas_reach_the_canvas_and_the_caller
    session, viewer = attached_session
    server = SSEServer.new
    client = instrumented_client(session, uri_base: server.uri_base)

    seen = []
    client.chat(parameters: {
                  model: "gpt-4o-mini",
                  messages: [{ role: "user", content: "hi" }],
                  stream: proc { |chunk, _bytesize| seen << chunk }
                })
    session.flush

    assert_equal 2, seen.length, "the caller's own stream proc must still run"
    assert_equal "Hel", seen.first.dig("choices", 0, "delta", "content")
    frame = viewer.wait_for_frame("node.token").first
    assert_equal "llm:step", frame["payload"]["nodeId"]
    assert_equal %w[Hel lo], frame["payload"]["deltas"].map { |d| d["v"] }
    assert_valid_frame(frame)
  ensure
    server&.close
  end

  def test_a_lambda_stream_handler_keeps_its_arity
    session, = attached_session
    server = SSEServer.new
    client = instrumented_client(session, uri_base: server.uri_base)

    seen = []
    handler = ->(chunk) { seen << chunk }
    client.chat(parameters: { model: "gpt-4o-mini", messages: [], stream: handler })

    assert_equal 2, seen.length
  ensure
    server&.close
  end

  def test_the_stream_wrapper_forwards_only_real_deltas
    extract = Graphmind::Integrations::RubyOpenAI.method(:delta_text)

    assert_equal "Hel", extract.call({ "choices" => [{ "delta" => { "content" => "Hel" } }] })
    assert_nil extract.call({ "choices" => [{ "delta" => {} }] })
    assert_nil extract.call({ "choices" => [{ "delta" => { "content" => "" } }] })
    assert_nil extract.call("not a hash")
    assert_equal "x", extract.call({ "type" => "response.output_text.delta", "delta" => "x" })
  end

  def test_detached_calls_are_untouched
    session = new_session(url: "ws://127.0.0.1:1/ingest")
    client = instrumented_client(session)

    response = client.chat(parameters: { model: "gpt-4o-mini", messages: [] })
    assert_equal "Hello there", response.dig("choices", 0, "message", "content")
    assert_equal 1, @calls
  end

  def test_instrumenting_twice_is_a_no_op
    session, viewer = attached_session
    client = instrumented_client(session)
    Graphmind::Integrations::RubyOpenAI.instrument(client, session)

    client.chat(parameters: { model: "gpt-4o-mini", messages: [] })
    viewer.wait_for_frame("node.finished")

    assert_equal 1, viewer.frames_of("node.started").length, "one node, not two"
  end

  def test_an_uninstrumented_client_in_the_same_process_is_untouched
    session, viewer = attached_session
    instrumented_client(session)
    plain = raw_client

    plain.chat(parameters: { model: "gpt-4o-mini", messages: [] })
    sleep 0.1

    assert_empty viewer.frames_of("node.started")
  end

  private

  def instrumented_client(session, **options)
    Graphmind::Integrations::RubyOpenAI.instrument(raw_client(**options), session)
  end

  def raw_client(fail_first: false, uri_base: nil)
    calls = -> { @calls += 1 }
    failed = [false]
    return OpenAI::Client.new(access_token: "test-key", log_errors: false, uri_base: uri_base) if uri_base

    OpenAI::Client.new(access_token: "test-key", log_errors: false) do |faraday|
      faraday.adapter(:test) do |stub|
        stub.post("/v1/chat/completions") do
          calls.call
          if fail_first && !failed[0]
            failed[0] = true
            [500, { "Content-Type" => "application/json" }, '{"error":{"message":"boom"}}']
          else
            [200, { "Content-Type" => "application/json" }, JSON.generate(CHAT_RESPONSE)]
          end
        end
      end
    end
  end

  # A one-shot HTTP server that answers any request with an SSE stream.
  class SSEServer
    BODY = [
      %(data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n),
      %(data: {"choices":[{"delta":{"content":"lo"}}]}\n\n),
      "data: [DONE]\n\n"
    ].join

    def initialize
      @server = TCPServer.new("127.0.0.1", 0)
      @thread = Thread.new { serve }
      @thread.report_on_exception = false
    end

    def uri_base = "http://127.0.0.1:#{@server.addr[1]}"

    def close
      @server.close
    rescue StandardError
      nil
    ensure
      @thread&.kill
    end

    private

    def serve
      loop do
        socket = @server.accept
        Thread.new(socket) do |io|
          request = +""
          request << io.readpartial(4096) until request.include?("\r\n\r\n")
          io.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n" \
                   "Content-Length: #{BODY.bytesize}\r\nConnection: close\r\n\r\n")
          io.write(BODY)
          io.flush
          io.close
        rescue StandardError
          nil
        end
      end
    rescue StandardError
      nil
    end
  end
end
