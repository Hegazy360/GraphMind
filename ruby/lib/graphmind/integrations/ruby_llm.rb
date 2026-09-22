# frozen_string_literal: true

require_relative "../ids"
require_relative "../wrap"
require_relative "support"

module Graphmind
  module Integrations
    # Instrumentation for the `ruby_llm` gem.
    #
    #   chat = Graphmind.instrument_ruby_llm(RubyLLM.chat.with_tool(Weather))
    #   chat.ask("what's the weather in Cairo?")
    #
    # NOTE: inside this module `::RubyLLM` is the gem and `RubyLLM` (unqualified)
    # would be this module — always qualify.
    #
    # It prepends modules to *this chat object's* singleton class and to the
    # singleton class of each tool instance it holds. Nothing global is
    # patched, and another chat in the same process is untouched.
    #
    # What you get:
    #   * a `llm:step` node per provider round-trip (one per API call, not one
    #     per `ask`), with model, trimmed messages, reply text and usage;
    #   * a `tool:<name>` node per `RubyLLM::Tool#call`, with real `inject`
    #     and `retry` — the debugger can replace a tool result and let the
    #     model carry on with it;
    #   * gates at before / error / after on both.
    #
    # Hook choice: the LLM gate wraps `provider_completion`, which is one HTTP
    # round-trip. It is a private method of RubyLLM::Chat, so if a future
    # version renames it this falls back to `complete_once` and then to the
    # public `complete` (coarser: one node for the whole turn). The hook that
    # was used is reported on the node as `hook`.
    #
    # Every patch forwards whatever arguments it is given. The hooks are
    # private API and their signatures move between major versions (1.x:
    # `provider_completion(&)` and `Tool#call(args)`; 2.0:
    # `provider_completion(usage_recorder:, stream_tracker:, &)` and
    # `Tool#call(tool_call:, **arguments)`). A patch that pinned one signature
    # raised ArgumentError inside the user's chat on the other — even with no
    # viewer attached — which is the one thing instrumentation must never do.
    module RubyLLM
      CHAT_MARKER = :@__graphmind_ruby_llm_chat
      TOOL_MARKER = :@__graphmind_ruby_llm_tool

      LLM_HOOKS = %i[provider_completion complete_once complete].freeze

      module_function

      def instrument(chat, session, node_id: Graphmind::Ids::LLM_NODE_ID,
                     name: Graphmind::Ids::LLM_NODE_NAME, tools: true)
        return chat if chat.nil?

        config = chat.instance_variable_get(CHAT_MARKER)
        if config.nil?
          hook = LLM_HOOKS.find { |candidate| chat.respond_to?(candidate, true) }
          config = { session: session, node_id: node_id, name: name, hook: hook,
                     mutex: Mutex.new, run_context: nil }
          chat.instance_variable_set(CHAT_MARKER, config)
          chat.singleton_class.prepend(chat_patch(hook))
          prepend_registration_patches(chat) if tools
        end
        instrument_tools(chat, session, config) if tools
        chat
      end

      def instrumented?(chat) = !chat.instance_variable_get(CHAT_MARKER).nil?

      # Gate tools registered after instrumentation — through whichever of the
      # registration methods this version has (2.0 removed `with_tool`).
      # Patching a missing one would make `respond_to?(:with_tool)` lie.
      def prepend_registration_patches(chat)
        chat.singleton_class.prepend(WithToolPatch) if chat.respond_to?(:with_tool)
        chat.singleton_class.prepend(WithToolsPatch) if chat.respond_to?(:with_tools)
      end

      # What the tool node shows as its input. 1.x calls `tool.call(args)` with
      # one positional Hash; 2.0 calls `tool.call(**args, tool_call:)`, where
      # `tool_call` is RubyLLM's own ToolCall object, not a model argument.
      def tool_input(args, kwargs)
        return args.length == 1 ? args.first : args if kwargs.empty?

        named = kwargs.each_with_object({}) do |(key, value), out|
          out[key.to_s] = value unless key.to_s == "tool_call"
        end
        args.empty? ? named : { "args" => args, "kwargs" => named }
      end

      # Wrap every tool the chat currently holds.
      def instrument_tools(chat, session, chat_config = nil)
        registry = chat.respond_to?(:tools) ? chat.tools : nil
        return unless registry.respond_to?(:each_value)

        registry.each_value { |tool| instrument_tool(tool, session, chat_config) }
        nil
      rescue StandardError
        nil
      end

      def instrument_tool(tool, session, chat_config = nil)
        return tool if tool.nil? || tool.instance_variable_get(TOOL_MARKER)

        name = begin
          tool.name.to_s
        rescue StandardError
          tool.class.name.to_s
        end
        tool.instance_variable_set(TOOL_MARKER,
                                   { session: session, name: name, chat: chat_config })
        tool.singleton_class.prepend(ToolPatch)
        tool
      rescue StandardError
        tool
      end

      # ruby_llm can run tool calls on a thread pool (`tool_concurrency`), and
      # a fresh thread has no run context. Fall back to the run the chat was
      # completing in, so a concurrently-executed tool still lands on the right
      # run instead of an implicit one.
      def run_context_for(session, config)
        current = session.current_run
        return current unless current.nil?

        chat_config = config[:chat]
        return nil if chat_config.nil?

        chat_config[:mutex].synchronize { chat_config[:run_context] }
      rescue StandardError
        nil
      end

      # One gated provider round-trip.
      def call_llm(config, chat, &body)
        session = config[:session]
        return body.call if session.nil? || !session.enabled? || session.disposed?

        config[:mutex].synchronize { config[:run_context] = session.current_run }

        Graphmind::Wrap.invoke(
          session,
          node_id: config[:node_id],
          kind: "llm",
          name: config[:name],
          input: describe(chat, config),
          output_for: ->(message) { summarize(message) },
          finish_extra: ->(message) { extra_for(message) },
          inject_as: ->(value) { coerce_message(value) },
          &body
        )
      end

      # An injected reply arrives as JSON, but ruby_llm expects a
      # RubyLLM::Message. Accept the shapes a human would actually type in the
      # viewer: a bare string, or an object with role/content.
      # `model_id` is 1.x's name for the model, `model` is 2.0's; Message.new
      # ignores the one it does not know in both.
      MESSAGE_KEYS = %i[role content model_id model input_tokens output_tokens cached_tokens
                        tool_calls tool_call_id].freeze

      def coerce_message(value)
        return value if value.is_a?(::RubyLLM::Message)

        if value.is_a?(Hash)
          attrs = value.each_with_object({}) do |(key, item), out|
            symbol = key.to_sym
            out[symbol] = item if MESSAGE_KEYS.include?(symbol)
          end
          attrs[:role] ||= :assistant
          attrs[:content] = "" unless attrs.key?(:content)
          return ::RubyLLM::Message.new(attrs)
        end

        ::RubyLLM::Message.new(role: :assistant, content: value.to_s)
      end

      def describe(chat, config)
        out = { "hook" => config[:hook].to_s }
        out["model"] = chat.model.id if chat.respond_to?(:model) && chat.model.respond_to?(:id)
        messages = Support.summarize_messages(message_hashes(chat))
        out["messages"] = messages unless messages.nil?
        tools = chat.respond_to?(:tools) ? chat.tools : nil
        out["tools"] = tools.keys.map(&:to_s) if tools.respond_to?(:keys) && !tools.empty?
        out
      rescue StandardError
        { "hook" => config[:hook].to_s }
      end

      def message_hashes(chat)
        return nil unless chat.respond_to?(:messages)

        chat.messages.map do |message|
          {
            "role" => message.role.to_s,
            "content" => Support.truncate(text_of(message.content))
          }
        end
      rescue StandardError
        nil
      end

      def text_of(content)
        return content if content.is_a?(String)
        return content.text if content.respond_to?(:text)

        content.to_s
      rescue StandardError
        ""
      end

      def summarize(message)
        return nil if message.nil?

        out = {}
        out["text"] = Support.truncate(text_of(message.content)) if message.respond_to?(:content)
        if message.respond_to?(:tool_call?) && message.tool_call?
          calls = message.tool_calls
          out["toolCalls"] = calls.respond_to?(:keys) ? calls.keys.map(&:to_s) : calls.to_s
        end
        model = model_of(message)
        out["model"] = model unless model.nil?
        out.empty? ? nil : out
      rescue StandardError
        nil
      end

      # 1.x: Message#model_id. 2.0: Message#model (the ID string).
      def model_of(message)
        model = if message.respond_to?(:model_id)
                  message.model_id
                elsif message.respond_to?(:model)
                  message.model
                end
        model = model.id if !model.nil? && !model.is_a?(String) && model.respond_to?(:id)
        model.nil? || model.to_s.empty? ? nil : model.to_s
      rescue StandardError
        nil
      end

      # 1.x: Message#input_tokens / #output_tokens. 2.0: Message#tokens.input / .output.
      def extra_for(message)
        input, output =
          if message.respond_to?(:input_tokens) && message.respond_to?(:output_tokens)
            [message.input_tokens, message.output_tokens]
          elsif message.respond_to?(:tokens) && message.tokens.respond_to?(:input) &&
                message.tokens.respond_to?(:output)
            [message.tokens.input, message.tokens.output]
          end
        return nil if input.nil? && output.nil?

        usage = Support.usage(input, output)
        usage.nil? ? nil : { "usage" => usage }
      rescue StandardError
        nil
      end

      # Build the singleton patch for whichever hook this ruby_llm version has.
      def chat_patch(hook)
        case hook
        when :provider_completion
          ProviderCompletionPatch
        when :complete_once
          CompleteOncePatch
        else
          CompletePatch
        end
      end

      # -- patches -------------------------------------------------------------

      module ProviderCompletionPatch
        def provider_completion(*args, **kwargs, &block)
          config = instance_variable_get(CHAT_MARKER)
          return super if config.nil?

          Graphmind::Integrations::RubyLLM.call_llm(config, self) { super(*args, **kwargs, &block) }
        end
        private :provider_completion
      end

      module CompleteOncePatch
        def complete_once(*args, **kwargs, &block)
          config = instance_variable_get(CHAT_MARKER)
          return super if config.nil?

          Graphmind::Integrations::RubyLLM.call_llm(config, self) { super(*args, **kwargs, &block) }
        end
        private :complete_once
      end

      module CompletePatch
        def complete(*args, **kwargs, &block)
          config = instance_variable_get(CHAT_MARKER)
          return super if config.nil?

          Graphmind::Integrations::RubyLLM.call_llm(config, self) { super(*args, **kwargs, &block) }
        end
      end

      # Tools added after instrumentation are gated too.
      module WithToolPatch
        def with_tool(*, **)
          result = super
          config = instance_variable_get(CHAT_MARKER)
          Graphmind::Integrations::RubyLLM.instrument_tools(self, config[:session], config) if config
          result
        end
      end

      module WithToolsPatch
        def with_tools(*, **)
          result = super
          config = instance_variable_get(CHAT_MARKER)
          Graphmind::Integrations::RubyLLM.instrument_tools(self, config[:session], config) if config
          result
        end
      end

      # The sharp end: a gated RubyLLM::Tool#call, where `inject` replaces the
      # result the model sees next.
      module ToolPatch
        def call(*args, **kwargs, &block)
          config = instance_variable_get(TOOL_MARKER)
          return super if config.nil?

          session = config[:session]
          return super if session.nil? || !session.enabled? || session.disposed?

          gated = lambda do
            Graphmind::Wrap.invoke(
              session,
              node_id: Graphmind::Ids.tool_node_id(config[:name]),
              kind: "tool",
              name: config[:name],
              input: Graphmind::Integrations::RubyLLM.tool_input(args, kwargs)
            ) { super(*args, **kwargs, &block) }
          end

          ctx = Graphmind::Integrations::RubyLLM.run_context_for(session, config)
          return gated.call if ctx.nil? || !session.current_run.nil?

          session.with_run_context(ctx) { gated.call }
        end
      end
    end
  end
end
