# frozen_string_literal: true

require_relative "test_helper"

# Runs, spans, tool wrappers and node identity.
class TestWrap < Minitest::Test
  def test_run_emits_the_full_lifecycle_with_stable_ids
    session, viewer = attached_session

    value = session.run("handle-ticket", meta: { "ticket" => 42 }) { |ctx| ctx.run_id }

    viewer.wait_for_frame("run.finished")
    started = viewer.frames_of("run.started").first
    node_started = viewer.frames_of("node.started").first
    node_finished = viewer.frames_of("node.finished").first
    finished = viewer.frames_of("run.finished").first

    assert_equal value, started["runId"]
    assert_equal "handle-ticket", started["payload"]["meta"]["name"]
    assert_equal 42, started["payload"]["meta"]["ticket"]
    assert_equal "agent:handle-ticket", node_started["payload"]["nodeId"]
    assert_equal "agent", node_started["payload"]["kind"]
    assert_equal value, node_started["payload"]["instanceId"]
    assert_equal value, node_finished["payload"]["instanceId"]
    assert_equal "ok", node_finished["payload"]["status"]
    assert_equal "ok", finished["payload"]["status"]
    [started, node_started, node_finished, finished].each { |f| assert_valid_frame(f) }
  end

  def test_run_records_an_error_and_still_raises
    session, viewer = attached_session

    assert_raises(RuntimeError) { session.run("bad") { raise "kaboom" } }

    viewer.wait_for_frame("run.finished")
    finished = viewer.frames_of("run.finished").first
    assert_equal "error", finished["payload"]["status"]
    assert_equal "RuntimeError", finished["payload"]["error"]["name"]
    assert_equal "kaboom", finished["payload"]["error"]["message"]
    assert_valid_frame(finished)
  end

  def test_run_context_is_visible_inside_and_gone_outside
    session, = attached_session

    assert_nil session.current_run
    inner = session.run("scoped") { session.current_run }
    refute_nil inner
    assert_equal "scoped", inner.name
    assert_nil session.current_run
  end

  def test_nested_runs_restore_the_outer_context
    session, = attached_session

    outer_after_inner = session.run("outer") do |outer|
      session.run("inner") { |inner| refute_equal outer.run_id, inner.run_id }
      session.current_run
    end

    assert_equal "outer", outer_after_inner.name
  end

  def test_events_outside_a_run_go_to_one_implicit_run
    session, viewer = attached_session

    session.emit("node.started", { "nodeId" => "tool:a", "kind" => "tool", "name" => "a",
                                   "instanceId" => "i1" })
    session.emit("node.started", { "nodeId" => "tool:b", "kind" => "tool", "name" => "b",
                                   "instanceId" => "i2" })

    viewer.wait_for_frame("node.started", count: 2)
    run_ids = viewer.frames_of("node.started").map { |f| f["runId"] }.uniq
    assert_equal 1, run_ids.length

    implicit = viewer.frames_of("run.started").first
    assert_equal true, implicit["payload"]["meta"]["implicit"]
  end

  def test_a_wrapped_tool_emits_stable_node_ids_and_fresh_instance_ids
    session, viewer = attached_session

    tool = Graphmind::Wrap.gate_callable(->(query:) { "hits for #{query}" }, -> { session },
                                         name: "search")
    session.run("r") do
      tool.call(query: "one")
      tool.call(query: "two")
    end

    viewer.wait_for_frame("node.finished", count: 3) # 2 tools + the agent node
    tool_starts = viewer.frames_of("node.started").select { |f| f["payload"]["kind"] == "tool" }

    assert_equal 2, tool_starts.length
    assert_equal ["tool:search"], tool_starts.map { |f| f["payload"]["nodeId"] }.uniq
    assert_equal 2, tool_starts.map { |f| f["payload"]["instanceId"] }.uniq.length
    assert_equal "one", tool_starts.first["payload"]["input"]["query"]
    tool_starts.each { |f| assert_valid_frame(f) }
  end

  def test_wrap_tools_keeps_the_shape_it_was_given
    session, = attached_session

    hash = session_wrap(session, { search: ->(q) { "h:#{q}" }, book: ->(q) { "b:#{q}" } })
    assert_instance_of Hash, hash
    assert_equal %i[search book], hash.keys
    assert_equal "h:x", hash[:search].call("x")
    assert_equal "search", hash[:search].name

    array = session_wrap(session, [->(q) { q }])
    assert_instance_of Array, array
    assert_equal "y", array.first.call("y")

    single = session_wrap(session, ->(q) { q.upcase })
    assert_equal "Z", single.call("z")
  end

  def test_wrap_tools_does_not_double_wrap
    session, = attached_session
    once = session_wrap(session, ->(q) { q })
    twice = session_wrap(session, once)

    assert_same once, twice
  end

  def test_wrap_method_gates_a_method_in_place
    session, viewer = attached_session

    service = Object.new
    def service.lookup(id) = "record-#{id}"

    Graphmind::Wrap.wrap_method(service, :lookup, -> { session })
    assert_equal "record-7", service.lookup(7)

    started = viewer.wait_for_frame("node.started").first
    assert_equal "tool:lookup", started["payload"]["nodeId"]
    assert_equal({ "id" => 7 }, started["payload"]["input"])
  end

  def test_the_instrument_mixin_gates_instance_methods
    session, viewer = attached_session
    holder = -> { session }

    klass = Class.new do
      include Graphmind::Instrument
      graphmind_tool :search, session: holder

      def search(query, limit: 5) = "#{query}:#{limit}"
    end

    assert_equal "flights:3", klass.new.search("flights", limit: 3)

    started = viewer.wait_for_frame("node.started").first
    assert_equal "tool:search", started["payload"]["nodeId"]
    assert_equal "flights", started["payload"]["input"]["query"]
    assert_equal 3, started["payload"]["input"]["limit"]
  end

  def test_span_is_a_gated_timed_node
    session, viewer = attached_session

    value = session_client(session).span("plan", kind: "chain", input: { "goal" => "book" }) do |span|
      span.output = { "steps" => 3 }
      :ignored
    end

    assert_equal({ "steps" => 3 }, value)
    started = viewer.wait_for_frame("node.started").first
    finished = viewer.wait_for_frame("node.finished").first
    assert_equal "chain:plan", started["payload"]["nodeId"]
    assert_equal "chain", started["payload"]["kind"]
    assert_equal({ "goal" => "book" }, started["payload"]["input"])
    assert_equal({ "steps" => 3 }, finished["payload"]["output"])
    assert_valid_frame(started)
    assert_valid_frame(finished)
  end

  def test_span_returns_the_block_value_when_no_output_is_set
    session, = attached_session
    assert_equal 42, session_client(session).span("compute") { 42 }
  end

  def test_graph_hint_pre_announces_structure
    session, viewer = attached_session

    session.graph_hint([{ "nodeId" => "tool:search", "kind" => "tool", "name" => "search" }])
    hint = viewer.wait_for_frame("graph.hint").first

    assert_equal "tool:search", hint["payload"]["nodes"].first["nodeId"]
    assert_valid_frame(hint)
  end

  def test_token_deltas_are_batched_into_node_token
    session, viewer = attached_session

    session.push_token("llm:step", "text", "Hel")
    session.push_token("llm:step", "text", "lo")
    session.flush

    frame = viewer.wait_for_frame("node.token").first
    assert_equal "llm:step", frame["payload"]["nodeId"]
    assert_equal %w[Hel lo], frame["payload"]["deltas"].map { |d| d["v"] }
    assert_valid_frame(frame)
  end

  private

  def session_wrap(session, tools) = Graphmind::Wrap.wrap_tools(tools, -> { session })

  def session_client(session)
    client = Graphmind::Client.allocate
    client.instance_variable_set(:@session, session)
    client.instance_variable_set(:@session_of, -> { session })
    client
  end
end
