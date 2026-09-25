# frozen_string_literal: true

require_relative "test_helper"
require "open3"
require "tmpdir"

# 0.6.0 parity for the Ruby gem (W1 scope — it does not announce edit-input):
# the requestId echo, hello.ack.hubCapabilities, the client-side inject guard
# under every debugger, an edited input refused rather than dropped, and the
# redaction of the answers. The guard's marker list is pinned by the shared
# fixture packages/client/test/fixtures/edit-input.json (`proposedValue`),
# which the TypeScript client, the hub and the Python SDK consume too.
class TestEditGuard < Minitest::Test
  FIXTURE = File.join(GraphmindTest::REPO_ROOT, "packages", "client", "test", "fixtures", "edit-input.json")
  BEFORE_TOOL = { "kind" => "tool", "name" => "search", "point" => "before" }.freeze
  EDITS = ["edit-input"].freeze

  def fixture = JSON.parse(File.read(FIXTURE, encoding: "UTF-8"))

  def held_tool(session, name: "search", &body)
    body ||= ->(q) { "real #{q}" }
    tool = Graphmind::Wrap.gate_callable(body, -> { session }, name: name)
    worker = Thread.new { tool.call("x") }
    worker.report_on_exception = false
    worker
  end

  # -- the shared fixture -----------------------------------------------------

  def test_the_fixture_uses_the_shared_placeholder
    assert_equal Graphmind::Redaction::REDACTED, fixture["placeholder"]
    assert_equal [nil, "placeholder", "truncated"], fixture["proposedValue"].map { |c| c["refusal"] }.uniq.sort_by(&:to_s)
  end

  def test_every_proposed_value_case_reproduces
    fixture["proposedValue"].each do |c|
      code = Graphmind::EditGuard.proposed_value_refusal(c["value"])&.code
      if c["refusal"].nil?
        assert_nil code, c["name"]
      else
        assert_equal c["refusal"], code, c["name"]
      end
    end
  end

  def test_what_cannot_be_serialised_is_a_shape_refusal_never_a_raise
    cyclic = {}
    cyclic["self"] = cyclic
    ["\xFF".dup.force_encoding(Encoding::BINARY), cyclic, Float::NAN].each do |value|
      assert_equal "shape", Graphmind::EditGuard.proposed_value_refusal(value).code
    end
  end

  def test_messages_never_quote_the_value
    secret = "SECRET-CANARY-91f2"
    [{ "q" => "#{secret} __REDACTED__" }, { "q" => "#{secret}…[truncated]" }].each do |value|
      refute_includes Graphmind::EditGuard.proposed_value_refusal(value).message, secret
    end
  end

  # -- hello and hello.ack ------------------------------------------------------

  def test_hello_does_not_announce_edit_input
    _session, viewer = attached_session(viewer_options: { hub_capabilities: EDITS })
    capabilities = viewer.wait_for_frame("hello").first["payload"]["capabilities"]
    refute_includes capabilities, "edit-input"
    assert_includes capabilities, "pause"
  end

  def test_pauses_are_never_offered_as_editable
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL], hub_capabilities: EDITS })
    worker = held_tool(session)
    paused = viewer.wait_for_frame("exec.paused").first
    assert_equal %w[pauseId nodeId point reason instanceId], paused["payload"].keys
    viewer.resume(paused["payload"]["pauseId"], "continue")
    assert_equal "real x", value_of(worker)
  end

  # -- requestId -------------------------------------------------------------------

  def test_request_id_is_echoed_on_exec_resumed
    %w[continue abort].each do |action|
      session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })
      worker = held_tool(session)
      pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
      viewer.resume_with({ "pauseId" => pause_id, "action" => action, "requestId" => "rq-#{action}" })
      begin
        value_of(worker)
      rescue Graphmind::AbortError
        nil
      end
      resumed = viewer.wait_for_frame("exec.resumed").first
      assert_equal({ "pauseId" => pause_id, "action" => action, "requestId" => "rq-#{action}" }, resumed["payload"])
      assert_valid_frame(resumed)
    end
  end

  def test_no_request_id_no_echo_and_a_long_one_is_echoed_whole
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })
    worker = held_tool(session)
    pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
    viewer.resume(pause_id, "continue")
    value_of(worker)
    assert_equal({ "pauseId" => pause_id, "action" => "continue" }, viewer.wait_for_frame("exec.resumed").first["payload"])

    worker = held_tool(session)
    second = viewer.wait_for_frame("exec.paused", count: 2).last["payload"]["pauseId"]
    long_id = "r" * 300
    viewer.resume_with({ "pauseId" => second, "action" => "continue", "requestId" => long_id })
    value_of(worker)
    assert_equal long_id, viewer.wait_for_frame("exec.resumed", count: 2).last["payload"]["requestId"]
  end

  def test_a_request_id_that_is_not_a_string_is_not_echoed
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })
    worker = held_tool(session)
    pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
    viewer.resume_with({ "pauseId" => pause_id, "action" => "continue", "requestId" => 7 })
    value_of(worker)
    refute viewer.wait_for_frame("exec.resumed").first["payload"].key?("requestId")
  end

  # -- the inject guard ------------------------------------------------------------

  def test_a_placeholder_or_preview_is_never_injected_under_any_debugger
    outputs = {
      { "answer" => "__REDACTED__" } => "placeholder",
      { "rows" => { "__graphmindTruncated" => true, "bytes" => 900_000, "preview" => "[" } } => "truncated",
      { "body" => "<4096 bytes>" } => "truncated",
      { "text" => "cut…[truncated]" } => "truncated"
    }
    [EDITS, nil].each do |hub|
      outputs.each do |output, code|
        @warnings = []
        session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL], hub_capabilities: hub })
        ran = false
        worker = held_tool(session) { |_q| ran = true; "real" }
        pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
        viewer.resume_with({ "pauseId" => pause_id, "action" => "inject", "output" => output, "requestId" => "inj" })
        refused = viewer.wait_for_frame("exec.refused").first
        assert_equal({ "pauseId" => pause_id, "code" => code, "message" => refused["payload"]["message"],
                       "requestId" => "inj" }, refused["payload"])
        assert_valid_frame(refused)
        sleep 0.05
        assert worker.alive?, "the gate must stay held after a refused inject"
        assert_equal 1, session.stats.held_gates
        # A 0.5 debugger does not show exec.refused: the app log says why.
        logged = warnings.count { |w| w.include?("refused an injected value") }
        assert_equal hub.nil? ? 1 : 0, logged, "hub #{hub.inspect}"
        viewer.resume(pause_id, "continue")
        assert_equal "real", value_of(worker)
        assert ran
      end
    end
  end

  # -- the gem's own recording bounds --------------------------------------------
  #
  # Session#sanitize bounds every recorded tool input and output. Each bound
  # must leave a marker the shared guard (this gem's, the TS client's and the
  # hub's) knows, or a pre-filled copy of a cut recording — the viewer's
  # editor starts from the recorded input at a Ruby gate — is injected and the
  # app runs on with part of its data silently gone.

  # Its #inspect is longer than Session::MAX_PREVIEW, and JSON cannot express it.
  class Blob
    def inspect = "#<Blob #{'y' * 9000}>"
  end

  ROWS = 250

  def rows = (1..ROWS).map { |i| { "id" => i, "status" => "open" } }
  def deep(levels) = (1..levels).reduce("leaf") { |inner, _| { "n" => inner } }

  def recordings
    session = new_session
    {
      "array" => session.send(:sanitize, { "rows" => rows }),
      "hash" => session.send(:sanitize, { "cols" => (1..ROWS).to_h { |i| ["k#{i}", i] } }),
      "depth" => session.send(:sanitize, deep(80)),
      "inspect" => session.send(:sanitize, { "blob" => Blob.new })
    }
  end

  def test_every_recording_bound_leaves_a_shared_truncation_marker
    recorded = recordings
    e = Graphmind::EditGuard::ELLIPSIS
    assert_equal rows.first(200) + ["#{e}[50 more]"], recorded["array"]["rows"]
    cols = recorded["hash"]["cols"]
    assert_equal 201, cols.size
    assert_equal "[50 more keys]", cols[e]
    assert_includes JSON.generate(recorded["depth"]), %("#{e}[depth limit]")
    blob = recorded["inspect"]["blob"]
    assert_equal "#<Blob #{'y' * (Graphmind::Session::MAX_PREVIEW - 7)}#{e}[truncated]", blob
    recorded.each do |bound, value|
      # The viewer pre-fills the recording; the user fixes one field and injects.
      edited = JSON.parse(JSON.generate(value), max_nesting: false)
      edited["rows"][0]["status"] = "closed" if bound == "array"
      assert_equal "truncated", Graphmind::EditGuard.proposed_value_refusal(edited)&.code, bound
    end
  end

  def test_a_value_within_every_bound_is_recorded_whole_and_injectable
    session = new_session
    value = { "rows" => rows.first(200), "cols" => (1..200).to_h { |i| ["k#{i}", i] },
              "deep" => deep(40), "text" => "y" * 20_000 }
    recorded = session.send(:sanitize, value)
    assert_equal value, recorded
    assert_nil Graphmind::EditGuard.proposed_value_refusal(recorded)
  end

  def test_the_typescript_client_and_the_hub_refuse_a_cut_ruby_recording
    node = ENV.fetch("GRAPHMIND_NODE", "node")
    client = File.join(GraphmindTest::REPO_ROOT, "packages", "client", "dist", "index.js")
    hub = File.join(GraphmindTest::REPO_ROOT, "packages", "cli", "dist", "control-auth.js")
    skip("packages/client and packages/cli are not built") unless File.exist?(client) && File.exist?(hub)
    Dir.mktmpdir("gm-edit-guard") do |dir|
      data = File.join(dir, "recordings.json")
      File.write(data, JSON.generate(recordings, max_nesting: false))
      script = <<~JS
        const { proposedValueRefusal } = await import(#{JSON.generate("file://#{client}")});
        const { contentRefusal } = await import(#{JSON.generate("file://#{hub}")});
        const fs = await import('node:fs');
        const recordings = JSON.parse(fs.readFileSync(#{JSON.generate(data)}, 'utf8'));
        const out = {};
        for (const [bound, value] of Object.entries(recordings)) {
          out[bound] = [proposedValueRefusal(value)?.code ?? null, contentRefusal(value, 'output')?.code ?? null];
        }
        process.stdout.write(JSON.stringify(out));
      JS
      out, err, status = Open3.capture3(node, "--input-type=module", "-e", script)
      assert status.success?, "node failed: #{err[0, 2000]}"
      codes = JSON.parse(out)
      assert_equal(recordings.keys.to_h { |bound| [bound, %w[truncated truncated]] }, codes)
    end
  rescue Errno::ENOENT
    skip("node is not available")
  end

  def test_a_prefilled_cut_recording_is_never_injected
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })
    tool = Graphmind::Wrap.gate_callable(->(list) { list }, -> { session }, name: "search")
    worker = Thread.new { tool.call(rows) }
    worker.report_on_exception = false
    pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
    # What the viewer's editor starts from at a Ruby gate: the recorded input.
    prefill = viewer.frames_of("node.started").last["payload"]["input"]
    edited = prefill["list"].dup
    edited[0] = edited[0].merge("status" => "closed")
    viewer.resume_with({ "pauseId" => pause_id, "action" => "inject", "output" => edited, "requestId" => "cut" })
    refused = viewer.wait_for_frame("exec.refused").first
    assert_equal "truncated", refused["payload"]["code"]
    assert_equal 1, session.stats.held_gates, "the gate stays held after a refused inject"
    viewer.resume(pause_id, "continue")
    assert_equal ROWS, value_of(worker).length
  end

  def test_a_cut_recorded_output_is_refused_too
    session, viewer = attached_session
    tool = Graphmind::Wrap.gate_callable(->(_q) { rows }, -> { session }, name: "fetch_rows")
    assert_equal ROWS, tool.call("all").length
    output = viewer.wait_for_frame("node.finished").first["payload"]["output"]
    assert_equal 201, output.length
    assert_equal "truncated", Graphmind::EditGuard.proposed_value_refusal(output)&.code
  end

  # -- deeply nested values ------------------------------------------------------
  #
  # json's default max_nesting (100) is not a limit the TypeScript client, the
  # hub or the Python SDK have: a clean value nested ~100 levels was refused
  # as `shape` here, and a resume frame carrying one was dropped unanswered.

  DEEP = 110

  def deep_value(levels = DEEP) = (1..levels).reduce("leaf") { |inner, _| { "k" => inner } }

  def test_a_clean_deeply_nested_value_is_not_refused
    assert_nil Graphmind::EditGuard.proposed_value_refusal(deep_value)
    assert_equal "truncated", Graphmind::EditGuard.proposed_value_refusal(deep_value.merge("x" => "cut…[truncated]"))&.code
    assert_nil Graphmind::EditGuard.proposed_value_refusal(deep_value(Graphmind::EditGuard::MAX_NESTING - 1))
  end

  # Past the guard's bound the value cannot be checked: a `shape` refusal,
  # never a crash (json's generator would overflow the thread's stack).
  def test_a_value_nested_past_the_guards_bound_is_refused_on_any_thread
    worker = Thread.new { Graphmind::EditGuard.proposed_value_refusal(deep_value(5_000))&.code }
    assert_equal "shape", value_of(worker)
    assert_equal "shape", Graphmind::EditGuard.proposed_value_refusal(deep_value(Graphmind::EditGuard::MAX_NESTING + 1))&.code
  end

  # Written as the hub's JSON.stringify writes it (the fake viewer's own
  # JSON.generate keeps json's default nesting limit).
  def send_deep_inject(viewer, pause_id, output, request_id)
    frame = JSON.generate({ "gm" => Graphmind::Protocol::PROTOCOL_VERSION, "seq" => 1000, "ts" => 1, "runId" => "*",
                            "type" => "exec.resume",
                            "payload" => { "pauseId" => pause_id, "action" => "inject", "output" => output,
                                           "requestId" => request_id } }, max_nesting: false)
    viewer.live_connections.each { |connection| connection.send_text(frame) }
  end

  def test_a_deeply_nested_inject_is_answered_and_applied
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })
    worker = held_tool(session)
    pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
    send_deep_inject(viewer, pause_id, deep_value, "deep")
    resumed = viewer.wait_for_frame("exec.resumed", timeout: 3.0).first
    assert_equal({ "pauseId" => pause_id, "action" => "inject", "requestId" => "deep" }, resumed["payload"])
    assert_equal deep_value, value_of(worker)
    assert_empty warnings.grep(/ignoring invalid frame/)
  end

  def test_an_inject_too_deep_to_check_is_refused_not_dropped
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })
    worker = held_tool(session)
    pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
    send_deep_inject(viewer, pause_id, deep_value(5_000), "too-deep")
    refused = viewer.wait_for_frame("exec.refused", timeout: 3.0).first
    assert_equal %w[shape too-deep], refused["payload"].values_at("code", "requestId")
    assert_equal 1, session.stats.held_gates, "the gate stays held after a refused inject"
    viewer.resume(pause_id, "continue")
    assert_equal "real x", value_of(worker)
  end

  def test_a_legitimate_truncated_field_is_injected
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })
    worker = held_tool(session)
    pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
    value = { "tree" => [], "truncated" => true, "note" => "GitHub API capped the listing" }
    viewer.resume(pause_id, "inject", value)
    assert_equal value, value_of(worker)
  end

  def test_hub_capabilities_are_forgotten_on_detach_and_re_read_on_attach
    @warnings = []
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL], hub_capabilities: EDITS })
    viewer.hub_capabilities = nil # the debugger comes back as a 0.5 hub
    viewer.live_connections.each(&:close)
    wait_until(label: "re-attach") { viewer.connection_count >= 2 && session.attached? }
    wait_until(label: "second hello") { viewer.frames_of("hello").length >= 2 }
    worker = held_tool(session)
    pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
    viewer.resume(pause_id, "inject", "__REDACTED__")
    viewer.wait_for_frame("exec.refused")
    wait_until(label: "log line") { warnings.any? { |w| w.include?("refused an injected value") } }
    viewer.resume(pause_id, "continue")
    value_of(worker)
  end

  # -- an edited input -----------------------------------------------------------

  def test_an_edited_input_is_refused_and_the_gate_stays_held
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL], hub_capabilities: EDITS })
    calls = []
    worker = held_tool(session) { |q| calls << q; "real #{q}" }
    pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
    viewer.resume_with({ "pauseId" => pause_id, "action" => "continue", "input" => { "q" => "edited" },
                         "requestId" => "e1" })
    refused = viewer.wait_for_frame("exec.refused").first["payload"]
    assert_equal "disabled", refused["code"]
    assert_equal "e1", refused["requestId"]
    sleep 0.05
    assert worker.alive?
    assert_empty calls
    viewer.resume(pause_id, "continue")
    assert_equal "real x", value_of(worker)
    assert_equal ["x"], calls
  end

  def test_unknown_pauses_and_actions_are_ignored
    session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] })
    worker = held_tool(session)
    pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
    viewer.resume_with({ "pauseId" => "pause_nope", "action" => "inject", "output" => "__REDACTED__" })
    viewer.resume_with({ "pauseId" => pause_id, "action" => "explode" })
    sleep 0.1
    assert_empty viewer.frames_of("exec.refused")
    assert worker.alive?
    viewer.resume(pause_id, "continue")
    value_of(worker)
  end

  # -- redaction of the answers ----------------------------------------------------

  def test_a_refusal_message_is_hidden_exactly_when_the_input_is
    [
      [{ env: { "GRAPHMIND_HIDE_TOOL_ARGS" => "1" } }, true],
      [{ hide_inputs: true }, true],
      [{ env: { "GRAPHMIND_HIDE_OUTPUTS" => "1" } }, false]
    ].each do |session_options, covered|
      session, viewer = attached_session(viewer_options: { breakpoints: [BEFORE_TOOL] }, **session_options)
      worker = held_tool(session)
      pause_id = viewer.wait_for_frame("exec.paused").first["payload"]["pauseId"]
      viewer.resume_with({ "pauseId" => pause_id, "action" => "inject", "output" => "__REDACTED__" })
      refused = viewer.wait_for_frame("exec.refused").first
      if covered
        assert_equal({ "pauseId" => pause_id, "code" => "placeholder",
                       "redaction" => { "count" => 1, "keys" => ["message"] } }, refused["payload"])
      else
        assert_equal Graphmind::EditGuard::PLACEHOLDER_MESSAGE, refused["payload"]["message"]
      end
      assert_valid_frame(refused)
      viewer.resume(pause_id, "continue")
      value_of(worker)
    end
  end

  def test_the_redactor_fails_closed_on_a_hostile_pause_answer
    red = Graphmind::Redaction::Redactor.new(
      Graphmind::Redaction::Switches.new(hide_inputs: true, hide_outputs: false, hide_tool_args: false,
                                         hide_tool_results: false)
    )
    hostile = Class.new(Hash) do
      def each_pair = raise("boom")
    end
    # Hash's own storage is read (bound each_pair), so a subclass cannot hide from it.
    payload = hostile.new
    payload["pauseId"] = "p"
    payload["action"] = "continue"
    payload["edited"] = { "after" => "SECRET" }
    out = red.apply("exec.resumed", payload, "r", "tool")
    assert_equal({ "pauseId" => "p", "action" => "continue", "edited" => { "after" => "__REDACTED__" },
                   "redaction" => { "count" => 1, "keys" => ["edited"] } }, out)
    assert_same Graphmind::Redaction::DROP, red.apply("exec.refused", { "pauseId" => 7, "code" => "schema" }, "r", "tool")
    assert_same Graphmind::Redaction::DROP, red.apply("exec.resumed", "raw", "r", nil)
    unkeyable = Object.new
    def unkeyable.to_s = raise("no name")
    weird = { "pauseId" => "p", "action" => "abort", unkeyable => 1 }
    failed = red.apply("exec.resumed", weird, "r", "tool")
    assert_equal({ "pauseId" => "p", "action" => "abort", "edited" => { "after" => "__REDACTED__" },
                   "redaction" => { "count" => 0, "keys" => ["edited"], "failed" => true } }, failed)
  end
end
