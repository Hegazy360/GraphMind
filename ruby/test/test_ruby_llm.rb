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

    reply = worker.value
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

    assert_equal "from a hash", worker.value.content
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

    assert_equal "four", worker.value.content
    assert_equal 2, @completions
  end

  def test_a_tool_call_becomes_a_gated_tool_node
    session, viewer = attached_session
    chat = instrumented_chat(session, tool: weather_tool_class)
    tool = chat.tools.values.first

    assert_equal "sunny in Cairo", tool.call({ "city" => "Cairo" })

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

    worker = Thread.new { tool.call({ "city" => "Cairo" }) }
    paused = viewer.wait_for_frame("exec.paused").first
    viewer.resume(paused["payload"]["pauseId"], "inject", "a blizzard, actually")

    assert_equal "a blizzard, actually", worker.value
  end

  def test_tools_added_after_instrumentation_are_gated_too
    session, viewer = attached_session
    chat = instrumented_chat(session)

    chat.with_tool(weather_tool_class)
    chat.tools.values.first.call({ "city" => "Oslo" })

    started = viewer.wait_for_frame("node.started").first
    assert_equal "tool:weather", started["payload"]["nodeId"]
  end

  def test_a_tool_error_is_recorded_and_re_raised
    session, viewer = attached_session
    chat = instrumented_chat(session, tool: exploding_tool_class)
    tool = chat.tools.values.first

    assert_raises(RuntimeError) { tool.call({}) }

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
      Thread.new { tool.call({ "city" => "Cairo" }) }.join
      ctx.run_id
    end

    viewer.wait_for_frame("run.finished")
    tool_frame = viewer.frames_of("node.started").find { |f| f["payload"]["name"] == "weather" }
    refute_nil tool_frame
    assert_equal run_id, tool_frame["runId"],
                 "a tool run on a pool thread must still belong to the caller's run"
  end

  private

  def instrumented_chat(session, tool: nil, fail_first: false)
    chat = ::RubyLLM.chat(model: "gpt-4o-mini", provider: :openai, assume_model_exists: true)
    chat.with_tool(tool) if tool
    stub_provider(chat, fail_first: fail_first)
    Graphmind::Integrations::RubyLLM.instrument(chat, session)
  end

  # Replace the one method that would perform HTTP. GraphMind's hook is
  # prepended *above* this, so the gates and every layer of ruby_llm in
  # between are real.
  def stub_provider(chat, fail_first: false)
    counter = -> { @completions += 1 }
    failed = [false]
    chat.define_singleton_method(:provider_completion) do |&_block|
      counter.call
      if fail_first && !failed[0]
        failed[0] = true
        raise "provider exploded"
      end
      ::RubyLLM::Message.new(role: :assistant, content: "four", model_id: "gpt-4o-mini",
                             input_tokens: 7, output_tokens: 2)
    end
    chat.singleton_class.send(:private, :provider_completion)
    chat
  end

  def weather_tool_class
    @weather_tool_class ||= Class.new(::RubyLLM::Tool) do
      def self.name = "WeatherTool"
      description "Looks up the weather"
      param :city, desc: "City name"

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
