# frozen_string_literal: true

require_relative "test_helper"
require "digest"

# Loop hold, Ruby port.
#
# Parity with packages/client/test/loop-guard.test.ts / loop-hold.test.ts and
# python/tests/test_loop_guard.py: the conformance fixture byte for byte, the
# randomised differential cases generated from the TypeScript canonicaliser,
# and the hold itself on the real wire — continue / inject / abort / retry,
# fail-open when detached or disconnected, configuration, and the privacy rule
# for the fingerprint.
class TestLoopGuard < Minitest::Test
  LG = Graphmind::LoopGuard
  FIXTURE = File.join(GraphmindTest::REPO_ROOT, "packages", "client", "test", "fixtures", "loop-guard.json")
  DIFFERENTIAL = File.join(GraphmindTest::REPO_ROOT, "python", "tests", "fixtures", "differential.json")
  REDACTED = Graphmind::Redaction::REDACTED

  def read_json(path) = JSON.parse(File.read(path, encoding: "UTF-8"), max_nesting: false)

  def guard(options = {}, env = {}) = LG::Guard.new(LG.resolve(options, env))

  # -- conformance fixture ---------------------------------------------------

  def test_fixture_states_the_defaults_this_implementation_uses
    data = read_json(FIXTURE)
    assert_equal 3, data["version"], "loop hold v3: back-to-back"
    assert(data["sequences"].all? { |sq| sq["calls"].all? { |c| c.key?("kind") } }, "every call names its kind")
    assert_equal({ "threshold" => 3, "mode" => "pause", "kinds" => ["tool"], "ignoreKeys" => LG::DEFAULT_IGNORE_KEYS },
                 data["defaults"])
    config = LG.resolve(nil, {})
    assert_equal [3, "pause"], [config.threshold, config.mode]
    assert_equal Set["tool"], config.kinds
    assert_equal Set["_meta"], config.ignore_keys
  end

  def test_every_canonical_case_reproduces_byte_for_byte
    data = read_json(FIXTURE)
    data["canonical"].each do |c|
      ignore = c.fetch("ignoreKeys", data["defaults"]["ignoreKeys"])
      assert_equal c["canonical"], LG.canonical_call(c["nodeId"], c["input"], ignore), c["name"]
      assert_equal c["fingerprint"], Digest::SHA256.hexdigest(c["canonical"])[0, 32], c["name"]
      assert_equal c["fingerprint"], LG.fingerprint_call(c["nodeId"], c["input"], ignore), c["name"]
    end
  end

  # An input whose property read raises (the fixture's `unreadable: true`).
  UNREADABLE_INPUT = Class.new(Hash) { def each_pair(*) = raise("unreadable") }.new.tap { |h| h["boom"] = 1 }.freeze

  # Rule v3 (fixture version 3): every trip — not only the first — with its
  # repeats and firstSeq, and a retry right after a trip never trips again.
  def test_every_sequence_trips_exactly_at_the_recorded_calls
    sequences = read_json(FIXTURE)["sequences"]
    assert_operator sequences.count { |sq| sq["trips"].any? }, :>=, 10
    assert_operator sequences.count { |sq| sq["trips"].empty? }, :>=, 10
    sequences.each do |s|
      options = { threshold: s["threshold"] }
      options[:ignore_keys] = s["ignoreKeys"] if s.key?("ignoreKeys")
      options[:allow_nodes] = s["allowNodes"] if s.key?("allowNodes")
      options[:kinds] = s["kinds"] if s.key?("kinds")
      g = guard(options)
      trips = []
      s["calls"].each_with_index do |call, index|
        kind = call.fetch("kind")
        name = call.fetch("name", call["nodeId"].split(":", 2)[1])
        input = call["unreadable"] ? UNREADABLE_INPUT : call["input"]
        record = g.record("run", kind, call["nodeId"], name, g.fingerprint(call["nodeId"], input), index)
        expected = s["fingerprints"][index]
        if expected.nil?
          assert_nil record, "#{s['name']}[#{index}] is not fingerprinted"
        else
          assert_equal expected, record&.fingerprint, "#{s['name']}[#{index}]"
        end
        info = g.consult("run", kind, call["nodeId"], name)
        if info
          assert_equal index, info.last_seq, "#{s['name']}[#{index}] lastSeq"
          trips << { "at" => index, "repeats" => info.repeats, "firstAt" => info.first_seq }
        end
        assert_nil g.consult("run", kind, call["nodeId"], name), "#{s['name']}[#{index}] retry"
      end
      assert_equal s["trips"], trips, s["name"]
      assert_equal [s["tripsAt"], s["repeatsAtTrip"]], [trips.first&.fetch("at"), trips.first&.fetch("repeats")], s["name"]
    end
  end

  def test_differential_cases_match_the_typescript_canonicaliser
    cases = read_json(DIFFERENTIAL)["canonical"]
    # Cases with unpaired UTF-16 surrogates cannot exist as Ruby Strings (they
    # are double-encoded under canonicalLoneSurrogates; the Python suite runs them).
    assert_operator cases.length, :>=, 300
    cases.each_with_index do |c, index|
      assert_equal c["canonical"], LG.canonical_call(c["nodeId"], c["input"], c["ignoreKeys"]), "case #{index}"
      assert_equal c["fingerprint"], LG.fingerprint_call(c["nodeId"], c["input"], c["ignoreKeys"]), "case #{index}"
    end
    assert(cases.any? { |c| c["canonical"].include?('"[depth]"') }, "the depth marker must be exercised")
  end

  # -- canonical form, Ruby specifics -----------------------------------------------

  def test_numbers_are_spelled_like_javascript
    {
      1.0 => "1", -0.0 => "0", 1e21 => "1e+21", 1e20 => "100000000000000000000", 1e-7 => "1e-7",
      1e-6 => "0.000001", 1.5e-7 => "1.5e-7", 0.1 + 0.2 => "0.30000000000000004", 123e-20 => "1.23e-18",
      5e-324 => "5e-324", 1.7976931348623157e308 => "1.7976931348623157e+308", -2.5e-8 => "-2.5e-8",
      12_345_678_901_234_567.0 => "12345678901234568", 1e16 => "10000000000000000", 100.5 => "100.5",
      0.0001 => "0.0001"
    }.each do |value, text|
      assert_equal text, LG.js_number(value), value.inspect
      assert_equal text, LG.canonicalize(value), value.inspect
    end
    assert_equal "[null,null,null]", LG.canonicalize([Float::NAN, Float::INFINITY, -Float::INFINITY])
    assert_equal "123456789012345678901234567890", LG.canonicalize(123_456_789_012_345_678_901_234_567_890)
  end

  def test_key_order_is_utf16_code_unit_order
    assert_equal "{\"😀\":2,\"\uffff\":1}", LG.canonicalize({ "\uffff" => 1, "😀" => 2 })
    assert_equal '{"1":6,"Z":4,"_":5,"a":3,"z":2,"é":1}', LG.canonicalize({ "é" => 1, "z" => 2, "a" => 3, "Z" => 4, "_" => 5, "1" => 6 })
  end

  def test_ruby_values
    assert_equal LG.canonicalize({ "q" => "x", "n" => 1 }), LG.canonicalize({ n: 1, q: :x })
    assert_equal '{"a":1}', LG.canonicalize({ a: 1, f: -> { 1 }, m: method(:puts) })
    assert_equal "[null,1]", LG.canonicalize([proc { 1 }, 1])
    assert_equal LG.canonicalize({ k: Set[3, 1, 2] }), LG.canonicalize({ k: Set[2, 3, 1] })
    point = Struct.new(:y, :x).new(2, 1)
    assert_equal '{"x":1,"y":2}', LG.canonicalize(point)
    assert_equal '"\\u0001\\"\\\\\\n"', LG.canonicalize("\u0001\"\\\n")
    assert_equal LG.canonicalize("abc"), LG.canonicalize("abc".b)
  end

  def test_ignore_keys_cycles_and_depth
    value = { "_meta" => 1, "x" => [{ "_meta" => { "p" => 1 }, "_metadata" => 2 }], "y" => { _meta: 3 } }
    assert_equal '{"x":[{"_metadata":2}],"y":{}}', LG.canonicalize(value, ["_meta"])
    cyclic = { "a" => 1 }
    cyclic["self"] = cyclic
    assert_equal '{"a":1,"self":"[circular]"}', LG.canonicalize(cyclic)
    shared = { "k" => 1 }
    assert_equal '[{"k":1},{"k":1}]', LG.canonicalize([shared, shared])
    deep = "leaf"
    200.times { deep = [deep] }
    assert_includes LG.canonicalize(deep), '"[depth]"'
  end

  # -- configuration ------------------------------------------------------------------

  def test_threshold_mode_and_allow_env
    { nil => 3, "" => 3, "  " => 3, "5" => 5, " 7 " => 7, "0" => 0, "3.0" => 3, "1e1" => 10, "0x10" => 16,
      "-1" => 3, "2.5" => 3, "abc" => 3, "Infinity" => 3, "NaN" => 3, "1_000" => 3 }.each do |raw, want|
      assert_equal want, LG.parse_threshold(raw), raw.inspect
    end
    { nil => "pause", "warn" => "warn", " OFF " => "off", "Pause" => "pause", "0" => "off", "false" => "off",
      "none" => "off", "hold" => "pause", "" => "pause" }.each do |raw, want|
      assert_equal want, LG.parse_mode(raw), raw.inspect
    end
    assert_equal %w[pollJob tool:heartbeat], LG.parse_allow("pollJob, tool:heartbeat ,,")
    assert_equal [], LG.parse_allow(" , ")
    assert_equal [], LG.parse_allow(nil)
  end

  def test_option_beats_env_beats_default_per_field
    env = { "GRAPHMIND_LOOP_THRESHOLD" => "5", "GRAPHMIND_ON_LOOP" => "warn", "GRAPHMIND_LOOP_ALLOW" => "a,b" }
    assert_equal 5, LG.resolve(nil, env).threshold
    mixed = LG.resolve({ threshold: 2 }, env)
    assert_equal [2, "warn", Set["a", "b"]], [mixed.threshold, mixed.mode, mixed.allow_nodes]
    assert_equal Set["only"], LG.resolve({ allow_nodes: [:only] }, env).allow_nodes
    assert_equal Set[], LG.resolve({ "allowNodes" => [] }, env).allow_nodes
    assert_equal "off", LG.resolve(false, env).mode
    assert_equal "warn", LG.resolve({ mode: :warn }, {}).mode
    assert_equal "pause", LG.resolve({ mode: "WARN" }, {}).mode
    assert_equal 3, LG.resolve({ threshold: true }, {}).threshold
    assert_equal 4, LG.resolve({ threshold: 4.0 }, {}).threshold
    assert_equal Set[], LG.resolve({ ignore_keys: [] }, {}).ignore_keys
    assert_equal Set["tool"], LG.resolve({ kinds: "tool" }, {}).kinds
    assert_equal Set["llm"], LG.resolve({ kinds: [:llm, 3] }, {}).kinds
  end

  def test_unreadable_options_fall_back_to_env_then_defaults
    hostile = Class.new(Hash) { def key?(*) = raise("boom") }.new
    assert_equal 9, LG.resolve(hostile, { "GRAPHMIND_LOOP_THRESHOLD" => "9" }).threshold
    env_hostile = Class.new(Hash) { def [](*) = raise("boom") }.new
    assert_equal 3, LG.resolve(hostile, env_hostile).threshold
    session = new_session(loop_guard: hostile, hide_inputs: Object.new)
    session.emit("node.started", { "nodeId" => "tool:x", "kind" => "tool", "name" => "x" })
    assert_operator session.stats.seq, :>=, 1
  end

  # -- counting -------------------------------------------------------------------------

  def rec(g, node_id, input, seq, run: "r", kind: "tool", name: node_id.to_s.split(":", 2)[1])
    g.record(run, kind, node_id, name, g.fingerprint(node_id, input), seq)
  end

  def test_unreadable_input_clears_the_kind_streak
    self_to_h = Class.new { def to_h = self }
    raises = Class.new { def inspect = raise("no") }
    [self_to_h, raises].each do |klass|
      g = guard
      [{ "q" => 1 }, { "q" => 1 }, { "q" => klass.new }, { "q" => 1 }, { "q" => 1 }].each_with_index do |value, i|
        rec(g, "tool:s", value, i)
      end
      assert_nil g.consult("r", "tool", "tool:s", "s"), klass.inspect
      rec(g, "tool:s", { "q" => 1 }, 5)
      assert_equal [3, 3], g.consult("r", "tool", "tool:s", "s").then { |i| [i.repeats, i.first_seq] }, klass.inspect
    end
  end

  def test_trips_once_per_repeat_and_again_on_the_next
    g = guard
    3.times { |i| rec(g, "tool:s", {}, i) }
    info = g.consult("r", "tool", "tool:s", "s")
    assert_equal [3, 0, 2], [info.repeats, info.first_seq, info.last_seq]
    assert_nil g.consult("r", "tool", "tool:s", "s")
    rec(g, "tool:s", {}, 9)
    info = g.consult("r", "tool", "tool:s", "s")
    assert_equal [4, 9], [info.repeats, info.last_seq]
  end

  # v3 replaced the per-node state (MAX_NODES_PER_RUN, gone): one streak per
  # kind per run, so thousands of distinct calls keep memory flat.
  def test_runs_are_lru_bounded_and_one_streak_per_kind_per_run
    g = guard
    rec(g, "tool:s", {}, 0, run: "long")
    (LG::MAX_RUNS * 2).times do |i|
      rec(g, "tool:s", {}, 0, run: "short-#{i}")
      rec(g, "tool:s", {}, i, run: "long") if (i % 10).zero?
    end
    assert_equal LG::MAX_RUNS, g.tracked_runs
    refute_nil g.consult("long", "tool", "tool:s", "s")

    g2 = guard({ kinds: %w[tool llm] })
    5000.times do |i|
      rec(g2, "tool:#{i}", { "i" => i }, i)
      rec(g2, "llm:#{i}", { "i" => i }, i, kind: "llm")
    end
    assert_equal 2, g2.tracked_streaks
    refute LG.const_defined?(:MAX_NODES_PER_RUN)
  end

  # -- counting, rule v3 --------------------------------------------------------------

  def test_another_watched_call_of_the_same_kind_replaces_the_streak
    g = guard
    rec(g, "tool:list", {}, 0)
    rec(g, "tool:list", {}, 1)
    rec(g, "tool:read", { "p" => 1 }, 2)
    rec(g, "tool:list", {}, 3)
    assert_nil g.consult("r", "tool", "tool:list", "list")
    rec(g, "tool:list", {}, 4)
    assert_nil g.consult("r", "tool", "tool:list", "list"), "A, A, B, A, A is not a loop"
    rec(g, "tool:list", {}, 5)
    info = g.consult("r", "tool", "tool:list", "list")
    assert_equal [3, 3, 5], [info.repeats, info.first_seq, info.last_seq]
  end

  def test_unwatched_starts_touch_no_streak_and_kinds_keep_their_own
    g = guard({ allow_nodes: ["poll"] })
    rec(g, "tool:list", {}, 0)
    assert_nil rec(g, "llm:step", { "m" => 1 }, 1, kind: "llm"), "llm is not watched by default"
    assert_nil rec(g, "tool:poll", { "id" => 1 }, 2), "allow-listed by name"
    rec(g, "tool:list", {}, 3)
    rec(g, "agent:x", {}, 4, kind: "agent")
    rec(g, "tool:list", {}, 5)
    assert_equal 3, g.consult("r", "tool", "tool:list", "list").repeats
    assert_nil g.consult("r", "tool", "tool:poll", "poll")

    both = guard({ kinds: [:tool, "llm"] })
    3.times do |i|
      rec(both, "tool:list", {}, i * 2)
      rec(both, "llm:step", { "m" => 1 }, (i * 2) + 1, kind: :llm)
    end
    assert_equal 3, both.consult("r", :tool, "tool:list", "list").repeats
    assert_equal [3, 1], both.consult("r", "llm", "llm:step", "step").then { |i| [i.repeats, i.first_seq] }
  end

  def test_a_gate_whose_node_is_not_its_kind_streaks_never_holds
    g = guard({ threshold: 1 })
    rec(g, "tool:a", {}, 0)
    rec(g, "tool:b", {}, 1)
    assert_nil g.consult("r", "tool", "tool:a", "a"), "tool:a's start was replaced by tool:b's"
    refute_nil g.consult("r", "tool", "tool:b", "b")
    assert_nil g.consult("r", "llm", "tool:b", "b"), "unwatched kind"
    assert_nil g.consult("other-run", "tool", "tool:b", "b")
  end

  def test_a_node_id_that_is_not_a_string_clears_and_a_symbol_is_its_name
    g = guard
    rec(g, "tool:s", {}, 0)
    rec(g, "tool:s", {}, 1)
    assert_nil g.record("r", "tool", 42, "s", g.fingerprint(42, {}), 2)
    assert_nil g.record("r", "tool", nil, nil, g.fingerprint(nil, {}), 2)
    rec(g, "tool:s", {}, 3)
    rec(g, "tool:s", {}, 4)
    assert_nil g.consult("r", "tool", "tool:s", "s"), "the non-String start cleared the streak"
    rec(g, :"tool:s", {}, 5, name: :s)
    assert_equal 3, g.consult("r", :tool, "tool:s", "s").repeats
    assert_equal g.fingerprint("tool:s", {}), g.fingerprint(:"tool:s", {})
    assert_same LG::UNREADABLE, g.fingerprint("tool:s", LG::UNREADABLE)
  end

  def test_claim_warning_claims_the_streak_of_its_node_once
    g = guard({ kinds: %w[tool llm] })
    rec(g, "tool:s", {}, 0)
    rec(g, "llm:m", {}, 1, kind: "llm")
    refute g.claim_warning("r", "tool:s", "llm"), "the llm streak is not tool:s's"
    assert g.claim_warning("r", "tool:s", "tool")
    refute g.claim_warning("r", "tool:s")
    assert g.claim_warning("r", "llm:m")
    refute g.claim_warning("nope", "llm:m")
    rec(g, "tool:t", {}, 2)
    assert g.claim_warning("r", "tool:t", :tool), "a new streak warns again"
  end

  # Thread safety as before: many threads record/consult one run's streaks
  # without raising, and every trip's repeats stay within what was recorded.
  def test_concurrent_record_and_consult_never_raise
    g = guard({ threshold: 2 })
    workers = Array.new(8) do |n|
      Thread.new do
        trips = 0
        400.times do |i|
          node = "tool:#{(n + i) % 3}"
          g.record("shared", "tool", node, node, g.fingerprint(node, {}), i)
          trips += 1 if g.consult("shared", "tool", node, node)
        end
        trips
      end
    end
    total = workers.sum { |w| value_of(w) }
    assert_operator total, :>=, 0
    assert_equal 1, g.tracked_streaks
  end

  def test_fingerprinting_a_1kb_input_is_cheap
    value = { "query" => "x" * 700, "filters" => (0...40).to_h { |i| ["k#{i}", i] } }
    assert_operator JSON.generate(value).bytesize, :>=, 1000
    g = guard
    started = now_ms
    2000.times { g.fingerprint("tool:s", value) }
    per_call = (now_ms - started) / 2000
    assert_operator per_call, :<, 0.5
  end

  # -- the hold on the wire -------------------------------------------------------------

  def tool(session, name, &body) = Graphmind::Wrap.gate_callable(body, -> { session }, name: name)

  def paused(viewer) = viewer.frames_of("exec.paused")

  def wait_paused(viewer, count)
    viewer.wait_for_frame("exec.paused", count: count, timeout: 8.0)[count - 1]
  end

  def test_third_identical_call_is_held_with_loop_details_matching_the_wire
    session, viewer = attached_session
    calls = Queue.new
    search = Graphmind::Wrap.gate_callable(->(origin, dest) { calls << origin; "no flights" }, -> { session },
                                           name: "search_flights")
    worker = Thread.new { session.run("loop") { Array.new(3) { search.call("AMS", "LIS") } } }
    frame = wait_paused(viewer, 1)
    sleep 0.2
    assert_equal 2, calls.size, "the held (third) call must not have run"
    payload = frame["payload"]
    assert_equal ["loop", "before", "tool:search_flights"], [payload["reason"], payload["point"], payload["nodeId"]]
    starts = viewer.frames_of("node.started").select { |f| f["payload"]["nodeId"] == "tool:search_flights" }
    loop_info = payload["loop"]
    assert_equal 3, loop_info["repeats"]
    assert_equal starts[0]["seq"], loop_info["firstSeq"]
    assert_equal starts[2]["seq"], loop_info["lastSeq"]
    assert_equal LG.fingerprint_call("tool:search_flights", { "origin" => "AMS", "dest" => "LIS" }, ["_meta"]),
                 loop_info["fingerprint"]
    assert_valid_frame(frame)
    viewer.resume(payload["pauseId"], "continue")
    assert_equal ["no flights"] * 3, value_of(worker)
    assert_equal 3, calls.size
  end

  def test_continue_then_held_again_inject_and_abort
    session, viewer = attached_session
    ran = Queue.new
    poll = Graphmind::Wrap.gate_callable(->(job) { ran << job; "pending" }, -> { session }, name: "poll")
    worker = Thread.new do
      session.run("loop") { Array.new(5) { poll.call(7) } }
    rescue Graphmind::AbortError => e
      e
    end
    first = wait_paused(viewer, 1)
    assert_equal 3, first["payload"]["loop"]["repeats"]
    viewer.resume(first["payload"]["pauseId"], "continue")
    second = wait_paused(viewer, 2)
    assert_equal 4, second["payload"]["loop"]["repeats"]
    viewer.resume(second["payload"]["pauseId"], "inject", { "status" => "done" })
    third = wait_paused(viewer, 3)
    assert_equal 5, third["payload"]["loop"]["repeats"]
    viewer.resume(third["payload"]["pauseId"], "abort")
    assert_kind_of Graphmind::AbortError, value_of(worker)
    assert_equal 3, ran.size
    viewer.wait_for_frame("run.finished")
    assert_equal "aborted", viewer.frames_of("run.finished").first["payload"]["status"]
    injected = viewer.frames_of("node.finished").find { |f| f["payload"]["injected"] }
    assert_equal({ "status" => "done" }, injected["payload"]["output"])
  end

  def test_retry_of_the_held_instance_does_not_hold_twice
    session, viewer = attached_session(viewer_options: { breakpoints: [{ "point" => "error" }] })
    attempts = 0
    flaky = Graphmind::Wrap.gate_callable(lambda do |_n|
      attempts += 1
      raise ArgumentError, "boom" if attempts == 3

      "ok"
    end, -> { session }, name: "flaky")
    worker = Thread.new { session.run("r") { Array.new(3) { flaky.call(1) } } }
    loop_hold = wait_paused(viewer, 1)
    assert_equal "loop", loop_hold["payload"]["reason"]
    viewer.resume(loop_hold["payload"]["pauseId"], "continue")
    error_hold = wait_paused(viewer, 2)
    assert_equal "error", error_hold["payload"]["point"]
    assert_equal "error", error_hold["payload"]["reason"]
    refute error_hold["payload"].key?("loop")
    viewer.resume(error_hold["payload"]["pauseId"], "retry")
    assert_equal %w[ok ok ok], value_of(worker)
    assert_equal 4, attempts
    assert_equal 2, paused(viewer).size, "retry re-entered the before-gate without a new node.started"
  end

  # This test used to pin the v2 per-node rule: search, read, search, read,
  # search held the third search. Under loop hold v3 (decisions.md, BINDING) a
  # loop is the same call BACK-TO-BACK, so the alternation is not held — the
  # accepted v3 limit — and only three searches in a row are.
  def test_different_arguments_never_hold_and_an_alternating_model_is_not_held
    # pause_timeout: a regression that holds must FAIL the assertion, not hang the suite.
    session, viewer = attached_session(pause_timeout: 2.0)
    search = tool(session, "search") { |q| q }
    read = tool(session, "read") { |i| i }
    session.run("r") { 6.times { |page| search.call({ "q" => "x", "page" => page }) } }
    assert_empty paused(viewer)
    session.run("r2") do
      search.call("x")
      read.call(1)
      search.call("x")
      read.call(2)
      search.call("x")
    end
    assert_empty paused(viewer), "search, read, search, read, search is not a back-to-back loop"
    worker = Thread.new { session.run("r3") { 3.times { search.call("x") } } }
    held = wait_paused(viewer, 1)
    assert_equal ["tool:search", 3], [held["payload"]["nodeId"], held["payload"]["loop"]["repeats"]]
    viewer.resume(held["payload"]["pauseId"], "continue")
    value_of(worker)
  end

  def test_symbol_and_string_keyed_arguments_are_the_same_call
    session, viewer = attached_session
    t = Graphmind::Wrap.gate_callable(->(args) { args }, -> { session }, name: "t")
    worker = Thread.new { [t.call({ q: "x" }), t.call({ "q" => "x" }), t.call({ q: :x })] }
    held = wait_paused(viewer, 1)
    assert_equal 3, held["payload"]["loop"]["repeats"]
    viewer.resume(held["payload"]["pauseId"], "continue")
    value_of(worker)
  end

  def test_arguments_that_differ_past_the_sanitizer_truncation_are_different_calls
    session, viewer = attached_session(pause_timeout: 2.0)
    t = Graphmind::Wrap.gate_callable(->(ids) { ids.size }, -> { session }, name: "bulk")
    base = (0...250).to_a
    session.run("r") { 4.times { |i| t.call(base + [1000 + i]) } }
    assert_empty paused(viewer), "the wire input is truncated to 200 items; the fingerprint must not be"
  end

  def test_the_fingerprint_is_hidden_when_inputs_or_tool_args_are_hidden
    [[{ hide_tool_args: true }, true], [{ hide_inputs: true }, true], [{ hide_outputs: true }, false]].each do |options, hidden|
      session, viewer = attached_session(**options)
      t = Graphmind::Wrap.gate_callable(->(email) { email.size }, -> { session }, name: "lookup")
      worker = Thread.new { Array.new(3) { t.call("alice@example.com") } }
      held = wait_paused(viewer, 1)
      loop_info = held["payload"]["loop"]
      assert_equal hidden, loop_info["fingerprint"] == REDACTED, options.inspect
      assert_equal 3, loop_info["repeats"]
      viewer.resume(held["payload"]["pauseId"], "continue")
      value_of(worker)
      refute_includes JSON.generate(viewer.received), "alice@example.com" if options[:hide_tool_args]
    end
  end

  # Verifier finding: `kind: :tool` is idiomatic Ruby and reaches the wire as
  # "tool", but the guard compared kinds as Strings, so a Symbol-kind tool was
  # never watched — and, once watched, its fingerprint must follow hide_tool_args.
  def test_symbol_kind_tools_are_watched_and_their_fingerprint_follows_hide_tool_args
    session, viewer = attached_session(hide_tool_args: true)
    t = Graphmind::Wrap.gate_callable(->(email) { email.size }, -> { session }, name: "lookup", kind: :tool)
    worker = Thread.new { Array.new(3) { t.call("alice@example.com") } }
    held = wait_paused(viewer, 1)
    assert_equal ["loop", 3, REDACTED],
                 [held["payload"]["reason"], held["payload"]["loop"]["repeats"], held["payload"]["loop"]["fingerprint"]]
    viewer.resume(held["payload"]["pauseId"], "continue")
    assert_equal [17, 17, 17], value_of(worker)
    refute_includes JSON.generate(viewer.received), "alice@example.com"
    guard = Graphmind::LoopGuard::Guard.new(LG.resolve({ kinds: [:tool], allow_nodes: [:poll] }, {}))
    assert guard.applies_to?(:tool, "tool:x", "x")
    refute guard.applies_to?("tool", "tool:poll", :poll)
  end

  # Verifier finding (pre-existing in Session#sanitize, reached by every
  # wrapped tool): a cyclic Hash argument recursed until SystemStackError,
  # which is not a StandardError and escaped into the host's call.
  def test_cyclic_and_very_deep_arguments_never_raise_into_the_host
    session, viewer = attached_session(pause_timeout: 1.0)
    cyclic = { "name" => "node" }
    cyclic["parent"] = cyclic
    deep = { "leaf" => "DEEP-LEAF" }
    5_000.times { deep = { "child" => deep } }
    looping = Class.new { def to_h = { "me" => self } }.new
    t = Graphmind::Wrap.gate_callable(->(x) { :ok }, -> { session }, name: "t")
    session.run("r") do
      assert_equal :ok, t.call(cyclic)
      assert_equal :ok, t.call(deep)
      assert_equal :ok, t.call(looping)
    end
    viewer.wait_for_frame("run.finished")
    started = viewer.frames_of("node.started").select { |f| f["payload"]["nodeId"] == "tool:t" }
    assert_equal 3, started.size, "no event may be lost to the nesting either"
    assert_equal({ "name" => "node", "parent" => "[circular]" }, started[0]["payload"]["input"]["x"])
    assert_includes JSON.generate(started[1]["payload"]["input"]), '"…[depth limit]"'
    assert_equal({ "me" => "[circular]" }, started[2]["payload"]["input"]["x"])
  end

  def test_an_unrelated_breakpoint_hold_carries_no_loop_details
    session, viewer = attached_session(viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "other", "point" => "before" }] })
    same = tool(session, "same") { 1 }
    other = tool(session, "other") { 2 }
    worker = Thread.new do
      3.times { same.call }
      other.call
    end
    loop_hold = wait_paused(viewer, 1)
    viewer.resume(loop_hold["payload"]["pauseId"], "continue")
    plain = wait_paused(viewer, 2)
    assert_equal "tool:other", plain["payload"]["nodeId"]
    # No loop details: reason "breakpoint"; instanceId (0.6.0) names the held call.
    assert_equal %w[instanceId nodeId pauseId point reason], plain["payload"].keys.sort
    assert_equal "breakpoint", plain["payload"]["reason"]
    viewer.resume(plain["payload"]["pauseId"], "continue")
    value_of(worker)
  end

  # -- loop hold v3 on the wire: back-to-back only ------------------------------------

  def loop_starts(viewer, node_id) = viewer.frames_of("node.started").select { |f| f["payload"]["nodeId"] == node_id }

  def llm_step(session, index)
    session.start_node(node_id: "llm:step", kind: "llm", name: "step", instance_id: "llm-#{index}",
                       input: { "messages" => ["same prompt"] })
    session.finish_node(node_id: "llm:step", instance_id: "llm-#{index}", duration_ms: 1, output: "call list_issues")
  end

  # The false hold v3 exists to remove: under mcp-proxy (or an implicit run) a
  # whole host session is one run, and a constant-argument tool called now and
  # then between other work was held as "Loop: 3x list_issues".
  def test_the_long_session_identical_calls_separated_by_other_tools_are_never_held
    session, viewer = attached_session(pause_timeout: 5.0)
    list_issues = tool(session, "list_issues") { |repo| "issues of #{repo}" }
    read_file = tool(session, "read_file") { |path| "contents of #{path}" }
    search_code = tool(session, "search_code") { |q| "hits for #{q}" }
    long_session = proc do
      3.times do |minute|
        list_issues.call("gm")
        llm_step(session, minute)
        read_file.call("src/f#{minute}.rb")
        search_code.call("term")
        search_code.call("term") # a back-to-back pair of another tool is below the threshold
      end
    end
    started = now_ms
    session.run("long session", &long_session)
    viewer.wait_for_frame("run.finished")
    assert_empty paused(viewer), "3 identical list_issues calls with other tools between must never be held"
    assert_operator now_ms - started, :<, 2500, "nothing waited for a pause timeout"
    assert_equal 3, loop_starts(viewer, "tool:list_issues").size

    # In ONE run: the same long session, then the same call three times
    # back-to-back. Only the third back-to-back call holds, and firstSeq names
    # the first of THEM, not an older identical call from the long session.
    worker = Thread.new do
      session.run("long session, then a loop") do
        long_session.call
        Array.new(3) { list_issues.call("gm") }
      end
    end
    held = wait_paused(viewer, 1)
    starts = loop_starts(viewer, "tool:list_issues").select { |f| f["runId"] == held["runId"] }
    assert_equal 6, starts.size, "held at the 6th call of the run (its node.started is sent before the gate)"
    loop_info = held["payload"]["loop"]
    assert_equal [3, starts[3]["seq"], starts[5]["seq"]], [loop_info["repeats"], loop_info["firstSeq"], loop_info["lastSeq"]]
    viewer.resume(held["payload"]["pauseId"], "continue")
    assert_equal ["issues of gm"] * 3, value_of(worker)
    assert_equal 1, paused(viewer).size
  end

  def test_detached_the_long_session_never_warns_and_back_to_back_warns_once
    session = new_session(url: "ws://127.0.0.1:1/ingest", connect_timeout: 0.05)
    list_issues = tool(session, "list_issues") { |_repo| "same" }
    get_me = tool(session, "get_me") { "me" }
    session.run("r") { 4.times { list_issues.call("gm") && get_me.call } }
    assert_empty(warnings.select { |m| m.include?("possible loop") }, warnings.inspect)
    session.run("r") { 3.times { list_issues.call("gm") } }
    assert_equal 1, warnings.count { |m| m.include?("possible loop: list_issues (tool:list_issues) was called 3×") },
                 warnings.inspect
  end

  def test_model_tool_model_tool_an_llm_step_between_identical_calls_does_not_break_the_streak
    session, viewer = attached_session
    list_issues = tool(session, "list_issues") { |repo| repo }
    worker = Thread.new do
      session.run("agent") do
        Array.new(3) do |i|
          llm_step(session, i)
          list_issues.call("gm")
        end
      end
    end
    held = wait_paused(viewer, 1)
    assert_equal ["tool:list_issues", 3], [held["payload"]["nodeId"], held["payload"]["loop"]["repeats"]]
    viewer.resume(held["payload"]["pauseId"], "continue")
    assert_equal %w[gm gm gm], value_of(worker)
  end

  def test_an_allow_listed_poller_between_identical_calls_is_invisible_but_another_tool_is_not
    session, viewer = attached_session(loop_guard: { allow_nodes: ["poll_job"] }, pause_timeout: 5.0)
    list_issues = tool(session, "list_issues") { |repo| repo }
    poll_job = tool(session, "poll_job") { |id| id }
    read_file = tool(session, "read_file") { |path| path }
    session.run("a-a-b-a-a") do
      2.times { list_issues.call("gm") }
      read_file.call("README.md")
      2.times { list_issues.call("gm") }
    end
    assert_empty paused(viewer), "A, A, B, A, A is not held"
    worker = Thread.new do
      session.run("poller") do
        list_issues.call("gm")
        poll_job.call(7)
        list_issues.call("gm")
        poll_job.call(7)
        list_issues.call("gm")
      end
    end
    held = wait_paused(viewer, 1)
    assert_equal ["tool:list_issues", 3], [held["payload"]["nodeId"], held["payload"]["loop"]["repeats"]]
    viewer.resume(held["payload"]["pauseId"], "continue")
    value_of(worker)
  end

  def test_a_start_whose_input_cannot_be_read_clears_the_streak_and_never_raises
    session, viewer = attached_session(pause_timeout: 5.0)
    list_issues = tool(session, "list_issues") { |repo| repo }
    unreadable = Class.new(Hash) { def [](key) = key == "input" ? raise("input getter") : super }.new
    unreadable.merge!("nodeId" => "tool:list_issues", "kind" => "tool", "name" => "list_issues",
                      "instanceId" => "hostile", "input" => { "repo" => "gm" })
    emitted = nil
    worker = Thread.new do
      session.run("r") do
        2.times { list_issues.call("gm") }
        emitted = session.emit("node.started", unreadable)
        Array.new(3) { list_issues.call("gm") }
      end
    end
    held = wait_paused(viewer, 1)
    # Without the clear, the call right after the unreadable start would have
    # been the third in a row and held (firstSeq = the first call of the run).
    starts = loop_starts(viewer, "tool:list_issues").reject { |f| f["payload"]["instanceId"] == "hostile" }
    assert_equal 5, starts.size
    assert_equal [3, starts[2]["seq"], starts[4]["seq"]], held["payload"]["loop"].values_at("repeats", "firstSeq", "lastSeq")
    viewer.resume(held["payload"]["pauseId"], "continue")
    value_of(worker)
    assert_nil emitted
    assert_equal 1, paused(viewer).size
  end

  # A node.started the redactor drops (fail closed: its identity cannot be read)
  # never reached the wire: it clears the streak, so no hold's lastSeq can point
  # at an event that was never sent.
  def test_a_start_dropped_by_fail_closed_redaction_clears_the_streak
    session, viewer = attached_session(hide_tool_args: true, pause_timeout: 5.0)
    list_issues = tool(session, "list_issues") { |repo| repo }
    unnameable = Object.new.tap { |k| k.define_singleton_method(:to_s) { raise "unnameable" } }
    worker = Thread.new do
      session.run("r") do
        2.times { list_issues.call("gm") }
        session.emit("node.started", { "nodeId" => "tool:list_issues", "kind" => "tool", "name" => "list_issues",
                                       "input" => { "repo" => "gm" }, unnameable => 1 }) # no instanceId: dropped
        Array.new(3) { list_issues.call("gm") }
      end
    end
    held = wait_paused(viewer, 1)
    sent = loop_starts(viewer, "tool:list_issues").map { |f| f["seq"] }
    assert_equal 5, sent.size, "the dropped start is not on the wire"
    assert_equal [3, sent[2], sent[4]], held["payload"]["loop"].values_at("repeats", "firstSeq", "lastSeq")
    viewer.resume(held["payload"]["pauseId"], "continue")
    value_of(worker)
    assert_equal 1, paused(viewer).size
  end

  # Same reason as the dropped start: a node.started that fails to serialise
  # (JSON.generate raises on a NaN or invalid UTF-8 in a field nobody hides)
  # never reached the wire, so it must neither count nor leave the previous
  # call looking like "the call right before" the next one.
  def test_a_start_that_cannot_be_serialised_clears_the_streak_instead_of_counting
    session, viewer = attached_session(pause_timeout: 5.0)
    list_issues = tool(session, "list_issues") { |repo| repo }
    emitted = :unset
    worker = Thread.new do
      session.run("r") do
        2.times { list_issues.call("gm") }
        emitted = session.emit("node.started", { "nodeId" => "tool:list_issues", "kind" => "tool", "name" => "list_issues",
                                                 "instanceId" => "nan", "input" => { "repo" => "gm" },
                                                 "costUsd" => Float::NAN })
        Array.new(3) { list_issues.call("gm") }
      end
    end
    held = wait_paused(viewer, 1)
    sent = loop_starts(viewer, "tool:list_issues")
    assert_equal 5, sent.size, "the unserialisable start is not on the wire"
    assert_equal [3, sent[2]["seq"], sent[4]["seq"]], held["payload"]["loop"].values_at("repeats", "firstSeq", "lastSeq")
    viewer.resume(held["payload"]["pauseId"], "continue")
    assert_equal %w[gm gm gm], value_of(worker)
    assert_nil emitted
    assert_equal 1, paused(viewer).size
  end

  def test_kinds_tool_and_llm_keep_independent_streaks_through_a_live_session
    session, viewer = attached_session(loop_guard: { kinds: %w[tool llm] })
    list_issues = tool(session, "list_issues") { |repo| repo }
    step = Graphmind::Wrap.gate_callable(->(prompt) { "answer" }, -> { session }, name: "step", kind: "llm",
                                                                                    node_id: "llm:step")
    worker = Thread.new do
      session.run("both") do
        3.times do
          list_issues.call("gm")
          step.call("same prompt")
        end
      end
    rescue StandardError => e
      e
    end
    first = wait_paused(viewer, 1)
    assert_equal ["tool:list_issues", 3], [first["payload"]["nodeId"], first["payload"]["loop"]["repeats"]]
    viewer.resume(first["payload"]["pauseId"], "continue")
    second = wait_paused(viewer, 2)
    assert_equal ["llm:step", 3], [second["payload"]["nodeId"], second["payload"]["loop"]["repeats"]]
    viewer.resume(second["payload"]["pauseId"], "continue")
    refute_kind_of Exception, value_of(worker)
  end

  # -- fail-open -------------------------------------------------------------------------

  def test_detached_never_holds_and_warns_once_without_arguments
    session = new_session(url: "ws://127.0.0.1:1/ingest", connect_timeout: 0.05)
    t = tool(session, "search") { |_token| "same" }
    started = now_ms
    session.run("r") { 7.times { assert_equal "same", t.call("SECRET-ARG") } }
    assert_operator now_ms - started, :<, 2000
    loop_logs = warnings.select { |m| m.include?("possible loop") }
    assert_equal 1, loop_logs.size, warnings.inspect
    assert_includes loop_logs[0], "search (tool:search)"
    assert_includes loop_logs[0], "3×"
    assert_includes loop_logs[0], "no debugger is attached"
    refute_includes loop_logs[0], "SECRET-ARG"
  end

  def test_warn_mode_never_holds_even_when_attached
    session, viewer = attached_session(env: { "GRAPHMIND_ON_LOOP" => "warn" }, pause_timeout: 2.0)
    t = tool(session, "t") { 1 }
    session.run("r") { 5.times { t.call } }
    assert_empty paused(viewer)
    assert_equal 1, warnings.count { |m| m.include?("GRAPHMIND_ON_LOOP=warn") }
  end

  def test_switched_off_allowed_or_below_threshold_never_holds
    [
      { env: { "GRAPHMIND_ON_LOOP" => "off" } },
      { env: { "GRAPHMIND_LOOP_THRESHOLD" => "0" } },
      { loop_guard: false },
      { loop_guard: { allow_nodes: ["t"] } },
      { loop_guard: { "allow_nodes" => ["tool:t"] } },
      { env: { "GRAPHMIND_LOOP_ALLOW" => "x, t" } },
      { env: { "GRAPHMIND_LOOP_THRESHOLD" => "6" } }
    ].each do |options|
      warnings.clear
      session, viewer = attached_session(**options, pause_timeout: 2.0)
      t = tool(session, "t") { 1 }
      session.run("r") { 5.times { t.call } }
      assert_empty paused(viewer), options.inspect
      assert_empty(warnings.select { |m| m.include?("possible loop") }, options.inspect)
    end
  end

  def test_threshold_from_env_holds_exactly_there
    session, viewer = attached_session(env: { "GRAPHMIND_LOOP_THRESHOLD" => "5" })
    count = Queue.new
    t = tool(session, "t") { count << 1 }
    worker = Thread.new { 5.times { t.call } }
    held = wait_paused(viewer, 1)
    assert_equal 5, held["payload"]["loop"]["repeats"]
    assert_equal 4, count.size
    viewer.resume(held["payload"]["pauseId"], "continue")
    value_of(worker)
  end

  def test_a_debugger_that_disconnects_mid_hold_releases_it
    session, viewer = attached_session
    t = tool(session, "t") { "ran" }
    worker = Thread.new { Array.new(3) { t.call } }
    wait_paused(viewer, 1)
    viewer.kill_abruptly
    assert_equal %w[ran ran ran], value_of(worker, timeout: 5)
    assert_equal 0, session.stats.held_gates
  end

  def test_pause_timeout_releases_a_loop_hold
    session, viewer = attached_session(pause_timeout: 0.3)
    t = tool(session, "t") { "ran" }
    started = now_ms
    assert_equal %w[ran ran ran], Array.new(3) { t.call }
    assert_operator now_ms - started, :>, 250
    assert_equal "continue", viewer.wait_for_frame("exec.resumed").first["payload"]["action"]
  end

  def test_a_debugger_that_attaches_late_holds_the_next_identical_call
    viewer = new_viewer
    session = new_session(url: viewer.url)
    t = tool(session, "t") { 1 }
    3.times { t.call }
    assert session.ready(5.0)
    worker = Thread.new { t.call }
    held = wait_paused(viewer, 1)
    assert_equal 4, held["payload"]["loop"]["repeats"]
    viewer.resume(held["payload"]["pauseId"], "continue")
    value_of(worker)
  end

  def test_many_concurrent_runs_are_held_and_all_released_on_disconnect
    session, viewer = attached_session
    t = tool(session, "t") { |n| n }
    workers = Array.new(10) { |n| Thread.new { session.run("run-#{n}") { Array.new(3) { t.call(n) } } } }
    viewer.wait_for_frame("exec.paused", count: 10, timeout: 10)
    assert_equal 10, paused(viewer).map { |f| f["runId"] }.uniq.size
    assert_equal 10, session.stats.held_gates
    viewer.kill_abruptly
    workers.each_with_index { |w, n| assert_equal [n, n, n], value_of(w, timeout: 5) }
  end
end
