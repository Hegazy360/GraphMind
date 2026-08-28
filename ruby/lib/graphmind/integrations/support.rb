# frozen_string_literal: true

module Graphmind
  module Integrations
    # Shared helpers for provider integrations.
    module Support
      # Chat histories grow without bound and a debugger is not an archive:
      # keep the tail, and trim each message body to something a canvas can
      # render.
      MAX_MESSAGES = 12
      MAX_CONTENT_CHARS = 2000

      module_function

      # Read a parameter that may be keyed by Symbol or String.
      def param(parameters, key)
        return nil unless parameters.respond_to?(:[])

        value = parameters[key.to_sym]
        value.nil? ? parameters[key.to_s] : value
      end

      def param_key(parameters, key)
        return key.to_sym unless parameters.is_a?(Hash)
        return key.to_sym if parameters.key?(key.to_sym)
        return key.to_s if parameters.key?(key.to_s)

        key.to_sym
      end

      def summarize_messages(messages)
        return nil unless messages.is_a?(Array)

        tail = messages.last(MAX_MESSAGES)
        summary = tail.map { |message| summarize_message(message) }
        summary.unshift({ "role" => "…", "content" => "#{messages.length - tail.length} earlier messages" }) if
          messages.length > tail.length
        summary
      end

      def summarize_message(message)
        return truncate(message.to_s) unless message.is_a?(Hash)

        out = {}
        message.each do |key, value|
          name = key.to_s
          out[name] = value.is_a?(String) ? truncate(value) : value
        end
        out
      end

      def truncate(text, limit = MAX_CONTENT_CHARS)
        string = text.to_s
        string.length > limit ? "#{string[0, limit]}… (#{string.length} chars)" : string
      end

      # The wire contract's TokenUsage: non-negative integers only.
      def usage(input_tokens, output_tokens)
        return nil if input_tokens.nil? && output_tokens.nil?

        {
          "inputTokens" => [input_tokens.to_i, 0].max,
          "outputTokens" => [output_tokens.to_i, 0].max
        }
      end
    end
  end
end
