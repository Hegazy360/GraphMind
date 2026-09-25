# frozen_string_literal: true

require_relative "test_helper"

# Coarse redaction (the GRAPHMIND_HIDE_* kill switches), Ruby port.
#
# Parity with packages/client/test/redaction.test.ts and
# python/tests/test_redaction.py: the cross-language conformance fixture
# must reproduce byte for byte, the randomised differential streams generated
# from the TypeScript reference must too, and the switches must hold on the
# real wire — including replay-on-attach.
class TestRedaction < Minitest::Test
  FIXTURE = File.join(GraphmindTest::REPO_ROOT, "packages", "client", "test", "fixtures", "redaction.json")
  DIFFERENTIAL = File.join(GraphmindTest::REPO_ROOT, "python", "tests", "fixtures", "differential.json")
  REDACTED = Graphmind::Redaction::REDACTED
  OPTION_NAMES = {
    "hideInputs" => :hide_inputs, "hideOutputs" => :hide_outputs,
    "hideToolArgs" => :hide_tool_args, "hideToolResults" => :hide_tool_results
  }.freeze
  RUN = "run-1"

  def read_json(path) = JSON.parse(File.read(path, encoding: "UTF-8"), max_nesting: false)

  def redactor(warn: nil, **switches)
    all = { hide_inputs: false, hide_outputs: false, hide_tool_args: false, hide_tool_results: false }
    Graphmind::Redaction::Redactor.new(Graphmind::Redaction::Switches.new(**all.merge(switches)), warn: warn)
  end

  # One event as the fixtures spell it: {type, payload}, or {type, dropped: true}
  # when the redactor failed closed and the event must not be emitted.
  def produce(red, type, payload, run_id, node_kind = nil)
    got = red.apply(type, payload, run_id, node_kind)
    got.equal?(Graphmind::Redaction::DROP) ? { "type" => type, "dropped" => true } : { "type" => type, "payload" => got }
  end

  # -- conformance fixture ---------------------------------------------------

  def test_fixture_uses_the_shared_placeholder
    fixture = read_json(FIXTURE)
    assert_equal "__REDACTED__", fixture["placeholder"]
    assert_equal REDACTED, fixture["placeholder"]
    assert_operator fixture["cases"].length, :>=, 7
  end

  def test_every_fixture_case_reproduces_byte_for_byte
    cases = read_json(FIXTURE)["cases"]
    cases.each do |c|
      switches = c["switches"].to_h { |k, v| [OPTION_NAMES.fetch(k), v] }
      red = Graphmind::Redaction::Redactor.new(Graphmind::Redaction.resolve(switches, {}))
      produced = c["in"].map { |e| produce(red, e["type"], e["payload"], "fixture-run", e["nodeKind"]) }
      assert_equal c["out"].length, produced.length, c["name"]
      produced.zip(c["out"]).each_with_index do |(got, want), index|
        assert_equal JSON.generate(want), JSON.generate(got), "#{c['name']} [#{index}]"
      end
    end
  end

  def test_every_fixture_case_reproduces_through_the_environment_too
    read_json(FIXTURE)["cases"].each do |c|
      env = c["switches"].to_h { |k, v| ["GRAPHMIND_#{OPTION_NAMES.fetch(k).to_s.upcase}", v ? "TRUE" : "0"] }
      red = Graphmind::Redaction::Redactor.new(Graphmind::Redaction.resolve(nil, env))
      produced = c["in"].map { |e| produce(red, e["type"], e["payload"], "r", e["nodeKind"]) }
      assert_equal JSON.generate(c["out"]), JSON.generate(produced), c["name"]
    end
  end

  def test_fixture_is_not_vacuous_and_inputs_are_never_mutated
    read_json(FIXTURE)["cases"].each do |c|
      any_on = c["switches"].values.any?
      # Compared without `nodeKind`, which only `in` entries carry.
      events = c["in"].map { |e| { "type" => e["type"], "payload" => e["payload"] } }
      assert_equal any_on, JSON.generate(events) != JSON.generate(c["out"]), c["name"]
      before = JSON.generate(c["in"])
      red = redactor(hide_inputs: true, hide_outputs: true, hide_tool_args: true, hide_tool_results: true)
      c["in"].each { |e| red.apply(e["type"], e["payload"], "r", e["nodeKind"]) }
      assert_equal before, JSON.generate(c["in"])
    end
  end

  def test_differential_streams_match_the_typescript_reference
    data = read_json(DIFFERENTIAL)
    # Streams with unpaired UTF-16 surrogates (double-encoded under
    # redactionLoneSurrogates) cannot exist as Ruby Strings; the Python suite runs them.
    compared = 0
    changed = 0
    data["redaction"].each_with_index do |stream, index|
      sw = stream["switches"]
      red = redactor(hide_inputs: sw["hideInputs"], hide_outputs: sw["hideOutputs"],
                     hide_tool_args: sw["hideToolArgs"], hide_tool_results: sw["hideToolResults"])
      stream["in"].zip(stream["out"]).each_with_index do |(event, want), position|
        got = produce(red, event["type"], event["payload"], event["runId"])
        assert_equal JSON.generate(want), JSON.generate(got), "stream #{index} event #{position}"
        compared += 1
        changed += 1 if JSON.generate(got) != JSON.generate(event.slice("type", "payload"))
      end
    end
    assert_operator compared, :>, 800
    assert_operator changed, :>, 150
  end

  # -- switches ----------------------------------------------------------------

  def test_env_and_option_spellings
    # A privacy switch fails closed on spelling: anything but an off word.
    ["1", "true", "TRUE", " True ", "\t1\n", "yes", "on", "2", "1.0"].each do |v|
      assert Graphmind::Redaction.env_flag_on?(v), v.inspect
    end
    [nil, "", "  ", "0", "false", "FALSE", " off ", "no", "No", 1, true].each do |v|
      refute Graphmind::Redaction.env_flag_on?(v), v.inspect
    end
    [true, 1, 1.0, "1", "true"].each { |v| assert Graphmind::Redaction.option_flag_on?(v), v.inspect }
    [false, nil, 0, 2, "no", [], {}, Object.new].each { |v| refute Graphmind::Redaction.option_flag_on?(v), v.inspect }
  end

  def test_either_source_turns_a_switch_on_and_env_is_a_floor
    s = Graphmind::Redaction.resolve({ hide_inputs: false, "hide_outputs" => true },
                                     { "GRAPHMIND_HIDE_INPUTS" => "1", "GRAPHMIND_HIDE_TOOL_RESULTS" => "true" })
    assert_equal({ hide_inputs: true, hide_outputs: true, hide_tool_args: false, hide_tool_results: true }, s.to_h)
  end

  def test_hostile_sources_never_raise
    hostile = Class.new(Hash) { def [](*) = raise("boom") }.new
    s = Graphmind::Redaction.resolve(hostile, hostile)
    refute s.any?
    assert Graphmind::Redaction.resolve(hostile, { "GRAPHMIND_HIDE_OUTPUTS" => "1" }).hide_outputs
  end

  # -- rules -----------------------------------------------------------------------

  def test_off_returns_the_same_object_and_on_never_mutates
    payload = { "nodeId" => "tool:a", "kind" => "tool", "name" => "a", "instanceId" => "1", "input" => { "s" => 1 } }
    assert_same payload, redactor.apply("node.started", payload, RUN)
    out = redactor(hide_inputs: true).apply("node.started", payload, RUN)
    assert_equal({ "s" => 1 }, payload["input"])
    refute payload.key?("redaction")
    assert_equal REDACTED, out["input"]
    assert_equal({ "count" => 1, "keys" => ["input"] }, out["redaction"])
  end

  def test_nil_counts_as_a_value_absent_does_not
    red = redactor(hide_outputs: true)
    assert_equal REDACTED, red.apply("node.finished", { "nodeId" => "llm:x", "output" => nil }, RUN)["output"]
    absent = { "nodeId" => "llm:x", "durationMs" => 1, "status" => "ok" }
    # Equal, not the same object: with a switch on, node.* events are redacted
    # from a one-read snapshot (fail-closed rule), so what was inspected is
    # exactly what is sent — even when nothing needed hiding.
    assert_equal absent, red.apply("node.finished", absent, RUN)
  end

  def test_symbol_keys_are_redacted_too_because_json_writes_them_as_strings
    red = redactor(hide_inputs: true, hide_outputs: true)
    started = red.apply("node.started", { nodeId: "llm:x", kind: "llm", name: "x", input: "SECRET" }, RUN)
    assert_equal REDACTED, started[:input]
    refute JSON.generate(started).include?("SECRET")
    token = red.apply("node.token", { nodeId: "llm:x", deltas: [{ t: "text", v: "SECRET" }] }, RUN)
    refute JSON.generate(token).include?("SECRET")
    assert_equal [{ t: "text", v: "", "chars" => 6 }], token[:deltas]
  end

  # Verifier finding: JSON.generate writes BOTH "input" and :input, and the
  # hub's JSON.parse keeps the last one — redacting only the String key leaked
  # the Symbol one (start_node(input: x, extra: { input: y }) builds exactly that).
  def test_a_field_under_both_its_string_and_symbol_key_is_hidden_under_both
    # #inspect, not JSON.generate: json 3 refuses to generate a Hash mixing
    # "input" and :input (json 2 writes both, which is where the leak was).
    red = redactor(hide_inputs: true, hide_outputs: true)
    started = red.apply("node.started", { "nodeId" => "llm:x", "kind" => "llm", "input" => "a", input: "SECRET-SYM" }, RUN)
    refute_includes started.inspect, "SECRET"
    assert_equal [REDACTED, REDACTED], [started["input"], started[:input]]
    assert_equal 1, started["redaction"]["count"]
    half = red.apply("node.started", { "nodeId" => "llm:x", "kind" => "llm", "input" => REDACTED, input: "SECRET-2" }, RUN)
    refute_includes half.inspect, "SECRET"
    finished = red.apply("node.finished", { "nodeId" => "llm:x", output: "SECRET-O", "output" => "SECRET-P" }, RUN)
    refute_includes finished.inspect, "SECRET"
    token = red.apply("node.token", { "nodeId" => "llm:x", "deltas" => [{ "t" => "text", "v" => "SECRET-T" }],
                                      deltas: [{ "t" => "text", "v" => "ok", v: "SECRET-V" }] }, RUN)
    refute_includes token.inspect, "SECRET"
    both = { "nodeId" => "llm:x", "kind" => "llm", "input" => REDACTED, input: REDACTED }
    # Equal, not the same object (the snapshot copy, see above).
    assert_equal both, red.apply("node.started", both, RUN), "already hidden everywhere: left alone, not counted"
  end

  def test_symbol_kind_is_the_tool_kind_json_writes
    red = redactor(hide_tool_args: true, hide_tool_results: true)
    started = red.apply("node.started", { "nodeId" => "custom:lookup", "kind" => :tool, "instanceId" => "i1", "input" => "SECRET-A" }, RUN)
    assert_equal REDACTED, started["input"]
    finished = red.apply("node.finished", { "nodeId" => "custom:lookup", "instanceId" => "i1", "output" => "SECRET-R" }, RUN)
    assert_equal REDACTED, finished["output"], "the instance's Symbol kind must count as tool for results too"
    token = red.apply("node.token", { "nodeId" => "llm:x", "deltas" => [{ "t" => :"tool-args", "v" => "SECRET-D" }] }, RUN)
    assert_equal "", token["deltas"][0]["v"], "a Symbol channel is written as \"tool-args\" too"
  end

  def test_symbol_kind_tool_arguments_never_reach_the_wire
    session, viewer = attached_session(env: { "GRAPHMIND_HIDE_TOOL_ARGS" => "1" })
    lookup = Graphmind::Wrap.gate_callable(->(email) { email.size }, -> { session }, name: "lookup", kind: :tool)
    session.run("r") { lookup.call("alice@example.com") }
    viewer.wait_for_frame("run.finished")
    refute_includes JSON.generate(viewer.received), "alice@example.com"
    started = viewer.frames_of("node.started").find { |f| f["payload"]["nodeId"] == "tool:lookup" }
    assert_equal ["tool", REDACTED], [started["payload"]["kind"], started["payload"]["input"]]
  end

  def test_start_node_extra_input_under_a_symbol_key_is_hidden_on_the_wire
    session, viewer = attached_session(hide_inputs: true)
    session.start_node(node_id: "tool:x", kind: "tool", name: "x", instance_id: "i1",
                       input: { "q" => "SECRET-1" }, extra: { input: "SECRET-2" })
    # A later event proves the one above was processed (json 3 refuses to
    # generate the mixed-key envelope and drops it; json 2 sends it).
    session.emit("node.started", { "nodeId" => "custom:marker", "kind" => "custom", "name" => "marker" })
    viewer.wait_until { viewer.received.any? { |f| f.dig("payload", "nodeId") == "custom:marker" } }
    refute_includes JSON.generate(viewer.received), "SECRET"
  end

  def test_chars_counts_utf16_code_units_like_javascript
    out = redactor(hide_outputs: true).apply(
      "node.token", { "nodeId" => "llm:x", "deltas" => [{ "t" => "text", "v" => "a😀é" }, { "t" => "text", "v" => "日本" }] }, RUN
    )
    assert_equal [4, 2], out["deltas"].map { |d| d["chars"] }
  end

  def test_node_error_is_never_redacted
    payload = { "nodeId" => "tool:a", "instanceId" => "1", "error" => { "name" => "E", "message" => "SECRET" } }
    red = redactor(hide_inputs: true, hide_outputs: true, hide_tool_args: true, hide_tool_results: true)
    assert_same payload, red.apply("node.error", payload, RUN)
  end

  def test_an_invalid_prior_count_is_not_carried_into_the_sum
    [1.5, -1, Float::NAN, Float::INFINITY, 2**60].each do |count|
      out = redactor(hide_outputs: true).apply(
        "node.finished", { "nodeId" => "llm:x", "output" => "S", "redaction" => { "count" => count, "keys" => ["input"] } }, RUN
      )
      assert_equal({ "count" => 1, "keys" => %w[input output] }, out["redaction"], count.inspect)
    end
    out = redactor(hide_outputs: true).apply(
      "node.finished", { "nodeId" => "llm:x", "output" => "S", "redaction" => { "count" => 2.0, "keys" => [] } }, RUN
    )
    assert_equal '{"count":3,"keys":["output"]}', JSON.generate(out["redaction"])
  end

  def test_instance_tracking_is_bounded_and_forgets_finished_instances
    red = Graphmind::Redaction::Redactor.new(
      Graphmind::Redaction::Switches.new(hide_tool_results: true), max_instances: 50
    )
    500.times do |i|
      red.apply("node.started", { "nodeId" => "x:#{i}", "kind" => "tool", "name" => "n", "instanceId" => i.to_s }, RUN)
    end
    assert_equal 50, red.tracked_instances
    red.apply("node.finished", { "nodeId" => "x:499", "instanceId" => "499", "output" => 1 }, RUN)
    assert_equal 49, red.tracked_instances
  end

  # This test used to pin the fail-OPEN behaviour the binding rule forbids: a
  # Hash whose #key? raises came back as the very same object, "S" and all, and
  # was sent; "nope" and nil were sent too. Now (decisions.md "Redaction fails
  # closed on internal error") the Hash is redacted from its real storage and a
  # payload that is not a Hash is dropped — still without raising.
  def test_hostile_payloads_never_raise
    hostile = Class.new(Hash) { def key?(*) = raise("boom") }.new
    hostile["input"] = "S"
    hostile["output"] = "S"
    red = redactor(hide_inputs: true, hide_outputs: true, hide_tool_results: true)
    assert_equal REDACTED, red.apply("node.started", hostile, RUN)["input"]
    assert_equal REDACTED, red.apply("node.finished", hostile, RUN)["output"]
    assert_same Graphmind::Redaction::DROP, red.apply("node.token", hostile, RUN), "no deltas and no nodeId"
    %w[node.started node.finished node.token].each do |type|
      assert_same Graphmind::Redaction::DROP, red.apply(type, "nope", RUN)
      assert_same Graphmind::Redaction::DROP, red.apply(type, nil, RUN)
    end
    assert_same hostile, redactor.apply("node.started", hostile, RUN), "every switch off: not involved"
  end

  def test_concurrent_threads_never_corrupt_the_tracking
    red = redactor(hide_tool_results: true)
    workers = Array.new(8) do |n|
      Thread.new do
        300.times do |i|
          iid = "#{n}-#{i}"
          red.apply("node.started", { "nodeId" => "x:#{n}", "kind" => "tool", "name" => "x", "instanceId" => iid }, RUN)
          out = red.apply("node.finished", { "nodeId" => "x:#{n}", "instanceId" => iid, "output" => i }, RUN)
          raise "not redacted" unless out["output"] == REDACTED
        end
      end
    end
    workers.each { |w| value_of(w) }
    assert_equal 0, red.tracked_instances
  end

  # -- fails closed (decisions.md "Redaction fails closed on internal error") ----

  DROP = Graphmind::Redaction::DROP
  FAILED = { "count" => 0, "keys" => %w[input output deltas], "failed" => true }.freeze
  CANARY = "FAILCLOSED-CANARY-7f3e"

  # A key whose #to_s raises: the snapshot cannot name it, so the event cannot
  # be inspected — the Ruby shape of "a property read throws".
  def raising_key = Object.new.tap { |k| k.define_singleton_method(:to_s) { raise "unnameable" } }

  def with_warnings
    reports = []
    [redactor(warn: ->(key, message) { reports << [key, message] }, hide_inputs: true, hide_outputs: true,
                                                                     hide_tool_results: true), reports]
  end

  def test_a_hash_whose_every_reader_raises_is_still_redacted_from_its_storage
    readers = %i[[] fetch key? has_key? include? each each_pair keys values to_h to_a dup clone merge
                 to_json dig slice select map any?]
    klass = Class.new(Hash) { readers.each { |m| define_method(m) { |*_a, **_k, &_b| raise "read #{m}" } } }
    payload = klass.new
    Graphmind::Redaction::HASH_EACH_PAIR.bind_call({ "nodeId" => "tool:t", "kind" => "tool", "name" => "t",
                                                     "instanceId" => "i1", "input" => CANARY }) do |k, v|
      Hash.instance_method(:[]=).bind_call(payload, k, v)
    end
    red, reports = with_warnings
    out = red.apply("node.started", payload, RUN)
    assert_instance_of Hash, out
    assert_equal REDACTED, out["input"]
    refute_includes JSON.generate(out), CANARY
    assert_equal CANARY, Hash.instance_method(:[]).bind_call(payload, "input"), "the host's object is never mutated"
    assert_empty reports, "nothing failed: the real storage was readable"
  end

  # Non-throwing ways past a switch: JSON.generate walks the Hash's storage and
  # honours an own #to_json and every key's #to_s, whatever #[] / #key? say.
  def test_closes_the_non_throwing_ways_past_the_switch
    red = redactor(hide_inputs: true)
    liar = Class.new(Hash) do
      def key?(key) = key == "input" ? false : super
      def [](key) = key == "input" ? "harmless" : super
    end.new
    liar.merge!("nodeId" => "tool:t", "kind" => "tool", "name" => "t", "instanceId" => "1", "input" => CANARY)
    to_json = { "nodeId" => "tool:t", "kind" => "tool", "name" => "t", "instanceId" => "2", "input" => "x" }
    to_json.define_singleton_method(:to_json) { |*| %({"input":"#{CANARY}"}) }
    renamed = +"harmless"
    renamed.define_singleton_method(:to_s) { "input" } # JSON.generate writes this key as "input"
    renamed_key = { "nodeId" => "tool:t", "kind" => "tool", "name" => "t", "instanceId" => "3" }.compare_by_identity
    renamed_key[renamed] = CANARY
    object_key = { "nodeId" => "tool:t", "kind" => "tool", "name" => "t", "instanceId" => "4",
                   Object.new.tap { |k| k.define_singleton_method(:to_s) { "input" } } => CANARY }
    fake_placeholder = Class.new(String) { def to_json(*) = %("#{CANARY}") }.new(REDACTED)
    lying_placeholder = { "nodeId" => "tool:t", "kind" => "tool", "name" => "t", "instanceId" => "5",
                          "input" => fake_placeholder }
    [liar, to_json, renamed_key, object_key, lying_placeholder].each_with_index do |payload, index|
      out = red.apply("node.started", payload, RUN)
      refute_includes JSON.generate({ "payload" => out }), CANARY, "payload #{index}"
    end
    # The same payloads DO leak when nothing redacts them: the test is not vacuous.
    [liar, to_json, renamed_key, object_key, lying_placeholder].each_with_index do |payload, index|
      assert_includes JSON.generate({ "payload" => payload }), CANARY, "payload #{index} (unredacted)"
    end
  end

  def test_a_started_event_that_cannot_be_inspected_is_sent_in_its_failed_form
    red, reports = with_warnings
    payload = { "nodeId" => "tool:t", "parentId" => "agent:a", "kind" => "tool", "name" => "t", "instanceId" => "i1",
                "input" => { "q" => CANARY }, "extra" => CANARY, raising_key => CANARY }
    out = red.apply("node.started", payload, RUN)
    assert_equal({ "nodeId" => "tool:t", "parentId" => "agent:a", "kind" => "tool", "name" => "t", "instanceId" => "i1",
                   "input" => REDACTED, "redaction" => FAILED }, out)
    assert_equal '{"nodeId":"tool:t","parentId":"agent:a","kind":"tool","name":"t","instanceId":"i1",' \
                 '"input":"__REDACTED__","redaction":{"count":0,"keys":["input","output","deltas"],"failed":true}}',
                 JSON.generate(out), "key order is the TypeScript reference's"
    assert_equal [["redaction:failed", "redaction failed on a node.started event (unreadable or malformed payload); " \
                                       "sent it with input/output/deltas hidden and redaction.failed set"]], reports
    # The failed start still taught the redactor the instance's kind.
    finished = red.apply("node.finished", { "nodeId" => "tool:t", "instanceId" => "i1", "durationMs" => 1,
                                            "status" => "ok", "output" => CANARY }, RUN)
    assert_equal REDACTED, finished["output"]
  end

  def test_a_failed_finished_form_copies_valid_timing_and_omits_invalid_optional_fields
    red, = with_warnings
    base = { "nodeId" => "tool:t", "instanceId" => "i1", "durationMs" => 2.5, "status" => "error",
             "output" => CANARY, raising_key => 1 }
    assert_equal({ "nodeId" => "tool:t", "instanceId" => "i1", "durationMs" => 2.5, "heldMs" => 0, "status" => "error",
                   "usage" => { "inputTokens" => 3, "outputTokens" => 4 }, "output" => REDACTED, "redaction" => FAILED },
                 red.apply("node.finished", base.merge("heldMs" => 0, "usage" => { inputTokens: 3, "outputTokens" => 4.0 }), RUN))
    assert_equal({ "nodeId" => "tool:t", "instanceId" => "i1", "durationMs" => 2.5, "status" => "error",
                   "output" => REDACTED, "redaction" => FAILED },
                 red.apply("node.finished", base.merge("heldMs" => -1, "usage" => { "inputTokens" => 1 }), RUN))
    assert_equal({ "nodeId" => "llm:x", "deltas" => [], "redaction" => FAILED },
                 red.apply("node.token", { "nodeId" => "llm:x", "instanceId" => 7, "deltas" => [CANARY] }, RUN))
  end

  def test_an_event_whose_required_fields_cannot_be_valid_is_dropped_with_one_report
    red, reports = with_warnings
    [
      ["node.started", { "nodeId" => "tool:t", "kind" => "tool", "name" => "t", "input" => CANARY, raising_key => 1 }],
      ["node.started", { "nodeId" => "tool:t", "kind" => "robot", "name" => "t", "instanceId" => "1", raising_key => 1 }],
      ["node.finished", { "nodeId" => "tool:t", "durationMs" => Float::NAN, "status" => "ok", raising_key => 1 }],
      ["node.finished", { "nodeId" => "tool:t", "durationMs" => 1, "status" => "done", raising_key => 1 }],
      ["node.token", { "deltas" => [CANARY] }],
      ["node.token", { raising_key => "nodeId", "deltas" => "x" }],
      ["node.started", Struct.new(:nodeId, :input).new("tool:t", CANARY)],
      ["node.finished", [CANARY]]
    ].each_with_index do |(type, payload), index|
      assert_same DROP, red.apply(type, payload, RUN), "case #{index}"
    end
    assert_equal ["redaction:dropped"], reports.map(&:first).uniq
    reports.each { |(_, message)| refute_includes message, CANARY }
  end

  # Symbol spellings reach the wire as Strings, so the failed form accepts them.
  def test_symbol_identity_fields_count_in_the_failed_form
    red, = with_warnings
    out = red.apply(:"node.started", { nodeId: :"tool:t", kind: :tool, name: :t, instanceId: "i", raising_key => 1,
                                       input: CANARY }, RUN)
    assert_equal '{"nodeId":"tool:t","kind":"tool","name":"t","instanceId":"i","input":"__REDACTED__",' \
                 '"redaction":{"count":0,"keys":["input","output","deltas"],"failed":true}}', JSON.generate(out)
  end

  def test_an_event_type_given_as_a_symbol_is_redacted_like_its_string
    out = redactor(hide_inputs: true).apply(:"node.started", { "nodeId" => "llm:x", "kind" => "llm", "input" => CANARY }, RUN)
    refute_includes JSON.generate(out), CANARY
  end

  # Any internal error — not only a hostile payload — fails closed.
  def test_an_internal_error_fails_closed_and_an_error_building_the_failed_form_drops
    reports = []
    switches = Graphmind::Redaction::Switches.new(hide_inputs: true, hide_outputs: true, hide_tool_args: false,
                                                  hide_tool_results: false)
    broken = Class.new(Graphmind::Redaction::Redactor) do
      private

      def on_started(*) = raise(NoMethodError, "bug")
      def on_token(*) = raise(SystemStackError, "deep")
    end.new(switches, warn: ->(key, message) { reports << [key, message] })
    started = { "nodeId" => "tool:t", "kind" => "tool", "name" => "t", "instanceId" => "1", "input" => CANARY }
    assert_equal({ "nodeId" => "tool:t", "kind" => "tool", "name" => "t", "instanceId" => "1",
                   "input" => REDACTED, "redaction" => FAILED }, broken.apply("node.started", started, RUN))
    assert_equal({ "nodeId" => "llm:x", "deltas" => [], "redaction" => FAILED },
                 broken.apply("node.token", { "nodeId" => "llm:x", "deltas" => [{ "t" => "text", "v" => CANARY }] }, RUN))
    worse = Class.new(Graphmind::Redaction::Redactor) do
      private

      def on_started(*) = raise("bug")
      def failed_form(*) = raise("worse")
    end.new(switches, warn: ->(*) { raise "the sink raises too" })
    assert_same DROP, worse.apply("node.started", started, RUN)
    assert_equal %w[redaction:failed redaction:failed], reports.map(&:first)
  end

  def test_token_deltas_it_cannot_inspect_fail_closed_only_where_a_switch_applies
    string_v = Class.new(String) { def empty? = true }.new(CANARY) # a lying #empty? still hides
    out = redactor(hide_outputs: true).apply("node.token", { "nodeId" => "llm:x", "deltas" => [{ "t" => "text", "v" => string_v }] }, RUN)
    assert_equal [{ "t" => "text", "v" => "", "chars" => CANARY.length }], out["deltas"]
    array_json = Class.new(Array) { def to_json(*) = %(["#{CANARY}"]) }.new([{ "t" => "text", "v" => "ok" }])
    out = redactor(hide_outputs: true).apply("node.token", { "nodeId" => "llm:x", "deltas" => array_json }, RUN)
    refute_includes JSON.generate(out), CANARY
    only_args = redactor(hide_tool_args: true)
    untouched = { "nodeId" => "llm:x", "deltas" => [{ "t" => "text", "v" => 3 }] }
    assert_equal untouched, only_args.apply("node.token", untouched, RUN), "no switch covers a text delta here"
    assert_equal({ "nodeId" => "llm:x", "deltas" => [], "redaction" => FAILED },
                 only_args.apply("node.token", { "nodeId" => "llm:x", "deltas" => [{ "t" => :"tool-args", "v" => nil }] }, RUN))
    assert_equal({ "nodeId" => "llm:x", "deltas" => [], "redaction" => FAILED },
                 redactor(hide_outputs: true).apply("node.token", { "nodeId" => "llm:x" }, RUN), "deltas missing")
    ok = redactor(hide_tool_results: true).apply("node.token", { "nodeId" => "llm:x", "deltas" => "nope" }, RUN)
    assert_equal({ "nodeId" => "llm:x", "deltas" => "nope" }, ok, "hide_tool_results covers no llm node: not inspected")
  end

  def test_every_switch_off_and_other_event_types_never_touch_a_hostile_payload
    hostile = { raising_key => CANARY, "nodeId" => "tool:t" }
    assert_same hostile, redactor.apply("node.started", hostile, RUN)
    all_on = redactor(hide_inputs: true, hide_outputs: true, hide_tool_args: true, hide_tool_results: true)
    %w[node.error run.started exec.paused graph.hint].each { |type| assert_same hostile, all_on.apply(type, hostile, RUN) }
  end

  # -- on the real wire ---------------------------------------------------------------

  def test_env_switches_hide_tool_args_and_results_on_the_wire_but_not_from_the_host
    session, viewer = attached_session(
      env: { "GRAPHMIND_HIDE_TOOL_ARGS" => "1", "GRAPHMIND_HIDE_TOOL_RESULTS" => "true" }
    )
    lookup = Graphmind::Wrap.gate_callable(->(email) { { "ssn" => "123-45-6789", "email" => email } },
                                           -> { session }, name: "lookup")
    result = session.run("r") do
      session.start_node(node_id: "custom:plan", kind: "custom", name: "plan", instance_id: "p1",
                         input: { "prompt" => "VISIBLE-PROMPT" })
      session.finish_node(node_id: "custom:plan", instance_id: "p1", duration_ms: 1, output: "VISIBLE-PLAN")
      lookup.call("alice@example.com")
    end
    assert_equal({ "ssn" => "123-45-6789", "email" => "alice@example.com" }, result)

    viewer.wait_for_frame("run.finished")
    raw = JSON.generate(viewer.received)
    refute_includes raw, "alice@example.com"
    refute_includes raw, "123-45-6789"
    assert_includes raw, "VISIBLE-PROMPT"
    assert_includes raw, "VISIBLE-PLAN"
    started = viewer.frames_of("node.started").find { |f| f["payload"]["nodeId"] == "tool:lookup" }
    finished = viewer.frames_of("node.finished").find { |f| f["payload"]["nodeId"] == "tool:lookup" }
    assert_equal REDACTED, started["payload"]["input"]
    assert_equal({ "count" => 1, "keys" => ["input"] }, started["payload"]["redaction"])
    assert_equal REDACTED, finished["payload"]["output"]
    assert_equal 0, finished["payload"]["heldMs"]
    viewer.received.reject { |f| f["type"] == "hello" }.each { |f| assert_valid_frame(f) }
  end

  def test_option_hides_outputs_and_streamed_tokens_but_not_errors
    session, viewer = attached_session(hide_outputs: true, token_interval: 0.001)
    session.run("r") do
      session.start_node(node_id: "llm:step", kind: "llm", name: "step", instance_id: "l1",
                         input: { "messages" => ["VISIBLE-IN"] })
      session.push_token("llm:step", "text", "SECRET-TOKEN-😀")
      session.flush
      session.error_node("llm:step", "l1", ArgumentError.new("error text stays: E-CLUE"))
      session.finish_node(node_id: "llm:step", instance_id: "l1", duration_ms: 3.14159, output: { "text" => "SECRET-OUT" })
    end
    viewer.wait_for_frame("run.finished")
    raw = JSON.generate(viewer.received)
    refute_includes raw, "SECRET-TOKEN"
    refute_includes raw, "SECRET-OUT"
    assert_includes raw, "VISIBLE-IN"
    assert_includes raw, "E-CLUE"
    assert_equal [{ "t" => "text", "v" => "", "chars" => 15 }], viewer.frames_of("node.token").first["payload"]["deltas"]
  end

  def test_redaction_happens_before_the_ring_buffer_so_replay_on_attach_is_redacted
    viewer = new_viewer
    session = new_session(url: viewer.url, env: { "GRAPHMIND_HIDE_INPUTS" => "1" })
    session.run("early") do
      session.start_node(node_id: "tool:t", kind: "tool", name: "t", instance_id: "1", input: { "k" => "BUFFERED-SECRET" })
      session.finish_node(node_id: "tool:t", instance_id: "1", duration_ms: 1, output: "ok")
    end
    assert session.ready(5.0)
    viewer.wait_for_frame("run.finished")
    refute_includes JSON.generate(viewer.received), "BUFFERED-SECRET"
    assert_equal REDACTED, viewer.frames_of("node.started").last["payload"]["input"]
  end

  def test_env_floor_beats_an_option_that_tries_to_lower_it
    session, viewer = attached_session(hide_inputs: false, env: { "GRAPHMIND_HIDE_INPUTS" => "1" })
    session.emit("node.started", { "nodeId" => "llm:x", "kind" => "llm", "name" => "x", "input" => "SECRET" })
    frame = viewer.wait_for_frame("node.started").first
    assert_equal REDACTED, frame["payload"]["input"]
  end

  def test_process_environment_is_read_when_no_env_is_passed
    ENV["GRAPHMIND_HIDE_TOOL_ARGS"] = "1"
    viewer = new_viewer
    session = Graphmind::Session.new(url: viewer.url, enabled: true, logger: ->(_) {}, retry_interval: 60.0)
    @sessions << session
    assert session.redaction_switches.hide_tool_args
    assert session.ready(5.0)
    session.emit("node.started", { "nodeId" => "tool:x", "kind" => "tool", "name" => "x", "input" => "SECRET" })
    assert_equal REDACTED, viewer.wait_for_frame("node.started").first["payload"]["input"]
  ensure
    ENV.delete("GRAPHMIND_HIDE_TOOL_ARGS")
  end

  def test_disabled_session_is_a_no_op
    session = new_session(enabled: false, hide_inputs: true)
    session.emit("node.started", { "nodeId" => "tool:x", "kind" => "tool", "name" => "x", "input" => "S" })
    assert_equal 0, session.stats.seq
  end

  # Fail closed on the real wire: hostile payloads emitted both before the
  # debugger attached (replayed from the ring buffer) and live. Nothing secret
  # may appear in any frame the viewer received, every frame must be valid, the
  # session keeps working, and each outcome is reported once.
  def test_hostile_payloads_never_put_a_hidden_value_on_the_wire_live_or_replayed
    viewer = new_viewer
    session = new_session(url: viewer.url, hide_inputs: true, hide_outputs: true, warn_interval: 3600.0)
    key = raising_key
    liar = Class.new(Hash) { def key?(k) = k == "input" ? false : super }
    emit_hostile = lambda do |tag|
      session.emit("node.started", { "nodeId" => "tool:a", "kind" => "tool", "name" => "a", "instanceId" => "#{tag}1",
                                     "input" => "#{CANARY}-#{tag}-input", key => "#{CANARY}-#{tag}-key" })
      session.emit("node.started", liar.new.merge!("nodeId" => "tool:b", "kind" => "tool", "name" => "b",
                                                   "instanceId" => "#{tag}2", "input" => "#{CANARY}-#{tag}-liar"))
      session.emit("node.token", { "nodeId" => "llm:c", "deltas" => ["#{CANARY}-#{tag}-bare-delta"] })
      session.emit("node.finished", { "nodeId" => "tool:a", "instanceId" => "#{tag}1", "durationMs" => 1,
                                      "status" => "finished?", "output" => "#{CANARY}-#{tag}-out", key => 1 })
      session.emit("node.started", Struct.new(:input).new("#{CANARY}-#{tag}-struct"))
    end
    emit_hostile.call("early")
    assert session.ready(5.0)
    emit_hostile.call("live")
    session.emit("node.started", { "nodeId" => "custom:marker", "kind" => "custom", "name" => "marker", "instanceId" => "m" })
    # (`Hash ===` guard: with the fix reverted a payload may be a bare String,
    # and the test must then fail on the canary below, not on #dig.)
    viewer.wait_until { viewer.received.any? { |f| Hash === f["payload"] && f["payload"]["nodeId"] == "custom:marker" } }

    frames = viewer.received.reject { |f| f["type"] == "hello" }
    refute_includes JSON.generate(viewer.received), CANARY
    frames.each { |f| assert_valid_frame(f) }
    failed = frames.select { |f| f.dig("payload", "redaction", "failed") }
    # Per round: the started with an unnameable key and the bare-string token
    # (failed forms); the liar is redacted normally; the finished with an
    # invalid status and the Struct are dropped.
    assert_equal %w[node.started node.token] * 2, failed.map { |f| f["type"] }
    assert_equal 2, frames.count { |f| f.dig("payload", "nodeId") == "tool:b" && f.dig("payload", "input") == REDACTED }
    assert_empty frames.select { |f| f["type"] == "node.finished" }
    seqs = viewer.received.map { |f| f["seq"] }.sort # hello takes a seq too
    assert_equal (0...seqs.size).to_a, seqs, "a dropped event takes no seq: no hole"
    assert_equal 1, warnings.count { |m| m.include?("redaction failed on a") }, warnings.inspect
    assert_equal 1, warnings.count { |m| m.include?("could not be redacted and its identity fields") }, warnings.inspect
    warnings.each { |m| refute_includes m, CANARY }
  end

  def test_fail_closed_never_raises_into_the_host_even_when_the_logger_raises
    session, viewer = attached_session(hide_tool_args: true, logger: ->(_m) { raise "logger down" })
    assert_nil session.emit("node.started", { "nodeId" => "tool:a", "kind" => "tool", raising_key => CANARY })
    assert_nil session.emit("node.token", { "nodeId" => "llm:a", "deltas" => [{ "t" => "tool-args", "v" => [CANARY] }] })
    lookup = Graphmind::Wrap.gate_callable(->(q) { "ok #{q}" }, -> { session }, name: "lookup")
    assert_equal "ok 1", session.run("r") { lookup.call(1) }
    viewer.wait_for_frame("run.finished")
    refute_includes JSON.generate(viewer.received), CANARY
  end

  # Verifier pass (loop v3 / fail-closed, 2026-09-14). The switches decide by
  # identity fields — a start's kind, the nodeId/instanceId a result's kind is
  # looked up by, a delta's t — but JSON.generate writes a Symbol as its name
  # and any other object as its #to_s. Before the fix a Symbol node_id (an
  # idiomatic `gate_callable(..., node_id: :lookup)`) was never remembered, so
  # the tool's result went out unhidden under HIDE_TOOL_RESULTS; an object whose
  # #to_s is "tool" kept a tool's arguments visible under `"kind":"tool"`.
  class ToS
    def initialize(text)
      @text = text
    end

    def to_s
      @text
    end
  end

  def test_a_symbol_node_id_counts_as_its_name_and_a_to_s_identity_fails_closed_on_the_wire
    canary = "COERCED-CANARY-4c7a"
    warnings = []
    session, viewer = attached_session(hide_tool_args: true, hide_tool_results: true, logger: ->(m) { warnings << m })
    lookup = Graphmind::Wrap.gate_callable(->(q) { "#{canary} for #{q}" }, -> { session }, name: "lookup", kind: :tool,
                                                                                            node_id: :"custom:lookup")
    session.run("coerced") do
      assert_equal "#{canary} for 1", lookup.call(1)
      # a start's kind whose #to_s is the tool kind
      assert_nil session.emit("node.started", { "nodeId" => "tool:a", "kind" => ToS.new("tool"), "name" => "a",
                                                "instanceId" => "a1", "input" => { "q" => canary } })
      # a result whose nodeId / instanceId is an object JSON writes as the string
      session.emit("node.started", { "nodeId" => "mcp:d", "kind" => "tool", "name" => "d", "instanceId" => "d1", "input" => 1 })
      session.emit("node.finished", { "nodeId" => ToS.new("mcp:d"), "instanceId" => "d1", "durationMs" => 1, "status" => "ok",
                                      "output" => { "r" => canary } })
      session.emit("node.started", { "nodeId" => "mcp:e", "kind" => "tool", "name" => "e", "instanceId" => "e1", "input" => 1 })
      session.emit("node.started", { "nodeId" => "mcp:e", "kind" => "llm", "name" => "e", "instanceId" => "e2", "input" => 1 })
      session.emit("node.finished", { "nodeId" => "mcp:e", "instanceId" => ToS.new("e1"), "durationMs" => 1, "status" => "ok",
                                      "output" => { "r" => canary } })
      # tokens: a Symbol nodeId of a tool is that tool; a #to_s channel fails closed
      session.emit("node.token", { "nodeId" => :"custom:lookup", "deltas" => [{ "t" => "text", "v" => canary }] })
      session.emit("node.token", { "nodeId" => "llm:f", "deltas" => [{ "t" => ToS.new("tool-args"), "v" => canary }] })
      # the session keeps streaming and still redacts a well-formed call
      session.start_node(node_id: "tool:after", kind: "tool", name: "after", instance_id: "z1", input: { "q" => canary })
    end
    viewer.wait_for_frame("run.finished")
    frames = viewer.received.reject { |f| f["type"] == "hello" }
    refute_includes JSON.generate(viewer.received), canary
    frames.each { |f| assert_valid_frame(f) }
    failed = { "count" => 0, "keys" => %w[input output deltas], "failed" => true }
    starts = viewer.frames_of("node.started").map { |f| f["payload"]["nodeId"] }
    assert_equal %w[agent:coerced custom:lookup mcp:d mcp:e mcp:e tool:after], starts
    lookup_done = viewer.frames_of("node.finished").find { |f| f["payload"]["nodeId"] == "custom:lookup" }
    assert_equal REDACTED, lookup_done["payload"]["output"], "a Symbol node_id's tool result is hidden"
    results = viewer.frames_of("node.finished").map { |f| f["payload"] }.select { |p| p["nodeId"].start_with?("mcp:") }
    assert_equal [["mcp:e", false, REDACTED, failed]],
                 results.map { |p| [p["nodeId"], p.key?("instanceId"), p["output"], p["redaction"]] }
    tokens = viewer.frames_of("node.token").map { |f| f["payload"] }
    assert_equal [{ "nodeId" => "custom:lookup", "deltas" => [{ "t" => "text", "v" => "", "chars" => canary.size }],
                    "redaction" => { "count" => 1, "keys" => ["deltas"] } },
                  { "nodeId" => "llm:f", "deltas" => [], "redaction" => failed }], tokens
    warnings.each { |m| refute_includes m, canary }
    assert_equal 1, warnings.count { |m| m.include?("could not be redacted and its identity fields") }, warnings.inspect
    assert_equal 1, warnings.count { |m| m.include?("redaction failed on a") }, warnings.inspect
  end

  # A kind that is a String subclass lying in #== must still count as "tool" for
  # the fingerprint rule: hide_tool_args hides the input, so the unsalted digest
  # of that input must not reach the wire either (found by the loop-v3 verifier).
  def test_a_kind_that_lies_in_equality_still_hides_the_loop_fingerprint
    liar = Class.new(String) { def ==(_other) = false }
    session, viewer = attached_session(hide_tool_args: true, loop_guard: { threshold: 3 })
    lookup = Graphmind::Wrap.gate_callable(->(email) { "found #{email}" }, -> { session },
                                           name: "lookup", kind: liar.new("tool"))
    worker = Thread.new { 3.times { lookup.call("alice@example.com") } }
    paused = viewer.wait_for_frame("exec.paused").first
    assert_equal "loop", paused["payload"]["reason"]
    assert_equal Graphmind::Redaction::REDACTED, paused["payload"]["loop"]["fingerprint"]
    viewer.resume(paused["payload"]["pauseId"], "continue")
    value_of(worker)
  end

end
