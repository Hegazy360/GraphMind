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
    #     the request as sent (messages / input in full, the sampling
    #     parameters, tools by schema hash), the response text, the requested
    #     tool calls, the normalized finish reason and inclusive token usage
    #     (contract C1: prompt tokens INCLUDE cached ones);
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

      # What a `stream:` proc saw: the gem hands the caller chunks, and what
      # `chat` returns for a streamed call is not the completion.
      class StreamState
        attr_reader :text, :calls, :usage, :finish_reason, :final

        def initialize
          @text = +""
          @calls = {}
          @usage = nil
          @finish_reason = nil
          @final = nil
          @seen = false
        end

        def seen? = @seen

        # The stream carried refusal deltas (a stop that is a refusal).
        def refused? = @refused == true

        def observe(chunk)
          return unless chunk.is_a?(Hash)

          @seen = true
          @usage = chunk["usage"] if chunk["usage"].is_a?(Hash)
          choice = chunk.dig("choices", 0)
          observe_choice(choice) if choice.is_a?(Hash)
          type = chunk["type"].to_s
          @final = chunk["response"] if type.start_with?("response.") && chunk["response"].is_a?(Hash) &&
                                         %w[response.completed response.incomplete response.failed].include?(type)
        end

        def observe_choice(choice)
          @finish_reason = choice["finish_reason"] if choice["finish_reason"].is_a?(String)
          delta = choice["delta"]
          return unless delta.is_a?(Hash)

          content = delta["content"]
          @text << content if content.is_a?(String)
          @refused = true if delta["refusal"].is_a?(String) && !delta["refusal"].empty?
          Array(delta["tool_calls"]).each do |call|
            next unless call.is_a?(Hash)

            entry = (@calls[call["index"].is_a?(Integer) ? call["index"] : 0] ||= [nil, nil, +"", false])
            entry[0] = call["id"] if call["id"].is_a?(String) && !call["id"].empty?
            # A custom (freeform) tool streams `custom: {name, input}`.
            entry[3] = true if call["type"] == "custom" || call["custom"].is_a?(Hash)
            source_key, text_key = entry[3] ? %w[custom input] : %w[function arguments]
            source = call[source_key].is_a?(Hash) ? call[source_key] : {}
            entry[1] = source["name"] if source["name"].is_a?(String) && !source["name"].empty?
            entry[2] << source[text_key] if source[text_key].is_a?(String)
          end
        end

        # A custom tool's input is text by design: recorded as the string, as
        # chat_tool_calls does for a non-streamed one.
        def tool_calls
          @calls.keys.sort.filter_map do |index|
            id, name, text, custom = @calls[index]
            next Support.tool_call(id, name, text) unless custom
            next nil unless name.is_a?(String) && !name.empty?

            id.nil? ? { "name" => name, "input" => text.dup } : { "id" => id, "name" => name, "input" => text.dup }
          end
        end
      end

      # One gated LLM call.
      def call(config, parameters, operation)
        session = config[:session]
        node_id = config[:node_id]
        return yield(parameters) if session.nil? || !session.enabled? || session.disposed?

        stream = StreamState.new
        Graphmind::Wrap.invoke(
          session,
          node_id: node_id,
          kind: "llm",
          name: config[:name],
          input: describe(parameters, operation, session),
          full_input: true,
          output_for: ->(response) { summarize_response(response, stream) },
          finish_extra: ->(response) { extra_for(response, stream) },
          inject_as: ->(value) { coerce_response(value, operation) }
        ) do
          yield(instrument_stream(parameters, session, node_id, stream))
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

      # node.started.input: the request as sent (contract C1) — model,
      # instructions and messages / input in FULL (no message-count or length
      # trim; the 512 KB shrink bounds the event), the sampling parameters under
      # the API's own names (an allow-list: `user`, `metadata` and the stream
      # proc are never read), and tools as {name, schemaHash} with each
      # definition sent once per run as toolSchemas.
      def describe(parameters, operation, session = nil)
        out = { "operation" => operation }
        %i[model instructions previous_response_id].each do |key|
          value = Support.param(parameters, key)
          out[key.to_s] = Support.record(value) unless value.nil?
        end
        messages = Support.param(parameters, :messages)
        out["messages"] = Support.record(messages) unless messages.nil?
        input = Support.param(parameters, :input)
        out["input"] = Support.record(input) unless input.nil?
        out.merge!(Support.pick_params(parameters))
        tools = capture_tools(session, Support.param(parameters, :tools))
        out.merge!(tools) unless tools.nil?
        out["stream"] = true if Support.param(parameters, :stream)
        out
      rescue StandardError
        { "operation" => operation }
      end

      def capture_tools(session, tools)
        return nil unless tools.is_a?(Array)

        run = session&.current_run
        Support.capture_tools(session || self, run.nil? ? "implicit" : run.run_id, tools)
      rescue StandardError
        nil
      end

      # Wrap a caller-supplied `stream:` proc so deltas also reach the canvas
      # (and the step's tool calls, finish reason and last-chunk usage reach
      # `stream`). The caller's proc still runs, with the same arity it declared.
      def instrument_stream(parameters, session, node_id, stream = nil)
        return parameters unless parameters.is_a?(Hash)

        key = Support.param_key(parameters, :stream)
        original = parameters[key]
        return parameters unless original.respond_to?(:call)

        copy = parameters.dup
        copy[key] = proc do |chunk, bytesize|
          begin
            text = delta_text(chunk)
            session.push_token(node_id, "text", text) if text
            stream&.observe(chunk)
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

      # node.finished.output (contract C1): text, the requested tool calls as
      # {id, name, input, inputText?}, the normalized finishReason and the API's
      # own value as rawFinishReason (chat: finish_reason; Responses: the
      # incomplete reason, else the status). A streamed call reports what the
      # stream proc saw.
      def summarize_response(response, stream = nil)
        response = stream.final if stream&.final && !completion?(response)
        return streamed_output(stream) if stream&.seen? && !completion?(response)
        return Support.truncate(response.to_s) unless response.is_a?(Hash)

        out = response.key?("choices") ? chat_output(response) : responses_output(response)
        out["id"] = response["id"] if response["id"]
        out["model"] = response["model"] if response["model"]
        out.empty? ? Support.truncate(response.to_s) : out
      rescue StandardError
        nil
      end

      def completion?(response)
        response.is_a?(Hash) && (response.key?("choices") || response.key?("output"))
      end

      def chat_output(response)
        choice = response.dig("choices", 0) || {}
        message = choice.is_a?(Hash) ? choice["message"] : nil
        text = message.is_a?(Hash) ? message["content"] : nil
        text = choice["text"] if text.nil? && choice.is_a?(Hash)
        calls = chat_tool_calls(message.is_a?(Hash) ? message["tool_calls"] : nil)
        out = {}
        out["text"] = text if text.is_a?(String)
        out["toolCalls"] = calls unless calls.empty?
        refusal = message.is_a?(Hash) ? message["refusal"] : nil
        out.merge!(Support.finish_fields(choice.is_a?(Hash) ? choice["finish_reason"] : nil, !calls.empty?,
                                         refusal.is_a?(String) && !refusal.empty?))
      end

      def chat_tool_calls(calls)
        Array(calls).filter_map do |call|
          next nil unless call.is_a?(Hash)

          function = call["function"]
          if function.is_a?(Hash)
            Support.tool_call(call["id"], function["name"], function["arguments"])
          elsif call["custom"].is_a?(Hash) && call["custom"]["name"].is_a?(String)
            entry = { "name" => call["custom"]["name"], "input" => call["custom"]["input"] || "" }
            call["id"].is_a?(String) ? { "id" => call["id"] }.merge(entry) : entry
          end
        end
      end

      def responses_output(response)
        calls = Array(response["output"]).filter_map do |item|
          next nil unless item.is_a?(Hash)

          if item["type"] == "function_call"
            Support.tool_call(item["call_id"], item["name"], item["arguments"])
          elsif item["type"] == "custom_tool_call" && item["name"].is_a?(String) && !item["name"].empty?
            # A custom (freeform) tool's input is text by design.
            entry = { "name" => item["name"], "input" => item["input"] || "" }
            item["call_id"].is_a?(String) ? { "id" => item["call_id"] }.merge(entry) : entry
          end
        end
        text = output_text(response)
        reason = response.dig("incomplete_details", "reason")
        raw = reason.is_a?(String) && !reason.empty? ? reason : response["status"]
        out = {}
        out["text"] = text if text.is_a?(String)
        out["toolCalls"] = calls unless calls.empty?
        refused = Array(response["output"]).any? do |item|
          item.is_a?(Hash) && Array(item["content"]).any? { |part| part.is_a?(Hash) && part["type"] == "refusal" }
        end
        out.merge!(Support.finish_fields(raw, !calls.empty?, refused))
        out["status"] = response["status"] if response["status"].is_a?(String)
        out
      end

      def streamed_output(stream)
        calls = stream.tool_calls
        out = { "text" => stream.text.dup }
        out["toolCalls"] = calls unless calls.empty?
        out.merge!(Support.finish_fields(stream.finish_reason, !calls.empty?, stream.refused?))
        out["streamed"] = true
        out
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

      # {"usage" => ...}: inclusive, cache and reasoning counts only when
      # reported. A streamed chat call's usage rides its last chunk (with
      # `stream_options: {include_usage: true}`).
      def extra_for(response, stream = nil)
        usage = response["usage"] if response.is_a?(Hash)
        usage = stream.usage if usage.nil? && stream
        usage = stream.final["usage"] if usage.nil? && stream&.final
        tokens = Support.openai_usage(usage)
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
