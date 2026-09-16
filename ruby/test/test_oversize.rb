# frozen_string_literal: true

require_relative "test_helper"

# The payload budget applied at emit (port of the TypeScript client's
# serializeWithinBudget + the ring buffer's rejectOversize):
#
#   * an event whose payload JSON is over MAX_PAYLOAD_BYTES is shrunk BEFORE
#     the ring buffer, from the payload parsed back out of the wire JSON, with
#     its type, so what is buffered and sent is what the server stores and a
#     valid event stays a valid event (its node finishes in the viewer);
#   * one rate-limited warning per event type, never quoting content, and an
#     honest one when the result is not a valid event;
#   * a frame bigger than the whole replay buffer never evicts other frames:
#     sent live when attached, else counted lost with one warning;
#   * under budget, frames are byte-identical to JSON.generate(envelope).
class TestOversize < Minitest::Test
  S = Graphmind::Shrink
  MAX = S::MAX_PAYLOAD_BYTES
  CANARY = "CANARY-CONTENT-7f3a"
  DEAD_URL = "ws://127.0.0.1:1/ingest"

  # -- ring buffer ------------------------------------------------------------------

  def test_the_ring_buffer_refuses_an_item_larger_than_itself_without_evicting_anything
    buffer = Graphmind::RingBuffer.new(10, 100)
    3.times { |i| assert_equal true, buffer.push("a#{i}" * 10) }
    before = [buffer.to_a, buffer.byte_size, buffer.dropped]

    assert_equal false, buffer.push("x" * 101)
    assert_equal before, [buffer.to_a, buffer.byte_size, buffer.dropped], "nothing evicted, nothing added"
    assert_equal 1, buffer.rejected

    # Exactly the budget still fits (over means bytes > max) and sheds the rest.
    assert_equal true, buffer.push("y" * 100)
    assert_equal ["y" * 100], buffer.to_a
    assert_equal 100, buffer.byte_size
    assert_equal 3, buffer.dropped
    assert_equal 1, buffer.rejected
  end

  def test_the_ring_buffer_measures_utf8_bytes_and_keeps_the_old_behaviour_on_request
    buffer = Graphmind::RingBuffer.new(10, 10)
    refute buffer.push("é" * 6), "12 UTF-8 bytes do not fit 10"
    assert buffer.push("é" * 5)

    legacy = Graphmind::RingBuffer.new(10, 10, reject_oversize: false)
    legacy.push("abc")
    assert_equal true, legacy.push("z" * 50)
    assert_equal ["z" * 50], legacy.to_a
    assert_equal 0, legacy.rejected

    unbounded = Graphmind::RingBuffer.new(2)
    assert unbounded.push("q" * 1_000_000)
    assert_equal 0, unbounded.rejected
  end

  # -- shrink at emit ---------------------------------------------------------------

  def test_a_17_mb_tool_output_is_shrunk_before_it_is_sent_and_the_node_finishes
    session, viewer = attached_session(warn_interval: 3600.0)
    big = "#{CANARY}#{'o' * 17_000_000}"
    session.run("big") do
      session.start_node(node_id: "tool:dump", kind: "tool", name: "dump", instance_id: "i-17mb")
      session.finish_node(node_id: "tool:dump", instance_id: "i-17mb", duration_ms: 12.5, output: big)
    end
    viewer.wait_for_frame("run.finished", timeout: 20.0)
    frame = viewer.frames_of("node.finished").find { |f| f["payload"]["nodeId"] == "tool:dump" }
    refute_nil frame, "the oversized node.finished must reach the viewer"
    payload = frame["payload"]

    assert_operator S.stringify(payload).bytesize, :<=, MAX
    assert S.valid_for?("node.finished", payload), "still a valid node.finished"
    assert_equal ["tool:dump", "i-17mb", "ok", 12.5], payload.values_at("nodeId", "instanceId", "status", "durationMs")
    assert_equal true, payload["__graphmindTruncated"]
    assert_equal ["output"], payload["fields"]
    assert_equal "#{big[0, S::PREVIEW_CHARS]}#{S::TRUNCATION_SUFFIX}", payload["output"]
    # `bytes` is the UTF-8 size of the original payload JSON: the output plus
    # its small siblings.
    assert_includes (big.bytesize + 2)..(big.bytesize + 200), payload["bytes"]
    assert_contiguous_seqs(viewer)

    budget = warnings.select { |w| w.include?("shrunk to a preview") }
    assert_equal 1, budget.size, warnings.inspect
    assert_includes budget.first, "512 KB"
    warnings.each { |w| refute_includes w, CANARY, "a warning must never quote content" }
  end

  def test_a_6000_record_keyed_output_keeps_256_records_and_says_how_many_it_dropped
    session, viewer = attached_session
    records = (0...6000).to_h { |i| ["rec-#{i}", { "id" => i, "title" => "title #{i} #{'t' * 80}", "tags" => %w[a b] }] }
    session.emit("node.started", { "nodeId" => "tool:list", "kind" => "tool", "name" => "list", "instanceId" => "k1" })
    session.emit("node.finished", { "nodeId" => "tool:list", "instanceId" => "k1", "durationMs" => 3,
                                    "status" => "ok", "output" => records })
    frame = viewer.wait_for_frame("node.finished").first
    payload = frame["payload"]

    assert_operator S.stringify(payload).bytesize, :<=, MAX
    assert S.valid_for?("node.finished", payload)
    output = payload["output"]
    assert_equal 6000 - 256, output["keysDropped"]
    assert_equal true, output["__graphmindTruncated"]
    assert_equal (0...256).map { |i| "rec-#{i}" }, output.keys.first(256)
    assert_equal [], output["rec-0"]["tags"], "nested arrays become [] in a shrunk field"
    assert_equal ["output"], payload["fields"]
  end

  # The shrink runs on the wire form, byte for byte what the reference does to
  # it: the frame's payload equals serialize_payload(JSON.parse(wire payload)).
  def test_the_frame_payload_is_exactly_the_shrink_of_the_wire_form
    session, viewer = attached_session
    wide = (0...5000).to_h { |i| ["x#{i}", "v" * 150] } # > MAX_TRIM_FIELDS: the skeleton
    payload = wide.merge("nodeId" => "tool:w", "instanceId" => "w1", "durationMs" => 1.25, "status" => "error",
                         "heldMs" => 4, "at" => Time.at(0).utc, sym: :value)
    session.emit("node.finished", payload)
    got = viewer.wait_for_frame("node.finished").first["payload"]

    wire = JSON.parse(JSON.generate(payload))
    expected_json, expected, truncated = S.serialize_payload(wire, MAX, "node.finished")
    assert truncated
    assert_equal expected_json, S.stringify(got)
    assert_equal expected, got
    assert S.valid_for?("node.finished", got)
    assert_equal ["tool:w", "w1", 1.25, 4, "error"], got.values_at("nodeId", "instanceId", "durationMs", "heldMs", "status")
    # Every key the skeleton did not keep verbatim: the 5,000 extras, the Time
    # (written as its to_s) and the Symbol-keyed field.
    assert_equal wide.keys + %w[at sym], got["fields"]
    assert_equal "1970-01-01 00:00:00 UTC", wire["at"], "the shrink saw the Time as json wrote it"
  end

  def test_under_budget_frames_are_byte_identical_to_the_generated_envelope
    session = new_session(url: DEAD_URL)
    payloads = [
      ["node.started", { "nodeId" => "tool:a", "kind" => "tool", "name" => "a", "instanceId" => "u1",
                         "input" => { "q" => "café 中 \u{1F600} \"quoted\" \\ \n   /", "n" => [1, 2.5, 1e20, -0.0, 2**64] } }],
      ["graph.hint", { "nodes" => [{ "nodeId" => "tool:a", "kind" => "tool", "name" => "a" }] }],
      ["custom.type", { sym: :val, "nested" => { "deep" => [nil, true, false] } }],
      ["node.started", { "nodeId" => "tool:b", "kind" => "tool", "name" => "b", "instanceId" => "u2",
                         "input" => "p" * (MAX - 200) }] # just under the budget: not shrunk
    ]
    payloads.each { |type, payload| session.emit(type, payload) }
    frames = session.instance_variable_get(:@buffer).to_a
    assert_equal payloads.size + 1, frames.size # + the implicit run.started
    frames.drop(1).zip(payloads).each do |frame, (type, payload)|
      parsed = JSON.parse(frame)
      expected = Graphmind::Protocol.serialize_envelope(
        Graphmind::Protocol.create_envelope(type, payload, parsed["seq"], parsed["runId"], parsed["ts"])
      )
      assert_equal expected, frame, "#{type}: under budget, the frame is what JSON.generate wrote before"
    end
    assert_empty warnings.grep(/shrunk|drop/)
  end

  # json writes 1e20 as "1e+20" (5 bytes); JavaScript as 21 digits. A payload
  # under the budget by Ruby's bytes can be over it by the server's, and must
  # be shrunk here, or the live view and the stored event would differ.
  def test_a_payload_over_budget_only_in_javascript_number_spelling_is_still_shrunk
    session = new_session(url: DEAD_URL)
    floats = Array.new(80_000, 1e20)
    session.emit("node.finished", { "nodeId" => "tool:f", "instanceId" => "f1", "durationMs" => 1,
                                    "status" => "ok", "output" => floats })
    frame = session.instance_variable_get(:@buffer).to_a.last
    assert_operator JSON.generate(floats).bytesize, :<, MAX, "the premise: Ruby's own text is under budget"
    payload = JSON.parse(frame)["payload"]
    assert_equal [], payload["output"]
    assert_equal ["output"], payload["fields"]
    assert_operator payload["bytes"], :>, MAX
  end

  def test_an_invalid_oversized_event_gets_the_honest_warning
    session, viewer = attached_session
    session.emit("node.finished", { "nodeId" => "tool:bad", "durationMs" => 1, "output" => "#{CANARY}#{'z' * 700_000}" })
    session.emit("node.started", { "nodeId" => "tool:next", "kind" => "tool", "name" => "next", "instanceId" => "n" })
    viewer.wait_for_frame("node.started")
    frame = viewer.wait_for_frame("node.finished").first
    assert_equal %w[__graphmindTruncated bytes preview], frame["payload"].keys
    invalid = warnings.grep(/could not be shrunk to a valid event/)
    assert_equal 1, invalid.size, warnings.inspect
    assert_includes invalid.first, "the debugger will drop it"
    assert_includes invalid.first, "node.finished"
    assert_empty warnings.grep(/shrunk to a preview/)
    warnings.each { |w| refute_includes w, CANARY }
    assert_contiguous_seqs(viewer)
  end

  def test_one_warning_per_event_type_per_interval
    session, viewer = attached_session(warn_interval: 3600.0)
    3.times do |i|
      session.emit("node.finished", { "nodeId" => "tool:r", "instanceId" => "r#{i}", "durationMs" => 1,
                                      "status" => "ok", "output" => "r" * 600_000 })
    end
    session.emit("node.started", { "nodeId" => "tool:s", "kind" => "tool", "name" => "s", "instanceId" => "s1",
                                   "input" => "s" * 600_000 })
    viewer.wait_for_frame("node.started")
    viewer.wait_for_frame("node.finished", count: 3)
    assert_equal 2, warnings.grep(/shrunk to a preview/).size, warnings.inspect
  end

  # -- unserializable payloads --------------------------------------------------------

  def test_an_unserializable_field_is_replaced_by_a_marker_instead_of_losing_the_event
    session, viewer = attached_session(warn_interval: 3600.0)
    cyclic = { "name" => CANARY }
    cyclic["self"] = cyclic
    session.emit("node.started", { "nodeId" => "tool:c", "kind" => "tool", "name" => "c", "instanceId" => "c1" })
    session.emit("node.finished", { "nodeId" => "tool:c", "instanceId" => "c1", "durationMs" => 2,
                                    "status" => "ok", "output" => cyclic })
    session.emit("node.finished", { "nodeId" => "tool:u", "instanceId" => "u1", "durationMs" => 2,
                                    "status" => "ok", "output" => "bad \xFF bytes".b.force_encoding(Encoding::UTF_8) })
    frames = viewer.wait_for_frame("node.finished", count: 2)
    frames.each do |frame|
      payload = frame["payload"]
      assert S.valid_for?("node.finished", payload), payload.inspect
      assert_equal({ "__graphmindTruncated" => true, "bytes" => 0, "preview" => "[unserializable value]" }, payload["output"])
      assert_equal ["output"], payload["fields"]
    end
    marker = warnings.grep(/could not be serialized to JSON; it was sent with that value replaced by a marker/)
    assert_equal 1, marker.size, warnings.inspect
    warnings.each { |w| refute_includes w, CANARY }
    assert_contiguous_seqs(viewer)
  end

  def test_an_unserializable_field_next_to_a_huge_one_is_degraded_then_shrunk
    session, viewer = attached_session
    cyclic = []
    cyclic << cyclic
    session.emit("node.error", { "nodeId" => "tool:e", "instanceId" => "e1",
                                 "error" => { "name" => "Boom", "message" => "m" * 3_000_000 }, "context" => cyclic })
    payload = viewer.wait_for_frame("node.error").first["payload"]
    assert_operator S.stringify(payload).bytesize, :<=, MAX
    assert S.valid_for?("node.error", payload)
    assert_equal "Boom", payload["error"]["name"]
    assert payload["error"]["message"].start_with?("m" * 2000)
    assert_equal [], payload["context"]
  end

  # A NaN has no JSON text in json's generator; JavaScript writes null. The gem
  # keeps dropping such an event (pinned by test_loop_guard) — but it must take
  # no seq, so the next event is not preceded by a hole.
  def test_an_event_that_still_cannot_be_serialised_takes_no_seq
    session, viewer = attached_session
    session.emit("node.started", { "nodeId" => "tool:a", "kind" => "tool", "name" => "a", "instanceId" => "a1" })
    session.emit("node.finished", { "nodeId" => "tool:a", "instanceId" => "a1", "durationMs" => 1, "status" => "ok",
                                    "costUsd" => Float::NAN })
    session.emit("node.started", { "nodeId" => "tool:b", "kind" => "tool", "name" => "b", "instanceId" => "b1" })
    viewer.wait_for_frame("node.started", count: 2)
    assert_empty viewer.frames_of("node.finished")
    assert_contiguous_seqs(viewer)
  end

  def test_a_payload_that_raises_while_being_read_never_raises_into_the_host
    session, viewer = attached_session
    hostile = Class.new(Hash) do
      def each_pair = raise(IOError, "cannot read")
      def each = raise(IOError, "cannot read")
      def to_json(*) = raise(IOError, "cannot read")
    end.new
    hostile["nodeId"] = "tool:h"
    assert_nil session.emit("custom.hostile", hostile)
    session.emit("node.started", { "nodeId" => "tool:ok", "kind" => "tool", "name" => "ok", "instanceId" => "o" })
    viewer.wait_for_frame("node.started")
    assert_contiguous_seqs(viewer)
  end

  # -- the replay buffer ----------------------------------------------------------------

  # Before: the 17 MB frame alone was bigger than the 8 MiB buffer, so pushing
  # it evicted every event emitted while dark, and on attach it was refused by
  # the 16 MiB frame cap — the whole dark stretch vanished.
  def test_a_huge_event_emitted_while_dark_costs_no_other_event_and_replays_shrunk
    session, viewer = attached_session(retry_interval: 60.0)
    viewer.kill_abruptly
    wait_until(label: "detach") { !session.attached? }

    session.emit("node.started", { "nodeId" => "tool:d", "kind" => "tool", "name" => "d", "instanceId" => "d1" })
    10.times { |i| session.emit("custom.dark", { "i" => i }) }
    session.emit("node.finished", { "nodeId" => "tool:d", "instanceId" => "d1", "durationMs" => 1, "status" => "ok",
                                    "output" => "d" * 17_000_000 })
    session.emit("custom.after", { "ok" => true })
    assert_equal 0, session.stats.dropped

    assert session.ready(5.0), "expected a reconnect"
    viewer.wait_for_frame("custom.after", timeout: 20.0)
    assert_equal 10, viewer.frames_of("custom.dark").size
    finished = viewer.frames_of("node.finished").find { |f| f["payload"]["instanceId"] == "d1" }
    refute_nil finished
    assert S.valid_for?("node.finished", finished["payload"])
    assert_contiguous_seqs(viewer)
  end

  def test_a_frame_bigger_than_the_whole_buffer_while_detached_is_lost_alone_with_one_warning
    session = new_session(url: DEAD_URL, max_buffer_bytes: 4096, warn_interval: 3600.0)
    5.times { |i| session.emit("custom.small", { "i" => i }) }
    buffer = session.instance_variable_get(:@buffer)
    kept = buffer.to_a
    session.emit("node.started", { "nodeId" => "tool:big", "kind" => "tool", "name" => "big", "instanceId" => "b",
                                   "input" => "#{CANARY}#{'b' * 100_000}" })
    session.emit("node.started", { "nodeId" => "tool:big", "kind" => "tool", "name" => "big", "instanceId" => "b2",
                                   "input" => "b" * 100_000 })

    assert_equal kept, buffer.to_a, "no older frame was evicted for it"
    assert_equal 0, session.stats.dropped, "nothing was EVICTED for the oversize frames"
    # The loss must be visible through the PUBLIC stats, not only in a log line
    # and a private ivar: `dropped` counts evictions, `lost` counts events that
    # never reached the debugger (TypeScript SessionStats parity).
    assert_equal 2, session.stats.lost, "counted as lost, and visible to the host program"
    assert_equal 2, session.stats.to_h["lost"], "and in the serialised form"
    assert_equal 2, session.instance_variable_get(:@lost), "counted as lost"
    assert_equal 8, session.stats.seq, "the lost events took their seqs (a hole the viewer can see)"
    lost = warnings.grep(/larger than the whole replay buffer/)
    assert_equal 1, lost.size, warnings.inspect
    assert_includes lost.first, "max_buffer_bytes is 4096"
    assert_includes lost.first, "the debugger is not attached"
    warnings.each { |w| refute_includes w, CANARY }
  end

  def test_a_frame_bigger_than_the_whole_buffer_while_attached_is_sent_live_but_not_kept
    session, viewer = attached_session(max_buffer_bytes: 4096)
    session.emit("node.started", { "nodeId" => "tool:live", "kind" => "tool", "name" => "live", "instanceId" => "l",
                                   "input" => "l" * 100_000 })
    frame = viewer.wait_for_frame("node.started").first
    assert_equal 100_000, frame["payload"]["input"].size
    refute(session.instance_variable_get(:@buffer).to_a.any? { |f| f.include?("tool:live") })
    assert_equal 0, session.instance_variable_get(:@lost)
    assert_equal 0, session.stats.lost, "sent live is NOT lost, and stats say so"
    sent = warnings.grep(/it was sent but not kept for replay/)
    assert_equal 1, sent.size, warnings.inspect
  end

  # `dropped` (evicted) and `lost` (never reached the debugger) are different
  # numbers, and BOTH are public: an oversize frame refused while dark is the
  # case where they disagree, and where reporting only `dropped` said "0 lost".
  def test_stats_report_lost_separately_from_dropped_and_expose_both
    session = new_session(url: DEAD_URL, max_buffer_bytes: 4096, warn_interval: 3600.0)
    session.emit("custom.small", { "i" => 0 })
    before = session.stats
    assert_equal 0, before.lost
    assert_equal 0, before.dropped

    session.emit("node.started", { "nodeId" => "tool:big", "kind" => "tool", "name" => "big",
                                   "instanceId" => "b", "input" => "b" * 100_000 })
    stats = session.stats
    assert_equal 1, stats.lost, "the refused frame is lost"
    assert_equal 0, stats.dropped, "and it evicted nothing"
    assert_equal before.buffered, stats.buffered, "every earlier frame is still buffered"
    assert_equal before.seq + 1, stats.seq, "the lost event still took its seq"
    assert_includes stats.to_h.keys, "lost"
    assert_equal({ "enabled" => true, "attached" => false, "buffered" => before.buffered,
                   "dropped" => 0, "lost" => 1, "heldGates" => 0, "seq" => before.seq + 1 },
                 stats.to_h)
  end

  # -- concurrency --------------------------------------------------------------------

  def test_threads_emitting_next_to_a_huge_event_keep_seq_order_on_the_wire
    session, viewer = attached_session
    big = Thread.new do
      2.times do |i|
        session.emit("node.finished", { "nodeId" => "tool:big", "instanceId" => "t#{i}", "durationMs" => 1,
                                        "status" => "ok", "output" => "t" * 8_000_000 })
      end
    end
    small = Array.new(4) do |t|
      Thread.new { 50.times { |i| session.emit("custom.small", { "t" => t, "i" => i }) } }
    end
    value_of(big, timeout: 60.0, label: "big emitter")
    small.each { |thread| value_of(thread, timeout: 60.0, label: "small emitter") }
    viewer.wait_for_frame("custom.small", count: 200, timeout: 20.0)
    viewer.wait_for_frame("node.finished", count: 2, timeout: 20.0)
    seqs = viewer.received.reject { |f| f["type"] == "hello" }.map { |f| f["seq"] }
    assert_equal seqs.sort, seqs, "frames reach the socket in seq order"
    assert_contiguous_seqs(viewer)
  end

  private

  def assert_contiguous_seqs(viewer)
    seqs = viewer.received.map { |f| f["seq"] }.uniq.sort
    assert_equal (seqs.first..seqs.last).to_a, seqs, "seqs must have no hole"
  end
end
