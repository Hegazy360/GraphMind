# frozen_string_literal: true

require_relative "test_helper"
require "graphmind/integrations/support"

begin
  require "openai"
  require "faraday"
  require "graphmind/integrations/ruby_openai"
  LLM_CAPTURE_OPENAI = true
rescue LoadError
  LLM_CAPTURE_OPENAI = false
end

begin
  require "ruby_llm"
  require "graphmind/integrations/ruby_llm"
  LLM_CAPTURE_RUBY_LLM = true
rescue LoadError
  LLM_CAPTURE_RUBY_LLM = false
end

# LLM-step capture (contract C1): the shared conformance fixture
# (packages/client/test/fixtures/llm.json) plus end-to-end checks through
# ruby-openai and ruby_llm. There is no Ruby Anthropic integration.
class TestLlmCapture < Minitest::Test
  FIXTURE = JSON.parse(File.read(File.join(GraphmindTest::REPO_ROOT, "packages", "client", "test",
                                           "fixtures", "llm.json")))
  S = Graphmind::Integrations::Support

  # -- the shared fixture -----------------------------------------------------

  def test_finish_reasons
    FIXTURE["finishReasons"].each do |raw, has_tool_calls, expected|
      actual = S.normalize_finish_reason(raw, has_tool_calls)
      expected.nil? ? assert_nil(actual, raw.inspect) : assert_equal(expected, actual, raw.inspect)
    end
  end

  def test_tool_calls
    FIXTURE["toolCalls"].each do |row|
      given = row["in"]
      actual = S.tool_call(given["id"], given["name"], given["args"])
      row["out"].nil? ? assert_nil(actual, given.inspect) : assert_equal(row["out"], actual, given.inspect)
    end
  end

  def test_schema_hashes
    FIXTURE["schemaHashes"].each do |row|
      assert_equal row["hash"], S.schema_hash(row["in"]), row["in"].inspect
    end
  end

  def test_openai_usage
    { "openai-chat" => :openai_chat_usage, "openai-responses" => :openai_responses_usage }.each do |provider, mapper|
      cases = FIXTURE["usage"].select { |c| c["provider"] == provider }
      refute_empty cases
      cases.each do |c|
        actual = S.public_send(mapper, c["raw"])
        c["out"].nil? ? assert_nil(actual, c["name"]) : assert_equal(c["out"], actual, c["name"])
        # The shape-sniffing entry point the integration uses agrees.
        sniffed = S.openai_usage(c["raw"])
        c["out"].nil? ? assert_nil(sniffed, c["name"]) : assert_equal(c["out"], sniffed, c["name"])
      end
    end
  end

  def test_ruby_llm_usage
    cases = FIXTURE["usage"].select { |c| c["provider"] == "ruby_llm" }
    refute_empty cases
    cases.each do |c|
      raw = c["raw"]
      actual = S.ruby_llm_usage(input: raw["input"], output: raw["output"],
                                cache_read: raw["cache_read"] || raw["cached"],
                                cache_write: raw["cache_write"] || raw["cache_creation"],
                                thinking: raw["thinking"])
      c["out"].nil? ? assert_nil(actual, c["name"]) : assert_equal(c["out"], actual, c["name"])
    end
  end

  def test_the_sampling_allow_list_matches_typescript
    assert_equal FIXTURE["samplingParams"], S::SAMPLING_PARAM_KEYS
  end

  # -- helpers ------------------------------------------------------------------

  def test_make_usage_never_invents_optional_counts
    assert_equal({ "inputTokens" => 1, "outputTokens" => 2, "inclusive" => true }, S.make_usage(input: 1, output: 2))
    assert_nil S.make_usage(cache_read: 3)
    assert_equal 3, S.token_count(2.5) # Math.round, not banker's
    assert_nil S.token_count(-1)
    assert_nil S.token_count("3")
    assert_nil S.token_count(Float::NAN)
  end

  def test_capture_tools_sends_each_definition_once_per_run
    owner = Object.new
    tool = { "type" => "function", "function" => { "name" => "get_weather", "parameters" => { "type" => "object" } } }
    digest = S.schema_hash(tool)
    first = S.capture_tools(owner, "r1", [tool])
    assert_equal({ "tools" => [{ "name" => "get_weather", "schemaHash" => digest }],
                   "toolSchemas" => { digest => tool } }, first)
    assert_equal({ "tools" => first["tools"] }, S.capture_tools(owner, "r1", [tool]))
    assert_equal first, S.capture_tools(owner, "r2", [tool])
    assert_nil S.capture_tools(owner, "r1", [])
    # Symbol keys hash like the JSON they serialise as.
    symbolic = { type: "function", function: { name: "get_weather", parameters: { type: "object" } } }
    assert_equal digest, S.capture_tools(Object.new, "r", [symbolic])["tools"][0]["schemaHash"]
  end

  def test_record_keeps_everything
    history = Array.new(300) { |i| { role: :user, content: "m#{i} #{'x' * 3000}" } }
    out = S.record(history)
    assert_equal 300, out.length
    assert_equal "user", out[0]["role"]
    assert_equal 3000 + 3, out[0]["content"].length
    assert_equal({ "type" => "binary", "bytes" => 3 }, S.record("\xFF\xFE\x00".b))
    cyclic = {}
    cyclic[:self] = cyclic
    assert_equal({ "self" => "[circular]" }, S.record(cyclic))
  end

  def test_pick_params_reads_symbol_and_string_keys_and_skips_procs
    params = { temperature: 0.2, "max_tokens" => 5, stream: -> {}, user: "SECRET", metadata: { a: 1 } }
    assert_equal({ "temperature" => 0.2, "max_tokens" => 5 }, S.pick_params(params))
  end

  # -- ruby-openai --------------------------------------------------------------

  CHAT_WITH_TOOLS = {
    "id" => "chatcmpl-9",
    "model" => "gpt-test",
    "choices" => [{
      "index" => 0,
      "finish_reason" => "length",
      "message" => {
        "role" => "assistant", "content" => nil,
        "tool_calls" => [
          { "id" => "call_ok", "type" => "function", "function" => { "name" => "ls", "arguments" => "{}" } },
          { "id" => "call_cut", "type" => "function",
            "function" => { "name" => "write", "arguments" => '{"path":"a.txt","content":"hel' } }
        ]
      }
    }],
    "usage" => {
      "prompt_tokens" => 2048, "completion_tokens" => 16, "total_tokens" => 2064,
      "prompt_tokens_details" => { "cached_tokens" => 1920, "cache_write_tokens" => 0 },
      "completion_tokens_details" => { "reasoning_tokens" => 8 }
    }
  }.freeze

  def test_ruby_openai_records_the_request_and_the_reply
    skip("ruby-openai is not installed") unless LLM_CAPTURE_OPENAI
    session, viewer = attached_session
    client = OpenAI::Client.new(access_token: "test-key", log_errors: false) do |faraday|
      faraday.adapter(:test) do |stub|
        stub.post("/v1/chat/completions") do
          [200, { "Content-Type" => "application/json" }, JSON.generate(CHAT_WITH_TOOLS)]
        end
      end
    end
    Graphmind::Integrations::RubyOpenAI.instrument(client, session)
    tool = { type: "function", function: { name: "write", parameters: { type: "object" } } }
    history = Array.new(20) { |i| { role: "user", content: "message #{i} #{'y' * 2500}" } }

    client.chat(parameters: { model: "gpt-test", messages: history, temperature: 0.1,
                              max_completion_tokens: 16, tools: [tool], tool_choice: "auto",
                              user: "SECRET-USER" })

    started = viewer.wait_for_frame("node.started").first
    finished = viewer.wait_for_frame("node.finished").first
    input = started["payload"]["input"]
    assert_equal 20, input["messages"].length, "every message: no 12-message trim"
    assert_equal history.last[:content], input["messages"].last["content"], "no 2,000-char trim"
    assert_equal 0.1, input["temperature"]
    assert_equal 16, input["max_completion_tokens"]
    assert_equal "auto", input["tool_choice"]
    digest = S.schema_hash(tool)
    assert_equal [{ "name" => "write", "schemaHash" => digest }], input["tools"]
    assert_equal({ digest => S.record(tool) }, input["toolSchemas"])
    refute_includes JSON.generate(viewer.received), "SECRET-USER"

    assert_equal({ "inputTokens" => 2048, "outputTokens" => 16, "inclusive" => true,
                   "cacheReadTokens" => 1920, "cacheWriteTokens" => 0, "reasoningTokens" => 8 },
                 finished["payload"]["usage"])
    output = finished["payload"]["output"]
    assert_equal "length", output["finishReason"]
    assert_equal "length", output["rawFinishReason"]
    assert_equal [{ "id" => "call_ok", "name" => "ls", "input" => {} },
                  { "id" => "call_cut", "name" => "write", "input" => nil,
                    "inputText" => '{"path":"a.txt","content":"hel' }], output["toolCalls"]
    assert_valid_frame(started)
    assert_valid_frame(finished)
  end

  def test_ruby_openai_streamed_usage_and_tool_calls_come_from_the_chunks
    skip("ruby-openai is not installed") unless LLM_CAPTURE_OPENAI
    stream = Graphmind::Integrations::RubyOpenAI::StreamState.new
    [
      { "choices" => [{ "delta" => { "content" => "Hel" } }] },
      { "choices" => [{ "delta" => { "tool_calls" => [{ "index" => 0, "id" => "c1",
                                                        "function" => { "name" => "f", "arguments" => '{"a"' } }] } }] },
      { "choices" => [{ "delta" => { "tool_calls" => [{ "index" => 0, "function" => { "arguments" => ":1}" } }] },
                        "finish_reason" => "tool_calls" }] },
      { "choices" => [], "usage" => { "prompt_tokens" => 9, "completion_tokens" => 2,
                                      "prompt_tokens_details" => { "cached_tokens" => 4 } } }
    ].each { |chunk| stream.observe(chunk) }
    output = Graphmind::Integrations::RubyOpenAI.summarize_response({}, stream)
    assert_equal({ "text" => "Hel", "toolCalls" => [{ "id" => "c1", "name" => "f", "input" => { "a" => 1 } }],
                   "finishReason" => "tool-calls", "rawFinishReason" => "tool_calls", "streamed" => true }, output)
    assert_equal({ "usage" => { "inputTokens" => 9, "outputTokens" => 2, "inclusive" => true, "cacheReadTokens" => 4 } },
                 Graphmind::Integrations::RubyOpenAI.extra_for({}, stream))
  end

  def test_ruby_openai_responses_incomplete_is_length
    skip("ruby-openai is not installed") unless LLM_CAPTURE_OPENAI
    output = Graphmind::Integrations::RubyOpenAI.summarize_response(
      { "id" => "resp_1", "status" => "incomplete", "incomplete_details" => { "reason" => "max_output_tokens" },
        "output" => [{ "type" => "function_call", "call_id" => "c", "name" => "f", "arguments" => '{"x":' }] }
    )
    assert_equal "length", output["finishReason"]
    assert_equal "max_output_tokens", output["rawFinishReason"]
    assert_equal [{ "id" => "c", "name" => "f", "input" => nil, "inputText" => '{"x":' }], output["toolCalls"]
  end

  # -- ruby_llm -----------------------------------------------------------------

  def test_ruby_llm_records_full_messages_tools_and_inclusive_usage
    skip("ruby_llm is not installed") unless LLM_CAPTURE_RUBY_LLM
    ::RubyLLM.configure { |config| config.openai_api_key = "test-key" }
    session, viewer = attached_session
    chat = ::RubyLLM.chat(model: "gpt-4o-mini", provider: :openai, assume_model_exists: true)
    chat.with_tools(weather_tool_class)
    chat.with_temperature(0.4) if chat.respond_to?(:with_temperature)
    15.times { |i| chat.add_message(role: :user, content: "earlier #{i} #{'z' * 2500}") }
    stub = lambda do
      call = ::RubyLLM::ToolCall.new(id: "call_1", name: "weather", arguments: { "city" => "Cairo" })
      ::RubyLLM::Message.new(role: :assistant, content: "", tool_calls: { "call_1" => call },
                             model_id: "gpt-4o-mini", model: "gpt-4o-mini",
                             input_tokens: 20, output_tokens: 5,
                             # 1.x and 2.0 spell the cache counts differently; each ignores the other.
                             cached_tokens: 1000, cache_read_tokens: 1000,
                             cache_write_tokens: 100,
                             cache_creation_tokens: 100)
    end
    chat.define_singleton_method(:provider_completion) { |*_a, **_k, &_b| stub.call }
    chat.singleton_class.send(:private, :provider_completion)
    Graphmind::Integrations::RubyLLM.instrument(chat, session)

    chat.send(:provider_completion)

    started = viewer.wait_for_frame("node.started").find { |f| f["payload"]["nodeId"] == "llm:step" }
    finished = viewer.wait_for_frame("node.finished").find { |f| f["payload"]["nodeId"] == "llm:step" }
    input = started["payload"]["input"]
    assert_equal 15, input["messages"].length, "every message: no 12-message trim"
    assert_equal 2500 + "earlier 0 ".length, input["messages"].first["content"].length, "no 2,000-char trim"
    assert_equal 0.4, input["temperature"] if chat.respond_to?(:with_temperature)
    assert_equal ["weather"], input["tools"].map { |t| t["name"] }
    digest = input["tools"][0]["schemaHash"]
    assert_equal "weather", input["toolSchemas"][digest]["name"]

    usage = finished["payload"]["usage"]
    assert_equal 1120, usage["inputTokens"], "non-cached input + cache reads + cache writes"
    assert_equal true, usage["inclusive"]
    assert_equal 1000, usage["cacheReadTokens"]
    assert_equal 100, usage["cacheWriteTokens"]
    assert_equal [{ "id" => "call_1", "name" => "weather", "input" => { "city" => "Cairo" } }],
                 finished["payload"]["output"]["toolCalls"]
    assert_valid_frame(started)
    assert_valid_frame(finished)
  end

  private

  def weather_tool_class
    Class.new(::RubyLLM::Tool) do
      def self.name = "WeatherTool"
      description "Looks up the weather"
      if respond_to?(:parameter)
        parameter :city, description: "City name"
      else
        param :city, description: "City name"
      end

      def execute(city:) = "sunny in #{city}"
    end
  end
end
