# frozen_string_literal: true

require_relative "test_helper"

# "Near-zero overhead when detached" is a claim, so it is measured.
#
# The budgets are deliberately loose (a shared CI box is a noisy place); they
# exist to catch a regression of the *kind* that matters — an allocation or a
# lock creeping onto the detached fast path — not to benchmark the machine.
class TestOverhead < Minitest::Test
  ITERATIONS = 20_000

  def test_a_disabled_gate_costs_almost_nothing
    session = new_session(url: "ws://127.0.0.1:1/ingest", enabled: false)
    node = Graphmind::GateNode.new("tool:x", "tool", "x")

    session.gate("before", node) # warm up
    elapsed = measure { ITERATIONS.times { session.gate("before", node) } }
    per_call_us = (elapsed / ITERATIONS) * 1_000_000

    assert_operator per_call_us, :<, 5.0,
                    "a disabled gate cost #{per_call_us.round(3)}us per call"
    report("disabled gate", per_call_us)
  end

  def test_a_detached_gate_costs_almost_nothing
    session = new_session(url: "ws://127.0.0.1:1/ingest")
    node = Graphmind::GateNode.new("tool:x", "tool", "x")

    session.gate("before", node)
    elapsed = measure { ITERATIONS.times { session.gate("before", node) } }
    per_call_us = (elapsed / ITERATIONS) * 1_000_000

    assert_operator per_call_us, :<, 5.0,
                    "a detached gate cost #{per_call_us.round(3)}us per call"
    report("detached gate", per_call_us)
  end

  def test_a_disabled_wrapped_tool_is_a_thin_shim
    session = new_session(url: "ws://127.0.0.1:1/ingest", enabled: false)
    raw = ->(a, b) { a + b }
    wrapped = Graphmind::Wrap.gate_callable(raw, -> { session }, name: "add")

    wrapped.call(1, 2)
    baseline = measure { ITERATIONS.times { raw.call(1, 2) } }
    instrumented = measure { ITERATIONS.times { wrapped.call(1, 2) } }
    overhead_us = ((instrumented - baseline) / ITERATIONS) * 1_000_000

    assert_operator overhead_us, :<, 10.0,
                    "a disabled wrapped call added #{overhead_us.round(3)}us"
    report("disabled wrapped call (added)", overhead_us)
  end

  def test_an_enabled_but_detached_emit_stays_off_the_network
    session = new_session(url: "ws://127.0.0.1:1/ingest", buffer_size: 50_000)
    payload = { "nodeId" => "tool:x", "kind" => "tool", "name" => "x", "instanceId" => "i" }

    session.emit("node.started", payload)
    count = 5_000
    elapsed = measure { count.times { session.emit("node.started", payload) } }
    per_call_us = (elapsed / count) * 1_000_000

    # Serializing + buffering, no socket. Generous, but it must not be
    # milliseconds.
    assert_operator per_call_us, :<, 100.0, "a detached emit cost #{per_call_us.round(3)}us"
    report("detached emit (serialize + buffer)", per_call_us)
  end

  private

  def measure
    start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    yield
    Process.clock_gettime(Process::CLOCK_MONOTONIC) - start
  end

  def report(label, value_us)
    return unless ENV["GRAPHMIND_REPORT_OVERHEAD"]

    puts format("  %-36s %8.3f us", label, value_us)
  end
end
