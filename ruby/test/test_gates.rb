# frozen_string_literal: true

require_relative "test_helper"

# The gates are the product. These tests prove that execution genuinely stops —
# by timestamp ordering, not by "a pause event was emitted".
class TestGates < Minitest::Test
  BEFORE_TOOL = { "kind" => "tool", "name" => "search", "point" => "before" }.freeze

  def test_a_matching_breakpoint_holds_the_calling_thread
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })

    order = Queue.new
    body_ran_at = nil
    tool = Graphmind::Wrap.gate_callable(->(q) { body_ran_at = now_ms; "results for #{q}" },
                                         -> { session }, name: "search")

    worker = Thread.new do
      order << [:call_started, now_ms]
      value = tool.call("flights")
      order << [:call_returned, now_ms]
      value
    end

    paused = viewer.wait_for_frame("exec.paused").first
    pause_seen_at = now_ms
    assert_equal "tool:search", paused["payload"]["nodeId"]
    assert_equal "before", paused["payload"]["point"]
    assert_valid_frame(paused)

    # Hold it long enough that "it did not run yet" cannot be a scheduling fluke.
    sleep 0.3
    assert_nil body_ran_at, "the tool body ran while the gate was held"
    assert_equal 1, session.stats.held_gates

    viewer.resume(paused["payload"]["pauseId"], "continue")
    assert_equal "results for flights", worker.value

    refute_nil body_ran_at
    assert_operator body_ran_at, :>, pause_seen_at + 250,
                    "the body ran less than the hold duration after the pause was observed"

    resumed = viewer.wait_for_frame("exec.resumed").first
    assert_equal paused["payload"]["pauseId"], resumed["payload"]["pauseId"]
    assert_equal "continue", resumed["payload"]["action"]
    assert_equal 0, session.stats.held_gates
  end

  def test_inject_substitutes_the_result_without_running_the_body
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })

    ran = false
    tool = Graphmind::Wrap.gate_callable(->(_q) { ran = true; "real" }, -> { session }, name: "search")
    worker = Thread.new { tool.call("x") }

    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "inject", { "flights" => 2 })

    assert_equal({ "flights" => 2 }, worker.value)
    refute ran, "the body must not run when the debugger injects a result"

    finished = viewer.wait_for_frame("node.finished").first
    assert_equal true, finished["payload"]["injected"]
    assert_equal "ok", finished["payload"]["status"]
    assert_valid_frame(finished)
  end

  def test_retry_at_the_error_gate_re_runs_the_body
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "flaky", "point" => "error" }] }
    )

    attempts = 0
    tool = Graphmind::Wrap.gate_callable(
      lambda {
        attempts += 1
        raise "boom" if attempts == 1

        "ok on attempt #{attempts}"
      },
      -> { session }, name: "flaky"
    )
    worker = Thread.new { tool.call }

    paused = viewer.wait_for_frame("exec.paused").first
    assert_equal "error", paused["payload"]["point"]
    viewer.resume(paused["payload"]["pauseId"], "retry")

    assert_equal "ok on attempt 2", worker.value
    assert_equal 2, attempts

    error_frame = viewer.frames_of("node.error").first
    assert_equal "RuntimeError", error_frame["payload"]["error"]["name"]
    assert_valid_frame(error_frame)
  end

  def test_inject_at_the_error_gate_recovers_the_call
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "flaky", "point" => "error" }] }
    )

    tool = Graphmind::Wrap.gate_callable(-> { raise IOError, "nope" }, -> { session }, name: "flaky")
    worker = Thread.new { tool.call }

    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "inject", "recovered")

    assert_equal "recovered", worker.value
    finished = viewer.wait_for_frame("node.finished").first
    assert_equal true, finished["payload"]["recoveredFromError"]
  end

  def test_continue_at_the_error_gate_re_raises_the_original
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "flaky", "point" => "error" }] }
    )

    tool = Graphmind::Wrap.gate_callable(-> { raise ArgumentError, "original" }, -> { session },
                                         name: "flaky")
    worker = Thread.new do
      tool.call
      :no_raise
    rescue StandardError => e
      e
    end

    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "continue")

    error = worker.value
    assert_instance_of ArgumentError, error
    assert_equal "original", error.message
  end

  def test_abort_raises_abort_error_and_marks_the_run_aborted
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })

    tool = Graphmind::Wrap.gate_callable(-> { "never" }, -> { session }, name: "search")
    worker = Thread.new do
      session.run("aborted-run") do |ctx|
        begin
          tool.call
        rescue Graphmind::AbortError => e
          next [:aborted, ctx.aborted?, e]
        end
        [:not_aborted]
      end
    end

    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "abort")

    outcome, ctx_aborted, error = worker.value
    assert_equal :aborted, outcome
    assert ctx_aborted, "the run context should report aborted"
    assert_instance_of Graphmind::AbortError, error

    finished = viewer.wait_for_frame("run.finished").first
    assert_equal "aborted", finished["payload"]["status"]
  end

  def test_after_gate_only_fires_with_an_explicit_after_breakpoint
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "search", "point" => "after" }] }
    )

    tool = Graphmind::Wrap.gate_callable(-> { "real" }, -> { session }, name: "search")
    worker = Thread.new { tool.call }

    paused = viewer.wait_for_frame("exec.paused").first
    assert_equal "after", paused["payload"]["point"]
    viewer.resume(paused["payload"]["pauseId"], "inject", "swapped")

    assert_equal "swapped", worker.value
  end

  def test_step_mode_pauses_at_every_before_point
    session, viewer = attached_session(viewer_options: { mode: "step" })

    tool = Graphmind::Wrap.gate_callable(-> { "value" }, -> { session }, name: "anything")
    worker = Thread.new { tool.call }

    paused = viewer.wait_for_frame("exec.paused").first
    assert_equal "before", paused["payload"]["point"]
    viewer.resume(paused["payload"]["pauseId"], "continue")
    assert_equal "value", worker.value
  end

  def test_mode_set_control_arms_stepping_at_runtime
    session, viewer = attached_session

    node = Graphmind::GateNode.new("tool:x", "tool", "x")
    engine = session.instance_variable_get(:@engine)
    refute engine.should_pause?("before", node)

    viewer.set_mode("step")
    wait_until(label: "step mode") { engine.should_pause?("before", node) }

    viewer.set_mode("run")
    wait_until(label: "run mode") { !engine.should_pause?("before", node) }
  end

  def test_breakpoint_set_and_clear_controls
    session, viewer = attached_session
    engine = session.instance_variable_get(:@engine)
    node = Graphmind::GateNode.new("tool:search", "tool", "search")

    viewer.set_breakpoint({ "kind" => "tool", "name" => "search" })
    wait_until(label: "breakpoint armed") { engine.should_pause?("before", node) }

    viewer.clear_breakpoint({ "kind" => "tool", "name" => "search" })
    wait_until(label: "breakpoint cleared") { !engine.should_pause?("before", node) }
  end

  def test_a_disconnect_mid_hold_auto_continues_every_gate
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })

    released_at = nil
    tool = Graphmind::Wrap.gate_callable(-> { released_at = now_ms; "ran anyway" },
                                         -> { session }, name: "search")
    worker = Thread.new { tool.call }

    viewer.wait_for_frame("exec.paused")
    assert_equal 1, session.stats.held_gates
    killed_at = now_ms

    viewer.kill_abruptly

    assert_equal "ran anyway", worker.value
    refute_nil released_at
    assert_operator released_at - killed_at, :<, 2000,
                    "fail-open took too long after the debugger vanished"
    assert_equal 0, session.stats.held_gates
  end

  def test_dispose_releases_held_gates
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })

    tool = Graphmind::Wrap.gate_callable(-> { "ran" }, -> { session }, name: "search")
    worker = Thread.new { tool.call }
    viewer.wait_for_frame("exec.paused")

    session.dispose
    assert_equal "ran", worker.value
  end

  def test_pause_timeout_auto_continues_a_gate_nobody_resumes
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] },
                                       pause_timeout: 0.3)

    tool = Graphmind::Wrap.gate_callable(-> { "ran" }, -> { session }, name: "search")
    started = now_ms
    worker = Thread.new { tool.call }
    viewer.wait_for_frame("exec.paused")

    assert_equal "ran", worker.value
    elapsed = now_ms - started
    assert_operator elapsed, :>, 250, "the gate should have held for the timeout"
    assert_operator elapsed, :<, 3000, "the gate should not have held forever"
  end

  def test_concurrent_gates_are_held_and_resumed_independently
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "point" => "before" }] }
    )

    results = {}
    mutex = Mutex.new
    workers = %w[alpha beta gamma].map do |name|
      tool = Graphmind::Wrap.gate_callable(-> { "#{name}-done" }, -> { session }, name: name)
      Thread.new do
        value = tool.call
        mutex.synchronize { results[name] = value }
      end
    end

    paused = viewer.wait_for_frame("exec.paused", count: 3)
    assert_equal 3, session.stats.held_gates
    assert_equal 3, paused.map { |f| f["payload"]["pauseId"] }.uniq.length

    paused.each { |frame| viewer.resume(frame["payload"]["pauseId"], "continue") }
    workers.each(&:join)

    assert_equal %w[alpha-done beta-done gamma-done], results.values_at("alpha", "beta", "gamma")
  end
end
