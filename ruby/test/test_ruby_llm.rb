# frozen_string_literal: true

require_relative "test_helper"

begin
  require "ruby_llm"
  require "graphmind/integrations/ruby_llm"
  RUBY_LLM_AVAILABLE = true
rescue LoadError
  RUBY_LLM_AVAILABLE = false
end

# Instrumentation for the `ruby_llm` gem. No network and no API key: the
# provider round-trip is stubbed on the chat object itself, one layer below the
# hook GraphMind gates, so everything above it is the real gem.
class TestRubyLLM < Minitest::Test
  def setup
    super
    skip("ruby_llm is not installed") unless RUBY_LLM_AVAILABLE

    ::RubyLLM.configure { |config| config.openai_api_key = "test-key" }
    @completions = 0
  end

  def test_a_completion_becomes_an_llm_node
    session, viewer = attached_session
    chat = instrumented_chat(session)

    response = chat.ask("what is 2 + 2?")

    assert_equal "four", response.content
    assert_equal 1, @completions

    started = viewer.wait_for_frame("node.started").first
    finished = viewer.wait_for_frame("node.finished").first
    assert_equal "llm:step", started["payload"]["nodeId"]
    assert_equal "llm", started["payload"]["kind"]
    assert_equal "provider_completion", started["payload"]["input"]["hook"]
    assert_equal "what is 2 + 2?", started["payload"]["input"]["messages"].last["content"]
    assert_equal "four", finished["payload"]["output"]["text"]
    assert_equal({ "inputTokens" => 7, "outputTokens" => 2 }, finished["payload"]["usage"])
    assert_valid_frame(started)
    assert_valid_frame(finished)
  end

  def test_inject_at_the_before_gate_skips_the_provider_call
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "llm", "point" => "before" }] }
    )
    chat = instrumented_chat(session)

    worker = Thread.new { chat.ask("hello") }
    paused = viewer.wait_for_frame("exec.paused").first
    # What a human types in the viewer is JSON, not a Ruby object — the
    # integration coerces it into a RubyLLM::Message.
    viewer.resume(paused["payload"]["pauseId"], "inject", "injected")

    reply = value_of(worker)
    assert_instance_of ::RubyLLM::Message, reply
    assert_equal "injected", reply.content
    assert_equal :assistant, reply.role
    assert_equal 0, @completions, "no provider call may happen when a reply is injected"
  end

  def test_an_injected_object_is_coerced_too
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "llm", "point" => "before" }] }
    )
    chat = instrumented_chat(session)

    worker = Thread.new { chat.ask("hello") }
    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "inject",
                  { "role" => "assistant", "content" => "from a hash" })

    assert_equal "from a hash", value_of(worker).content
  end

  def test_retry_at_the_error_gate_calls_the_provider_again
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "llm", "point" => "error" }] }
    )
    chat = instrumented_chat(session, fail_first: true)

    worker = Thread.new { chat.ask("hello") }
    paused = viewer.wait_for_frame("exec.paused").first
    assert_equal "error", paused["payload"]["point"]
    viewer.resume(paused["payload"]["pauseId"], "retry")

    assert_equal "four", value_of(worker).content
    assert_equal 2, @completions
  end

  def test_a_tool_call_becomes_a_gated_tool_node
    session, viewer = attached_session
    chat = instrumented_chat(session, tool: weather_tool_class)
    tool = chat.tools.values.first

    assert_equal "sunny in Cairo", call_tool(tool, { "city" => "Cairo" })

    started = viewer.wait_for_frame("node.started").first
    finished = viewer.wait_for_frame("node.finished").first
    assert_equal "tool:weather", started["payload"]["nodeId"]
    assert_equal "tool", started["payload"]["kind"]
    assert_equal({ "city" => "Cairo" }, started["payload"]["input"])
    assert_equal "sunny in Cairo", finished["payload"]["output"]
    assert_valid_frame(started)
  end

  def test_inject_replaces_a_tool_result
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "weather", "point" => "before" }] }
    )
    chat = instrumented_chat(session, tool: weather_tool_class)
    tool = chat.tools.values.first

    worker = Thread.new { call_tool(tool, { "city" => "Cairo" }) }
    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "inject", "a blizzard, actually")

    assert_equal "a blizzard, actually", value_of(worker)
  end

  def test_tools_added_after_instrumentation_are_gated_too
    session, viewer = attached_session
    chat = instrumented_chat(session)

    chat.with_tools(weather_tool_class)
    call_tool(chat.tools.values.first, { "city" => "Oslo" })

    started = viewer.wait_for_frame("node.started").first
    assert_equal "tool:weather", started["payload"]["nodeId"]
  end

  # 1.x only: 2.0 removed `with_tool`.
  def test_a_tool_added_with_with_tool_is_gated_too
    plain = ::RubyLLM.chat(model: "gpt-4o-mini", provider: :openai, assume_model_exists: true)
    skip("this ruby_llm has no Chat#with_tool") unless plain.respond_to?(:with_tool)

    session, viewer = attached_session
    chat = instrumented_chat(session)
    chat.with_tool(weather_tool_class)
    call_tool(chat.tools.values.first, { "city" => "Oslo" })

    assert_equal "tool:weather", viewer.wait_for_frame("node.started").first["payload"]["nodeId"]
  end

  # A registration method this version lacks must stay missing: patching it in
  # would make `respond_to?` lie to duck-typing callers, and calling it would
  # fail inside GraphMind instead of with the gem's own NoMethodError.
  def test_instrumenting_adds_no_methods_the_chat_did_not_have
    plain = ::RubyLLM.chat(model: "gpt-4o-mini", provider: :openai, assume_model_exists: true)
    had = %i[with_tool with_tools].to_h { |name| [name, plain.respond_to?(name)] }

    session, = attached_session
    chat = instrumented_chat(session)

    had.each { |name, before| assert_equal before, chat.respond_to?(name), "respond_to?(:#{name})" }
  end

  # The real loop, not a direct `tool.call`: the provider asks for a tool, the
  # gem executes it the way this version does (1.x: `call(args)`; 2.0:
  # `call(**args, tool_call:)`), and the model answers with its result.
  def test_the_chat_loop_runs_a_gated_tool_and_carries_on
    session, viewer = attached_session
    chat = instrumented_chat(session, tool: weather_tool_class, tool_round: { "city" => "Cairo" })

    reply = chat.ask("weather in Cairo?")

    assert_equal "four", reply.content
    assert_equal 2, @completions
    tool_started = viewer.wait_for_frame("node.started", count: 3).find do |frame|
      frame["payload"]["nodeId"] == "tool:weather"
    end
    refute_nil tool_started
    assert_equal({ "city" => "Cairo" }, tool_started["payload"]["input"],
                 "the tool input is the model's arguments, without RubyLLM's ToolCall")
    tool_finished = viewer.frames_of("node.finished").find { |f| f["payload"]["nodeId"] == "tool:weather" }
    assert_equal "sunny in Cairo", tool_finished["payload"]["output"]
    assert_equal "sunny in Cairo", chat.messages.find { |m| m.role == :tool }.content
  end

  def test_inject_through_the_chat_loop_reaches_the_model
    session, viewer = attached_session(
      viewer_options: { breakpoints: [{ "kind" => "tool", "name" => "weather", "point" => "before" }] }
    )
    chat = instrumented_chat(session, tool: weather_tool_class, tool_round: { "city" => "Cairo" })

    worker = Thread.new { chat.ask("weather in Cairo?") }
    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "inject", "a blizzard, actually")

    assert_equal "four", value_of(worker).content
    assert_equal "a blizzard, actually", chat.messages.find { |m| m.role == :tool }.content
  end

  def test_a_tool_error_is_recorded_and_re_raised
    session, viewer = attached_session
    chat = instrumented_chat(session, tool: exploding_tool_class)
    tool = chat.tools.values.first

    assert_raises(RuntimeError) { call_tool(tool, {}) }

    error = viewer.wait_for_frame("node.error").first
    assert_equal "tool:exploding", error["payload"]["nodeId"]
    assert_equal "RuntimeError", error["payload"]["error"]["name"]
    assert_valid_frame(error)
  end

  def test_detached_chats_behave_normally
    session = new_session(url: "ws://127.0.0.1:1/ingest")
    chat = instrumented_chat(session)

    assert_equal "four", chat.ask("hi").content
    assert_equal 1, @completions
  end

  def test_instrumenting_twice_is_a_no_op
    session, viewer = attached_session
    chat = instrumented_chat(session)
    Graphmind::Integrations::RubyLLM.instrument(chat, session)

    chat.ask("hi")
    viewer.wait_for_frame("node.finished")

    assert_equal 1, viewer.frames_of("node.started").length
  end

  def test_the_run_context_reaches_a_tool_executed_on_another_thread
    session, viewer = attached_session
    chat = instrumented_chat(session, tool: weather_tool_class)
    tool = chat.tools.values.first

    run_id = session.run("weather-run") do |ctx|
      # Prime the chat's run context the way a real completion does, then run
      # the tool on a pool thread as ruby_llm's tool_concurrency would.
      chat.ask("hi")
      Thread.new { call_tool(tool, { "city" => "Cairo" }) }.join
      ctx.run_id
    end

    viewer.wait_for_frame("run.finished")
    tool_frame = viewer.frames_of("node.started").find { |f| f["payload"]["name"] == "weather" }
    refute_nil tool_frame
    assert_equal run_id, tool_frame["runId"],
                 "a tool run on a pool thread must still belong to the caller's run"
  end

  private

  def instrumented_chat(session, tool: nil, fail_first: false, tool_round: nil)
    chat = ::RubyLLM.chat(model: "gpt-4o-mini", provider: :openai, assume_model_exists: true)
    chat.with_tools(tool) if tool
    stub_provider(chat, fail_first: fail_first, tool_round: tool_round)
    Graphmind::Integrations::RubyLLM.instrument(chat, session)
  end

  # Replace the one method that would perform HTTP. GraphMind's hook is
  # prepended *above* this, so the gates and every layer of ruby_llm in
  # between are real. It takes any arguments: 1.x passes none, 2.0 passes
  # `usage_recorder:` and `stream_tracker:`. With `tool_round`, the first reply
  # asks for the weather tool with those arguments.
  def stub_provider(chat, fail_first: false, tool_round: nil)
    counter = -> { @completions += 1 }
    failed = [false]
    chat.define_singleton_method(:provider_completion) do |*_args, **_kwargs, &_block|
      counter.call
      if fail_first && !failed[0]
        failed[0] = true
        raise "provider exploded"
      end
      unless tool_round.nil? || messages.any? { |message| message.role == :tool }
        call = ::RubyLLM::ToolCall.new(id: "call_1", name: "weather", arguments: tool_round)
        next ::RubyLLM::Message.new(role: :assistant, content: "", tool_calls: { "call_1" => call },
                                    model_id: "gpt-4o-mini", model: "gpt-4o-mini")
      end
      ::RubyLLM::Message.new(role: :assistant, content: "four", model_id: "gpt-4o-mini", model: "gpt-4o-mini",
                             input_tokens: 7, output_tokens: 2)
    end
    chat.singleton_class.send(:private, :provider_completion)
    chat
  end

  # Call a tool directly the way this ruby_llm's chat loop does: 1.x passes
  # one positional Hash, 2.0 passes keywords.
  def call_tool(tool, args)
    keywords = ::RubyLLM::Tool.instance_method(:call).parameters.any? { |type, _| type == :keyrest }
    keywords ? tool.call(**args) : tool.call(args)
  end

  def weather_tool_class
    @weather_tool_class ||= Class.new(::RubyLLM::Tool) do
      def self.name = "WeatherTool"
      description "Looks up the weather"
      # 2.0 renamed `param` to `parameter`; both accept `description:`.
      if respond_to?(:parameter)
        parameter :city, description: "City name"
      else
        param :city, description: "City name"
      end

      def execute(city:) = "sunny in #{city}"
    end
  end

  def exploding_tool_class
    @exploding_tool_class ||= Class.new(::RubyLLM::Tool) do
      def self.name = "ExplodingTool"
      description "Always fails"

      def execute = raise("tool exploded")
    end
  end
end
