# frozen_string_literal: true

require_relative "test_helper"

class TestHandshake < Minitest::Test
  def test_connects_and_completes_the_handshake
    viewer = new_viewer
    session = new_session(url: viewer.url)

    assert session.ready(5.0), "expected ready() to report attached"
    assert session.attached?

    hello = viewer.wait_for_frame("hello").first
    assert_equal 1, hello["gm"]
    assert_equal "*", hello["runId"]
    assert_equal 1, hello["payload"]["versions"]["protocol"]
    assert_equal Graphmind::VERSION, hello["payload"]["versions"]["client"]
    assert_equal %w[pause step inject retry abort run-claim], hello["payload"]["capabilities"]
    # First connection: nothing to prove continuity with yet.
    refute hello["payload"].key?("resumeToken")
    assert_valid_frame(hello)
  end

  # The run-claim capability: the debugger mints a token in `hello.ack`, and a
  # reconnecting client echoes it so its runs are recognised as still its own.
  # Without it, a reconnect looks like a different process and the debugger
  # refuses to let it keep streaming the run it was already streaming.
  def test_echoes_the_session_token_on_reconnect
    viewer = new_viewer
    session = new_session(url: viewer.url, retry_interval: 0.1)
    assert session.ready(5.0)
    assert_nil viewer.wait_for_frame("hello").first["payload"]["resumeToken"]

    viewer.kill_abruptly
    wait_until(label: "detach") { !session.attached? }
    assert session.ready(5.0), "expected the client to reconnect"

    hellos = viewer.wait_for_frame("hello", count: 2)
    assert_operator hellos.length, :>=, 2, "expected a second hello after the reconnect"
    assert_equal FakeViewer::SESSION_TOKEN, hellos.last["payload"]["resumeToken"]
  end

  def test_ready_is_false_when_nothing_is_listening
    # Port 1 is reserved and nothing local answers it.
    session = new_session(url: "ws://127.0.0.1:1/ingest", connect_timeout: 0.3)

    refute session.ready(1.0)
    refute session.attached?
  end

  def test_ready_is_false_when_disabled
    session = new_session(url: "ws://127.0.0.1:1/ingest", enabled: false)

    refute session.ready(0.2)
    refute session.attached?
  end

  def test_adopts_breakpoints_and_mode_from_the_ack
    viewer = new_viewer(breakpoints: [{ "kind" => "tool", "name" => "search" }], mode: "step")
    session = new_session(url: viewer.url)
    assert session.ready(5.0)

    node = Graphmind::GateNode.new("tool:search", "tool", "search")
    other = Graphmind::GateNode.new("tool:book", "tool", "book")
    engine = session.instance_variable_get(:@engine)

    assert engine.should_pause?("before", node)
    # step mode pauses at every before point, matching or not
    assert engine.should_pause?("before", other)
    assert_equal "step", engine.mode
  end

  def test_refuses_a_viewer_on_a_different_protocol_version
    viewer = new_viewer(ack_protocol: 99)
    session = new_session(url: viewer.url)

    refute session.ready(1.5)
    refute session.attached?
    assert(warnings.any? { |w| w.include?("protocol") }, "expected a protocol warning, got #{warnings.inspect}")
  end

  def test_survives_a_server_that_refuses_the_upgrade
    viewer = new_viewer(refuse_upgrade: true)
    session = new_session(url: viewer.url)

    refute session.ready(1.5)
    refute session.attached?
  end

  def test_stays_detached_when_the_viewer_never_acks
    viewer = new_viewer(auto_ack: false)
    session = new_session(url: viewer.url, handshake_timeout: 0.3)

    refute session.ready(1.5)
    refute session.attached?
    assert(warnings.any? { |w| w.include?("handshake") }, warnings.inspect)
  end

  def test_reconnects_after_the_viewer_disappears_and_replays_the_buffer
    viewer = new_viewer
    session = new_session(url: viewer.url, retry_interval: 0.2)
    assert session.ready(5.0)

    session.emit("node.started", {
                   "nodeId" => "tool:a", "kind" => "tool", "name" => "a", "instanceId" => "i1"
                 })
    viewer.wait_for_frame("node.started")

    viewer.kill_abruptly
    wait_until(label: "detach") { !session.attached? }

    # Emitted while dark: must survive in the ring buffer.
    session.emit("node.finished", {
                   "nodeId" => "tool:a", "instanceId" => "i1", "durationMs" => 1.0, "status" => "ok"
                 })

    assert session.ready(5.0), "expected a reconnect"
    frames = viewer.wait_for_frame("node.finished")
    assert_equal 1, frames.length
    assert_operator viewer.connection_count, :>=, 2
    # Replayed envelopes keep their original seq so the viewer can dedupe.
    started = viewer.frames_of("node.started")
    assert_operator started.length, :>=, 1
  end
end
