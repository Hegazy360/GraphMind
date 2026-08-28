# frozen_string_literal: true

require_relative "session"
require_relative "wrap"

module Graphmind
  # One debugger attachment point for a process.
  #
  #   gm = Graphmind.configure(app: "support-agent")
  #
  #   search = gm.tool("search_flights") { |origin:, destination:| ... }
  #
  #   gm.run("handle-ticket") do
  #     search.call(origin: "LHR", destination: "JFK")
  #   end
  #
  # Everything degrades to a no-op when no debugger is attached, and to
  # literally nothing when GraphMind is disabled.
  class Client
    attr_reader :session

    def initialize(app: nil, sdk: nil, **session_options)
      @session = Session.new(
        app_name: app || default_app_name,
        sdk: sdk || { "name" => "ruby", "version" => Graphmind::VERSION },
        **session_options
      )
      @session_of = -> { @session }
    end

    # -- attach --------------------------------------------------------------

    def enabled?  = @session.enabled?
    def attached? = @session.attached?
    def url       = @session.url

    # Block until the debugger handshake completes (breakpoints armed).
    # `false` means "carry on detached" — it is never an error.
    def ready(timeout = Session::DEFAULT_READY_TIMEOUT) = @session.ready(timeout)

    # -- runs & spans --------------------------------------------------------

    # Run boundary: `gm.run("name") { |ctx| ... }`.
    def run(name, meta: nil, &block)
      @session.run(name, meta: meta, &block)
    end

    def current_run = @session.current_run
    def with_run_context(ctx, &block) = @session.with_run_context(ctx, &block)
    def clear_run_context = @session.clear_run_context

    # An arbitrary node on the canvas: gated, timed, named. Use it for the
    # parts of a graph GraphMind cannot see by itself — a retrieval step, a
    # hand-rolled planner loop, a Sidekiq job body.
    #
    # The block's value becomes the node's output and the span's value, unless
    # `span.output = ...` sets one explicitly.
    def span(name, kind: "custom", input: nil, parent_id: nil)
      kind = "custom" unless Protocol::NODE_KINDS.include?(kind)
      holder = Span.new
      Wrap.invoke(@session,
                  node_id: "#{kind}:#{name}", kind: kind, name: name.to_s,
                  parent_id: parent_id, input: input) do
        value = yield holder
        holder.output_set? ? holder.output : value
      end
    end

    # -- tools ---------------------------------------------------------------

    # Wrap a block as a gated tool:
    #
    #   search = gm.tool("search") { |query:| index.query(query) }
    #   search.call(query: "flights")
    def tool(name = nil, kind: "tool", parent_id: nil, &block)
      raise ArgumentError, "Graphmind#tool needs a block" if block.nil?

      Wrap.gate_callable(block, @session_of, name: name, kind: kind, parent_id: parent_id)
    end

    # Wrap any callable (Proc, Method, or an object responding to #call).
    def wrap(callable, name: nil, kind: "tool", node_id: nil, parent_id: nil)
      Wrap.gate_callable(callable, @session_of, name: name, kind: kind, node_id: node_id,
                                                parent_id: parent_id)
    end

    # Wrap a {name => callable} Hash, an Array of callables, or one callable.
    def wrap_tools(tools) = Wrap.wrap_tools(tools, @session_of)

    # Gate one method on one object, in place.
    def wrap_method(target, method_name, name: nil, kind: "tool", parent_id: nil)
      Wrap.wrap_method(target, method_name, @session_of, name: name, kind: kind,
                                                         parent_id: parent_id)
    end

    # -- integrations --------------------------------------------------------

    # Instrument a ruby-openai `OpenAI::Client` in place and return it.
    def instrument_openai(client, **options)
      require_relative "integrations/ruby_openai"
      Integrations::RubyOpenAI.instrument(client, @session, **options)
    end

    # Instrument a `RubyLLM::Chat` (and its tools) in place and return it.
    def instrument_ruby_llm(chat, **options)
      require_relative "integrations/ruby_llm"
      Integrations::RubyLLM.instrument(chat, @session, **options)
    end

    # -- low level -----------------------------------------------------------

    def emit(type, payload) = @session.emit(type, payload)
    def gate(point, node) = @session.gate(point, node)
    def graph_hint(nodes) = @session.graph_hint(nodes)
    def push_token(node_id, channel, value) = @session.push_token(node_id, channel, value)
    def stats = @session.stats
    def dispose = @session.dispose

    private

    def default_app_name
      if defined?(::Rails) && ::Rails.respond_to?(:application) && ::Rails.application
        ::Rails.application.class.name.to_s.split("::").first.to_s.downcase
      else
        File.basename(Dir.pwd)
      end
    rescue StandardError
      "ruby"
    end
  end

  # Yielded by Client#span so the block can name what the node produced.
  class Span
    attr_reader :output

    def initialize
      @output = nil
      @set = false
    end

    def output=(value)
      @output = value
      @set = true
    end

    def output_set? = @set
  end

  # -- module-level default instance -----------------------------------------

  @default = nil
  @default_mutex = Mutex.new

  class << self
    # Create (or replace) the process-wide default instance. Accepts
    # everything Session accepts plus `app:` and `sdk:`.
    def configure(**options)
      previous = nil
      client = nil
      @default_mutex.synchronize do
        previous = @default
        client = Client.new(**options)
        @default = client
      end
      previous&.dispose
      client
    end
    alias init configure

    # The default instance, created with defaults on first use.
    def instance
      current = @default
      return current if current

      @default_mutex.synchronize do
        @default ||= Client.new
      end
    end

    def configured? = !@default.nil?

    # Dispose and forget the default instance (mainly for tests).
    def reset
      current = @default_mutex.synchronize do
        previous = @default
        @default = nil
        previous
      end
      current&.dispose
      nil
    end

    def session = instance.session
    def enabled? = instance.enabled?
    def attached? = instance.attached?
    def ready(timeout = Session::DEFAULT_READY_TIMEOUT) = instance.ready(timeout)
    def run(name, meta: nil, &block) = instance.run(name, meta: meta, &block)
    def span(name, **kwargs, &block) = instance.span(name, **kwargs, &block)
    def tool(name = nil, **kwargs, &block) = instance.tool(name, **kwargs, &block)
    def wrap(callable, **kwargs) = instance.wrap(callable, **kwargs)
    def wrap_tools(tools) = instance.wrap_tools(tools)
    def wrap_method(target, method_name, **kwargs) = instance.wrap_method(target, method_name, **kwargs)
    def instrument_openai(client, **kwargs) = instance.instrument_openai(client, **kwargs)
    def instrument_ruby_llm(chat, **kwargs) = instance.instrument_ruby_llm(chat, **kwargs)
    def emit(type, payload) = instance.emit(type, payload)
    def graph_hint(nodes) = instance.graph_hint(nodes)
    def current_run = instance.current_run
    def with_run_context(ctx, &block) = instance.with_run_context(ctx, &block)
    def clear_run_context = instance.clear_run_context
    def stats = instance.stats
    def dispose = instance.dispose
  end

  # Class-level macro for gating instance methods:
  #
  #   class Tools
  #     include Graphmind::Instrument
  #     graphmind_tool :search, :book
  #
  #     def search(query) = ...
  #   end
  #
  # Every instance of the class now pauses at `tool:search` / `tool:book`.
  module Instrument
    def self.included(base)
      base.extend(ClassMethods)
    end

    module ClassMethods
      def graphmind_tool(*method_names, kind: "tool", session: nil)
        gates = (@graphmind_gate_module ||= begin
          mod = Module.new
          prepend(mod)
          mod
        end)
        method_names.each do |method_name|
          node_name = method_name.to_s
          gates.define_method(method_name) do |*args, **kwargs, &block|
            active = session ? session.call : Graphmind.instance.session
            body = lambda do
              kwargs.empty? ? super(*args, &block) : super(*args, **kwargs, &block)
            end
            if active.nil? || !active.enabled? || active.disposed?
              body.call
            else
              parameters =
                begin
                  method(method_name).super_method&.parameters || []
                rescue StandardError
                  []
                end
              Graphmind::Wrap.invoke(
                active,
                node_id: Graphmind::Ids.tool_node_id(node_name),
                kind: kind,
                name: node_name,
                input: Graphmind::Wrap.describe(parameters, args, kwargs),
                &body
              )
            end
          end
        end
        method_names
      end
    end
  end
end
