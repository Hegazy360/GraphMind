# frozen_string_literal: true

module Graphmind
  # "Never raise into the host app" plumbing.
  #
  # All internal failures degrade to a no-op plus a rate-limited warning: at
  # most one warning per key per interval, so a permanently broken transport
  # cannot spam a Rails log.
  class Warner
    # `Kernel.warn`, explicitly: a bare `warn(message)` inside this class binds
    # to Warner#warn (arity 2+) and raises ArgumentError, which the rescue at
    # the bottom of #warn would then swallow — leaving the default sink
    # silently printing nothing.
    def initialize(interval = 60.0, sink = nil)
      @interval = interval
      @sink = sink || ->(message) { Kernel.warn(message) }
      @last = {}
      @mutex = Mutex.new
    end

    def warn(key, message, cause = nil)
      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      emit = @mutex.synchronize do
        previous = @last[key]
        if previous && (now - previous) < @interval
          false
        else
          @last[key] = now
          true
        end
      end
      return unless emit

      suffix =
        if cause.is_a?(Exception)
          " (#{cause.class}: #{cause.message})"
        elsif cause.nil?
          ""
        else
          " (#{cause})"
        end
      @sink.call("[graphmind] #{message}#{suffix}")
    rescue StandardError
      # Even a raising sink must not propagate into the host.
      nil
    end
  end
end
