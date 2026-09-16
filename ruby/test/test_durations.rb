# frozen_string_literal: true

require_relative "test_helper"

# Durations: sub-millisecond, monotonic, and with the debugger's hold time
# reported separately from the node's own time (`heldMs`).
#
# Cross-SDK parity with packages/client/test/held-time.test.ts and
# python/tests/test_durations.py: the same contract, the same numbers.
class TestDurations < Minitest::Test
  RUN = "run-1"

  # A clock the test advances by hand.
  class Manual
    attr_accessor :t

    def initialize = @t = 1000.0
    def now = @t
    def advance(ms) = @t += ms
    def to_proc = method(:now).to_proc
  end

  def teardown
    Graphmind::Clock.override = nil
    super
  end

  def decimals(value)
    text = value.to_s
    text.include?(".") ? text.split(".").last.length : 0
  end

  def make_ledger(max_instances: nil)
    manual = Manual.new
    opts = { clock: -> { manual.now } }
    opts[:max_instances] = max_instances if max_instances
    [Graphmind::HeldLedger.new(**opts), manual]
  end

  # -- clock -----------------------------------------------------------------

  def test_normalize_rounds_to_two_decimals_and_clamps
    clock = Graphmind::Clock
    assert_in_delta 1.23, clock.normalize_duration_ms(1.23456), 0.0
    assert_equal 0.0, clock.normalize_duration_ms(0.004)
    assert_in_delta 0.01, clock.normalize_duration_ms(0.006), 0.0
    assert_equal 38_100.0, clock.normalize_duration_ms(38_100.004)
    assert_equal 0.0, clock.normalize_duration_ms(-1)
    assert_equal 0.0, clock.normalize_duration_ms(-0.001)
    assert_equal 0.0, clock.normalize_duration_ms(Float::NAN)
    assert_equal 0.0, clock.normalize_duration_ms(Float::INFINITY)
    assert_equal 0.0, clock.normalize_duration_ms(-Float::INFINITY)
    assert_equal 0.0, clock.normalize_duration_ms(nil)
    assert_equal 0.0, clock.normalize_duration_ms("12")
    assert_equal 7.0, clock.normalize_duration_ms(7)
    seed = 42
    2000.times do
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      assert_operator decimals(clock.normalize_duration_ms(seed / 2_147_483_648.0 * 100_000)), :<=, 2
    end
  end

  def test_monotonic_clock_is_sub_millisecond_and_a_sleep_is_non_zero
    a = Graphmind::Clock.now_ms
    spin = (0...20_000).sum { |i| i % 7 }
    b = Graphmind::Clock.now_ms
    assert_operator spin, :>, 0
    assert_operator b, :>=, a
    refute(a == a.floor && b == b.floor && a == b, "two reads should not be pinned to the same integer")

    started = Graphmind::Clock.now_ms
    sleep 0.002
    elapsed = Graphmind::Clock.elapsed_ms(started)
    assert_operator elapsed, :>, 0
    assert_operator elapsed, :<, 1000
  end

  def test_injected_clock_and_backwards_clock
    manual = Manual.new
    manual.t = 100.0
    Graphmind::Clock.override = -> { manual.t }
    started = Graphmind::Clock.now_ms
    manual.t = 100.123456
    assert_in_delta 0.12, Graphmind::Clock.elapsed_ms(started), 0.0
    manual.t = 99.0
    assert_equal 0.0, Graphmind::Clock.elapsed_ms(started)
    Graphmind::Clock.override = nil
    refute_equal 99.0, Graphmind::Clock.now_ms
    assert_in_delta 2.35, Graphmind::Clock.elapsed_ms(10, 12.345), 0.0
    assert_equal 0.0, Graphmind::Clock.elapsed_ms(10, 5)
  end

  # -- ledger ----------------------------------------------------------------

  def test_ledger_credits_a_before_hold_to_the_instance_it_precedes
    ledger, m = make_ledger
    ledger.started(RUN, "tool:search", "c1")
    ledger.hold_opened("p1", RUN, "tool:search", "before")
    m.advance(38_100.123)
    ledger.hold_closed("p1")
    assert_in_delta 38_100.12, ledger.finished(RUN, "tool:search", "c1"), 0.0
    assert_equal 0, ledger.tracked_instances
  end

  def test_ledger_sums_holds_across_a_retry_loop_and_peek_includes_open_hold
    ledger, m = make_ledger
    ledger.started(RUN, "tool:flaky", "c1")
    ledger.hold_opened("p1", RUN, "tool:flaky", "before")
    m.advance(1000)
    ledger.hold_closed("p1")
    ledger.errored(RUN, "tool:flaky", "c1")
    ledger.hold_opened("p2", RUN, "tool:flaky", "error")
    m.advance(2000)
    assert_equal 3000, ledger.peek(RUN, "tool:flaky", "c1")
    ledger.hold_closed("p2")
    ledger.hold_opened("p3", RUN, "tool:flaky", "before")
    m.advance(300)
    ledger.hold_closed("p3")
    assert_equal 3300, ledger.finished(RUN, "tool:flaky", "c1")
  end

  def test_ledger_zero_for_unheld_nil_for_unknown_newest_when_unnamed
    ledger, m = make_ledger
    ledger.started(RUN, "tool:a", "i1")
    assert_equal 0.0, ledger.finished(RUN, "tool:a", "i1")
    assert_nil ledger.finished(RUN, "tool:a", "ghost")
    assert_nil ledger.peek(RUN, "tool:a", nil)
    ledger.started(RUN, "tool:a", "i1")
    assert_nil ledger.finished(RUN, "tool:a", "i2") # named-but-unknown is not "the newest"
    assert_equal 0.0, ledger.finished(RUN, "tool:a", "i1")

    ledger.started(RUN, "llm:step", "s1")
    ledger.started(RUN, "llm:step", "s2")
    ledger.hold_opened("p1", RUN, "llm:step", "before")
    m.advance(10)
    ledger.hold_closed("p1")
    assert_equal 10, ledger.finished(RUN, "llm:step", nil)
    assert_equal 0, ledger.finished(RUN, "llm:step", nil)
    assert_nil ledger.finished(RUN, "llm:step", nil)
  end

  def test_ledger_ignores_holds_that_belong_to_nobody
    ledger, m = make_ledger
    ledger.started(RUN, "tool:a", "i1")
    assert_equal 0, ledger.finished(RUN, "tool:a", "i1")
    ledger.hold_opened("p1", RUN, "tool:a", "error") # gate after finish
    m.advance(40_000)
    ledger.hold_closed("p1")
    assert_equal 0, ledger.open_holds
    ledger.started(RUN, "tool:a", "i2")
    assert_equal 0, ledger.finished(RUN, "tool:a", "i2")
    ledger.hold_opened("p2", RUN, "custom:never", "before")
    ledger.hold_closed("p2")
    ledger.hold_closed("unknown")
    assert_equal 0, ledger.open_holds
  end

  def test_ledger_open_hold_at_finish_is_credited_up_to_now
    ledger, m = make_ledger
    ledger.started(RUN, "tool:a", "i1")
    ledger.hold_opened("p1", RUN, "tool:a", "before")
    m.advance(700)
    assert_equal 700, ledger.finished(RUN, "tool:a", "i1")
    m.advance(9999)
    ledger.hold_closed("p1")
    ledger.started(RUN, "tool:a", "i2")
    assert_equal 0, ledger.finished(RUN, "tool:a", "i2")
  end

  def test_ledger_backwards_clock_never_negative
    ledger, m = make_ledger
    ledger.started(RUN, "tool:a", "i1")
    ledger.hold_opened("p1", RUN, "tool:a", "before")
    m.t = 900.0
    ledger.hold_closed("p1")
    assert_equal 0, ledger.finished(RUN, "tool:a", "i1")
  end

  def test_ledger_isolation
    ledger, m = make_ledger
    ledger.started("a", "tool:x", "i1")
    ledger.started("b", "tool:x", "i1")
    ledger.started("a", "tool:y", "i1")
    ledger.hold_opened("p1", "a", "tool:x", "before")
    m.advance(500)
    ledger.hold_closed("p1")
    assert_equal 0, ledger.finished("b", "tool:x", "i1")
    assert_equal 0, ledger.finished("a", "tool:y", "i1")
    ledger.started("a", "tool:x", "i1") # restarted id: from zero
    assert_equal 1, ledger.tracked_instances
    assert_equal 0, ledger.finished("a", "tool:x", "i1")
  end

  def test_ledger_child_holds_credit_open_ancestors_as_a_union
    ledger, m = make_ledger
    ledger.started(RUN, "agent:a", "r1")
    ledger.started(RUN, "llm:step", "s1", "agent:a")
    assert_equal 0, ledger.finished(RUN, "llm:step", "s1")
    ledger.started(RUN, "tool:weather", "w1", "llm:step") # step closed: walk through it
    ledger.hold_opened("pw", RUN, "tool:weather", "before")
    m.advance(1000)
    ledger.started(RUN, "tool:currency", "c1", "agent:a")
    ledger.hold_opened("pc", RUN, "tool:currency", "before")
    m.advance(2000)
    ledger.hold_closed("pw")
    m.advance(500)
    ledger.hold_closed("pc")
    assert_equal 3000, ledger.finished(RUN, "tool:weather", "w1")
    assert_equal 2500, ledger.finished(RUN, "tool:currency", "c1")
    assert_equal 3500, ledger.finished(RUN, "agent:a", "r1") # not 5500
  end

  def test_ledger_run_root_is_credited_without_a_declared_parent
    ledger, m = make_ledger
    ledger.started(RUN, "agent:agent", RUN) # the agent node's instanceId IS the runId
    ledger.started(RUN, "tool:search", "c1") # Wrap emits no parentId
    ledger.hold_opened("p1", RUN, "tool:search", "before")
    m.advance(38_100)
    ledger.hold_closed("p1")
    assert_equal 38_100, ledger.finished(RUN, "tool:search", "c1")
    assert_equal 38_100, ledger.finished(RUN, "agent:agent", RUN)
    # reached through parentId as well: still once
    ledger.started(RUN, "agent:agent", RUN)
    ledger.started(RUN, "tool:t", "t1", "agent:agent")
    ledger.hold_opened("p2", RUN, "tool:t", "before")
    m.advance(100)
    ledger.hold_closed("p2")
    assert_equal 100, ledger.finished(RUN, "agent:agent", RUN)
    assert_equal 100, ledger.finished(RUN, "tool:t", "t1")
    # a root that already finished is not credited
    ledger.started(RUN, "tool:u", "u1")
    ledger.hold_opened("p3", RUN, "tool:u", "before")
    m.advance(5)
    ledger.hold_closed("p3")
    assert_equal 5, ledger.finished(RUN, "tool:u", "u1")
    assert_equal 0, ledger.tracked_instances
  end

  def test_ledger_hold_after_finish_still_credits_open_ancestors_and_root
    # A callback-style after/error gate fires AFTER node.finished: the hold is
    # outside every instance of the tool, but the chain and the agent are
    # still running while the developer looks.
    ledger, m = make_ledger
    ledger.started(RUN, "agent:graph", RUN)
    ledger.started(RUN, "chain:node", "n1", "agent:graph")
    ledger.started(RUN, "tool:t", "t1", "chain:node")
    assert_equal 0, ledger.finished(RUN, "tool:t", "t1")
    ledger.hold_opened("p1", RUN, "tool:t", "error")
    assert_equal 1, ledger.open_holds
    m.advance(40_000)
    ledger.hold_closed("p1")
    assert_equal 0, ledger.open_holds
    ledger.started(RUN, "tool:t", "t2", "chain:node")
    assert_equal 0, ledger.finished(RUN, "tool:t", "t2")
    assert_equal 40_000, ledger.finished(RUN, "chain:node", "n1")
    assert_equal 40_000, ledger.finished(RUN, "agent:graph", RUN)
    # A gate for a node that never started still counts for an open root.
    ledger.started(RUN, "agent:graph", RUN)
    ledger.hold_opened("p2", RUN, "custom:raw-gate", "before")
    m.advance(250)
    ledger.hold_closed("p2")
    assert_nil ledger.finished(RUN, "custom:raw-gate", nil)
    assert_equal 250, ledger.finished(RUN, "agent:graph", RUN)
  end

  def test_ledger_parent_cycle_and_late_parent
    ledger, m = make_ledger
    ledger.started(RUN, "a", "a1", "b")
    ledger.started(RUN, "b", "b1", "a")
    ledger.hold_opened("p1", RUN, "a", "before")
    m.advance(10)
    ledger.hold_closed("p1")
    assert_equal 10, ledger.finished(RUN, "a", "a1")
    assert_equal 10, ledger.finished(RUN, "b", "b1")
    ledger.started(RUN, "tool:t", "t1", "agent:late")
    ledger.hold_opened("p2", RUN, "tool:t", "before")
    m.advance(100)
    ledger.started(RUN, "agent:late", "r1")
    m.advance(400)
    ledger.hold_closed("p2")
    assert_equal 0, ledger.finished(RUN, "agent:late", "r1")
    assert_equal 500, ledger.finished(RUN, "tool:t", "t1")
  end

  def test_ledger_overlapping_instance_heuristics
    ledger, m = make_ledger
    ledger.started(RUN, "tool:s", "A")
    ledger.hold_opened("pA", RUN, "tool:s", "before")
    ledger.started(RUN, "tool:s", "B")
    ledger.hold_opened("pB", RUN, "tool:s", "before")
    m.advance(2000)
    ledger.hold_closed("pA")
    m.advance(2000)
    ledger.hold_closed("pB")
    assert_equal 2000, ledger.finished(RUN, "tool:s", "A")
    assert_equal 4000, ledger.finished(RUN, "tool:s", "B")

    ledger.started(RUN, "tool:t", "A")
    ledger.started(RUN, "tool:t", "B")
    ledger.errored(RUN, "tool:t", "A")
    ledger.hold_opened("pe", RUN, "tool:t", "error")
    m.advance(700)
    ledger.hold_closed("pe")
    ledger.hold_opened("pf", RUN, "tool:t", "after")
    m.advance(300)
    ledger.hold_closed("pf")
    assert_equal 1000, ledger.finished(RUN, "tool:t", "A")
    assert_equal 0, ledger.finished(RUN, "tool:t", "B")
  end

  def test_ledger_is_bounded
    ledger, m = make_ledger(max_instances: 3)
    ledger.started(RUN, "tool:a", "i1")
    ledger.hold_opened("p1", RUN, "tool:a", "before")
    [2, 3, 4].each { |i| ledger.started(RUN, "tool:a", "i#{i}") }
    assert_equal 3, ledger.tracked_instances
    assert_equal 0, ledger.open_holds
    assert_nil ledger.finished(RUN, "tool:a", "i1")
    m.advance(1000)
    ledger.hold_closed("p1")
    assert_equal 0, ledger.finished(RUN, "tool:a", "i4")

    big = Graphmind::HeldLedger.new(max_instances: 500)
    5000.times { |i| big.started(RUN, "tool:#{i % 17}", "i#{i}", "agent:a") }
    assert_equal 500, big.tracked_instances
  end

  def test_ledger_thread_safety_smoke
    ledger, = make_ledger
    errors = Queue.new
    threads = 8.times.map do |n|
      Thread.new do
        500.times do |i|
          ledger.started(RUN, "tool:#{n}", "i#{i}", "agent:a")
          ledger.hold_opened("p#{n}-#{i}", RUN, "tool:#{n}", "before")
          ledger.hold_closed("p#{n}-#{i}")
          ledger.finished(RUN, "tool:#{n}", "i#{i}")
        end
      rescue StandardError => e
        errors << e
      end
    end
    threads.each { |t| t.join(10) }
    assert_empty errors.size.times.map { errors.pop }
    assert_equal 0, ledger.tracked_instances
  end

  # -- through the public API -------------------------------------------------

  def finished_for(viewer, node_id, instance_id = nil)
    viewer.wait_until(label: "node.finished for #{node_id}") do
      viewer.frames_of("node.finished").any? do |f|
        f["payload"]["nodeId"] == node_id && (instance_id.nil? || f["payload"]["instanceId"] == instance_id)
      end
    end
    viewer.frames_of("node.finished").find do |f|
      f["payload"]["nodeId"] == node_id && (instance_id.nil? || f["payload"]["instanceId"] == instance_id)
    end
  end

  def test_a_one_millisecond_tool_reports_a_non_zero_fractional_duration
    session, viewer = attached_session
    blink = Graphmind::Wrap.gate_callable(-> { sleep 0.001; "ok" }, -> { session }, name: "blink")

    session.run("agent") { assert_equal "ok", blink.call }

    finished = finished_for(viewer, "tool:blink")
    duration = finished["payload"]["durationMs"]
    assert_kind_of Float, duration
    assert_operator duration, :>, 0, "Time.now-style clocks said 0 here"
    assert_operator duration, :<, 1000
    assert_operator decimals(duration), :<=, 2
    # Nothing was held: heldMs is present and exactly 0 (measured, not missing).
    assert_equal 0, finished["payload"]["heldMs"]
    assert_valid_frame(finished)
    agent = finished_for(viewer, "agent:agent")
    assert_operator agent["payload"]["durationMs"], :>, 0
    assert_equal 0, agent["payload"]["heldMs"]
  end

  def test_held_time_is_reported_separately_from_duration
    # The load-bearing product claim: a developer who thinks for 38 s at a
    # breakpoint does not turn a 2 ms tool into a 38 s one.
    session, viewer = attached_session(viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "search" }] })
    manual = Manual.new
    Graphmind::Clock.override = -> { manual.now } # every duration AND the ledger read this clock
    search = Graphmind::Wrap.gate_callable(->(q) { manual.advance(2.4); q }, -> { session }, name: "search")

    worker = Thread.new { session.run("agent") { search.call("flights") } }
    paused = viewer.wait_for_frame("exec.paused").first
    manual.advance(38_100.123) # thinking
    viewer.resume(paused["payload"]["pauseId"], "continue")
    assert_equal "flights", worker.value

    tool = finished_for(viewer, "tool:search")["payload"]
    assert_in_delta 38_102.52, tool["durationMs"], 0.0 # wall clock, hold included — unchanged meaning
    assert_in_delta 38_100.12, tool["heldMs"], 0.0 # the debugger's share
    agent = finished_for(viewer, "agent:agent")["payload"]
    assert_in_delta 38_100.12, agent["heldMs"], 0.0 # the hold sits inside the agent node too
    assert_operator agent["durationMs"], :>=, 38_102.52
  end

  def test_node_error_carries_the_running_total_and_retry_sums
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "flaky", "point" => "before" },
                                      { "kind" => "tool", "name" => "flaky", "point" => "error" }] }
    )
    manual = Manual.new
    Graphmind::Clock.override = -> { manual.now }
    attempts = 0
    flaky = Graphmind::Wrap.gate_callable(
      lambda {
        attempts += 1
        raise "boom" if attempts == 1

        "second time"
      },
      -> { session }, name: "flaky"
    )
    holds = [1000.0, 2000.0, 300.0]
    actions = %w[continue retry continue]
    resumer = Thread.new do
      3.times do |i|
        frame = viewer.wait_for_frame("exec.paused", count: i + 1)[i]
        manual.advance(holds[i])
        viewer.resume(frame["payload"]["pauseId"], actions[i])
      end
    end
    worker = Thread.new { session.run("agent") { flaky.call } }
    assert_equal "second time", worker.value
    resumer.join(5)

    errored = viewer.wait_for_frame("node.error").first
    assert_equal 1000, errored["payload"]["heldMs"] # only the before-hold had happened
    finished = finished_for(viewer, "tool:flaky")["payload"]
    assert_equal 3300, finished["heldMs"]
    assert_operator finished["durationMs"], :>=, 3300
  end

  def test_fail_open_release_still_credits_held_time
    session, viewer = attached_session(viewer_options: { breakpoints: [{ "kind" => "tool" }] })
    manual = Manual.new
    Graphmind::Clock.override = -> { manual.now }
    slow = Graphmind::Wrap.gate_callable(-> { "done" }, -> { session }, name: "slow")

    worker = Thread.new { session.run("agent") { slow.call } }
    viewer.wait_for_frame("exec.paused")
    manual.advance(1234.5)
    viewer.kill_abruptly # the debugger vanishes: fail open
    assert_equal "done", worker.value

    # Nobody is attached, so the frame sits in the replay buffer.
    buffered = session.instance_variable_get(:@buffer).to_a.map { |f| JSON.parse(f) }
    finished = buffered.select { |f| f["type"] == "node.finished" && f["payload"]["nodeId"] == "tool:slow" }
    assert_equal 1, finished.length
    assert_in_delta 1234.5, finished.first["payload"]["heldMs"], 0.0
  end

  def test_heldms_omitted_for_unknown_instance_and_caller_value_wins_and_bad_durations_clamp
    session, viewer = attached_session
    session.emit("node.finished", { "nodeId" => "tool:x", "instanceId" => "never",
                                    "durationMs" => 3.14159, "status" => "ok" })
    frame = finished_for(viewer, "tool:x", "never")["payload"]
    refute frame.key?("heldMs")
    assert_in_delta 3.14, frame["durationMs"], 0.0 # normalised on the way out

    session.emit("node.started", { "nodeId" => "tool:y", "kind" => "tool", "name" => "y", "instanceId" => "i1" })
    session.emit("node.finished", { "nodeId" => "tool:y", "instanceId" => "i1", "durationMs" => -5,
                                    "status" => "ok", "heldMs" => 7 })
    frame = finished_for(viewer, "tool:y", "i1")["payload"]
    assert_equal 7, frame["heldMs"]
    assert_equal 0.0, frame["durationMs"]

    [Float::NAN, Float::INFINITY, -1.0].each_with_index do |raw, i|
      session.finish_node(node_id: "tool:z", instance_id: "i#{i}", duration_ms: raw)
      assert_equal 0.0, finished_for(viewer, "tool:z", "i#{i}")["payload"]["durationMs"]
    end
  end
end
