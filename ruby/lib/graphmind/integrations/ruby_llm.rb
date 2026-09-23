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
    #     per `ask`), with the model, every message in full, the sampling
    #     parameters and tools (by schema hash), the reply text, the requested
    #     tool calls, the normalized finish reason (2.0) and inclusive usage
    #     (contract C1: ruby_llm counts input WITHOUT cache, GraphMind adds the
    #     cache reads and writes back);
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
          full_input: true,
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

      # node.started.input (contract C1): the hook, the model, EVERY message
      # in full (no 12-message / 2,000-char trim; the 512 KB shrink bounds the
      # event), the sampling parameters the chat will send (temperature, 2.0's
      # max_output_tokens, allow-listed `with_params` / provider options), and
      # the tools as {name, schemaHash} with each definition ({name,
      # description, parameters}) sent once per run as toolSchemas.
      def describe(chat, config)
        out = { "hook" => config[:hook].to_s }
        out["model"] = chat.model.id if chat.respond_to?(:model) && chat.model.respond_to?(:id)
        messages = message_hashes(chat)
        out["messages"] = messages unless messages.nil?
        out.merge!(sampling_params(chat))
        tools = tool_capture(chat, config)
        out.merge!(tools) unless tools.nil?
        out
      rescue StandardError
        { "hook" => config[:hook].to_s }
      end

      def message_hashes(chat)
        return nil unless chat.respond_to?(:messages)

        chat.messages.map do |message|
          entry = { "role" => message.role.to_s, "content" => text_of(message.content) }
          calls = message.respond_to?(:tool_calls) ? message.tool_calls : nil
          if calls.respond_to?(:each_value) && !calls.empty?
            entry["tool_calls"] = calls.each_value.filter_map { |call| requested_call(call) }
          end
          if message.respond_to?(:tool_call_id) && !message.tool_call_id.nil?
            entry["tool_call_id"] = message.tool_call_id.to_s
          end
          entry
        end
      rescue StandardError
        nil
      end

      # temperature (2.0 reader, 1.x ivar), 2.0's max_output_tokens, and the
      # allow-listed keys of 1.x `params` / 2.0 `provider_options`.
      def sampling_params(chat)
        out = {}
        temperature = chat.respond_to?(:temperature) ? chat.temperature : chat.instance_variable_get(:@temperature)
        out["temperature"] = temperature if temperature.is_a?(Numeric)
        max = chat.respond_to?(:max_output_tokens) ? chat.max_output_tokens : nil
        out["max_output_tokens"] = max if max.is_a?(Integer)
        %i[params provider_options].each do |reader|
          extra = chat.respond_to?(reader) ? chat.public_send(reader) : nil
          out.merge!(Support.pick_params(extra)) if extra.is_a?(Hash)
        end
        out
      rescue StandardError
        {}
      end

      def tool_capture(chat, config)
        registry = chat.respond_to?(:tools) ? chat.tools : nil
        return nil unless registry.respond_to?(:each_value) && !registry.empty?

        definitions = registry.each_value.filter_map { |tool| tool_definition(tool) }
        session = config[:session]
        run = session.respond_to?(:current_run) ? session.current_run : nil
        Support.capture_tools(session, run.nil? ? "implicit" : run.run_id, definitions)
      rescue StandardError
        nil
      end

      # {name, description, parameters}: 1.x `params_schema`, 2.0 `parameters_schema`.
      def tool_definition(tool)
        name = tool.respond_to?(:name) ? tool.name.to_s : nil
        return nil if name.nil? || name.empty?

        definition = { "name" => name }
        description = tool.respond_to?(:description) ? tool.description : nil
        definition["description"] = description.to_s unless description.nil?
        schema = if tool.respond_to?(:parameters_schema)
                   tool.parameters_schema
                 elsif tool.respond_to?(:params_schema)
                   tool.params_schema
                 end
        definition["parameters"] = Support.record(schema) unless schema.nil?
        definition
      rescue StandardError
        nil
      end

      # One RubyLLM::ToolCall as recorded in output.toolCalls.
      def requested_call(call)
        return nil unless call.respond_to?(:name)

        Support.tool_call(call.respond_to?(:id) ? call.id : nil, call.name.to_s,
                          call.respond_to?(:arguments) ? call.arguments : nil)
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

      # node.finished.output (contract C1): the full reply text, the tool calls
      # the model requested as {id, name, input}, 2.0's finish reason normalized
      # (+ rawFinishReason; 1.x reports none), and the model.
      def summarize(message)
        return nil if message.nil?

        out = {}
        out["text"] = text_of(message.content) if message.respond_to?(:content)
        calls = []
        if message.respond_to?(:tool_call?) && message.tool_call?
          registry = message.tool_calls
          calls = registry.each_value.filter_map { |call| requested_call(call) } if registry.respond_to?(:each_value)
          out["toolCalls"] = calls unless calls.empty?
        end
        raw = message.respond_to?(:finish_reason) ? message.finish_reason : nil
        out.merge!(Support.finish_fields(raw, !calls.empty?))
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

      # Inclusive usage (contract C1). ruby_llm's input count EXCLUDES cached
      # tokens in both majors (2.0 Tokens#input is "standard (non-cached)"; 1.x
      # providers report or subtract to the uncached tail), so the cache reads
      # and writes are added back. 1.16+ and 2.0: Message#tokens (2.0:
      # cache_read / cache_write / thinking; 1.16: cached / cache_creation, with
      # cache_read / cache_write aliases). Older 1.x: the Message readers.
      def extra_for(message)
        usage = Support.ruby_llm_usage(**token_counts(message))
        usage.nil? ? nil : { "usage" => usage }
      rescue StandardError
        nil
      end

      def token_counts(message)
        tokens = message.respond_to?(:tokens) ? message.tokens : nil
        source = tokens.respond_to?(:input) ? tokens : message
        {
          input: read_first(source, :input, :input_tokens),
          output: read_first(source, :output, :output_tokens),
          cache_read: read_first(source, :cache_read, :cached, :cache_read_tokens, :cached_tokens),
          cache_write: read_first(source, :cache_write, :cache_creation, :cache_write_tokens,
                                  :cache_creation_tokens),
          thinking: read_first(source, :thinking, :thinking_tokens, :reasoning_tokens)
        }
      end

      def read_first(source, *names)
        names.each do |name|
          next unless source.respond_to?(name)

          value = source.public_send(name)
          return value unless value.nil? || !value.is_a?(Numeric)
        end
        nil
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
