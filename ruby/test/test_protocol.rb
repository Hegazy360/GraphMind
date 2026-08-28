# frozen_string_literal: true

require_relative "test_helper"

# The wire contract, checked against packages/schema/schema.json rather than
# against this gem's idea of it.
class TestProtocol < Minitest::Test
  def test_every_event_type_this_gem_emits_validates_against_schema_json
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "search", "point" => "before" }] }
    )

    tool = Graphmind::Wrap.gate_callable(->(query:) { { "hits" => [query] } }, -> { session },
                                         name: "search")
    worker = Thread.new do
      session.run("full-lifecycle", meta: { "env" => "test" }) do
        session.graph_hint([{ "nodeId" => "tool:search", "kind" => "tool", "name" => "search" }])
        session.push_token("llm:step", "text", "hello")
        session.flush
        tool.call(query: "flights")
      end
    end

    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "continue")
    worker.join
    viewer.wait_for_frame("run.finished")

    seen = viewer.received.map { |f| f["type"] }.uniq.sort
    expected = %w[exec.paused exec.resumed graph.hint hello node.finished node.started node.token
                  run.finished run.started]
    assert_equal expected, seen

    viewer.received.each { |frame| assert_valid_frame(frame) }
  end

  def test_node_error_validates
    session, viewer = attached_session
    tool = Graphmind::Wrap.gate_callable(-> { raise "nope" }, -> { session }, name: "boom")

    assert_raises(RuntimeError) { tool.call }
    frame = viewer.wait_for_frame("node.error").first

    assert_equal "tool:boom", frame["payload"]["nodeId"]
    refute_nil frame["payload"]["instanceId"]
    assert_valid_frame(frame)
  end

  def test_envelope_shape
    envelope = Graphmind::Protocol.create_envelope("run.started", { "app" => "a" }, 7, "run_1")

    assert_equal 1, envelope["gm"]
    assert_equal 7, envelope["seq"]
    assert_equal "run_1", envelope["runId"]
    assert_equal "run.started", envelope["type"]
    assert_kind_of Integer, envelope["ts"]
  end

  def test_parse_rejects_a_different_protocol_version
    result = Graphmind::Protocol.parse_envelope_json(
      '{"gm":2,"seq":0,"ts":0,"runId":"*","type":"hello.ack","payload":{}}'
    )
    assert_equal :version_mismatch, result.kind
    assert_equal 2, result.received
  end

  def test_parse_tolerates_unknown_types
    result = Graphmind::Protocol.parse_envelope_json(
      '{"gm":1,"seq":0,"ts":0,"runId":"*","type":"from.the.future","payload":{}}'
    )
    assert_equal :unknown_type, result.kind
  end

  def test_parse_rejects_malformed_frames
    assert_equal :invalid, Graphmind::Protocol.parse_envelope_json("{").kind
    assert_equal :invalid, Graphmind::Protocol.parse_envelope_json("[]").kind
    assert_equal :invalid, Graphmind::Protocol.parse_envelope_json('{"gm":1}').kind
    assert_equal :invalid,
                 Graphmind::Protocol.parse_envelope_json('{"gm":1,"type":"hello","runId":"*"}').kind
  end

  def test_node_kinds_match_the_schema_including_the_mcp_additions
    assert_equal %w[agent llm tool chain retriever server resource prompt custom],
                 Graphmind::Protocol::NODE_KINDS
  end

  def test_the_websocket_codec_round_trips_masked_and_unmasked_frames
    ["", "hi", "x" * 200, "y" * 70_000, "é" * 100].each do |payload|
      masked = Graphmind::WebSocket::Frame.encode(payload, mask: true)
      unmasked = Graphmind::WebSocket::Frame.encode(payload, mask: false)

      assert_equal payload.dup.force_encoding(Encoding::BINARY),
                   decode_single(masked).force_encoding(Encoding::BINARY)
      assert_equal payload.dup.force_encoding(Encoding::BINARY),
                   decode_single(unmasked).force_encoding(Encoding::BINARY)
    end
  end

  private

  # Round-trip one encoded frame through the real Connection reader.
  # StringIO, not IO.pipe: a 70 KB frame would deadlock on a 64 KB pipe buffer
  # with nobody draining it.
  def decode_single(bytes)
    require "stringio"
    io = StringIO.new(bytes.dup.force_encoding(Encoding::BINARY))
    Graphmind::WebSocket::Connection.new(io, mask: false).read_message
  end
end
