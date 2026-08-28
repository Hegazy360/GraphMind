# frozen_string_literal: true

require_relative "../ids"
require_relative "../wrap"
require_relative "support"

module Graphmind
  module Integrations
    # Instrumentation for the `ruby-openai` gem (`OpenAI::Client`).
    #
    #   client = Graphmind.instrument_openai(OpenAI::Client.new(access_token: ...))
    #
    # It prepends a module to *that client's singleton class*, so nothing
    # global is monkey-patched: an uninstrumented client in the same process is
    # untouched, and the gem is never loaded unless you ask for it.
    #
    # What you get:
    #   * a `llm:step` node for every `chat` / `responses.create` call, with
    #     the model, the (trimmed) messages, the response text and token usage;
    #   * a `before` gate — the debugger can pause and `inject` a response
    #     without the request ever leaving the process;
    #   * an `error` gate — a 429 or a timeout pauses instead of raising, and
    #     `retry` re-sends the request;
    #   * streamed deltas forwarded to the canvas when you pass `stream:`.
    #
    # Tool *execution* is your code, not the gem's, so gate it with
    # `Graphmind.tool` / `wrap_tools` (see the README).
    module RubyOpenAI
      MARKER = :@__graphmind_openai

      module_function

      def instrument(client, session, node_id: Graphmind::Ids::LLM_NODE_ID,
                     name: Graphmind::Ids::LLM_NODE_NAME)
        return client if client.nil?
        return client if client.instance_variable_get(MARKER)

        config = { session: session, node_id: node_id, name: name }
        client.instance_variable_set(MARKER, config)
        client.singleton_class.prepend(ClientPatch)
        client
      end

      def instrumented?(client)
        !client.instance_variable_get(MARKER).nil?
      end

      # One gated LLM call.
      def call(config, parameters, operation)
        session = config[:session]
        node_id = config[:node_id]
        return yield(parameters) if session.nil? || !session.enabled? || session.disposed?

        Graphmind::Wrap.invoke(
          session,
          node_id: node_id,
          kind: "llm",
          name: config[:name],
          input: describe(parameters, operation),
          output_for: ->(response) { summarize_response(response) },
          finish_extra: ->(response) { extra_for(response) },
          inject_as: ->(value) { coerce_response(value, operation) }
        ) do
          yield(instrument_stream(parameters, session, node_id))
        end
      end

      # An injected reply arrives as JSON. A Hash is already response-shaped
      # and passes straight through; a bare string — what a human actually
      # types in the viewer — is wrapped so the caller's `dig("choices", ...)`
      # keeps working.
      def coerce_response(value, operation)
        return value unless value.is_a?(String)

        if operation == "responses.create"
          {
            "id" => "graphmind-injected",
            "object" => "response",
            "output" => [{ "type" => "message", "role" => "assistant",
                           "content" => [{ "type" => "output_text", "text" => value }] }],
            "graphmindInjected" => true
          }
        else
          {
            "id" => "graphmind-injected",
            "object" => "chat.completion",
            "choices" => [{ "index" => 0, "finish_reason" => "stop",
                            "message" => { "role" => "assistant", "content" => value } }],
            "graphmindInjected" => true
          }
        end
      end

      def describe(parameters, operation)
        out = { "operation" => operation }
        model = Support.param(parameters, :model)
        out["model"] = model unless model.nil?
        messages = Support.summarize_messages(Support.param(parameters, :messages))
        out["messages"] = messages unless messages.nil?
        input = Support.param(parameters, :input)
        out["input"] = Support.truncate(input) if input.is_a?(String)
        tools = Support.param(parameters, :tools)
        out["tools"] = tool_names(tools) if tools.is_a?(Array)
        out["stream"] = true if Support.param(parameters, :stream)
        out
      rescue StandardError
        { "operation" => operation }
      end

      def tool_names(tools)
        tools.map do |tool|
          next tool["name"] || tool[:name] unless tool.is_a?(Hash) && (tool["function"] || tool[:function])

          fn = tool["function"] || tool[:function]
          fn["name"] || fn[:name]
        end.compact
      rescue StandardError
        []
      end

      # Wrap a caller-supplied `stream:` proc so deltas also reach the canvas.
      # The caller's proc still runs, with the same arity it declared.
      def instrument_stream(parameters, session, node_id)
        return parameters unless parameters.is_a?(Hash)

        key = Support.param_key(parameters, :stream)
        original = parameters[key]
        return parameters unless original.respond_to?(:call)

        copy = parameters.dup
        copy[key] = proc do |chunk, bytesize|
          begin
            text = delta_text(chunk)
            session.push_token(node_id, "text", text) if text
          rescue StandardError
            nil
          end
          original.arity == 1 ? original.call(chunk) : original.call(chunk, bytesize)
        end
        copy
      rescue StandardError
        parameters
      end

      def delta_text(chunk)
        return nil unless chunk.is_a?(Hash)

        # Chat Completions streaming.
        delta = chunk.dig("choices", 0, "delta")
        text = delta.is_a?(Hash) ? (delta["content"] || delta["reasoning_content"]) : nil
        return text if text.is_a?(String) && !text.empty?

        # Responses API streaming.
        text = chunk["delta"] if chunk["type"].to_s.include?("output_text")
        text.is_a?(String) && !text.empty? ? text : nil
      rescue StandardError
        nil
      end

      def summarize_response(response)
        return Support.truncate(response.to_s) unless response.is_a?(Hash)

        text = response.dig("choices", 0, "message", "content")
        text ||= response.dig("choices", 0, "text")
        text ||= output_text(response)
        calls = response.dig("choices", 0, "message", "tool_calls")

        out = {}
        out["text"] = Support.truncate(text) if text.is_a?(String)
        out["toolCalls"] = calls if calls.is_a?(Array) && !calls.empty?
        out["id"] = response["id"] if response["id"]
        out["model"] = response["model"] if response["model"]
        out.empty? ? Support.truncate(response.to_s) : out
      rescue StandardError
        nil
      end

      def output_text(response)
        output = response["output"]
        return nil unless output.is_a?(Array)

        output.filter_map do |item|
          content = item.is_a?(Hash) ? item["content"] : nil
          next nil unless content.is_a?(Array)

          content.filter_map { |part| part["text"] if part.is_a?(Hash) }.join
        end.join
      rescue StandardError
        nil
      end

      def extra_for(response)
        return nil unless response.is_a?(Hash)

        usage = response["usage"]
        return nil unless usage.is_a?(Hash)

        tokens = Support.usage(
          usage["prompt_tokens"] || usage["input_tokens"],
          usage["completion_tokens"] || usage["output_tokens"]
        )
        tokens.nil? ? nil : { "usage" => tokens }
      rescue StandardError
        nil
      end

      # Prepended onto one client instance.
      module ClientPatch
        def chat(parameters: {})
          config = instance_variable_get(MARKER)
          return super(parameters: parameters) if config.nil?

          RubyOpenAI.call(config, parameters, "chat.completions") do |params|
            super(parameters: params)
          end
        end

        def responses
          object = super
          config = instance_variable_get(MARKER)
          return object if config.nil? || object.nil?
          return object if object.instance_variable_get(RubyOpenAI::MARKER)

          object.instance_variable_set(RubyOpenAI::MARKER, config)
          object.singleton_class.prepend(RubyOpenAI::ResponsesPatch)
          object
        end
      end

      # Prepended onto the client's memoized `responses` helper.
      module ResponsesPatch
        def create(parameters: {})
          config = instance_variable_get(RubyOpenAI::MARKER)
          return super(parameters: parameters) if config.nil?

          RubyOpenAI.call(config, parameters, "responses.create") do |params|
            super(parameters: params)
          end
        end
      end
    end
  end
end
