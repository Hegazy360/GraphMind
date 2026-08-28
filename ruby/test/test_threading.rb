# frozen_string_literal: true

require_relative "test_helper"

# Ruby's concurrency story, stated as tests: a Rails request is a thread, a
# Sidekiq job is a thread, and a run context must not bleed between them.
class TestThreading < Minitest::Test
  def test_concurrent_runs_on_different_threads_have_separate_contexts
    session, viewer = attached_session

    threads = 8.times.map do |i|
      Thread.new do
        session.run("job-#{i}") do |ctx|
          sleep(rand * 0.02)
          [ctx.run_id, session.current_run.run_id, session.current_run.name]
        end
      end
    end
    results = threads.map(&:value)

    run_ids = results.map(&:first)
    assert_equal 8, run_ids.uniq.length, "each thread must get its own run id"
    results.each_with_index do |(run_id, seen_id, name), _i|
      assert_equal run_id, seen_id, "current_run must be this thread's run"
      assert_match(/\Ajob-\d\z/, name)
    end

    viewer.wait_for_frame("run.finished", count: 8)
    assert_equal 8, viewer.frames_of("run.started").map { |f| f["runId"] }.uniq.length
  end

  def test_events_are_attributed_to_the_emitting_threads_run
    session, viewer = attached_session

    threads = 6.times.map do |i|
      Thread.new do
        session.run("run-#{i}") do |ctx|
          session.emit("node.started", { "nodeId" => "tool:t", "kind" => "tool", "name" => "t",
                                         "instanceId" => "inst-#{i}" })
          ctx.run_id
        end
      end
    end
    expected = threads.map(&:value)

    viewer.wait_for_frame("node.started", count: 12) # agent node + tool node per run
    pairs = viewer.frames_of("node.started")
             .select { |f| f["payload"]["kind"] == "tool" }
             .map { |f| [f["payload"]["instanceId"], f["runId"]] }

    assert_equal 6, pairs.length
    pairs.each do |instance_id, run_id|
      index = instance_id.split("-").last.to_i
      assert_equal expected[index], run_id, "event landed in the wrong run"
    end
  end

  def test_seq_numbers_stay_unique_and_monotonic_under_concurrency
    session, viewer = attached_session

    threads = 8.times.map do
      Thread.new do
        25.times do |j|
          session.emit("node.started", { "nodeId" => "tool:x", "kind" => "tool", "name" => "x",
                                         "instanceId" => "i#{j}" })
        end
      end
    end
    threads.each(&:join)

    viewer.wait_for_frame("node.started", count: 200)
    seqs = viewer.received.map { |f| f["seq"] }
    assert_equal seqs.length, seqs.uniq.length, "sequence numbers must never repeat"
  end

  def test_a_run_context_does_not_leak_into_a_thread_you_spawn
    session, = attached_session

    inner = session.run("outer") { Thread.new { session.current_run }.value }
    assert_nil inner, "a spawned thread starts with no run context (documented behaviour)"
  end

  def test_with_run_context_carries_a_run_into_a_worker_thread
    session, viewer = attached_session

    session.run("outer") do |ctx|
      Thread.new do
        session.with_run_context(ctx) do
          assert_equal ctx.run_id, session.current_run.run_id
          session.emit("node.started", { "nodeId" => "tool:bg", "kind" => "tool", "name" => "bg",
                                         "instanceId" => "bg1" })
        end
      end.join
      ctx
    end

    viewer.wait_for_frame("run.finished")
    background = viewer.frames_of("node.started").find { |f| f["payload"]["name"] == "bg" }
    outer = viewer.frames_of("run.started").first
    assert_equal outer["runId"], background["runId"]
  end

  def test_clear_run_context_wipes_a_leaked_run
    session, = attached_session

    ctx = Graphmind::RunContext.new("run_x", "leaked")
    session.with_run_context(ctx) { refute_nil session.current_run }

    Thread.current[Graphmind::Session::RUN_KEY] = ctx
    assert_equal "leaked", session.current_run.name
    session.clear_run_context
    assert_nil session.current_run
  end

  def test_a_gate_holds_only_the_thread_that_hit_it
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "slow", "point" => "before" }] }
    )

    slow = Graphmind::Wrap.gate_callable(-> { "slow done" }, -> { session }, name: "slow")
    fast = Graphmind::Wrap.gate_callable(-> { "fast done" }, -> { session }, name: "fast")

    held = Thread.new { slow.call }
    viewer.wait_for_frame("exec.paused")

    # The other thread must sail straight through while the first is held.
    free = Thread.new { fast.call }
    assert_equal "fast done", free.value
    assert_equal 1, session.stats.held_gates

    paused = viewer.frames_of("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "continue")
    assert_equal "slow done", held.value
  end
end
