# frozen_string_literal: true

require_relative "test_helper"

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
    assert_equal %w[pauseId nodeId point], paused["payload"].keys
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
