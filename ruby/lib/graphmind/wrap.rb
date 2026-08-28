# frozen_string_literal: true

require_relative "errors"
require_relative "gate_engine"
require_relative "ids"

module Graphmind
  # Gating a plain callable — where `inject` and `retry` actually work.
  #
  # A callback or a patched provider client can *observe* and *hold*, but only
  # a wrapper that owns the call site can substitute a result. So this is the
  # sharp end of the debugger:
  #
  #   * `before` gate before the body runs — `inject` returns the debugger's
  #     value instead of calling it at all;
  #   * `error` gate when the body raises, BEFORE the caller sees the error —
  #     `inject` swallows the error and returns a value, `retry` re-runs the
  #     body, `continue` re-raises the original, `abort` aborts the run;
  #   * `after` gate post-body, pre-return (fires only in step mode or with an
  #     explicit `after` breakpoint — decisions.md #2).
  #
  # Gates hold the CALLING thread, so a wrapped tool called from a Puma worker
  # holds exactly that request and nothing else.
  module Wrap
    MAX_ARGS_PREVIEW = 32

    module_function

    # The core gated invocation. `body` is the real work.
    #
    # `output_for` maps the body's result to what the viewer should show (an
    # LLM response object is not something you want rendered raw), and
    # `finish_extra` contributes extra node.finished fields (token usage).
    # Both are optional and never allowed to break the call.
    # `inject_as` adapts a value the debugger injected — which arrived as
    # plain JSON over the socket — into whatever the call site expects
    # (a provider response object, say). Without it, `inject` is only usable
    # where the host already speaks Hash/String.
    def invoke(session, node_id:, kind:, name:, parent_id: nil, input: nil, output_for: nil,
               finish_extra: nil, inject_as: nil, &body)
      return body.call if session.nil? || !session.enabled? || session.disposed?

      node = GateNode.new(node_id, kind, name)
      ctx = session.current_run
      instance_id = Ids.next_id("call")
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      session.start_node(node_id: node_id, kind: kind, name: name, instance_id: instance_id,
                         parent_id: parent_id, input: input)

      finish = lambda do |output, status, extra = nil|
        session.finish_node(
          node_id: node_id,
          instance_id: instance_id,
          duration_ms: (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000.0,
          status: status,
          output: output,
          extra: extra
        )
      end

      loop do
        pre = session.gate("before", node)
        if pre.abort?
          finish.call(nil, "aborted")
          raise session.abort_error(ctx)
        end
        if pre.inject?
          finish.call(pre.output, "ok", { "injected" => true })
          return coerce_injected(inject_as, pre.output)
        end
        # `retry` before execution is equivalent to continue.

        begin
          result = body.call
        rescue Exception => e # rubocop:disable Lint/RescueException
          unless gateable_error?(e)
            finish.call(nil, Errors.abort_error?(e) ? "aborted" : "error")
            raise
          end
          session.error_node(node_id, instance_id, e)
          decision = session.gate("error", node)
          if decision.inject?
            finish.call(decision.output, "ok",
                        { "injected" => true, "recoveredFromError" => true })
            return coerce_injected(inject_as, decision.output)
          end
          next if decision.retry?

          if decision.abort?
            finish.call(nil, "aborted")
            raise session.abort_error(ctx)
          end
          finish.call(nil, "error")
          raise
        end

        post = session.gate("after", node)
        if post.inject?
          finish.call(post.output, "ok", { "injected" => true })
          return coerce_injected(inject_as, post.output)
        end
        next if post.retry?

        output = output_for ? project(output_for, result) : result
        if post.abort?
          finish.call(output, "aborted")
          raise session.abort_error(ctx)
        end

        finish.call(output, "ok", project(finish_extra, result))
        return result
      end
    end

    # Adapt an injected JSON value to the host's expected type. A coercion
    # that fails falls back to the raw value rather than breaking the call.
    def coerce_injected(coercer, value)
      return value if coercer.nil?

      coercer.call(value)
    rescue StandardError
      value
    end

    # A viewer-facing projection must never break the host's call.
    def project(mapper, result)
      return nil if mapper.nil?

      mapper.call(result)
    rescue StandardError
      nil
    end

    # Only ordinary errors are gated. A debugger-driven abort surfacing from
    # the body is terminal, and Interrupt / SystemExit / SignalException must
    # never be held.
    def gateable_error?(error)
      return false unless error.is_a?(StandardError)

      !Errors.abort_error?(error)
    end

    # A readable `input` payload for the viewer, keyed by parameter name when
    # the callable exposes one.
    def describe(parameters, args, kwargs)
      out = {}
      index = 0
      Array(parameters).each do |kind, pname|
        case kind
        when :req, :opt
          break if index >= args.length

          out[pname.to_s] = args[index]
          index += 1
        when :rest
          rest = args[index..] || []
          out[(pname || :args).to_s] = rest unless rest.empty?
          index = args.length
        end
      end
      leftover = args[index..] || []
      out["args"] = leftover.first(MAX_ARGS_PREVIEW) unless leftover.empty?
      kwargs.each { |k, v| out[k.to_s] = v } if kwargs.is_a?(Hash)
      out
    rescue StandardError
      { "args" => Array(args).first(MAX_ARGS_PREVIEW) }
    end

    def callable_name(callable)
      return callable.name.to_s if callable.respond_to?(:name) && callable.name

      "callable"
    rescue StandardError
      "callable"
    end

    def parameters_of(callable)
      callable.respond_to?(:parameters) ? callable.parameters : []
    rescue StandardError
      []
    end
  end

  # A callable wrapped with GraphMind gates. Quacks like the original: #call,
  # #to_proc, #arity, and `.()`.
  class GatedCallable
    attr_reader :name, :node_id, :kind, :original

    def initialize(callable, session_of, name: nil, kind: "tool", node_id: nil, parent_id: nil)
      @original = callable
      @session_of = session_of
      @name = (name || Wrap.callable_name(callable)).to_s
      @kind = kind
      @node_id = node_id || Ids.tool_node_id(@name)
      @parent_id = parent_id
      @parameters = Wrap.parameters_of(callable)
    end

    def call(*args, **kwargs, &block)
      session = @session_of.call
      body = -> { kwargs.empty? ? @original.call(*args, &block) : @original.call(*args, **kwargs, &block) }
      return body.call if session.nil? || !session.enabled? || session.disposed?

      Wrap.invoke(
        session,
        node_id: @node_id,
        kind: @kind,
        name: @name,
        parent_id: @parent_id,
        input: Wrap.describe(@parameters, args, kwargs),
        &body
      )
    end

    alias [] call
    alias === call

    def to_proc
      method(:call).to_proc
    end

    def arity
      @original.respond_to?(:arity) ? @original.arity : -1
    end

    def parameters = @parameters
    def graphmind_wrapped? = true

    def respond_to_missing?(symbol, include_private = false)
      @original.respond_to?(symbol, include_private) || super
    end

    def method_missing(symbol, ...)
      return @original.public_send(symbol, ...) if @original.respond_to?(symbol)

      super
    end
  end

  module Wrap
    module_function

    def gate_callable(callable, session_of, name: nil, kind: "tool", node_id: nil, parent_id: nil)
      return callable if callable.is_a?(GatedCallable)

      GatedCallable.new(callable, session_of, name: name, kind: kind, node_id: node_id,
                                              parent_id: parent_id)
    end

    def wrapped?(callable)
      callable.is_a?(GatedCallable) ||
        (callable.respond_to?(:graphmind_wrapped?) && callable.graphmind_wrapped?)
    end

    # Wrap a Hash of {name => callable}, an Array of callables, or a single
    # callable. Shape in, shape out.
    def wrap_tools(tools, session_of)
      case tools
      when Hash
        tools.each_with_object({}) do |(key, fn), out|
          out[key] = wrapped?(fn) ? fn : gate_callable(fn, session_of, name: key.to_s)
        end
      when Array
        tools.map { |fn| wrapped?(fn) ? fn : gate_callable(fn, session_of) }
      else
        raise ArgumentError, "wrap_tools expects a callable, an Array, or a {name => callable} Hash" unless tools.respond_to?(:call)

        gate_callable(tools, session_of)
      end
    end

    # Gate one method on one object, in place. The object keeps its API; the
    # method now pauses.
    def wrap_method(target, method_name, session_of, name: nil, kind: "tool", parent_id: nil)
      original = target.method(method_name)
      gated = gate_callable(original, session_of, name: name || method_name.to_s, kind: kind,
                                                  parent_id: parent_id)
      target.define_singleton_method(method_name) do |*args, **kwargs, &block|
        gated.call(*args, **kwargs, &block)
      end
      target
    end
  end
end
