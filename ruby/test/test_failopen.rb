# frozen_string_literal: true

require_relative "test_helper"

# The two non-negotiable invariants: GraphMind fails open, and it never raises
# into the host application.
class TestFailOpen < Minitest::Test
  def test_disabled_session_never_touches_the_network
    session = new_session(url: "ws://127.0.0.1:1/ingest", enabled: false)

    refute session.enabled?
    session.emit("node.started", { "nodeId" => "tool:a", "kind" => "tool", "name" => "a",
                                   "instanceId" => "i" })
    assert_equal 0, session.stats.seq
    assert_equal 0, session.stats.buffered
    assert_same Graphmind::CONTINUE, session.gate("before", node)
  end

  def test_graphmind_disabled_env_beats_an_explicit_enable
    session = new_session(url: "ws://127.0.0.1:1/ingest", enabled: true,
                          env: { "GRAPHMIND_DISABLED" => "1" })

    refute session.enabled?
  end

  def test_production_like_env_disables_unless_opted_in
    refute Graphmind::Env.resolve_enabled(nil, { "RAILS_ENV" => "production" })
    assert Graphmind::Env.resolve_enabled(nil, { "RAILS_ENV" => "development" })
    assert Graphmind::Env.resolve_enabled(nil, { "RAILS_ENV" => "production", "GRAPHMIND" => "1" })
    # The first *set* variable decides — an unset one does not veto.
    refute Graphmind::Env.resolve_enabled(nil, { "RAILS_ENV" => "prod", "NODE_ENV" => "development" })
    assert Graphmind::Env.resolve_enabled(true, { "RAILS_ENV" => "production" })
    refute Graphmind::Env.resolve_enabled(true, { "GRAPHMIND_DISABLED" => "1" })
  end

  def test_url_resolution
    assert_equal "ws://127.0.0.1:4747/ingest", Graphmind::Env.resolve_url(nil, {})
    assert_equal "ws://host:9/x", Graphmind::Env.resolve_url(nil, { "GRAPHMIND_URL" => "ws://host:9/x" })
    assert_equal "ws://explicit/x",
                 Graphmind::Env.resolve_url("ws://explicit/x", { "GRAPHMIND_URL" => "ws://host:9/x" })
  end

  def test_detached_gate_is_a_no_op
    session = new_session(url: "ws://127.0.0.1:1/ingest")

    assert_same Graphmind::CONTINUE, session.gate("before", node)
    assert_same Graphmind::CONTINUE, session.gate("error", node)
  end

  def test_a_wrapped_tool_still_works_with_no_debugger_anywhere
    session = new_session(url: "ws://127.0.0.1:1/ingest")
    tool = Graphmind::Wrap.gate_callable(->(a, b) { a + b }, -> { session }, name: "add")

    assert_equal 3, tool.call(1, 2)
    assert_raises(ZeroDivisionError) { Graphmind::Wrap.gate_callable(-> { 1 / 0 }, -> { session }).call }
  end

  def test_the_host_error_propagates_unchanged_through_a_run
    session = new_session(url: "ws://127.0.0.1:1/ingest")

    error = assert_raises(ArgumentError) do
      session.run("boom") { raise ArgumentError, "host error" }
    end
    assert_equal "host error", error.message
  end

  def test_the_default_warner_actually_prints
    # Regression: a bare `warn(message)` inside Warner binds to Warner#warn
    # (arity 2), raises ArgumentError, and gets swallowed — so the default sink
    # printed nothing at all and every loss warning was invisible.
    warner = Graphmind::Warner.new(60.0)
    captured = capture_stderr { warner.warn("k", "a message the developer must see") }

    assert_includes captured, "[graphmind] a message the developer must see"
  end

  def test_the_warner_rate_limits_per_key
    warner = Graphmind::Warner.new(60.0)
    captured = capture_stderr do
      3.times { warner.warn("same", "repeated") }
      warner.warn("other", "different")
    end

    assert_equal 1, captured.scan("repeated").length
    assert_equal 1, captured.scan("different").length
  end

  def test_a_broken_logger_cannot_break_the_host
    session = Graphmind::Session.new(url: "ws://127.0.0.1:1/ingest", enabled: true, env: {},
                                     logger: ->(_m) { raise "logger exploded" })
    @sessions << session

    session.emit("node.started", { "nodeId" => "n", "kind" => "tool", "name" => "n",
                                   "instanceId" => "i" })
    # 2 = the implicit run.started plus the node.started.
    assert_equal 2, session.stats.seq
  ensure
    session&.dispose
  end

  def test_unserializable_input_does_not_break_an_emit
    session, viewer = attached_session

    weird = Object.new
    def weird.inspect = "#<weird>"

    tool = Graphmind::Wrap.gate_callable(->(_x) { "ok" }, -> { session }, name: "weird")
    assert_equal "ok", tool.call(weird)

    started = viewer.wait_for_frame("node.started").first
    assert_equal "#<weird>", started["payload"]["input"]["_x"]
    assert_valid_frame(started)
  end

  def test_a_viewer_sending_garbage_is_tolerated
    session, viewer = attached_session

    viewer.live_connections.each { |c| c.send_text("not json at all") }
    viewer.live_connections.each { |c| c.send_text('{"gm":1,"seq":0,"ts":0,"runId":"*","type":"unheard.of","payload":{}}') }
    sleep 0.1

    assert session.attached?, "garbage frames must not detach the client"
    session.emit("node.started", { "nodeId" => "n", "kind" => "tool", "name" => "n",
                                   "instanceId" => "i" })
    viewer.wait_for_frame("node.started")
  end

  def test_resume_for_an_unknown_pause_id_is_ignored
    session, viewer = attached_session

    viewer.resume("pause_does_not_exist", "continue")
    sleep 0.1

    assert session.attached?
  end

  def test_dispose_is_idempotent
    session, = attached_session

    session.dispose
    session.dispose
    assert session.disposed?
  end

  def test_the_ring_buffer_bounds_memory_while_detached
    session = new_session(url: "ws://127.0.0.1:1/ingest", buffer_size: 10)

    20.times do |i|
      session.emit("node.started", { "nodeId" => "n#{i}", "kind" => "tool", "name" => "n",
                                     "instanceId" => "i#{i}" })
    end

    stats = session.stats
    # 21 frames total: the implicit run.started plus 20 node.started.
    assert_equal 10, stats.buffered
    assert_equal 11, stats.dropped
    assert(warnings.any? { |w| w.include?("dropped") }, "loss must reach the developer: #{warnings.inspect}")
  end

  def test_the_byte_bound_also_sheds_oldest_first
    buffer = Graphmind::RingBuffer.new(1000, 300)
    5.times { |i| buffer.push("x" * 100 + i.to_s) }

    assert_operator buffer.size, :<=, 3
    assert_operator buffer.dropped, :>=, 2
  end

  private

  def node = Graphmind::GateNode.new("tool:x", "tool", "x")

  def capture_stderr
    require "stringio"
    previous = $stderr
    $stderr = StringIO.new
    yield
    $stderr.string
  ensure
    $stderr = previous
  end
end
